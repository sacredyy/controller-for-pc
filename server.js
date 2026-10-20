// Пульт ноутбука — сервер. Нужен только Node.js 18+, никаких npm-пакетов.
// Запуск:  node server.js        (свой порт: PORT=8080 node server.js)

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec, execFile, spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT) || 7777;
const DIR = __dirname;
const TMP = os.tmpdir();
const CONFIG = path.join(DIR, "config.json");
const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'

/* ========== конфиг и токен ========== */
let config = { customCommands: [] };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch {}
if (!config.token) config.token = crypto.randomBytes(16).toString("hex");
if (!Array.isArray(config.customCommands)) config.customCommands = [];
if (!config.night) config.night = { volume: 15, minutes: 45, dimSteps: 4 };
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));

const TOKEN = Buffer.from(config.token);
function authorized(req) {
  const got = Buffer.from(String(req.headers["x-token"] || ""));
  return got.length === TOKEN.length && crypto.timingSafeEqual(got, TOKEN);
}

/* ========== системные команды ========== */
const PS = (s) => `powershell -NoProfile -Command "${s}"`;
const winKey = (c) => PS(`(New-Object -ComObject WScript.Shell).SendKeys([char]${c})`);
const mac = (s) => `osascript -e '${s}'`;

const COMMANDS = {
  win32: {
    shutdown: "shutdown /s /t 0", restart: "shutdown /r /t 0",
    sleep: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
    lock: "rundll32.exe user32.dll,LockWorkStation", logoff: "shutdown /l",
    volUp: winKey(175), volDown: winKey(174), mute: winKey(173),
    playPause: winKey(179), next: winKey(176), prev: winKey(177),
    brightUp: PS("$b=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness;(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,[math]::Min(100,$b+15))"),
    brightDown: PS("$b=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness;(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,[math]::Max(0,$b-15))"),
    screenOff: PS("(Add-Type '[DllImport(\\\"user32.dll\\\")]public static extern int SendMessage(int hWnd,int hMsg,int wParam,int lParam);' -Name A -Pass)::SendMessage(-1,0x0112,0xF170,2)"),
    emptyTrash: PS("Clear-RecycleBin -Force -ErrorAction SilentlyContinue"),
  },
  darwin: {
    shutdown: mac('tell app "System Events" to shut down'),
    restart: mac('tell app "System Events" to restart'),
    sleep: "pmset sleepnow", lock: "pmset displaysleepnow",
    logoff: mac('tell app "System Events" to log out'),
    volUp: mac("set volume output volume ((output volume of (get volume settings)) + 10)"),
    volDown: mac("set volume output volume ((output volume of (get volume settings)) - 10)"),
    mute: mac("set volume output muted (not (output muted of (get volume settings)))"),
    playPause: mac('tell application "Music" to playpause'),
    next: mac('tell application "Music" to next track'),
    prev: mac('tell application "Music" to previous track'),
    brightUp: mac('tell app "System Events" to key code 144'),
    brightDown: mac('tell app "System Events" to key code 145'),
    screenOff: "pmset displaysleepnow",
    emptyTrash: mac('tell app "Finder" to empty trash'),
  },
  linux: {
    shutdown: "systemctl poweroff", restart: "systemctl reboot",
    sleep: "systemctl suspend", lock: "loginctl lock-session",
    logoff: "loginctl terminate-user $USER",
    volUp: "pactl set-sink-volume @DEFAULT_SINK@ +10%",
    volDown: "pactl set-sink-volume @DEFAULT_SINK@ -10%",
    mute: "pactl set-sink-mute @DEFAULT_SINK@ toggle",
    playPause: "playerctl play-pause", next: "playerctl next", prev: "playerctl previous",
    brightUp: "brightnessctl set +15%", brightDown: "brightnessctl set 15%-",
    screenOff: "xset dpms force off",
    emptyTrash: "rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/*",
  },
}[PLATFORM] || {};

function run(cmd, timeout = 20000) {
  return new Promise((ok, no) => exec(cmd,
    { timeout, maxBuffer: 1 << 22, shell: PLATFORM === "win32" ? undefined : "/bin/bash" },
    (e, out, err) => e ? no(new Error(err || e.message)) : ok(out)));
}
// без оболочки: аргументы уходят как есть, кавычки экранировать не нужно
function runFile(bin, args, timeout = 8000) {
  return new Promise((ok, no) => execFile(bin, args, { timeout, windowsHide: true },
    (e, out, err) => e ? no(new Error(err || e.message)) : ok(out)));
}
function hasBinary(name) {
  return spawnSync(PLATFORM === "win32" ? "where" : "which", [name], { stdio: "ignore" }).status === 0;
}

