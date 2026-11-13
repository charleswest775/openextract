# OpenExtract's Windows smoke test, on the test PC. smoke.sh copies this into a run folder
# (<home>\oe-smoke\runs\<run>) with the code to test, and start.ps1 runs it as a scheduled
# task in the signed-in user's console session with a standard token, the way the
# installed app runs. It logs to out\log.txt as it goes, writes out\results.json and
# out\summary.txt at the end, then out\done.txt (0 if everything passed).
#
# <home>\oe-smoke\repo is reused from run to run: its node_modules and .venv are only
# rebuilt when package-lock.json or the Python requirements change.
param(
  [Parameter(Mandatory)] [string] $RunDir,
  # A release tag: install the run folder's OpenExtract-Setup-*.exe and drive that, not the dev build.
  [string] $Release = '',
  [switch] $SkipTests,
  [switch] $SkipApp,
  [switch] $RequireDevice,
  [switch] $StartBackup,
  # Uninstall Apple Devices first, so Install Apple Devices really runs winget. Changes the PC.
  [switch] $FreshAppleDevices,
  [int] $VitePort = 5290
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path (Split-Path $RunDir -Parent) -Parent
$Repo = Join-Path $Root 'repo'
$Out = Join-Path $RunDir 'out'
New-Item -ItemType Directory -Force $Out | Out-Null
$LogFile = Join-Path $Out 'log.txt'
$VenvPython = Join-Path $Repo '.venv\Scripts\python.exe'
$steps = New-Object System.Collections.ArrayList
$results = [ordered]@{
  run = Split-Path $RunDir -Leaf
  source = (Get-Content (Join-Path $RunDir 'source.txt') -Raw).Trim()
  iosBackupCore = (Get-Content (Join-Path $RunDir 'ibc.txt') -Raw).Trim()
}

function Log([string] $Text) {
  Add-Content -LiteralPath $LogFile -Value ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $Text) -Encoding utf8
}

# Runs a native command with its output in out\<Name>.txt; returns its exit code.
function Invoke-Native([string] $Name, [scriptblock] $Command) {
  $ErrorActionPreference = 'Continue'  # Windows PowerShell turns stderr lines into errors
  & $Command 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath (Join-Path $Out "$Name.txt") -Append -Encoding utf8
  $LASTEXITCODE
}

# One line of the report. $Body returns a short detail, or throws to fail the step.
function Step([string] $Name, [scriptblock] $Body) {
  Log "== $Name"
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $step = [ordered]@{ name = $Name; ok = $true; detail = '' }
  try { $step.detail = (& $Body | Out-String).Trim() }
  catch { $step.ok = $false; $step.detail = $_.Exception.Message }
  $step.seconds = [int]$watch.Elapsed.TotalSeconds
  Log ('{0} {1} ({2} s): {3}' -f $(if ($step.ok) { 'PASS' } else { 'FAIL' }), $Name, $step.seconds, $step.detail)
  [void]$steps.Add([pscustomobject]$step)
  $step.ok
}

function Stop-Tree([int] $ProcessId) { taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null }

