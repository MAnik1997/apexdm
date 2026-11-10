@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\electron\package.json" (
  echo First launch installs the ApexDM runtime. This can take a few minutes.
  call npm install
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
