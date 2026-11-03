; The per-user fresh-install branch of app-builder-lib 26.8.1 templates/nsis/multiUser.nsh, verbatim.
!include common.nsh
OutFile probe-old.exe
Function .onInit
  StrCpy $0 "$LocalAppData\Programs"
  System::Store S
  System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
  ${If} $1 == 0
    System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
    StrCpy $0 $1
    System::Call 'OLE32::CoTaskMemFree(p r2)'
  ${endif}
  System::Store L
FunctionEnd
