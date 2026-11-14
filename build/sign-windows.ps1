# Signs every file listed in -List with Azure Trusted Signing in one Invoke-TrustedSigning call:
# one sign-in and one signtool run per few dozen files, instead of a new PowerShell and sign-in
# for each file the way electron-builder signs. Called by build/sign-windows.js (afterPack).
#
# -List is a text file of paths relative to its own folder, one per line (the module's
# -FilesCatalog format). Credentials come from AZURE_TENANT_ID, AZURE_CLIENT_ID and
# AZURE_CLIENT_SECRET, as for electron-builder's own Azure signing.
param(
  [Parameter(Mandatory)] [string] $List,
  [Parameter(Mandatory)] [string] $Endpoint,
  [Parameter(Mandatory)] [string] $CodeSigningAccountName,
  [Parameter(Mandatory)] [string] $CertificateProfileName
)
$ErrorActionPreference = 'Stop'

# The same module and minimum version electron-builder installs for its own signing.
if (-not (Get-Module -ListAvailable -Name TrustedSigning | Where-Object { $_.Version -ge [version]'0.5.0' })) {
  try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null } catch { }
  Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser
}
Import-Module TrustedSigning

$params = @{
  Endpoint               = $Endpoint
  CodeSigningAccountName = $CodeSigningAccountName
  CertificateProfileName = $CertificateProfileName
  FilesCatalog           = $List
  FileDigest             = 'SHA256'
  TimestampRfc3161       = 'http://timestamp.acs.microsoft.com'
  TimestampDigest        = 'SHA256'
  # Seconds per signtool run (a batch of files). The default, 300, is meant for a few files.
  Timeout                = 1200
}

# One retry: signing a file that's already signed just replaces its signature.
for ($attempt = 1; ; $attempt++) {
  try {
    Invoke-TrustedSigning @params | Out-Null
    break
  } catch {
    if ($attempt -ge 2) { throw }
    Write-Output "Trusted Signing failed ($($_.Exception.Message)); trying once more in 15 seconds"
    Start-Sleep -Seconds 15
  }
}
