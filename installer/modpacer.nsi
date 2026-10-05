; ModPacer -- Windows installer (NSIS), modeled on Vortex Collection Tools' installer.
;
; Built by release\build-installer.ps1, never by hand: that script passes every path in through the /D defines below, from the same staged
; package the zip is made from (so the zip and the installer can never differ).
;
; Required defines (all supplied by build-installer.ps1):
;   MP_VERSION    e.g. 1.0.0      shown in Windows' Apps list and on the pages
;   MP_STAGE_DIR  the staged package (release-staging), the tray program ModPacer.exe included
;   MP_OUTFILE    the .exe to write
;   MP_ICON       launcher\modpacer.ico (the installer, the uninstaller and the Apps entry all wear the logo)
;
; PER-USER, NO ADMINISTRATOR. ModPacer keeps its settings INSIDE its own folder (lib/data-dir.js: config.json, state.json, caches, logs), so the
; folder must be writable by the person: %LOCALAPPDATA%\Programs\ModPacer, never Program Files. Everything user-level goes to HKCU.
;
; LAYOUT: flat, like the zip: ModPacer.exe (the tray program) beside server.js, runtime\, lib\, web\, node_modules\, helper\, tools\.
;
; UPDATING: running a newer installer over an existing install closes the running ModPacer (only the ModPacer.exe that runs from THIS folder;
; its Node server is tied to it and ends with it; never "every node"), replaces the program files and leaves config.json, state.json, the caches and
; the logs alone.
;
; UNINSTALLING: removes the program, the shortcuts and the Start-with-Windows entry, then asks once whether to also delete the settings (default No).
;
; TESTING WITHOUT TOUCHING THE PC: /TESTROOT="<scratch folder>" (with /S) installs into <scratch>\install and SKIPS every write outside that folder:
; no Start Menu, no desktop, no registry, no Start-with-Windows entry. The uninstaller takes the same switch, plus /DELETESETTINGS to answer the
; question with Yes. See tests/test-installer.js. (The real shortcuts and the Apps entry cannot be tried that way.)

Unicode true

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!define MP_NAME "ModPacer"
!define MP_PUBLISHER "awesmdiver"
!define MP_EXE "ModPacer.exe"
!define MP_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ModPacer"
!define MP_RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${MP_NAME} ${MP_VERSION}"
OutFile "${MP_OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${MP_NAME}"
; An existing install wins over the default, so an update lands on top of the old copy instead of creating a second one.
InstallDirRegKey HKCU "${MP_REGKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUnInstDetails show

VIProductVersion "${MP_VERSION}.0"
VIAddVersionKey "ProductName" "${MP_NAME}"
VIAddVersionKey "CompanyName" "${MP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${MP_NAME} installer"
VIAddVersionKey "FileVersion" "${MP_VERSION}"
VIAddVersionKey "ProductVersion" "${MP_VERSION}"
VIAddVersionKey "LegalCopyright" "${MP_PUBLISHER}"

!define MUI_ICON "${MP_ICON}"
!define MUI_UNICON "${MP_ICON}"
!define MUI_ABORTWARNING

Var TESTROOT
Var OptStartMenu
Var OptDesktop
Var OptAutostart
Var ChkStartMenu
Var ChkDesktop
Var ChkAutostart

; ---- the words (the design side sends these through a Gemini pass afterwards) ----
!define MUI_WELCOMEPAGE_TITLE "${MP_NAME} ${MP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Welcome to ModPacer. It keeps your mods up to date and installs new ones, with Vortex or Mod Organizer 2."
; Short on purpose: with a "Launch" checkbox the finish page only has room for a few lines.
!define MUI_FINISHPAGE_TITLE "${MP_NAME} is installed"
!define MUI_FINISHPAGE_TEXT "You'll find it in your Start Menu and in the tray, by your clock."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch ModPacer now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchModPacer

!insertmacro MUI_PAGE_WELCOME
Page custom ExpectPageCreate
!insertmacro MUI_PAGE_DIRECTORY
Page custom OptionsPageCreate OptionsPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---- shared by the install and the uninstall: close a running ModPacer that runs from THIS folder ----
; Only that one program: the tray program ends its own hidden Node server with it (a Windows job object, KILL_ON_JOB_CLOSE), so no other node.exe on
; the PC is ever touched. Quiet on purpose (the "not running" case is the ordinary one).
!macro StopRunningApp
    DetailPrint "Closing ${MP_NAME} if it is running..."
    nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='${MP_EXE}'\" | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\${MP_EXE}' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
    ; Process end and file release are not the same instant, and the next thing is writing or deleting the files it held.
    Sleep 1500
