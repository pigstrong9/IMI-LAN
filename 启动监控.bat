@echo off
setlocal
cd /d "%~dp0"

set "PROJECT=%~dp0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"

rem One runtime for both launch methods: portable build first, project root fallback.
set "USING_PORTABLE=1"
set "RUNTIME=%PROJECT%\desktop\dist\IMI-LAN-win32-x64"
if not exist "%RUNTIME%\go2rtc.exe" set "USING_PORTABLE=0"
if not exist "%RUNTIME%\go2rtc.yaml" set "USING_PORTABLE=0"
if not exist "%RUNTIME%\qr-login.js" set "USING_PORTABLE=0"
if "%USING_PORTABLE%"=="0" set "RUNTIME=%PROJECT%"

set "ENGINE=%RUNTIME%\go2rtc.exe"
set "CONFIG=%RUNTIME%\go2rtc.yaml"
set "HELPER=%RUNTIME%\qr-login.js"

rem Keep the portable UI/helper equal to the source tree.
if "%USING_PORTABLE%"=="1" (
  if exist "%PROJECT%\web" xcopy /E /I /Y "%PROJECT%\web" "%RUNTIME%\web" >nul
  if exist "%PROJECT%\qr-login.js" copy /Y "%PROJECT%\qr-login.js" "%RUNTIME%\qr-login.js" >nul
)

set "URL=http://127.0.0.1:1984/?t=%RANDOM%"

rem Start the shared go2rtc engine.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (-not (Get-NetTCPConnection -LocalPort 1984 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -FilePath '%ENGINE%' -ArgumentList '-config','%CONFIG%' -WorkingDirectory '%RUNTIME%' -WindowStyle Hidden }"

rem Start the shared QR helper from the same runtime.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (-not (Get-NetTCPConnection -LocalPort 1985 -State Listen -ErrorAction SilentlyContinue)) { $runner = '%RUNTIME%\IMI-LAN.exe'; if (-not (Test-Path $runner)) { $runner = '%PROJECT%\desktop\node_modules\electron\dist\electron.exe' }; if (Test-Path $runner) { $env:ELECTRON_RUN_AS_NODE = '1'; Start-Process -FilePath $runner -ArgumentList ('\"%HELPER%\"') -WorkingDirectory '%RUNTIME%' -WindowStyle Hidden } else { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source; if ($node) { Start-Process -FilePath $node -ArgumentList ('\"%HELPER%\"') -WorkingDirectory '%RUNTIME%' -WindowStyle Hidden } } }"

rem Wait until the engine accepts connections, about 8 seconds max.
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
