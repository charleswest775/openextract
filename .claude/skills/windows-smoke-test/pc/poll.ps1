# Prints a smoke run's log lines after the first -Skip, then "::done:: <0|1>" once it has
# finished, or "::stopped::" if its scheduled task ended without finishing.
param([Parameter(Mandatory)] [string] $RunDir, [int] $Skip = 0)
$log = Join-Path $RunDir 'out\log.txt'
if (Test-Path $log) { Get-Content $log -Encoding utf8 | Select-Object -Skip $Skip }
$done = Join-Path $RunDir 'out\done.txt'
if (Test-Path $done) { "::done:: $((Get-Content $done -Raw).Trim())" }
elseif ((Get-ScheduledTask -TaskName OE-Smoke -ErrorAction SilentlyContinue).State -ne 'Running') { '::stopped::' }
