Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Icon "${ICON_PATH}"
UninstallIcon "${ICON_PATH}"
Name "CoreWaste"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\CoreWaste"
RequestExecutionLevel user
SetCompressor /SOLID zlib
CRCCheck on
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "CoreWaste"
VIAddVersionKey /LANG=1033 "FileDescription" "CoreWaste Firebase Client Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "CoreWaste"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Installs the CoreWaste Windows client for your account. No Docker or administrator access is required.$\r$\n$\r$\nInternet access and activated Firebase/API/database services are needed to sign in. Cloud activation is pending for this development build."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE CheckDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\CoreWaste.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "InstallLocation"
  StrCmp $0 "" no_previous
    MessageBox MB_ICONSTOP "Uninstall the previous CoreWaste installation before installing this version. Your saved account settings will be preserved."
    Abort
  no_previous:
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "CoreWaste requires 64-bit Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "CoreWaste requires Windows 10 or later."
    Abort
  ${EndIf}
FunctionEnd
Function CheckDirectory
  ; Refuse to overwrite a prior install or another application's files.
  FindFirst $0 $1 "$INSTDIR\*.*"
  loop:
    StrCmp $1 "" clear
    StrCmp $1 "." next
    StrCmp $1 ".." next
    FindClose $0
    MessageBox MB_ICONSTOP "Choose an empty CoreWaste folder. Uninstall an existing CoreWaste installation first. Your saved account settings will be preserved."
    Abort
  next:
    FindNext $0 $1
    Goto loop
  clear:
    FindClose $0
FunctionEnd
Section "CoreWaste" Main
  ; Also enforce the directory check for silent installations.
  Call CheckDirectory
  !include "${BUILD_DIR}/payload-install.nsh"
  SetOutPath "$INSTDIR"
  File /oname=START-HERE.txt "${BUILD_DIR}/START-HERE.txt"
  FileOpen $0 "$INSTDIR\.corewaste-install" w
  FileWrite $0 "CoreWaste:com.corewaste.office:${VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\CoreWaste"
  CreateShortcut "$SMPROGRAMS\CoreWaste\CoreWaste.lnk" "$INSTDIR\CoreWaste.exe" "" "$INSTDIR\corewaste.ico" 0
  CreateShortcut "$SMPROGRAMS\CoreWaste\Uninstall CoreWaste.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "DisplayName" "CoreWaste (Firebase Client)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "Publisher" "CoreWaste"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "DisplayIcon" "$INSTDIR\corewaste.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste" "NoRepair" 1
SectionEnd
Function un.onInit
  SetShellVarContext current
  FileOpen $0 "$INSTDIR\.corewaste-install" r
  IfErrors invalid
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "CoreWaste:com.corewaste.office:${VERSION}" valid invalid
  invalid:
    MessageBox MB_ICONSTOP "CoreWaste installation marker is missing or does not match. No files were removed."
    Abort
  valid:
    ClearErrors
    FileOpen $0 "$INSTDIR\CoreWaste.exe" a
    IfErrors running
    FileClose $0
    Return
  running:
    MessageBox MB_ICONSTOP "Close CoreWaste before uninstalling. No files were removed."
    Abort
FunctionEnd
Section "Uninstall"
  ; Delete only known installed files. Never recursively delete a user-selected folder.
  !include "${BUILD_DIR}/payload-uninstall.nsh"
  Delete "$INSTDIR\START-HERE.txt"
  Delete "$INSTDIR\.corewaste-install"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\CoreWaste\CoreWaste.lnk"
  Delete "$SMPROGRAMS\CoreWaste\Uninstall CoreWaste.lnk"
  RMDir "$SMPROGRAMS\CoreWaste"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CoreWaste"
  ; AppData settings and all cloud/customer records are deliberately preserved.
SectionEnd