!macroend

Function .onInit
    ${GetParameters} $R0
    ${GetOptions} $R0 "/TESTROOT=" $TESTROOT
    ${If} $TESTROOT != ""
        StrCpy $INSTDIR "$TESTROOT\install"
    ${EndIf}
    StrCpy $OptStartMenu ${BST_CHECKED}
    StrCpy $OptDesktop ${BST_UNCHECKED}
    StrCpy $OptAutostart ${BST_UNCHECKED}
FunctionEnd

Function un.onInit
    ${GetParameters} $R0
    ${GetOptions} $R0 "/TESTROOT=" $TESTROOT
FunctionEnd

; ---- page: what to expect ----
Function ExpectPageCreate
    !insertmacro MUI_HEADER_TEXT "What to expect" "A few things to know before you install."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 4u 100% 12u "1. ModPacer runs quietly in the tray, the small icons by your clock."
    Pop $0
    ${NSD_CreateLabel} 0 22u 100% 24u "2. It opens its page in your web browser. Double-click the tray icon any time to open it again."
    Pop $0
    ${NSD_CreateLabel} 0 52u 100% 24u "3. Everything it saves stays in its own folder. Uninstall it from Windows Settings whenever you like."
    Pop $0
    ${NSD_CreateLabel} 0 82u 100% 24u "4. If you use Vortex, the setup will show you how to add the Vortex Bridge extension."
    Pop $0
    nsDialogs::Show
FunctionEnd

; ---- page: options ----
Function OptionsPageCreate
    !insertmacro MUI_HEADER_TEXT "Options" "Choose what the installer sets up."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateCheckbox} 0 6u 100% 12u "Add a Start Menu shortcut"
    Pop $ChkStartMenu
    ${NSD_SetState} $ChkStartMenu $OptStartMenu
    ${NSD_CreateCheckbox} 0 26u 100% 12u "Add a desktop shortcut"
    Pop $ChkDesktop
    ${NSD_SetState} $ChkDesktop $OptDesktop
    ${NSD_CreateCheckbox} 0 46u 100% 12u "Start ModPacer when Windows starts"
    Pop $ChkAutostart
    ${NSD_SetState} $ChkAutostart $OptAutostart
    nsDialogs::Show
FunctionEnd

Function OptionsPageLeave
    ${NSD_GetState} $ChkStartMenu $OptStartMenu
    ${NSD_GetState} $ChkDesktop $OptDesktop
    ${NSD_GetState} $ChkAutostart $OptAutostart
FunctionEnd

Function LaunchModPacer
    ; ShellExecute from the installer's own (foreground) window, so the tray program is allowed to bring the browser to the front.
    ExecShell "open" "$INSTDIR\${MP_EXE}"
FunctionEnd

