@echo off
setlocal

rem Request administrator rights
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

netsh advfirewall firewall delete rule name="IMI LAN go2rtc camera" >nul 2>&1
netsh advfirewall firewall add rule name="IMI LAN go2rtc camera" dir=in action=allow program="%~dp0go2rtc.exe" enable=yes profile=any remoteip=localsubnet

if errorlevel 1 (
  echo.
  echo Failed. Right-click this file and choose "Run as administrator".
) else (
  echo.
  echo Rule added for:
  echo   %~dp0go2rtc.exe
  echo You can close this window now.
)

echo.
pause
