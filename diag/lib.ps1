# Throwaway helpers for the NSIS System.dll crash investigation (branch claude/nsis-crash-diag).

$script:AppGuid = '5a1717d0-2788-5d31-aed0-854cb1183416'   # UUID v5 of com.openextract.app, as electron-builder derives it
$script:InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs'

function Reset-Install {
  param([switch]$PresetInstallLocation)
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($script:InstallRoot, 'OrdinalIgnoreCase') } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($d in 'OpenExtract', 'openextract') { Remove-Item -LiteralPath (Join-Path $script:InstallRoot $d) -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath "HKCU:\Software\$script:AppGuid" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:AppGuid" -Recurse -Force -ErrorAction SilentlyContinue
  if ($PresetInstallLocation) {
    # What an earlier install leaves behind; multiUser.nsh then skips the SHGetKnownFolderPath branch.
    New-Item -Path "HKCU:\Software\$script:AppGuid" -Force | Out-Null
    Set-ItemProperty -Path "HKCU:\Software\$script:AppGuid" -Name InstallLocation -Value (Join-Path $script:InstallRoot 'OpenExtract')
  }
}

# Runs one installer with /S. -KillAfter: seconds after which a still-running installer counts as
# past startup and is killed (0 = wait for it to finish, up to 300 s).
function Invoke-Trial {
  param([string]$Exe, [int]$KillAfter = 0, [string[]]$Arguments = @('/S'))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -PassThru
  $null = $p.Handle   # keeps ExitCode readable after exit
  $limit = if ($KillAfter -gt 0) { $KillAfter * 1000 } else { 300000 }
  $exited = $p.WaitForExit($limit)
  $ms = $sw.ElapsedMilliseconds
  if ($exited) {
    $code = $p.ExitCode
  } else {
    & taskkill.exe /T /F /PID $p.Id *> $null
    $code = if ($KillAfter -gt 0) { 'alive' } else { 'timeout' }
  }
  $installed = Test-Path (Join-Path $script:InstallRoot 'OpenExtract\OpenExtract.exe')
  [pscustomobject]@{ Exe = (Split-Path $Exe -Leaf); Code = $code; Ms = $ms; Installed = $installed }
}

function Enable-LocalDumps {
  param([string[]]$ExeNames, [string]$Folder)
  New-Item -ItemType Directory -Force $Folder | Out-Null
  $base = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
  foreach ($n in $ExeNames) {
    $k = Join-Path $base $n
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name DumpFolder -Value $Folder -Type ExpandString
    Set-ItemProperty -Path $k -Name DumpType -Value 2 -Type DWord   # full dump
    Set-ItemProperty -Path $k -Name DumpCount -Value 4 -Type DWord
  }
}

function Get-FaultEvents {
  param([datetime]$Since)
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = $Since } -ErrorAction SilentlyContinue | ForEach-Object {
    $m = $_.Message
    [pscustomobject]@{
      App    = if ($m -match 'Faulting application name: ([^,]+)') { $Matches[1] } else { '?' }
      Module = if ($m -match 'Faulting module name: ([^,]+), version: ([^,]+), time stamp: (0x[0-9a-fA-F]+)') { "$($Matches[1]) $($Matches[3])" } else { '?' }
      Code   = if ($m -match 'Exception code: (0x[0-9a-fA-F]+)') { $Matches[1] } else { '?' }
      Offset = if ($m -match 'Fault offset: (0x[0-9a-fA-F]+)') { $Matches[1] } else { '?' }
      Path   = if ($m -match 'Faulting module path: (.+)') { $Matches[1].Trim() } else { '?' }
    }
  }
}

function Write-Summary {
  param($Results, [string]$Title)
  $lines = @("### $Title", '', '| Variant | Trials | Crashed (0xC0000005) | Other non-zero | OK/alive |', '|---|---|---|---|---|')
  foreach ($g in ($Results | Group-Object Variant)) {
    $crash = @($g.Group | Where-Object { $_.Code -eq -1073741819 }).Count
    $ok = @($g.Group | Where-Object { $_.Code -eq 0 -or $_.Code -eq 'alive' }).Count
    $other = $g.Count - $crash - $ok
    $lines += "| $($g.Name) | $($g.Count) | $crash | $other | $ok |"
    Write-Output "RESULT variant=$($g.Name) trials=$($g.Count) crashed=$crash other=$other ok=$ok"
  }
  $lines -join "`n" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}

function Find-Cdb {
  $c = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers" -Recurse -Filter cdb.exe -ErrorAction SilentlyContinue
  $x64 = $c | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
  if ($x64) { return $x64.FullName }
  if ($c) { return ($c | Select-Object -First 1).FullName }
  return $null
}

# Prints the exception, registers, stack and the memory around the faulting address of a dump.
function Show-Dump {
  param([string]$Dump)
  $cdb = Find-Cdb
  if (-not $cdb) { Write-Output 'cdb.exe not found'; return }
  Write-Output "===== $Dump (cdb: $cdb)"
  $first = & $cdb -z $Dump -c '.effmach x86; .exr -1; .ecxr; r; kv 20; ub @eip L30; u @eip L10; lm; q' 2>&1
  $first | Write-Output
  $fault = ($first | Select-String -Pattern 'Parameter\[1\]: ([0-9a-fA-F`]+)' | Select-Object -First 1)
  if ($fault) {
    $a = $fault.Matches[0].Groups[1].Value -replace '`', ''
    Write-Output "===== memory around fault address $a"
    & $cdb -z $Dump -c ".effmach x86; !address $a; !address $a-1; db $a-0x100 L100; du $a-0x800 L100; .ecxr; !address @esi; !address @edi; dd @esp L30; q" 2>&1 | Write-Output
  }
}