/* ========== размер экрана (для кликов по живой картинке) ========== */
let SCREEN = { w: 1920, h: 1080 };
(function detectScreen() {
  try {
    if (PLATFORM === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-Command",
        'Add-Type -AssemblyName System.Windows.Forms;$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"$($b.Width) $($b.Height)"'],
        { encoding: "utf8" });
      const m = String(r.stdout).trim().split(/\s+/).map(Number);
      if (m[0] > 0) SCREEN = { w: m[0], h: m[1] };
    } else if (PLATFORM === "linux" && hasBinary("xdotool")) {
      const r = spawnSync("xdotool", ["getdisplaygeometry"], { encoding: "utf8" });
      const m = String(r.stdout).trim().split(/\s+/).map(Number);
      if (m[0] > 0) SCREEN = { w: m[0], h: m[1] };
    } else if (PLATFORM === "darwin") {
      const r = spawnSync("osascript", ["-e", 'tell application "Finder" to get bounds of window of desktop'],
        { encoding: "utf8" });
      const m = String(r.stdout).trim().split(/,\s*/).map(Number);
      if (m[2] > 0) SCREEN = { w: m[2], h: m[3] };
    }
  } catch {}
})();

/* ========== мышь и клавиатура: постоянный процесс-помощник ==========
   Один долгоживущий процесс читает строки команд — так курсор двигается
   плавно, без запуска нового процесса на каждое движение пальца.       */

const HELPER_SRC = {
  win32: `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,int d,int e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint flags,int extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
while ($true) {
  $line = [Console]::ReadLine()
  if ($line -eq $null) { break }
  $sp = $line.IndexOf(' ')
  if ($sp -lt 0) { $op = $line; $arg = '' } else { $op = $line.Substring(0,$sp); $arg = $line.Substring($sp+1) }
  try {
    switch ($op) {
      'move'   { $a = $arg.Split(' '); $p = New-Object M+POINT; [void][M]::GetCursorPos([ref]$p); [void][M]::SetCursorPos($p.X + [int]$a[0], $p.Y + [int]$a[1]) }
      'abs'    { $a = $arg.Split(' '); [void][M]::SetCursorPos([int]$a[0], [int]$a[1]) }
      'click'  { [M]::mouse_event(0x0002,0,0,0,0); [M]::mouse_event(0x0004,0,0,0,0) }
      'rclick' { [M]::mouse_event(0x0008,0,0,0,0); [M]::mouse_event(0x0010,0,0,0,0) }
      'dclick' { [M]::mouse_event(0x0002,0,0,0,0); [M]::mouse_event(0x0004,0,0,0,0); [M]::mouse_event(0x0002,0,0,0,0); [M]::mouse_event(0x0004,0,0,0,0) }
      'down'   { [M]::mouse_event(0x0002,0,0,0,0) }
      'up'     { [M]::mouse_event(0x0004,0,0,0,0) }
      'scroll' { [M]::mouse_event(0x0800,0,0,[int]$arg,0) }
      'hscroll' { [M]::mouse_event(0x01000,0,0,[int]$arg,0) }
      'key'    { [System.Windows.Forms.SendKeys]::SendWait($arg) }
      'type'   { [System.Windows.Forms.SendKeys]::SendWait([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($arg))) }
      'combo'  {
        switch ($arg) {
          'switch'  { [M]::keybd_event(0x12,0,0,0); [M]::keybd_event(0x09,0,0,0); [M]::keybd_event(0x09,0,2,0); [M]::keybd_event(0x12,0,2,0) }
          'desktop' { [M]::keybd_event(0x5B,0,0,0); [M]::keybd_event(0x44,0,0,0); [M]::keybd_event(0x44,0,2,0); [M]::keybd_event(0x5B,0,2,0) }
          'close'   { [M]::keybd_event(0x12,0,0,0); [M]::keybd_event(0x73,0,0,0); [M]::keybd_event(0x73,0,2,0); [M]::keybd_event(0x12,0,2,0) }
        }
      }
    }
  } catch {}
}`,
  linux: `
while IFS= read -r line; do
  op=\${line%% *}; arg=\${line#* }
  [ "$op" = "$line" ] && arg=""
  case "$op" in
    move)   xdotool mousemove_relative -- $arg ;;
    abs)    xdotool mousemove -- $arg ;;
    click)  xdotool click 1 ;;
    rclick) xdotool click 3 ;;
    dclick) xdotool click --repeat 2 1 ;;
    down)   xdotool mousedown 1 ;;
    up)     xdotool mouseup 1 ;;
    scroll) if [ "$arg" -gt 0 ] 2>/dev/null; then xdotool click 4; else xdotool click 5; fi ;;
    hscroll) if [ "$arg" -gt 0 ] 2>/dev/null; then xdotool click 7; else xdotool click 6; fi ;;
    key)    xdotool key --clearmodifiers "$arg" ;;
    type)   xdotool type --clearmodifiers -- "$arg" ;;
    combo)
      case "$arg" in
        switch)  xdotool key --clearmodifiers alt+Tab ;;
        desktop) xdotool key --clearmodifiers super+d ;;
        close)   xdotool key --clearmodifiers alt+F4 ;;
      esac ;;
  esac
done`,
  darwin: `
while IFS= read -r line; do
  op=\${line%% *}; arg=\${line#* }
  [ "$op" = "$line" ] && arg=""
  case "$op" in
    move)   set -- $arg; cliclick "m:+$1,+$2" ;;
    abs)    set -- $arg; cliclick "m:$1,$2" ;;
    click)  cliclick c:. ;;
    rclick) cliclick rc:. ;;
    dclick) cliclick dc:. ;;
    down)   cliclick dd:. ;;
    up)     cliclick du:. ;;
    scroll) if [ "$arg" -gt 0 ] 2>/dev/null; then cliclick w:+3; else cliclick w:-3; fi ;;
    key)    osascript -e "tell application \\"System Events\\" to $arg" ;;
    type)   osascript -e "tell application \\"System Events\\" to keystroke \\"$arg\\"" ;;
    combo)
      case "$arg" in
        switch)  osascript -e 'tell app "System Events" to key code 48 using command down' ;;
        desktop) osascript -e 'tell app "System Events" to key code 3 using {command down, option down}' ;;
        close)   osascript -e 'tell app "System Events" to key code 13 using command down' ;;
      esac ;;
  esac
done`,
}[PLATFORM];

