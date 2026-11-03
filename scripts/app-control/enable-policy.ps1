# Turns on an enforced App Control for Business (WDAC) policy that lets only two kinds of
# code run or load: Microsoft's (Windows' AllowMicrosoft example policy) and code signed
# by OpenExtract's publisher through Azure Trusted Signing. No reputation lookups, so
# unsigned code is blocked even where Smart App Control might let it through; anything
# that passes here is signed, which Smart App Control accepts.
#
# Run in Windows PowerShell 5.1 (the ConfigCI cmdlets need it), as administrator. Writes
# the policy's ID to $env:GITHUB_OUTPUT as `id`, for removing it afterwards, and the time
# it was turned on as `since`.
param(
  [Parameter(Mandatory)] [string] $InstallDir,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $RootThumbprint,
  [Parameter(Mandatory)] [string] $OutDir
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$citool = Join-Path $env:windir 'System32\CiTool.exe'
if (-not (Test-Path $citool)) { throw "$citool not found: this check needs Windows Server 2025 or Windows 11 22H2 or later" }
$examples = Join-Path $env:windir 'schemas\CodeIntegrity\ExamplePolicies'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Rules for our publisher. A Publisher rule is the CA below Microsoft's root plus the
# signer's name; take one from a file signed through each issuing CA in the install, in
# case Trusted Signing used more than one.
$signed = @(Get-PeFiles $InstallDir | ForEach-Object { Get-SignerInfo $_.FullName } |
  Where-Object { Test-Publisher $_ $Publisher $RootThumbprint })
if ($signed.Count -eq 0) { throw "No file under $InstallDir is signed by $Publisher through Azure Trusted Signing" }
$rules = @()
foreach ($group in $signed | Group-Object IssuingCAThumbprint) {
  $file = $group.Group[0].Path
  Write-Output "Publisher rule from $file ($($group.Group[0].IssuingCA), $($group.Count) files)"
  $rules += New-CIPolicyRule -Level Publisher -DriverFilePath $file
}
$ours = Join-Path $OutDir 'openextract.xml'
New-CIPolicy -FilePath $ours -Rules $rules -UserPEs | Out-Null

$policy = Join-Path $OutDir 'policy.xml'
Merge-CIPolicy -PolicyPaths (Join-Path $examples 'AllowMicrosoft.xml'), $ours -OutputFilePath $policy | Out-Null
Set-RuleOption -FilePath $policy -Option 0            # Enabled:UMCI (user-mode code, not just drivers)
Set-RuleOption -FilePath $policy -Option 3 -Delete    # not Audit Mode: enforce
Set-RuleOption -FilePath $policy -Option 14 -Delete   # no Intelligent Security Graph (reputation)
Set-RuleOption -FilePath $policy -Option 11           # Disabled:Script Enforcement, so the job's PowerShell keeps working
Set-RuleOption -FilePath $policy -Option 16           # Enabled:Update Policy No Reboot
Set-CIPolicyIdInfo -FilePath $policy -PolicyName 'OpenExtract App Control check' -ResetPolicyID | Out-Null
$id = ([xml](Get-Content -Raw $policy)).SiPolicy.PolicyID
$cip = Join-Path $OutDir "$id.cip"
ConvertFrom-CIPolicy -XmlFilePath $policy -BinaryFilePath $cip | Out-Null

Write-Output "Signers:"
([xml](Get-Content -Raw $ours)).SiPolicy.Signers.Signer | ForEach-Object {
  Write-Output "  $($_.Name): publisher '$($_.CertPublisher.Value)'"
}
Write-Output "Options:"
([xml](Get-Content -Raw $policy)).SiPolicy.Rules.Rule | ForEach-Object { Write-Output "  $($_.Option)" }

if ($env:GITHUB_OUTPUT) {
  # 5.1's >> writes UTF-16; outputs must be UTF-8.
  "id=$id", "since=$((Get-Date).ToString('o'))" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}
& $citool --update-policy $cip -json
if ($LASTEXITCODE -ne 0) { throw "CiTool --update-policy exited with $LASTEXITCODE" }

$active = (& $citool --list-policies -json | Out-String | ConvertFrom-Json).Policies |
  Where-Object { $_.PolicyID.Trim('{}') -eq $id.Trim('{}') }
if (-not $active -or -not $active.IsEnforced) {
  throw "Policy $id is not enforced: $($active | ConvertTo-Json -Compress)"
}
Write-Output "Policy $id is enforced"