$vite = $null
try {
  Log "OpenExtract Windows smoke test, run $($results.run): $($results.source)"
  # Keep the last ten runs.
  Get-ChildItem (Split-Path $RunDir -Parent) -Directory | Sort-Object Name -Descending | Select-Object -Skip 10 |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  $ok = Step 'This PC' {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $os = Get-CimInstance Win32_OperatingSystem
    $apple = (Get-AppxPackage AppleInc.AppleDevices).Version
    $installed = (Get-Item "$env:LOCALAPPDATA\Programs\OpenExtract\OpenExtract.exe" -ErrorAction SilentlyContinue).VersionInfo.ProductVersion -replace '\.0$'
    $script:results.pc = [ordered]@{
      windows = "$($os.Caption) build $($os.BuildNumber)"; user = $id.Name; session = $session; elevated = $elevated
      appleDevices = $apple; openExtractInstalled = $installed; node = (node --version)
    }
    if ($elevated) { throw 'Running elevated; the real app runs with a standard token' }
    if ($session -eq 0) { throw "Running in session 0, not the signed-in user's session" }
    "$($os.Caption) build $($os.BuildNumber); $($id.Name) in session $session, not elevated; " +
      "Apple Devices $(if ($apple) { $apple } else { 'not installed' }); OpenExtract $(if ($installed) { "$installed installed" } else { 'not installed' })"
  }
  if (-not $ok) { throw 'Not in the right session' }

  $ok = Step 'Copy the code' {
    New-Item -ItemType Directory -Force $Repo | Out-Null
    Get-ChildItem -LiteralPath $Repo -Force | Where-Object Name -notin 'node_modules', '.venv' | Remove-Item -Recurse -Force
    tar.exe -xzf (Join-Path $RunDir 'repo.tgz') -C $Repo
    if ($LASTEXITCODE) { throw "tar exited with $LASTEXITCODE" }
    $ibc = Join-Path $Root 'ios-backup-core'
    if (Test-Path $ibc) { Remove-Item -Recurse -Force $ibc }
    New-Item -ItemType Directory $ibc | Out-Null
    tar.exe -xzf (Join-Path $RunDir 'ibc.tgz') -C $ibc
    if ($LASTEXITCODE) { throw "tar exited with $LASTEXITCODE" }
    # macOS tar adds AppleDouble ._ files, which tests then read as UTF-8. (Only folders go
    # down the pipe: Get-ChildItem given a file returns that file, whatever the filter.)
    Get-ChildItem $Repo -File -Force -Filter '._*' | Remove-Item -Force
    Get-ChildItem $Repo -Directory -Force | Where-Object Name -notin 'node_modules', '.venv' |
      Get-ChildItem -Recurse -File -Force -Filter '._*' | Remove-Item -Force
    "$($results.source); ios-backup-core $($results.iosBackupCore.Substring(0, 12))"
  }
  if (-not $ok) { throw "Couldn't copy the code" }

  $ok = Step 'Python environment' {
    $base = Join-Path $Root 'python\tools\python.exe'
    if (-not (Test-Path $base)) {
      # This PC has no Python of its own: use python.org's NuGet package, unzipped.
      $zip = Join-Path $Root 'python.zip'
      curl.exe -sSfL -o $zip https://www.nuget.org/api/v2/package/python/3.11.9
      if ($LASTEXITCODE) { throw "Couldn't download Python (curl exited with $LASTEXITCODE)" }
      New-Item -ItemType Directory -Force (Join-Path $Root 'python') | Out-Null
      tar.exe -xf $zip -C (Join-Path $Root 'python')
      Remove-Item $zip
    }
    $requirements = (Get-Content "$Repo\python\requirements.txt", "$Repo\python\requirements-dev.txt" -Raw) -join ''
    $stamp = Join-Path $Repo '.venv\smoke-requirements.txt'
    $did = @()
    if (-not (Test-Path $VenvPython) -or (Get-Content $stamp -Raw -ErrorAction SilentlyContinue) -ne $requirements) {
      if (Test-Path "$Repo\.venv") { Remove-Item -Recurse -Force "$Repo\.venv" }
      if (Invoke-Native 'pip' { & $base -m venv "$Repo\.venv" }) { throw "Couldn't make a venv; see pip.txt" }
      # requirements.txt installs ios-backup-core from a sibling folder; install it from ours.
      Get-Content "$Repo\python\requirements.txt" | Where-Object { $_ -notmatch '^-e ' } | Set-Content "$Repo\.venv\requirements.txt"
      if (Invoke-Native 'pip' { & $VenvPython -m pip install -q --disable-pip-version-check -r "$Repo\.venv\requirements.txt" -r "$Repo\python\requirements-dev.txt" }) {
        throw "pip install failed; see pip.txt"
      }
      Set-Content $stamp $requirements -NoNewline
      $did += 'new venv'
    }
    $ibcStamp = Join-Path $Repo '.venv\smoke-ios-backup-core.txt'
    if ((Get-Content $ibcStamp -Raw -ErrorAction SilentlyContinue) -ne $results.iosBackupCore) {
      # Its dependencies, then itself even if its version number hasn't changed.
      if ((Invoke-Native 'pip' { & $VenvPython -m pip install -q --disable-pip-version-check "$Root\ios-backup-core" }) -or
          (Invoke-Native 'pip' { & $VenvPython -m pip install -q --disable-pip-version-check --force-reinstall --no-deps "$Root\ios-backup-core" })) {
        throw "Couldn't install ios-backup-core; see pip.txt"
      }
      Set-Content $ibcStamp $results.iosBackupCore -NoNewline
      $did += 'ios-backup-core installed'
    }
    "$(& $VenvPython --version)$(if ($did) { ', ' + ($did -join ', ') } else { ', up to date' })"
  }
  if (-not $ok) { throw 'No Python environment' }

  $ok = Step 'Node environment' {
    Set-Location $Repo
    $stamp = Join-Path $Repo 'node_modules\.smoke-package-lock.txt'
    $lock = (Get-FileHash "$Repo\package-lock.json").Hash
    $did = 'up to date'
    if ((Get-Content $stamp -Raw -ErrorAction SilentlyContinue) -ne $lock) {
      if (Invoke-Native 'npm-ci' { npm.cmd ci --no-audit --no-fund }) { throw 'npm ci failed; see npm-ci.txt' }
      Set-Content $stamp $lock -NoNewline
      $did = 'npm ci'
    }
    # Electron's install.js has stopped after unpacking only locales\ on this PC; then unpack
    # the zip it downloaded ourselves.
    $electron = Join-Path $Repo 'node_modules\electron'
    $version = (Get-Content "$electron\package.json" -Raw | ConvertFrom-Json).version
    if (-not (Test-Path "$electron\dist\electron.exe")) {
      Invoke-Native 'npm-ci' { node "$electron\install.js" } | Out-Null
    }
    if (-not (Test-Path "$electron\dist\electron.exe")) {
      $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v$version-win32-x64.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $zip) { throw "No electron.exe, and no electron-v$version-win32-x64.zip in the Electron cache" }
      New-Item -ItemType Directory -Force "$electron\dist" | Out-Null
      tar.exe -xf $zip.FullName -C "$electron\dist"
      Set-Content "$electron\path.txt" 'electron.exe' -NoNewline
    }
    if (-not (Test-Path "$Repo\node_modules\playwright-core")) {
      if (Invoke-Native 'npm-ci' { npm.cmd install --no-save --no-audit --no-fund playwright-core@1.59.1 }) { throw "Couldn't install playwright-core; see npm-ci.txt" }
    }
    "Node $(node --version), Electron $version, $did"
  }
  if (-not $ok) { throw 'No Node environment' }

  if (-not $SkipTests) {
    Step 'Python tests' {
      Set-Location $Repo
      $code = Invoke-Native 'pytest' { & $VenvPython -m pytest python/tests -q -rs -p no:cacheprovider }
      $summary = "$((Select-String -LiteralPath "$Out\pytest.txt" -Pattern '\d+ (passed|failed|errors?)\b' | Select-Object -Last 1).Line)".Trim('= ')
      if ($code) { throw "pytest exited with $code ($summary); see pytest.txt" }
      $summary
    } | Out-Null

    Step 'npm test' {
      Set-Location $Repo
      $code = Invoke-Native 'npm-test' { npm.cmd test }
      $counts = (Select-String -LiteralPath "$Out\npm-test.txt" -Pattern '\b(tests|pass|fail) (\d+)\s*$' |
        ForEach-Object { "$($_.Matches[0].Groups[1].Value) $($_.Matches[0].Groups[2].Value)" }) -join ', '
      if ($code) { throw "npm test exited with $code ($counts); see npm-test.txt" }
      $counts
    } | Out-Null
  }

  if (-not $SkipApp) {
    $appArgs = $null
    if ($Release) {
      $ok = Step "Install OpenExtract $Release" {
        if (Get-Process OpenExtract -ErrorAction SilentlyContinue) { throw 'OpenExtract is running; close it, then run again' }
        $setup = Get-ChildItem $RunDir -Filter 'OpenExtract-Setup-*.exe' | Select-Object -First 1
        if (-not $setup) { throw 'No OpenExtract-Setup-*.exe in the run folder' }
        # Per user, no admin rights, as the app's updater installs it.
        $p = Start-Process $setup.FullName -ArgumentList '/S' -Wait -PassThru
        if ($p.ExitCode) { throw "The installer exited with $($p.ExitCode)" }
        Remove-Item $setup.FullName
        $exe = "$env:LOCALAPPDATA\Programs\OpenExtract\OpenExtract.exe"
        $version = (Get-Item $exe).VersionInfo.ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'  # 0.10.0.0
        if ("v$version" -ne $Release) { throw "Installed $version, but the release is $Release" }
        $script:appArgs = @('--app', $exe)
        "installed $version (per user, no admin prompt)"
      }
    } else {
      $ok = Step 'Start the dev app''s renderer' {
        Set-Location $Repo
        if (Invoke-Native 'tsc' { npx.cmd tsc -p tsconfig.electron.json }) { throw 'tsc failed; see tsc.txt' }
        $script:vite = Start-Process npx.cmd -ArgumentList 'vite', '--port', $VitePort, '--strictPort', '--host', '127.0.0.1' `
          -WorkingDirectory $Repo -NoNewWindow -PassThru -RedirectStandardOutput "$Out\vite.txt" -RedirectStandardError "$Out\vite-errors.txt"
        $up = $false
        for ($i = 0; $i -lt 90 -and -not $up; $i++) {
          try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$VitePort").StatusCode -eq 200 } catch { Start-Sleep 1 }
        }
        if (-not $up) { throw "Vite didn't answer on port $VitePort; see vite.txt" }
        $script:appArgs = @('--dev', "http://127.0.0.1:$VitePort")
        "Vite on 127.0.0.1:$VitePort, Electron main built"
      }
    }

    if ($ok -and $FreshAppleDevices) {
      $ok = Step 'Uninstall Apple Devices (-FreshAppleDevices)' {
        Stop-Process -Name AppleDevices, AppleMobileDeviceProcess, AppleMobileDeviceLauncher -Force -ErrorAction SilentlyContinue
        Get-AppxPackage AppleInc.AppleDevices | Remove-AppxPackage
        if (Get-AppxPackage AppleInc.AppleDevices) { throw 'Apple Devices is still installed' }
        "removed, so Install Apple Devices will run winget"
      }
    }

    if ($ok) {
      Step 'Back up my iPhone' {
        Set-Location $Repo
        $nodeArgs = @('scripts\e2e-device-backup.mjs', '--out', "$Out\device", '--apple-devices') + $appArgs
        if ($RequireDevice) { $nodeArgs += '--require-device' }
        if ($StartBackup) { $nodeArgs += '--start-backup' }
        $code = Invoke-Native 'device' { node @nodeArgs }
        $device = Get-Content "$Out\device\results.json" -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
        if (-not $device) { throw "No results from e2e-device-backup.mjs (exit $code); see device.txt" }
        $script:results.device = $device
        $failed = @($device.checks | Where-Object { -not $_.ok })
        $summary = "$(@($device.checks).Count - $failed.Count) of $(@($device.checks).Count) checks passed. $($device.notes -join '. ')"
        if ($code -or $failed) { throw "$summary. Failed: $(($failed | ForEach-Object { $_.name }) -join '; ')" }
        $summary
      } | Out-Null
    }
  }
} catch {
  Log "Stopped: $($_.Exception.Message)"
} finally {
  if ($vite) { Stop-Tree $vite.Id }
  $results.steps = @($steps)
  $results.passed = $steps.Count -gt 0 -and -not ($steps | Where-Object { -not $_.ok })
  $results | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Out 'results.json') -Encoding utf8
  $summary = @("OpenExtract Windows smoke test $($results.run): $($results.source)")
  if ($results.pc) { $summary += "PC: $($results.pc.windows), $($results.pc.user), session $($results.pc.session), elevated: $($results.pc.elevated)" }
  foreach ($s in $steps) { $summary += ('{0}  {1} ({2} s): {3}' -f $(if ($s.ok) { 'PASS' } else { 'FAIL' }), $s.name, $s.seconds, $s.detail) }
  $summary += $(if ($results.passed) { 'Everything passed.' } else { 'Something failed; the out folder has the logs.' })
  $summary | Set-Content (Join-Path $Out 'summary.txt') -Encoding utf8
  Log 'Finished'
  Set-Content (Join-Path $Out 'done.txt') $(if ($results.passed) { '0' } else { '1' })
}
