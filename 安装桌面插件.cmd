@echo off
where codex >nul 2>nul
if errorlevel 1 (
  echo The codex plugin command is required. See README.md.
  pause
  exit /b 1
)
call codex plugin marketplace add "%~dp0."
if errorlevel 1 (
  pause
  exit /b 1
)
call codex plugin add stylescout@stylescout
if errorlevel 1 (
  pause
  exit /b 1
)
echo Installation complete. Reopen your desktop client and start a new chat.
pause