const INPUT_NEEDS = { linux: "xdotool", darwin: "cliclick", win32: null }[PLATFORM];
const INPUT_OK = !INPUT_NEEDS || hasBinary(INPUT_NEEDS);

let helper = null;
function startHelper() {
  if (!INPUT_OK || helper) return;
  const f = path.join(TMP, PLATFORM === "win32" ? "pcr-helper.ps1" : "pcr-helper.sh");
  fs.writeFileSync(f, HELPER_SRC);
  helper = PLATFORM === "win32"
    ? spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { stdio: ["pipe", "ignore", "ignore"] })
    : spawn("bash", [f], { stdio: ["pipe", "ignore", "ignore"] });
  const me = helper;
  // если помощник умер, запись в его stdin даёт EPIPE — без обработчика это роняет сервер
  helper.stdin.on("error", () => {});
  helper.on("error", () => { if (helper === me) helper = null; });
  helper.on("exit", () => { if (helper === me) helper = null; });
}
startHelper();

const scrollRest = { scroll: 0, hscroll: 0 };   // остаток прокрутки меньше одного щелчка колеса
function sendInput(line) {
  if (!INPUT_OK) throw new Error(`Нужен ${INPUT_NEEDS}. Установите его и перезапустите сервер.`);
  if (!helper) startHelper();
  if (!helper) throw new Error("Помощник не запустился");
  helper.stdin.write(String(line).replace(/[\r\n]/g, " ") + "\n");
}

