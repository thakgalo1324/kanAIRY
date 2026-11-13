@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-other-mt5.ps1"
echo.
pause
