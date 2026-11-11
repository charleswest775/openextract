$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.13.0/OpenExtract-Setup-0.13.0.exe'
  checksum64     = 'ccfbd125c15215b5612aa1eb7f80cf575d57634706613fc8729677cfb251b0a2'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
