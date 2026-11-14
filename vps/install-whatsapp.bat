@echo off
cd /d "%~dp0"
echo Installing the WhatsApp add-on. This needs internet and takes a minute.
call npm install @whiskeysockets/baileys --no-audit --no-fund
echo.
echo Done. Close the Kanairy window and start it again.
pause
