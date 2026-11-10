@echo off
chcp 65001 >nul
taskkill /IM go2rtc.exe /F >nul 2>nul
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 1985 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul
echo 已停止后台监控引擎和二维码登录助手。
timeout /t 2 >nul
