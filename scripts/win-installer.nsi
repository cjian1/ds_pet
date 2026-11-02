; ds_pet 的 Windows 安装程序（NSIS 3）。由 scripts/build-win.mjs 调 makensis 生成，下面这些都从命令行传进来：
;   VERSION         版本号（1.3.0）
;   ARCH            x64 | arm64
;   SRC_DIR         组装好的 ds_pet 文件夹（里面是 ds_pet.exe 和 Electron 的其它文件）
;   OUT_FILE        生成的安装程序
;   ICON            安装 / 卸载程序的图标（desktop/resources/icon.ico）
;   WELCOME_BMP     欢迎页、完成页左边的竖图（scripts/win-installer-welcome.bmp）
;   APP_ID          应用 ID（= updater.js 的 BUNDLE_ID，也是注册表里登录项的值名）
;   UNINSTALLER     卸载程序的文件名（= updater.js 的 WIN_UNINSTALLER：有它就是安装版，可以一键更新）
;   UNINSTALL_LIST  build-win.mjs 生成的「装了哪些文件」清单（卸载时只删这些，不碰文件夹里别的东西）
;
; 只装给当前用户（%LOCALAPPDATA%\Programs\ds_pet），不要管理员权限。
; 一键更新时由 desktop/main/updater.js 用 /S /D=<原来的文件夹> 静默运行。
; ds_pet 基于 PC2005-cloud/dsh-pet（MIT）二次创作，欢迎页上写明出处。

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define APP_NAME "ds_pet"
!define APP_EXE "ds_pet.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${UNINST_KEY}" "InstallLocation"
BrandingText "${APP_NAME} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

