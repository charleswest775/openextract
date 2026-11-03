; The same page-end string, read with the bounded lstrcpynW copy.
!include common.nsh
OutFile probe-page-new.exe
Function .onInit
  System::Call 'kernel32::VirtualAlloc(p 0, i 4096, i 0x3000, i 4)p.r3'
  IntOp $4 $3 + 3968
  System::Call 'kernel32::lstrcpyW(p r4, w "C:\Users\runneradmin\AppData\Local\Programs")'
  System::Call 'KERNEL32::lstrcpynW(w .r5, p r4, i ${NSIS_MAX_STRLEN})p'
FunctionEnd