const KEYS = {
  win32: { space: " ", left: "{LEFT}", right: "{RIGHT}", up: "{UP}", down: "{DOWN}",
    enter: "{ENTER}", esc: "{ESC}", back: "{BACKSPACE}", tab: "{TAB}", del: "{DELETE}",
    pgup: "{PGUP}", pgdn: "{PGDN}", home: "{HOME}", end: "{END}",
    f: "f", m: "m", k: "k", j: "j", l: "l" },
  linux: { space: "space", left: "Left", right: "Right", up: "Up", down: "Down",
    enter: "Return", esc: "Escape", back: "BackSpace", tab: "Tab", del: "Delete",
    pgup: "Prior", pgdn: "Next", home: "Home", end: "End",
    f: "f", m: "m", k: "k", j: "j", l: "l" },
  darwin: { space: "key code 49", left: "key code 123", right: "key code 124",
    up: "key code 126", down: "key code 125", enter: "key code 36", esc: "key code 53",
    back: "key code 51", tab: "key code 48", del: "key code 117",
    pgup: "key code 116", pgdn: "key code 121", home: "key code 115", end: "key code 119",
    f: 'keystroke "f"', m: 'keystroke "m"', k: 'keystroke "k"', j: 'keystroke "j"', l: 'keystroke "l"' },
}[PLATFORM] || {};