Section "Install"
    !insertmacro StopRunningApp

    SetOutPath "$INSTDIR"
    ; Program files only, replaced from scratch: an older version's leftovers must not linger. NEVER the data (config.json, state.json,
    ; vortex-info-cache.json, cache\, logs\, pending-updates\, ...): those are not in this list, and the staged package never holds them.
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\node_modules"
    RMDir /r "$INSTDIR\lib"
    RMDir /r "$INSTDIR\web"
    RMDir /r "$INSTDIR\tools"
    RMDir /r "$INSTDIR\helper"
    File /r /x ".release-staging" "${MP_STAGE_DIR}\*"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ${If} $TESTROOT == ""
        ${If} $OptStartMenu == ${BST_CHECKED}
            CreateDirectory "$SMPROGRAMS\${MP_NAME}"
            CreateShortcut "$SMPROGRAMS\${MP_NAME}\${MP_NAME}.lnk" "$INSTDIR\${MP_EXE}" "" "$INSTDIR\${MP_EXE}" 0
        ${EndIf}
        ${If} $OptDesktop == ${BST_CHECKED}
            CreateShortcut "$DESKTOP\${MP_NAME}.lnk" "$INSTDIR\${MP_EXE}" "" "$INSTDIR\${MP_EXE}" 0
        ${EndIf}
        ; The same switch as the tray menu's "Start with Windows" (the program's own Run entry, this person's only).
        ${If} $OptAutostart == ${BST_CHECKED}
            WriteRegStr HKCU "${MP_RUNKEY}" "${MP_NAME}" `"$INSTDIR\${MP_EXE}"`
        ${EndIf}
        ; Windows' Apps list. HKCU, matching the per-user install: no administrator, only this person's account.
        WriteRegStr HKCU "${MP_REGKEY}" "DisplayName" "${MP_NAME}"
        WriteRegStr HKCU "${MP_REGKEY}" "DisplayVersion" "${MP_VERSION}"
        WriteRegStr HKCU "${MP_REGKEY}" "Publisher" "${MP_PUBLISHER}"
        WriteRegStr HKCU "${MP_REGKEY}" "DisplayIcon" "$INSTDIR\${MP_EXE}"
        WriteRegStr HKCU "${MP_REGKEY}" "InstallLocation" "$INSTDIR"
        WriteRegStr HKCU "${MP_REGKEY}" "UninstallString" `"$INSTDIR\Uninstall.exe"`
        WriteRegStr HKCU "${MP_REGKEY}" "QuietUninstallString" `"$INSTDIR\Uninstall.exe" /S`
        WriteRegDWORD HKCU "${MP_REGKEY}" "NoModify" 1
        WriteRegDWORD HKCU "${MP_REGKEY}" "NoRepair" 1
        ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
        IntFmt $0 "0x%08X" $0
        WriteRegDWORD HKCU "${MP_REGKEY}" "EstimatedSize" "$0"
    ${EndIf}
SectionEnd

Section "Uninstall"
    ; Only ever remove a folder that really is one of our installs ($INSTDIR comes from where this uninstaller sits).
    ${IfNot} ${FileExists} "$INSTDIR\${MP_EXE}"
        MessageBox MB_ICONSTOP|MB_OK "This folder doesn't look like a ${MP_NAME} installation, so nothing was removed:$\r$\n$INSTDIR" /SD IDOK
        Abort
    ${EndIf}

    !insertmacro StopRunningApp

    ${If} $TESTROOT == ""
        Delete "$SMPROGRAMS\${MP_NAME}\${MP_NAME}.lnk"
        RMDir "$SMPROGRAMS\${MP_NAME}"
        Delete "$DESKTOP\${MP_NAME}.lnk"
        DeleteRegValue HKCU "${MP_RUNKEY}" "${MP_NAME}"
        DeleteRegKey HKCU "${MP_REGKEY}"
    ${EndIf}

    ; Ask once. Silent runs say No unless /DELETESETTINGS is given.
    StrCpy $R1 "no"
    ${GetParameters} $R0
    ${GetOptions} $R0 "/DELETESETTINGS" $R2
    ${IfNot} ${Errors}
        StrCpy $R1 "yes"
    ${Else}
        ClearErrors
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your ModPacer settings?" /SD IDNO IDNO +2
        StrCpy $R1 "yes"
    ${EndIf}

    ; The program itself: named folders and files, so the settings (config.json, state.json, caches, logs) are not in the way.
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\node_modules"
    RMDir /r "$INSTDIR\lib"
    RMDir /r "$INSTDIR\web"
    RMDir /r "$INSTDIR\tools"
    RMDir /r "$INSTDIR\helper"
    Delete "$INSTDIR\${MP_EXE}"
    Delete "$INSTDIR\modpacer.ico"
    Delete "$INSTDIR\server.js"
    Delete "$INSTDIR\start.bat"
    Delete "$INSTDIR\package.json"
    Delete "$INSTDIR\package-lock.json"
    Delete "$INSTDIR\README.md"
    Delete "$INSTDIR\HELP.md"
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\THIRD-PARTY-NOTICES.md"
    Delete "$INSTDIR\Uninstall.exe"

    ${If} $R1 == "yes"
        RMDir /r "$INSTDIR"
    ${Else}
        RMDir "$INSTDIR" ; only succeeds when nothing of the settings is left in it
    ${EndIf}
SectionEnd
