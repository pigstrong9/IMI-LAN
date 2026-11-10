@echo off
setlocal

rem Request administrator rights
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

rem Desktop app uses its own rule name so it does not overwrite the browser rule
netsh advfirewall firewall delete rule name="IMI LAN go2rtc app" >nul 2>&1
netsh advfirewall firewall add rule name="IMI LAN go2rtc app" dir=in action=allow program="%~dp0go2rtc.exe" enable=yes profile=any remoteip=localsubnet

if errorlevel 1 (
  echo.
  echo Failed. Right-click this file and choose "Run as administrator".
) else (
  echo.
  echo Rule added for:
  echo   %~dp0go2rtc.exe
  echo Now use the tray icon and choose "Restart engine".
)

echo.
pause