function escapeText(t) {
  // в Windows текст едет в base64: stdin PowerShell читает в OEM-кодировке и портит кириллицу
  return PLATFORM === "win32"
       ? Buffer.from(t.replace(/[+^%~(){}\[\]]/g, (c) => "{" + c + "}"), "utf8").toString("base64")
       : PLATFORM === "darwin" ? t.replace(/["\\]/g, "\\$&") : t;
}

/* ========== громкость: прочитать и выставить точное значение ========== */
const VOL_PS = path.join(TMP, "pcr-volume.ps1");
if (PLATFORM === "win32") fs.writeFileSync(VOL_PS, `
param([string]$op,[int]$val)
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int a();int b();int c();int d();
  int SetMasterVolumeLevelScalar(float f,Guid g);
  int e();
  int GetMasterVolumeLevelScalar(out float f);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id,int ctx,int p,out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int a(); int GetDefaultAudioEndpoint(int flow,int role,out IMMDevice dev); }
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DevEnum { }
public class Audio {
  static IAudioEndpointVolume V() {
    IMMDeviceEnumerator e=(IMMDeviceEnumerator)(new DevEnum());
    IMMDevice d=null; e.GetDefaultAudioEndpoint(0,1,out d);
    Guid g=typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v=null;
    d.Activate(ref g,23,0,out v); return v;
  }
  public static float Get(){ float v; V().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v){ V().SetMasterVolumeLevelScalar(v,Guid.Empty); }
}
"@
if ($op -eq 'get') { [int][math]::Round([Audio]::Get()*100) } else { [Audio]::Set($val/100.0) }
`);

async function getVolume() {
  try {
    if (PLATFORM === "win32") {
      const out = await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${VOL_PS}" get`, 8000);
      const n = parseInt(String(out).trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (PLATFORM === "darwin") {
      const out = await run(`osascript -e 'output volume of (get volume settings)'`, 5000);
      const n = parseInt(String(out).trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    const out = await run("pactl get-sink-volume @DEFAULT_SINK@", 5000);
    const m = String(out).match(/(\d+)%/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
async function setVolume(v) {
  const n = Math.max(0, Math.min(100, Math.round(v)));
  if (PLATFORM === "win32") await run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${VOL_PS}" set ${n}`, 8000);
  else if (PLATFORM === "darwin") await run(`osascript -e 'set volume output volume ${n}'`, 5000);
  else await run(`pactl set-sink-volume @DEFAULT_SINK@ ${n}%`, 5000);
  volume = n;
  return n;
}
/* ========== батарея ========== */
async function getBattery() {
  try {
    if (PLATFORM === "win32") {
      const out = await runFile("powershell", ["-NoProfile", "-Command",
        '$b=Get-CimInstance Win32_Battery|Select-Object -First 1;if($b){"$($b.EstimatedChargeRemaining) $($b.BatteryStatus)"}']);
      const [lvl, st] = String(out).trim().split(/\s+/).map(Number);
      // BatteryStatus: 1 — разряжается, остальное (2, 6–9 …) — от сети
      return Number.isFinite(lvl) ? { level: lvl, charging: st !== 1 } : null;
    }
    if (PLATFORM === "darwin") {
      const out = String(await runFile("pmset", ["-g", "batt"]));
      const m = out.match(/(\d+)%;\s*([\w ]+)/);
      return m ? { level: Number(m[1]), charging: !/^discharging/i.test(m[2]) } : null;
    }
    const base = "/sys/class/power_supply";
    const bat = fs.readdirSync(base).find((d) => /^BAT/.test(d));
    if (!bat) return null;
    const level = Number(fs.readFileSync(path.join(base, bat, "capacity"), "utf8"));
    const status = fs.readFileSync(path.join(base, bat, "status"), "utf8").trim();
    return Number.isFinite(level) ? { level, charging: status !== "Discharging" } : null;
  } catch { return null; }
}

// значения обновляются в фоне, чтобы опрос состояния оставался быстрым.
// Опрашиваем, только пока пульт открыт: на Windows каждый замер — запуск PowerShell.
let volume = null, battery = null, lastSeen = 0;
async function pollVolume() { volume = await getVolume(); }
async function pollBattery() { battery = await getBattery(); }
const active = () => Date.now() - lastSeen < 20000;
pollVolume(); pollBattery();
setInterval(() => { if (active()) pollVolume(); }, 6000);
setInterval(() => { if (active()) pollBattery(); }, 60000);


/* ========== общий буфер обмена ========== */
function clipTool() {
  if (PLATFORM === "linux") {
    if (hasBinary("xclip")) return "xclip";
    if (hasBinary("xsel")) return "xsel";
    return null;
  }
  return PLATFORM === "win32" ? "powershell" : "pbcopy";
}
const CLIP_OK = !!clipTool();

async function clipboardGet() {
  if (!CLIP_OK) throw new Error("Нужен xclip. Установите его и перезапустите сервер.");
  if (PLATFORM === "win32") return await run("powershell -NoProfile -Command Get-Clipboard", 8000);
  if (PLATFORM === "darwin") return await run("pbpaste", 5000);
  return await run(clipTool() === "xclip"
    ? "xclip -selection clipboard -o" : "xsel --clipboard --output", 5000);
}
async function clipboardSet(text) {
  if (!CLIP_OK) throw new Error("Нужен xclip. Установите его и перезапустите сервер.");
  // текст кладём через файл, чтобы не возиться с экранированием в командной строке
  const f = path.join(TMP, "pcr-clip.txt");
  fs.writeFileSync(f, String(text), "utf8");
  if (PLATFORM === "win32") await run(`powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 '${f}' | Set-Clipboard"`, 8000);
  else if (PLATFORM === "darwin") await run(`pbcopy < "${f}"`, 5000);
  else await run(clipTool() === "xclip"
    ? `xclip -selection clipboard < "${f}"` : `xsel --clipboard --input < "${f}"`, 5000);
  try { fs.unlinkSync(f); } catch {}
}

/* ========== таймер ========== */
let timer = null;
function setTimer(action, minutes) {
  clearTimer();
  const ms = minutes * 60000;
  timer = { action, at: Date.now() + ms,
    handle: setTimeout(() => { const a = timer.action; timer = null; run(COMMANDS[a]).catch(console.error); }, ms) };
}
function clearTimer() { if (timer) clearTimeout(timer.handle); timer = null; }

/* ========== режим «уже сплю» ========== */
async function nightMode(minutes) {
  const n = config.night;
  const steps = Math.max(0, Number(n.dimSteps) || 4);
  for (let i = 0; i < steps; i++) {
    try { await run(COMMANDS.brightDown, 6000); } catch {}
  }
  try { await setVolume(Number(n.volume) || 15); } catch {}
  setTimer("sleep", minutes);
}

/* ========== автообновление с GitHub ==========
   Раз в полчаса смотрим package.json в репозитории. Вышла версия новее — скачиваем
   файлы, проверяем server.js и перезапускаемся. Выключить: "autoUpdate": false в config.json. */
const PKG = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "package.json"), "utf8")); }
  catch { return { version: "0.0.0" }; } })();
const newer = (a, b) => {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let updating = false;
async function checkUpdate() {
  const base = process.env.PCR_UPDATE_BASE ||   // свой адрес — для проверки обновлений локально
    (/^[\w.-]+\/[\w.-]+$/.test(PKG.repo || "") && `https://raw.githubusercontent.com/${PKG.repo}/${PKG.branch || "main"}`);
  if (config.autoUpdate === false || !base || updating) return;
  // перезапуск сбросит таймер и оборвёт управление — ждём, пока пультом не пользуются
  if (timer || active()) return setTimeout(checkUpdate, 2 * 60000);
  const raw = (f) => `${base}/${f}?t=${Date.now()}`;
  updating = true;
  try {
    const r = await fetch(raw("package.json"), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    const remote = await r.json();
    if (!newer(remote.version, PKG.version)) return;
    const names = Array.isArray(remote.files) ? remote.files : [];
    if (!names.includes("server.js") || !names.includes("package.json")) throw new Error("в package.json нет списка файлов");
    const files = {};
    for (const f of names) {
      if (!/^\w[\w.-]*$/.test(f)) throw new Error("странное имя файла: " + f);   // только файлы в корне папки
      const x = await fetch(raw(f), { signal: AbortSignal.timeout(30000) });
      if (!x.ok) throw new Error(`${f}: ответ ${x.status}`);
      files[f] = Buffer.from(await x.arrayBuffer());
    }
    // сломанный server.js не ставим: проверяем синтаксис до замены
    const probe = path.join(TMP, "pcr-update-check.js");
    fs.writeFileSync(probe, files["server.js"]);
    if (spawnSync(process.execPath, ["--check", probe]).status !== 0) throw new Error("новый server.js не проходит проверку");
    for (const [f, b] of Object.entries(files)) fs.writeFileSync(path.join(DIR, f + ".new"), b);
    for (const f of Object.keys(files)) fs.renameSync(path.join(DIR, f + ".new"), path.join(DIR, f));
    console.log(new Date().toLocaleTimeString(), `→ обновился ${PKG.version} → ${remote.version}, перезапускаюсь`);
    restartSelf();
  } catch (e) { console.error("обновление:", e.message); }
  finally { updating = false; }
}
function restartSelf() {
  // systemd и launchd сами поднимут сервер после выхода, в остальных случаях запускаем замену сами
  const managed = process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME === "com.pcremote.server";
  if (!managed) {
    let out = "ignore";
    try { out = fs.openSync(path.join(DIR, "pcr.log"), "a"); } catch {}
    spawn(process.execPath, [path.join(DIR, "server.js")], { cwd: DIR, detached: true,
      stdio: ["ignore", out, out], windowsHide: true }).unref();
  }
  if (helper) helper.kill();
  server.close();
  setTimeout(() => process.exit(0), 300);
}
setTimeout(checkUpdate, Number(process.env.PCR_UPDATE_DELAY) || 20000);
setInterval(checkUpdate, 30 * 60000);

/* ========== показатели системы ========== */
function cpuSnap() {
  return os.cpus().reduce((a, c) => {
    const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a;
  }, { idle: 0, total: 0 });
}
let last = cpuSnap(), cpuPercent = 0;
setInterval(() => {
  const n = cpuSnap(), i = n.idle - last.idle, t = n.total - last.total;
  cpuPercent = t ? Math.round(100 * (1 - i / t)) : 0; last = n;
}, 2000);

function info() {
  return {
    hostname: os.hostname(), platform: PLATFORM,
    uptimeSec: Math.round(os.uptime()), cpu: cpuPercent,
    memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(),
    input: INPUT_OK, inputNeeds: INPUT_OK ? null : INPUT_NEEDS, clipboard: CLIP_OK,
    volume, battery, screen: SCREEN, night: { minutes: config.night.minutes, volume: config.night.volume },
    timer: timer ? { action: timer.action, at: timer.at } : null,
    version: PKG.version,
    custom: config.customCommands.map(({ id, label }) => ({ id, label })),
  };
}

const localIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);

function openUrl(url) {
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("Ссылка должна начинаться с http:// или https://");
  const [bin, args] = { win32: ["rundll32", ["url.dll,FileProtocolHandler", url]],
    darwin: ["open", [url]], linux: ["xdg-open", [url]] }[PLATFORM];
  execFile(bin, args, { detached: true, stdio: "ignore" }).unref();
}

/* ========== HTTP ========== */
const send = (res, code, data) => {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const serve = (res, file, type, cache = "no-cache") => {
  const s = fs.createReadStream(path.isAbsolute(file) ? file : path.join(DIR, file));
  s.on("error", () => send(res, 404, { error: "Не найдено" }));
  s.on("open", () => { res.writeHead(200, { "Content-Type": type, "Cache-Control": cache }); s.pipe(res); });
};
const body = (req) => new Promise((r) => {
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > 4e4) { r({}); req.destroy(); } });
  req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } });
  req.on("error", () => r({}));
});

