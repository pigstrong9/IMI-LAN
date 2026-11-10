@echo off
taskkill /IM go2rtc.exe /F >nul 2>nul
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 1985 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul
echo Background engine and QR login helper stopped.
timeout /t 2 >nul
