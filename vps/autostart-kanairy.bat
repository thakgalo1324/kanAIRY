@echo off
rem Run this ONCE, as Administrator (right-click > Run as administrator).
rem It makes Kanairy server start by itself every time you sign in to this VPS.
cd /d "%~dp0"
schtasks /Create /TN "Kanairy server" /TR "\"%~dp0start-kanairy.bat\"" /SC ONLOGON /RL HIGHEST /F
if errorlevel 1 (echo Could not create the task. Right-click this file and choose Run as administrator.) else (echo Done. Kanairy server will now start whenever you sign in.)
pause
