// Автозапуск пульта вместе с ноутбуком.
//
//   node install.js          — включить автозапуск и сразу запустить
//   node install.js remove   — выключить автозапуск
//   node install.js status   — проверить, что настроено
//
// Ничего не требует, кроме Node.js. Права администратора не нужны:
// сервис ставится для текущего пользователя.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const SERVER = path.join(DIR, "server.js");
const LOG = path.join(DIR, "pcr.log");
const NODE = process.execPath;
const PLATFORM = os.platform();
const HOME = os.homedir();
const NAME = "pc-remote";
const mode = (process.argv[2] || "install").toLowerCase();

const say = (...a) => console.log(" ", ...a);
// консольные программы Windows пишут в OEM-кодировке (cp866) — иначе вместо ошибки «ромбики»
const decoder = new TextDecoder(PLATFORM === "win32" ? "ibm866" : "utf-8");
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, opts);
  return { ...r, stdout: r.stdout ? decoder.decode(r.stdout) : "", stderr: r.stderr ? decoder.decode(r.stderr) : "" };
};

if (!fs.existsSync(SERVER)) {
  console.error(`\n  Не нашёл server.js рядом с установщиком.\n  Положите install.js в ту же папку.\n`);
  process.exit(1);
}

/* ===================== Windows ===================== */
// Через папку «Автозагрузка» пользователя: прав администратора не нужно
// (задачу «при входе» в планировщике обычный пользователь создать не может).
// Окно консоли прячем обёрткой на VBScript.
const VBS = path.join(DIR, "pcr-launch.vbs");
const STARTUP = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "PC Remote.vbs");
const TASK = "PC Remote";   // так автозапуск ставили старые версии

const stopServer = () => sh("powershell", ["-NoProfile", "-Command",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
  `Where-Object { $_.CommandLine -like '*${SERVER.replace(/'/g, "''")}*' } | ` +
  "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);

const win = {
  install() {
    // перенаправление в журнал умеет только cmd, поэтому зовём его,
    // а VBScript нужен лишь чтобы спрятать чёрное окно консоли
    fs.writeFileSync(VBS,
      `Set s = CreateObject("WScript.Shell")\r\n` +
      `s.CurrentDirectory = "${DIR}"\r\n` +
      `cmd = "cmd /c """"${NODE}"" ""${SERVER}"" > ""${LOG}"" 2>&1"""\r\n` +
      `s.Run cmd, 0, False\r\n`);
    // в «Автозагрузке» лежит крошечный файл, который запускает лаунчер из папки пульта
    fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
    fs.writeFileSync(STARTUP, `CreateObject("WScript.Shell").Run """wscript.exe"" ""${VBS}""", 0, False\r\n`);

    // старая задача планировщика запускала бы второй экземпляр
    if (sh("schtasks", ["/Query", "/TN", TASK]).status === 0) sh("schtasks", ["/Delete", "/TN", TASK, "/F"]);
    stopServer();   // переустановка: гасим уже запущенный, чтобы не держал порт
    sh("wscript.exe", [VBS]);   // запускаем прямо сейчас
    return "Пульт добавлен в «Автозагрузку», запускается при входе в Windows.";
  },
  remove() {
    const had = fs.existsSync(STARTUP) || sh("schtasks", ["/Query", "/TN", TASK]).status === 0;
    try { fs.unlinkSync(STARTUP); } catch {}
    sh("schtasks", ["/Delete", "/TN", TASK, "/F"]);
    stopServer();
    try { fs.unlinkSync(VBS); } catch {}
    return had ? "Автозапуск убран, сервер остановлен." : "Автозапуска и так не было, сервер остановлен.";
  },
  status() {
    if (fs.existsSync(STARTUP)) return "включён (папка «Автозагрузка»)";
    return sh("schtasks", ["/Query", "/TN", TASK]).status === 0 ? "включён (планировщик задач)" : "выключен";
  },
};

/* ===================== macOS ===================== */
// Через LaunchAgent пользователя: стартует при входе и сам поднимается после падения.
const PLIST_ID = "com.pcremote.server";
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${PLIST_ID}.plist`);

const mac = {
  install() {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_ID}</string>
  <key>ProgramArguments</key>
  <array><string>${NODE}</string><string>${SERVER}</string></array>
  <key>WorkingDirectory</key><string>${DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`);
    sh("launchctl", ["unload", PLIST]);
    const r = sh("launchctl", ["load", "-w", PLIST]);
    if (r.status !== 0) throw new Error(r.stderr || "launchctl отказал");
    return "LaunchAgent установлен, пульт стартует при входе в систему.";
  },
  remove() {
    sh("launchctl", ["unload", "-w", PLIST]);
    try { fs.unlinkSync(PLIST); } catch {}
    return "LaunchAgent удалён.";
  },
  status() {
    if (!fs.existsSync(PLIST)) return "выключен";
    const r = sh("launchctl", ["list"]);
    return String(r.stdout).includes(PLIST_ID) ? "включён и работает (LaunchAgent)" : "настроен, но сейчас не запущен";
  },
};

