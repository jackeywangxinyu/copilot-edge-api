@echo off
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required.
  pause
  exit /b 1
)
set "NPM_ROOT="
for /f "delims=" %%i in ('npm.cmd root -g') do set "NPM_ROOT=%%i"
if not exist "%NPM_ROOT%\playwright\cli.js" (
  echo Installing Playwright CLI globally. This runs only once.
  call npm.cmd install -g playwright@1.62.1 --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.mjs
pause
