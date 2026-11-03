# Shared by the App Control check's scripts (.github/workflows/windows-app-control.yml)
# and release.yml. Works in Windows PowerShell 5.1 as well as PowerShell 7.

# Every PE file (one that starts with "MZ") under $Root, whatever its extension.
function Get-PeFiles([string] $Root) {
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
    $stream = [System.IO.File]::OpenRead($file.FullName)
    try {
      $head = New-Object byte[] 2
      $read = $stream.Read($head, 0, 2)
    } finally {
      $stream.Dispose()
    }
    if ($read -eq 2 -and $head[0] -eq 0x4D -and $head[1] -eq 0x5A) { $file }
  }
}

# A file's Authenticode status and who signed it: the signer's name, the CA that issued
# its certificate, and the CA below the root (the one App Control's Publisher rules name).
function Get-SignerInfo([string] $Path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $Path
  $info = [ordered]@{ Path = $Path; Status = [string]$sig.Status; Signer = ''; IssuingCA = ''; Pca = ''; PcaThumbprint = '' }
  if ($sig.SignerCertificate) {
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = 'NoCheck'
    # Azure Trusted Signing's certificates last three days. The signature's timestamp is
    # what keeps it valid afterwards (Status above), so don't let expiry stop the chain.
    $chain.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'
    # The intermediates are in the signature; use them rather than fetching them.
    $embedded = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    try { $embedded.Import($Path) } catch { }
    [void]$chain.ChainPolicy.ExtraStore.AddRange($embedded)
    [void]$chain.Build($sig.SignerCertificate)
    $certs = @($chain.ChainElements | ForEach-Object { $_.Certificate })
    $info.Signer = $sig.SignerCertificate.GetNameInfo('SimpleName', $false)
    if ($certs.Count -gt 1) { $info.IssuingCA = $certs[1].GetNameInfo('SimpleName', $false) }
    if ($certs.Count -gt 2) {
      $info.Pca = $certs[-2].GetNameInfo('SimpleName', $false)
      $info.PcaThumbprint = $certs[-2].Thumbprint
    }
  }
  [pscustomobject]$info
}

# True when the file is validly signed by $Publisher through the expected CA.
function Test-Publisher($Info, [string] $Publisher, [string] $PcaThumbprint) {
  $Info.Status -eq 'Valid' -and $Info.Signer -eq $Publisher -and $Info.PcaThumbprint -eq $PcaThumbprint
}