/* ========== библиотеки интерфейса: один раз скачиваем с CDN и храним рядом ==========
   Так пульт открывается и в домашней сети без интернета.                       */
const VENDOR_DIR = path.join(DIR, "vendor");
const VENDOR = {
  "react.js": "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js",
  "react-dom.js": "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js",
  "htm.js": "https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.umd.js",
};
const vendorLoading = {};
function vendorFile(name) {
  const f = path.join(VENDOR_DIR, name);
  if (fs.existsSync(f)) return Promise.resolve(f);
  return vendorLoading[name] ||= (async () => {
    const r = await fetch(VENDOR[name]);
    if (!r.ok) throw new Error("CDN ответил " + r.status);
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    return f;
  })().finally(() => { delete vendorLoading[name]; });
}
// при старте подкачиваем заранее, пока интернет, скорее всего, есть
for (const n of Object.keys(VENDOR)) vendorFile(n).catch(() => {});

/* ========== защита от перебора токена ========== */
const fails = new Map();   // ip → { n, t }
function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.t > 10 * 60000) { fails.delete(ip); return false; }
  return f.n >= 20;
}
function failed(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 10 * 60000) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}

const MANIFEST = JSON.stringify({
  name: "Пульт ноутбука", short_name: "Пульт", display: "standalone",
  background_color: "#0E1422", theme_color: "#0E1422", orientation: "portrait",
  icons: [{ src: "icon.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
  start_url: ".",
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (req.method === "GET" && (p === "/" || p === "/index.html")) return serve(res, "index.html", "text/html; charset=utf-8");
  if (p === "/manifest.json") { res.writeHead(200, { "Content-Type": "application/manifest+json" }); return res.end(MANIFEST); }
  if (p === "/icon.png") return serve(res, "icon.png", "image/png");
  if (p.startsWith("/vendor/") && VENDOR[p.slice(8)]) {
    return vendorFile(p.slice(8))
      .then((f) => serve(res, f, "text/javascript; charset=utf-8", "max-age=604800"))
      .catch(() => send(res, 502, { error: "Нет интернета, чтобы скачать интерфейс в первый раз" }));
  }

  if (!p.startsWith("/api/")) return send(res, 404, { error: "Не найдено" });
  const ip = req.socket.remoteAddress;
  if (blocked(ip)) return send(res, 429, { error: "Слишком много неверных попыток, подождите 10 минут" });
  if (!authorized(req)) { failed(ip); return send(res, 401, { error: "Неверный токен" }); }
  lastSeen = Date.now();

  try {
    if (req.method === "GET" && p === "/api/info") {
      // первый заход после паузы: обновим громкость и батарею сразу, а не через минуту
      if (volume === null) pollVolume();
      if (battery === null) pollBattery();
      return send(res, 200, info());
    }

    if (req.method === "POST" && p === "/api/action") {
      const { action } = await body(req);
      if (!COMMANDS[action]) return send(res, 400, { error: `Команда «${action}» недоступна на этой ОС` });
      console.log(new Date().toLocaleTimeString(), "→", action);
      send(res, 200, { ok: true });
      return setTimeout(() => {
        run(COMMANDS[action]).catch((e) => console.error(action, e.message));
        if (/^(volUp|volDown|mute)$/.test(action)) setTimeout(pollVolume, 400);
      }, 300);
    }

    if (req.method === "POST" && p === "/api/volume") {
      const { value } = await body(req);
      const n = Number(value);
      if (!Number.isFinite(n)) return send(res, 400, { error: "Нужно число от 0 до 100" });
      return send(res, 200, { volume: await setVolume(n) });
    }

    if (req.method === "POST" && p === "/api/night") {
      const { minutes } = await body(req);
      const m = Number(minutes) || config.night.minutes;
      if (!(m > 0 && m <= 1440)) return send(res, 400, { error: "От 1 до 1440 минут" });
      console.log(new Date().toLocaleTimeString(), "→ режим «уже сплю»,", m, "мин");
      nightMode(m).catch((e) => console.error("night:", e.message));
      return send(res, 200, { ok: true, minutes: m });
    }

    if (req.method === "POST" && p === "/api/input") {
      const { op, dx, dy, x, y, amount, key, text } = await body(req);
      if (op === "move") sendInput(`move ${Math.round(dx) | 0} ${Math.round(dy) | 0}`);
      else if (op === "abs") {   // координаты приходят долями экрана, 0…1
        const px = Math.round(Math.max(0, Math.min(1, Number(x))) * SCREEN.w);
        const py = Math.round(Math.max(0, Math.min(1, Number(y))) * SCREEN.h);
        sendInput(`abs ${px} ${py}`);
      }
      else if (["click", "rclick", "dclick", "down", "up"].includes(op)) sendInput(op);
      else if (op === "scroll" || op === "hscroll") {
        const a = Math.max(-2400, Math.min(2400, Math.round(Number(amount)) || 0));
        // Windows понимает плавное колесо (любая доля от 120), остальным — целые щелчки
        if (PLATFORM === "win32") { if (a) sendInput(`${op} ${a}`); }
        else {
          scrollRest[op] += a;
          const n = Math.trunc(scrollRest[op] / 120);
          scrollRest[op] -= n * 120;
          for (let i = 0; i < Math.min(Math.abs(n), 20); i++) sendInput(`${op} ${Math.sign(n)}`);
        }
      }
      else if (op === "key") {
        const k = KEYS[key];
        if (!k) return send(res, 400, { error: "Неизвестная клавиша" });
        sendInput(`key ${k}`);
      } else if (op === "combo") {
        if (!["switch", "desktop", "close"].includes(key)) return send(res, 400, { error: "Неизвестная комбинация" });
        sendInput(`combo ${key}`);
      } else if (op === "type") {
        const t = String(text || "").replace(/[\r\n]+/g, " ").slice(0, 500);
        if (t) sendInput(`type ${escapeText(t)}`);
      } else return send(res, 400, { error: "Неизвестная операция" });
      return send(res, 200, { ok: true });
    }

    if (p === "/api/clipboard") {
      if (req.method === "GET") return send(res, 200, { text: (await clipboardGet()).replace(/\r?\n$/, "") });
      if (req.method === "POST") {
        const { text } = await body(req);
        await clipboardSet(String(text || "").slice(0, 20000));
        return send(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && p === "/api/custom") {
      const { id } = await body(req);
      const c = config.customCommands.find((x) => x.id === id);
      if (!c) return send(res, 404, { error: "Команда не найдена" });
      console.log(new Date().toLocaleTimeString(), "→ своя команда:", c.label);
      send(res, 200, { ok: true });
      return setTimeout(() => run(c.cmd).catch((e) => console.error(c.label, e.message)), 100);
    }

    if (req.method === "POST" && p === "/api/timer") {
      const { action = "shutdown", minutes } = await body(req);
      if (!["shutdown", "sleep", "restart"].includes(action)) return send(res, 400, { error: "Неизвестное действие" });
      const m = Number(minutes);
      if (!(m > 0 && m <= 1440)) return send(res, 400, { error: "От 1 до 1440 минут" });
      setTimer(action, m); return send(res, 200, info());
    }
    if (req.method === "DELETE" && p === "/api/timer") { clearTimer(); return send(res, 200, info()); }

    if (req.method === "POST" && p === "/api/open") {
      const { url } = await body(req); openUrl(String(url || "")); return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "Не найдено" });
  } catch (e) { send(res, 500, { error: e.message }); }
});

// после обновления старый процесс ещё пару мгновений держит порт — подождём его
let listenTries = 0;
server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && listenTries++ < 30) return setTimeout(() => server.listen(PORT, "0.0.0.0"), 500);
  if (e.code === "EADDRINUSE") { console.error(`  Порт ${PORT} занят — похоже, пульт уже запущен.`); process.exit(0); }
  throw e;
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Пульт ноутбука запущен, версия ${PKG.version}.`);
  console.log("  Откройте на телефоне, затем «Поделиться» → «На экран Домой»:\n");
  for (const ip of localIPs()) console.log(`    http://${ip}:${PORT}/#${config.token}`);
  console.log(`\n  Экран: ${SCREEN.w}×${SCREEN.h}`);
  if (!INPUT_OK) console.log(`  Трекпад выключен: не найден ${INPUT_NEEDS}.`);
  console.log("\n  Токен, свои команды и настройки ночного режима — в config.json.\n");
});