; ---------------------------------------------------------------- 界面
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${WELCOME_BMP}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${WELCOME_BMP}"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "$(FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(FinishText)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(RunNow)"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(DesktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 没有弹窗选语言：系统是中文就用中文，别的用英文
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

LangString WelcomeTitle ${LANG_ENGLISH} "Welcome to ds_pet ${VERSION}"
LangString WelcomeTitle ${LANG_SIMPCHINESE} "欢迎安装 ds_pet ${VERSION}"
LangString WelcomeText ${LANG_ENGLISH} "A little blue-haired maid who lives on your desktop: drag her, fling her, poke her, and chat with her using the AI service you choose.$\r$\n$\r$\nds_pet is a remix of dsh-pet by PC2005-cloud (MIT license). The character, animations, artwork and physics all come from the original project:$\r$\nhttps://github.com/PC2005-cloud/dsh-pet$\r$\n$\r$\nIt is installed just for you, no administrator rights needed. Click Next to continue."
LangString WelcomeText ${LANG_SIMPCHINESE} "住在你桌面上的蓝毛小女仆：能拖、能甩、会碎碎念，还能接上你选的 AI 服务陪你聊天。$\r$\n$\r$\nds_pet 基于 PC2005-cloud 的开源项目 dsh-pet（MIT 协议）二次创作，角色、动画、美术与物理均来自原项目：$\r$\nhttps://github.com/PC2005-cloud/dsh-pet$\r$\n$\r$\n只装给当前用户，不需要管理员权限。点「下一步」继续。"
LangString FinishTitle ${LANG_ENGLISH} "ds_pet is installed"
LangString FinishTitle ${LANG_SIMPCHINESE} "ds_pet 装好啦"
LangString FinishText ${LANG_ENGLISH} "She will show up in the bottom-right corner of your desktop, and a little whale appears in the taskbar corner (click ^ if it is tucked away).$\r$\n$\r$\nThe first time, Settings opens so you can pick an AI provider and add an API key."
LangString FinishText ${LANG_SIMPCHINESE} "她会出现在桌面右下角，任务栏右下角多一个小鲸鱼图标（找不到就点「^」展开）。$\r$\n$\r$\n第一次打开会弹出设置窗口：选一家 AI 服务、填上 API Key 就能聊天。"
LangString RunNow ${LANG_ENGLISH} "Open ds_pet now"
LangString RunNow ${LANG_SIMPCHINESE} "现在打开 ds_pet"
LangString DesktopShortcut ${LANG_ENGLISH} "Create a desktop shortcut"
LangString DesktopShortcut ${LANG_SIMPCHINESE} "在桌面上创建快捷方式"
LangString AppRunning ${LANG_ENGLISH} "ds_pet is running. Click OK to close it and continue."
LangString AppRunning ${LANG_SIMPCHINESE} "ds_pet 正在运行。点「确定」关掉它并继续。"
LangString NeedArm64 ${LANG_ENGLISH} "This installer is for Windows on ARM. Please download ds_pet-${VERSION}-win-x64-setup.exe instead."
LangString NeedArm64 ${LANG_SIMPCHINESE} "这个安装程序是给 ARM 版 Windows 用的，请改下载 ds_pet-${VERSION}-win-x64-setup.exe。"
LangString Need64 ${LANG_ENGLISH} "ds_pet needs 64-bit Windows 10 or later."
LangString Need64 ${LANG_SIMPCHINESE} "ds_pet 需要 64 位的 Windows 10 或更新版本。"
LangString RemoveData ${LANG_ENGLISH} "Also delete your settings and chat history?$\r$\n($APPDATA\${APP_NAME})"
LangString RemoveData ${LANG_SIMPCHINESE} "要把设置和聊天记录也一起删掉吗？$\r$\n（$APPDATA\${APP_NAME}）"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "CompanyName" "ds_pet contributors"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "MIT License. A remix of PC2005-cloud/dsh-pet (MIT)"

; ---------------------------------------------------------------- 正在运行就先关掉
; 先礼貌地叫她退出（ds_pet.exe --quit 走单实例通道，见 desktop/main/index.js），等最多 5 秒，还在就强制结束。
; cmd /S /C ""…""：整条命令外面再包一层引号，cmd 只剥掉这一层（不然它会剥掉第一个和最后一个引号，命令就坏了）
!macro IsRunning
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /S /C ""$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq ${APP_EXE}" | "$SYSDIR\find.exe" /I "${APP_EXE}""'
  Pop $0 ; 0 = 找到了
  Pop $1
!macroend

!macro CloseRunningApp
  !insertmacro IsRunning
  ${If} $0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "$(AppRunning)" IDOK +2
      Quit
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\${APP_EXE}"
      ExecWait '"$INSTDIR\${APP_EXE}" --quit'
    ${EndIf}
    StrCpy $2 0
    ${Do}
      Sleep 250
      !insertmacro IsRunning
      IntOp $2 $2 + 1
      ${If} $2 >= 20
        ${ExitDo}
      ${EndIf}
    ${LoopWhile} $0 == 0
    ${If} $0 == 0
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM ${APP_EXE}'
      Sleep 500
    ${EndIf}
  ${EndIf}
!macroend

; ---------------------------------------------------------------- 安装
Function .onInit
  !if "${ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_ICONSTOP "$(NeedArm64)" /SD IDOK
      Abort
    ${EndIf}
  !else
    ${IfNot} ${RunningX64}
      MessageBox MB_ICONSTOP "$(Need64)" /SD IDOK
      Abort
    ${EndIf}
  !endif
FunctionEnd

Function CreateDesktopShortcut
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
FunctionEnd

Section "Install"
  !insertmacro CloseRunningApp
  ; 覆盖安装：先清掉上一版的 Electron 和应用文件（新版本可能删了一些文件）。只在这里确实是 ds_pet 时才清。
  ${If} ${FileExists} "$INSTDIR\${APP_EXE}"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "ds_pet contributors"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://github.com/cjian1/ds_pet"
  WriteRegStr HKCU "${UNINST_KEY}" "HelpLink" "https://github.com/cjian1/ds_pet"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

; ---------------------------------------------------------------- 卸载
Section "Uninstall"
  !insertmacro CloseRunningApp
  ; 只删安装时放进来的文件（清单由打包脚本生成），文件夹空了才删
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; 「登录时自动打开」写的启动项（Electron 用应用 ID 当值名）
  DeleteRegValue HKCU "${RUN_KEY}" "${APP_ID}"
  DeleteRegValue HKCU "${STARTUP_APPROVED_KEY}" "${APP_ID}"
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(RemoveData)" IDNO +2
    RMDir /r "$APPDATA\${APP_NAME}"
  ${EndIf}
SectionEnd