/* ===================== Linux ===================== */
// Пользовательский сервис systemd. Чтобы работал трекпад,
// пробрасываем переменные графической сессии.
const UNIT_DIR = path.join(HOME, ".config", "systemd", "user");
const UNIT = path.join(UNIT_DIR, `${NAME}.service`);
const uctl = (...a) => sh("systemctl", ["--user", ...a]);

const linux = {
  install() {
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    const display = process.env.DISPLAY || ":0";
    const wayland = process.env.WAYLAND_DISPLAY ? `\nEnvironment=WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}` : "";
    const xauth = process.env.XAUTHORITY ? `\nEnvironment=XAUTHORITY=${process.env.XAUTHORITY}` : "";

    fs.writeFileSync(UNIT, `[Unit]
Description=Пульт ноутбука
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=${DIR}
ExecStart=${NODE} ${SERVER}
Environment=DISPLAY=${display}${xauth}${wayland}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`);
    uctl("daemon-reload");
    const en = uctl("enable", `${NAME}.service`);
    if (en.status !== 0 && !fs.existsSync(path.join(UNIT_DIR, "default.target.wants", `${NAME}.service`)))
      throw new Error(en.stderr.trim() || "systemctl не смог включить сервис");

    const lines = [`Сервис ${NAME} включён, стартует при входе в систему.`];

    const start = uctl("restart", `${NAME}.service`);
    if (start.status !== 0)
      lines.push("Сейчас запустить не удалось — заработает после входа в систему.");

    // чтобы сервис жил и до входа в систему
    if (sh("loginctl", ["enable-linger", os.userInfo().username]).status !== 0)
      lines.push("Если нужен старт до входа:  sudo loginctl enable-linger $USER");

    return lines.join("\n  ");
  },
  remove() {
    uctl("disable", "--now", `${NAME}.service`);
    try { fs.unlinkSync(UNIT); } catch {}
    uctl("daemon-reload");
    return "Сервис удалён.";
  },
  status() {
    if (!fs.existsSync(UNIT)) return "выключен";
    const enabled = uctl("is-enabled", `${NAME}.service`).stdout.trim();
    const active = uctl("is-active", `${NAME}.service`).stdout.trim();
    return `${enabled === "enabled" ? "включён" : "настроен, но не включён"}, сейчас ${active === "active" ? "работает" : "не работает"}`;
  },
};

const impl = { win32: win, darwin: mac, linux }[PLATFORM];
if (!impl) {
  console.error(`\n  Автозапуск для ${PLATFORM} не поддерживается.\n`);
  process.exit(1);
}

/* ===================== запуск ===================== */
const osLabel = { win32: "Windows", darwin: "macOS", linux: "Linux" }[PLATFORM];
console.log("");

try {
  if (mode === "remove" || mode === "uninstall") {
    say(impl.remove());
    say("Пульт больше не стартует сам. Запускать вручную:  node server.js");
  } else if (mode === "status") {
    say(`${osLabel}: автозапуск ${impl.status()}`);
    if (fs.existsSync(LOG)) say(`Журнал: ${LOG}`);
  } else {
    say(`Настраиваю автозапуск для ${osLabel}…`);
    say(impl.install());
    say(`Журнал пульта: ${LOG}`);

    // показываем ссылку с токеном, чтобы не искать её в консоли
    setTimeout(() => {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
        const ips = Object.values(os.networkInterfaces()).flat()
          .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
        console.log("");
        say("Откройте на телефоне:");
        for (const ip of ips) console.log(`    http://${ip}:7777/#${cfg.token}`);
      } catch {
        say("Ссылку с токеном пульт напишет в журнал через пару секунд.");
      }
      console.log("");
      say("Выключить автозапуск:  node install.js remove");
      console.log("");
    }, 2500);
  }
} catch (e) {
  console.error(`\n  Не получилось: ${e.message}\n`);
  process.exit(1);
}
