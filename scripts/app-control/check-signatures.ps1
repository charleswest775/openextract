# Checks that the installer and every PE file it installed is validly signed. Files are
# found by content (they start with "MZ"), not by extension, so an executable with an
# unexpected extension can't slip past. The installer, the app and the engine must be
# signed by OpenExtract's publisher through the CA the App Control policy names.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $InstallDir,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $PcaThumbprint
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$installed = @(Get-PeFiles $InstallDir | ForEach-Object { Get-SignerInfo $_.FullName })
$setup = Get-SignerInfo $Installer
$failed = 0

$ours = @($setup) + @($installed | Where-Object { (Split-Path $_.Path -Leaf) -in 'OpenExtract.exe', 'openextract-engine.exe' })
if ($ours.Count -ne 3) {
  Write-Output "::error::Expected the installer, OpenExtract.exe and openextract-engine.exe; found $($ours.Count - 1) of the last two under $InstallDir"
  $failed++
}
foreach ($info in $ours) {
  if (-not (Test-Publisher $info $Publisher $PcaThumbprint)) {
    Write-Output "::error::$($info.Path) is not signed by $Publisher through the expected CA ($($info.Status), signer '$($info.Signer)', CA '$($info.Pca)' $($info.PcaThumbprint)). If Azure Trusted Signing has moved to a new CA, update SIGNING_PCA_* in windows-app-control.yml."
    $failed++
  }
}

$unsigned = @($installed | Where-Object Status -ne 'Valid')
Write-Output "$($installed.Count - $unsigned.Count) of $($installed.Count) PE files under $InstallDir are validly signed"
$installed | Group-Object Status, Signer, IssuingCA | Sort-Object Count -Descending | ForEach-Object {
  Write-Output ("{0,5}  {1}" -f $_.Count, $_.Name)
}
foreach ($info in $unsigned) {
  Write-Output ("::error::{0}: {1}" -f $info.Status, $info.Path.Substring($InstallDir.Length + 1))
}
$failed += $unsigned.Count

$summary = "### Signatures`n`n$($installed.Count) PE files installed, $($unsigned.Count) not validly signed. Installer: $($setup.Status), $($setup.Signer) ($($setup.IssuingCA)).`n"
if ($unsigned.Count -gt 0) {
  $summary += "`n| Status | File |`n|---|---|`n"
  $unsigned | ForEach-Object { $summary += "| $($_.Status) | $($_.Path.Substring($InstallDir.Length + 1)) |`n" }
}
if ($env:GITHUB_STEP_SUMMARY) { $summary >> $env:GITHUB_STEP_SUMMARY }
exit ([int]($failed -gt 0))
