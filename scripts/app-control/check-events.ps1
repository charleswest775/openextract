# Fails on any App Control block (event 3077, or 3076 if the policy is ever switched to
# audit mode) since $Since of a file loaded by the app or the engine, or of a file in the
# install folder or a one-file engine's %TEMP%\_MEI folder, whichever process loaded it.
# Blocks of anything else on the runner are listed but don't count, except $Canary: the
# workflow loads that unsigned DLL on purpose, and if its block isn't found here, this
# check can't see blocks at all.
param(
  [Parameter(Mandatory)] [datetime] $Since,
  [Parameter(Mandatory)] [string] $Canary,
  [Parameter(Mandatory)] [string] $LogDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$events = @(Get-WinEvent -FilterHashtable @{
    LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; Id = 3033, 3034, 3076, 3077; StartTime = $Since
  } -ErrorAction SilentlyContinue | ForEach-Object {
    $data = @{}
    foreach ($d in ([xml]$_.ToXml()).Event.EventData.Data) { $data[$d.Name] = $d.'#text' }
    # 3076/3077 name their fields "File Name" and "Process Name"; 3033/3034 use *Buffer.
    [pscustomobject]@{
      Time = $_.TimeCreated.ToString('HH:mm:ss'); Id = $_.Id
      Process = "$(if ($data['Process Name']) { $data['Process Name'] } else { $data['ProcessNameBuffer'] })"
      File = "$(if ($data['File Name']) { $data['File Name'] } else { $data['FileNameBuffer'] })"
      Policy = "$($data['PolicyName'])"
      Fields = ($data.Keys | Sort-Object) -join ', '
    }
  })
$events | Export-Csv -NoTypeInformation -LiteralPath (Join-Path $LogDir 'codeintegrity-events.csv')

# An event we can't read counts against us rather than being skipped.
$ours = { param($e)
  -not $e.File -or
  [IO.Path]::GetFileName($e.Process) -in 'OpenExtract.exe', 'openextract-engine.exe' -or
  $e.File -match '\\Programs\\OpenExtract\\|\\_MEI\d+\\' }
$relevant = @($events | Where-Object { & $ours $_ })
$other = @($events | Where-Object { -not (& $ours $_) })
$canaryName = Split-Path -Leaf $Canary
$canarySeen = @($other | Where-Object { $_.File.EndsWith("\$canaryName", 'OrdinalIgnoreCase') }).Count -gt 0

Write-Output "$($events.Count) CodeIntegrity block/audit event(s) since $($Since.ToString('HH:mm:ss')), $($relevant.Count) for OpenExtract"
foreach ($e in $other) { Write-Output "  not OpenExtract: $($e.Id) $($e.Process) loading $($e.File)" }
foreach ($e in $relevant) {
  $verb = if ($e.Id -in 3076, 3034) { 'would block' } else { 'blocked' }
  $what = if ($e.File) { $e.File } else { "a file (event $($e.Id) has no file name; its fields are $($e.Fields))" }
  Write-Output "::error::App Control $verb $what (loaded by $([IO.Path]::GetFileName($e.Process)), event $($e.Id))"
}
if (-not $canarySeen) {
  Write-Output "::error::No block was logged for the canary $canaryName, so this check can't see App Control blocks"
}

if ($relevant.Count -gt 0) {
  $summary = "### Blocked by App Control`n`n| Event | Loaded by | File |`n|---|---|---|`n"
  $relevant | ForEach-Object { $summary += "| $($_.Id) | $([IO.Path]::GetFileName($_.Process)) | $($_.File) |`n" }
  if ($env:GITHUB_STEP_SUMMARY) { $summary >> $env:GITHUB_STEP_SUMMARY }
}
exit ([int]($relevant.Count -gt 0 -or -not $canarySeen))
