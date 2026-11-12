$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.14.0/OpenExtract-Setup-0.14.0.exe'
  checksum64     = '6a60527f50d3e17c47d8fe7e2af6477152d7a86001f01d44d39d40497229e3e2'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
