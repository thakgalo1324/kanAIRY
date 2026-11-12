@echo off
title Kanairy server
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto nonode

netsh advfirewall firewall show rule name="Kanairy-app" >nul 2>&1
if errorlevel 1 (
  echo Opening port 8766 in Windows Firewall. Tap Yes if Windows asks.
  powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=Kanairy-app dir=in action=allow protocol=TCP localport=8766'"
)

:loop
node gateway.js
echo.
echo Kanairy server stopped. Restarting in 5 seconds. Close this window to quit.
timeout /t 5 >nul
goto loop

:nonode
echo Node.js is not installed yet.
where winget >nul 2>&1
if errorlevel 1 goto manual
echo Installing Node.js. Please wait...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
echo.
echo Done. Close this window, then double-click start-kanairy again.
pause
exit /b

:manual
echo Install Node.js LTS from https://nodejs.org then double-click start-kanairy again.
pause
exit /b
