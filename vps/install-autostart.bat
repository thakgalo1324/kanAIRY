@echo off
rem Makes Kanairy start by itself when the VPS boots, and keep running when you close Remote Desktop.
net session >nul 2>&1 || (echo Right-click this file and choose "Run as administrator". & pause & exit /b 1)
schtasks /create /tn "Kanairy" /tr "\"%~dp0start-kanairy.bat\"" /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn "Kanairy"
echo.
echo Done. Kanairy now runs in the background. You no longer need to keep its window open.
pause
