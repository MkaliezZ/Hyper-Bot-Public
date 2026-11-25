@echo off
setlocal
if not exist "%~dp0resources\node\node.exe" (
  echo Open this file from the extracted Hyper Bot test package.
  exit /b 1
)
"%~dp0resources\node\node.exe" "%~dp0resources\app\scripts\workspace.mjs" %*

