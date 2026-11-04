@echo off
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or later is required.
  pause
  exit /b 1
)
if not exist node_modules\playwright\cli.js (
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.mjs
pause
