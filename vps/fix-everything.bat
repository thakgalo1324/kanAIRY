@echo off
title Kanairy fix everything
cd /d "%~dp0"
rem Needs Administrator (to open the firewall and save MT5 settings). Ask for it if missing.
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for Administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is missing. Run start-kanairy.bat first, it installs it.
  pause
  exit /b
)
node doctor.js --fix
echo.
echo Report saved in data\doctor-report.txt
echo If it says Kanairy server is NOT running, double-click start-kanairy.bat and run this again.
pause
