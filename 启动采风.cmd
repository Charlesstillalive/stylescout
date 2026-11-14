@echo off
node "%~dp0plugins\stylescout\server\lib\standalone.mjs" --open
if errorlevel 1 pause
