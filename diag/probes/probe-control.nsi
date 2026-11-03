; SHGetKnownFolderPath and CoTaskMemFree only, no copy.
!include common.nsh
OutFile probe-control.exe
Function .onInit
  System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
  ${If} $1 == 0
    System::Call 'OLE32::CoTaskMemFree(p r2)'
  ${endif}
FunctionEnd
