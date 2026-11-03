Unicode true
!include LogicLib.nsh
Name "probe"
RequestExecutionLevel user
SilentInstall silent
!echo "NSIS_MAX_STRLEN=${NSIS_MAX_STRLEN}"
!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000
Section
SectionEnd
