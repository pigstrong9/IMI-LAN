; IMI-LAN Windows 安装包脚本（NSIS 3.x，Unicode）
; 产物：IMI-LAN-Setup-<版本>-win-x64.exe（按用户安装，不需要管理员权限）
;
; 构建方法（在仓库根目录执行）：
;   1. 先用 `npm run pack:portable`（desktop/ 下）生成便携版目录，
;      并按 README 补齐 go2rtc.exe、web、qr-login.js、防火墙 bat，
;      生成空白 go2rtc.yaml 的模板 go2rtc.yaml.example 会从仓库根目录读取；
;   2. 然后：
;      makensis /DVERSION=1.0.1 desktop\installer.nsi
;      （SRC/DEST 相对 desktop/ 目录解析，也可用绝对路径覆盖）
;
; 注意：按许可证要求，包内不带 GPL 构建的 bin/ffmpeg.exe；Electron 的
; LICENSE 与 LICENSES.chromium.html 必须随包分发（在 SRC 里已包含）。

Unicode true
ManifestDPIAware true

!define PRODUCT "IMI-LAN"
!ifndef VERSION
  !define VERSION "1.0.1"
!endif
!ifndef SRC
  !define SRC "dist\IMI-LAN-win32-x64"
!endif
!ifndef DEST
  !define DEST "..\.tmp-release"
!endif

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} 安装程序"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "LegalCopyright" "MIT License"
VIAddVersionKey "OriginalFilename" "IMI-LAN-Setup-${VERSION}-win-x64.exe"

Name "${PRODUCT} ${VERSION}"
OutFile "${DEST}\IMI-LAN-Setup-${VERSION}-win-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\IMI-LAN"
InstallDirRegKey HKCU "Software\${PRODUCT}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"

  ; 主程序与随包资源（Electron 运行时、go2rtc.exe、web、qr-login.js、防火墙 bat 等）
  File /r "${SRC}\*.*"

  ; 首次安装生成空白 go2rtc.yaml（升级时保留用户已有的令牌与摄像头配置）
  File "..\go2rtc.yaml.example"
  IfFileExists "$INSTDIR\go2rtc.yaml" +2 0
    CopyFiles /SILENT "$INSTDIR\go2rtc.yaml.example" "$INSTDIR\go2rtc.yaml"

  ; 桌面快捷方式「米家监控」
  CreateShortcut "$DESKTOP\米家监控.lnk" "$INSTDIR\IMI-LAN.exe"

  ; 卸载信息（按用户）
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${PRODUCT}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "Publisher" "pigstrong9"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "URLInfoAbout" "https://github.com/pigstrong9/IMI-LAN"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "DisplayIcon" "$INSTDIR\IMI-LAN.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "NoRepair" 1
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}" \
    "UninstallString" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; README 约定：卸载会一并删除配置（go2rtc.yaml 含令牌）与日志
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\米家监控.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
  DeleteRegKey HKCU "Software\${PRODUCT}"
SectionEnd
