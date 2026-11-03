; A short string 128 bytes before the end of a committed page, then the old '*ptr(&wN .s)' read.
; If the old read copies N wide chars regardless of the terminator, this faults every time.
!include common.nsh
OutFile probe-page-old.exe
Function .onInit
  System::Call 'kernel32::VirtualAlloc(p 0, i 4096, i 0x3000, i 4)p.r3'
  IntOp $4 $3 + 3968
  System::Call 'kernel32::lstrcpyW(p r4, w "C:\Users\runneradmin\AppData\Local\Programs")'
  System::Call '*$4(&w${NSIS_MAX_STRLEN} .s)'
  Pop $5
FunctionEnd
