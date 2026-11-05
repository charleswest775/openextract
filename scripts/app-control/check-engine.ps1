# Starts the installed engine and talks to it over JSON-RPC on stdin/stdout, the way the
# app does: list_backups, then opens an encrypted backup and reads from every part of it.
# Opening an encrypted backup loads pycryptodome's native DLLs, the ones Smart App Control
# blocked in #169; thumbnails load Pillow and pillow-heif. It also searches for iPhones,
# which on a PC without Apple's software must say Apple Devices is needed (#184).
# Run in PowerShell 7.
param(
  [Parameter(Mandatory)] [string] $Engine,
  [Parameter(Mandatory)] [string] $Backup,
  [Parameter(Mandatory)] [string] $Password,
  [Parameter(Mandatory)] [string] $LogDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$start = [System.Diagnostics.ProcessStartInfo]::new($Engine)
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Environment['PYTHONUNBUFFERED'] = '1'
$start.Environment['OPENEXTRACT_LOG_PATH'] = Join-Path $LogDir 'engine-log.txt'
try {
  $proc = [System.Diagnostics.Process]::Start($start)
} catch {
  Write-Output "::error::The engine didn't start: $($_.Exception.GetBaseException().Message)"
  exit 1
}
$stderr = $proc.StandardError.ReadToEndAsync()
$script:nextId = 0

function Read-Message([double] $TimeoutSec) {
  $line = $proc.StandardOutput.ReadLineAsync()
  if (-not $line.Wait([TimeSpan]::FromSeconds([Math]::Max($TimeoutSec, 1)))) {
    throw "no answer from the engine within $([int]$TimeoutSec) s"
  }
  if ($null -eq $line.Result) {
    $proc.WaitForExit(5000) | Out-Null
    throw "the engine exited$(if ($proc.HasExited) { " with code $($proc.ExitCode)" })"
  }
  $line.Result | ConvertFrom-Json
}

function Invoke-Engine([string] $Method, [hashtable] $Params = @{}, [int] $TimeoutSec = 120) {
  $id = ++$script:nextId
  $proc.StandardInput.WriteLine((@{ jsonrpc = '2.0'; id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 5))
  $proc.StandardInput.Flush()
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $message = Read-Message ($TimeoutSec - $watch.Elapsed.TotalSeconds)
  } until ($message.id -eq $id)  # notifications have no id
  if ($message.error) { throw "$Method failed: $($message.error.message)" }
  Write-Host ("{0,-20} answered in {1:n1} s" -f $Method, $watch.Elapsed.TotalSeconds)
  $message.result
}

$failure = $null
$deviceFailure = $null
try {
  # A one-file engine (0.9.0 and earlier on Windows) unpacks itself before it's ready.
  $ready = Read-Message 120
  if ($ready.status -ne 'ready') { throw "expected the ready line first, got $($ready | ConvertTo-Json -Compress)" }
  Invoke-Engine ping | Out-Null

  # The runner has no Apple software, so Back up my iPhone must get DEVICE_SERVICE_REQUIRED
  # (the app's "Install Apple Devices first" card), not a crash. The engine looks for Apple
  # Devices with PowerShell, which App Control puts in Constrained Language mode. A wrong
  # answer fails the check at the end, after the backup has been opened.
  try {
    $devices = Invoke-Engine backup.list_devices -TimeoutSec 120
    Write-Output "::warning::backup.list_devices reached Apple's usbmuxd on this runner ($($devices | ConvertTo-Json -Compress)), so the check for a PC without Apple software didn't run"
  } catch {
    if ($_.Exception.Message -notlike 'backup.list_devices failed: DEVICE_SERVICE_REQUIRED:*') {
      $deviceFailure = "without Apple software, $($_.Exception.Message) (expected DEVICE_SERVICE_REQUIRED)"
    } else {
      Write-Host 'backup.list_devices   said Apple Devices is needed, as it should here'
    }
  }
  Invoke-Engine ping | Out-Null

  $found = Invoke-Engine list_backups @{ path = Split-Path $Backup }
  $entry = @($found.backups | Where-Object { (Get-Item $_.backup_dir).FullName -eq (Get-Item $Backup).FullName })[0]
  if (-not $entry) { throw "list_backups didn't list $Backup" }
  if (-not $entry.encrypted) { throw "$Backup isn't encrypted, so opening it wouldn't load the decryption libraries" }
  $udid = $entry.udid

  $opened = Invoke-Engine open_backup @{ udid = $udid; password = $Password; backup_dir = $entry.backup_dir } -TimeoutSec 600
  if ($opened.status -ne 'open') { throw "open_backup returned '$($opened.status)', not 'open'" }

  # Read from each part, so the engine loads what each one needs.
  foreach ($method in 'list_conversations', 'list_contacts', 'list_calls', 'list_notes', 'list_voicemails', 'list_albums') {
    $result = Invoke-Engine $method @{ udid = $udid } -TimeoutSec 300
    if ($result.error) { throw "$method returned an error: $($result.error)" }
  }
  $photos = @((Invoke-Engine list_photos @{ udid = $udid; limit = 50 } -TimeoutSec 300).photos | Where-Object kind -ne 'video')
  if ($photos.Count -eq 0) { throw "list_photos found no photos in $Backup" }
  # Each image format once: JPEG needs Pillow, HEIC pillow-heif too.
  $thumbnails = 0
  foreach ($photo in $photos | Group-Object { [IO.Path]::GetExtension($_.filename).ToLower() } | ForEach-Object { $_.Group[0] }) {
    $thumb = Invoke-Engine get_photo_thumbnail @{ udid = $udid; file_hash = $photo.file_hash } -TimeoutSec 300
    if (-not $thumb.data) { throw "No thumbnail for $($photo.filename): $($thumb.error)" }
    $thumbnails++
  }
  Write-Host "$thumbnails thumbnail(s) made, one per image format"
} catch {
  $failure = $_.Exception.Message
} finally {
  if (-not $proc.HasExited) {
    $proc.StandardInput.Close()  # the engine exits at the end of its input
    if (-not $proc.WaitForExit(10000)) { $proc.Kill($true) }
  }
}

$errors = $stderr.Result
Set-Content -LiteralPath (Join-Path $LogDir 'engine-stderr.txt') -Value $errors -Encoding utf8
# What the engine says about its optional native libraries, e.g. "[photos] PIL=True HEIF=True".
($errors -split "`r?`n") | Where-Object { $_ -match '^\[photos\] PIL=' } | ForEach-Object { Write-Host $_ }

if ($deviceFailure) {
  Write-Output "::error::Engine: $deviceFailure"
}
if ($failure) {
  Write-Output "::error::Engine: $failure"
  Write-Output "Engine stderr (last 40 lines):"
  ($errors -split "`r?`n" | Select-Object -Last 40) | ForEach-Object { Write-Output "  $_" }
  exit 1
}
if ($deviceFailure) { exit 1 }
Write-Output "The engine opened the encrypted backup and answered every call"
