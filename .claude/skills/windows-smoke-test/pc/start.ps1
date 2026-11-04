# Starts run.ps1 for one smoke run and returns. Over SSH, Windows runs commands in a
# session of their own with the account's full (elevated) token; the installed app runs
# in the signed-in user's desktop with a standard token. So run.ps1 runs as a scheduled
# task with an Interactive, Limited principal for whoever is signed in at the console:
# its windows (the app's) appear on that screen.
#
#   start.ps1 -RunDir <home>\oe-smoke\runs\<run> [-Options SkipTests,RequireDevice,...] [-Release vX.Y.Z]
param(
  [Parameter(Mandatory)] [string] $RunDir,
  # run.ps1's switches, without the dash and comma-separated: SkipTests, SkipApp,
  # RequireDevice, StartBackup, FreshAppleDevices (-File passes one string, not a list)
  [string] $Options = '',
  [string] $Release = ''
)
$ErrorActionPreference = 'Stop'
$task = 'OE-Smoke'

$existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') { throw "Another smoke run is still going (scheduled task $task)" }
$user = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $user) { throw 'Nobody is signed in at the PC, so there is no desktop to run the app in' }

$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$RunDir\run.ps1`" -RunDir `"$RunDir`""
foreach ($option in $Options -split ',' | Where-Object { $_ }) {
  if ($option -notin 'SkipTests', 'SkipApp', 'RequireDevice', 'StartBackup', 'FreshAppleDevices') { throw "Unknown option $option" }
  $arguments += " -$option"
}
if ($Release) { $arguments += " -Release $Release" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $task
for ($i = 0; $i -lt 20 -and (Get-ScheduledTask -TaskName $task).State -ne 'Running' -and -not (Test-Path "$RunDir\out\done.txt"); $i++) {
  Start-Sleep -Milliseconds 500
}
"Started run.ps1 as $user (standard token, console session): scheduled task $task"
