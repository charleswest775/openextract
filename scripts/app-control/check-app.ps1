# Starts the installed app and checks that, after $Seconds, it and the engine it started
# are both still running. In #169 the engine exited at startup and the app said "Python
# sidecar is not running". Run in PowerShell 7.
param(
  [Parameter(Mandatory)] [string] $App,
  [Parameter(Mandatory)] [string] $LogDir,
  [int] $Seconds = 45
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Where the app's sidecar writes the engine's stderr and exit code.
$log = Join-Path $env:APPDATA 'OpenExtract\python_log.txt'
Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue

try {
  $app = Start-Process -FilePath $App -PassThru
} catch {
  Write-Output "::error::The app didn't start: $($_.Exception.GetBaseException().Message)"
  exit 1
}
Start-Sleep -Seconds $Seconds

$failures = @()
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'OpenExtract.exe' OR Name = 'openextract-engine.exe'")
$processes | ForEach-Object { Write-Output ("  {0,-24} pid {1,-6} parent {2,-6} {3}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath) }
$appIds = @($processes | Where-Object Name -eq 'OpenExtract.exe' | ForEach-Object ProcessId)
$engineExe = Join-Path (Split-Path $App) 'resources\python\openextract-engine.exe'
$engines = @($processes | Where-Object { $_.ExecutablePath -eq $engineExe -and $_.ParentProcessId -in $appIds })
if ($app.HasExited) { $failures += "the app exited with code $($app.ExitCode)" }
if ($engines.Count -eq 0) { $failures += "the app's engine isn't running" }
$text = if (Test-Path $log) { Get-Content -Raw -LiteralPath $log } else { '' }
if ($text -match '\[EXIT\] code[^\r\n]*|\[ERROR STARTING\][^\r\n]*') { $failures += "the engine stopped: $($Matches[0])" }
Write-Output "App running: $(-not $app.HasExited); engines started by it: $($engines.Count)"

$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path $log) { Copy-Item -LiteralPath $log (Join-Path $LogDir 'app-python_log.txt') }

if ($failures) {
  $failures | ForEach-Object { Write-Output "::error::App: $_" }
  if ($text) { Write-Output "python_log.txt (last 40 lines):"; ($text -split "`r?`n" | Select-Object -Last 40) | ForEach-Object { Write-Output "  $_" } }
  exit 1
}
Write-Output "The app started and its engine is running"
