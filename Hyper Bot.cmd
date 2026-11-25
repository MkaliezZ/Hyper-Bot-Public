@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\path.txt" (
  echo Hyper Bot dependencies need to be installed with npm ci.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run desktop
if errorlevel 1 pause

