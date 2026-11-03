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
  [Parameter(Mandatory)] [string] $Publisher,
  # SHA-384 of the to-be-signed part of the CA certificate the publisher's certificates
  # chain through (Microsoft ID Verified Code Signing PCA 2021 for Azure Trusted Signing).
  [Parameter(Mandatory)] [string] $PcaTbs,
  [Parameter(Mandatory)] [string] $OutDir
)
$ErrorActionPreference = 'Stop'

$citool = Join-Path $env:windir 'System32\CiTool.exe'
if (-not (Test-Path $citool)) { throw "$citool not found: this check needs Windows Server 2025 or Windows 11 22H2 or later" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# The example policies can't be edited in place.
$policy = Join-Path $OutDir 'policy.xml'
Copy-Item -LiteralPath (Join-Path $env:windir 'schemas\CodeIntegrity\ExamplePolicies\AllowMicrosoft.xml') -Destination $policy

# Our publisher, written the way New-CIPolicyRule -Level Publisher writes it (the CA below
# Microsoft's root, plus the signer's name), allowed for user-mode code (scenario 12).
# Built by hand: ConfigCI's scan for the same rule takes about six minutes on a runner.
$xml = [xml](Get-Content -Raw $policy)
$ns = $xml.SiPolicy.NamespaceURI
$signer = $xml.CreateElement('Signer', $ns)
$signer.SetAttribute('ID', 'ID_SIGNER_OPENEXTRACT')
$signer.SetAttribute('Name', 'Microsoft ID Verified Code Signing PCA 2021')
$certRoot = $xml.CreateElement('CertRoot', $ns)
$certRoot.SetAttribute('Type', 'TBS')
$certRoot.SetAttribute('Value', $PcaTbs)
$certPublisher = $xml.CreateElement('CertPublisher', $ns)
$certPublisher.SetAttribute('Value', $Publisher)
[void]$signer.AppendChild($certRoot)
[void]$signer.AppendChild($certPublisher)
[void]$xml.SiPolicy.Signers.AppendChild($signer)
$userMode = $xml.SiPolicy.SigningScenarios.SigningScenario | Where-Object Value -eq 12
$allowed = $xml.CreateElement('AllowedSigner', $ns)
$allowed.SetAttribute('SignerId', 'ID_SIGNER_OPENEXTRACT')
[void]$userMode.ProductSigners.AllowedSigners.AppendChild($allowed)
$xml.Save($policy)

Set-RuleOption -FilePath $policy -Option 0            # Enabled:UMCI (user-mode code, not just drivers)
Set-RuleOption -FilePath $policy -Option 3 -Delete    # not Audit Mode: enforce
Set-RuleOption -FilePath $policy -Option 14 -Delete   # no Intelligent Security Graph (reputation)
Set-RuleOption -FilePath $policy -Option 11           # Disabled:Script Enforcement, so the job's PowerShell keeps working
Set-RuleOption -FilePath $policy -Option 16           # Enabled:Update Policy No Reboot
Set-CIPolicyIdInfo -FilePath $policy -PolicyName 'OpenExtract App Control check' -ResetPolicyID | Out-Null
$id = ([xml](Get-Content -Raw $policy)).SiPolicy.PolicyID
$cip = Join-Path $OutDir "$id.cip"
ConvertFrom-CIPolicy -XmlFilePath $policy -BinaryFilePath $cip | Out-Null

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
