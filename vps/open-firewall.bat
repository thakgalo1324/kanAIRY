@echo off
rem Run as Administrator. Opens the Kanairy app port (8766) in Windows Firewall.
netsh advfirewall firewall add rule name="Kanairy app" dir=in action=allow protocol=TCP localport=8766
echo.
echo Done. If your VPS provider has its own firewall (security group), open TCP 8766 there too.
pause
