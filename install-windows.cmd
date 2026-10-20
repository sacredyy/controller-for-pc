@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Установка пульта ноутбука
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js не найден, ставлю его через winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo   Не получилось поставить Node.js. Скачайте его с nodejs.org и запустите этот файл ещё раз.
  pause
  exit /b 1
)
node install.js
echo   Если Windows спросит про брандмауэр - разрешите доступ в частных сетях.
pause
