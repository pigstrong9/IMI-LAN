@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "URL=http://127.0.0.1:1984/?t=%RANDOM%"

rem 如果 go2rtc 没在运行，就在后台启动它
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (-not (Get-NetTCPConnection -LocalPort 1984 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath '%~dp0go2rtc.exe' -ArgumentList '-config','%~dp0go2rtc.yaml' -WorkingDirectory '%~dp0' -WindowStyle Hidden }"

rem 启动二维码登录助手（使用桌面版自带 Node；没有桌面版时用本机 node）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (-not (Get-NetTCPConnection -LocalPort 1985 -State Listen -ErrorAction SilentlyContinue)) { $runner = '%~dp0desktop\dist\IMI-LAN-win32-x64\IMI-LAN.exe'; if (-not (Test-Path $runner)) { $runner = '%~dp0desktop\node_modules\electron\dist\electron.exe' }; if (Test-Path $runner) { $env:ELECTRON_RUN_AS_NODE = '1'; Start-Process -FilePath $runner -ArgumentList ('\"%~dp0qr-login.js\"') -WorkingDirectory '%~dp0' -WindowStyle Hidden } else { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source; if ($node) { Start-Process -FilePath $node -ArgumentList ('\"%~dp0qr-login.js\"') -WorkingDirectory '%~dp0' -WindowStyle Hidden } } }"

rem 等待引擎就绪（最多约 8 秒）
for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',1984); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto ready
  ping -n 2 127.0.0.1 >nul
)

:ready
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --window-size=1440,900
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1440,900
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --window-size=1440,900
) else (
  start "" %URL%
)

endlocal
