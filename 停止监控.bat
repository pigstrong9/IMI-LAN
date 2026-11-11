@echo off
taskkill /IM go2rtc.exe /F >nul 2>nul
rem 19841 = current helper, 1985 = legacy helper (stop both so they don't fight over go2rtc.yaml)
powershell -NoProfile -Command "foreach ($p in 1985,19841) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>nul
echo Background engine and QR login helper stopped.
timeout /t 2 >nul
