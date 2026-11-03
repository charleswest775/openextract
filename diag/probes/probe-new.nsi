; The same branch as app-builder-lib 26.18.1 has it (bounded lstrcpynW copy).
!include common.nsh
OutFile probe-new.exe
Function .onInit
  StrCpy $0 "$LocalAppData\Programs"
  Push $1
  Push $2
  StrCpy $2 0
  System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
  ${If} $1 == 0
    System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
  ${endif}
  ${If} $2 != 0
    System::Call 'OLE32::CoTaskMemFree(p r2)'
  ${endif}
  Pop $2
  Pop $1
FunctionEnd
