$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.8.0/OpenExtract-Setup-0.8.0.exe'
  checksum64     = 'a4d85063873525e92ffa9b051af372d47974319397114e0f6fe02e1249c32988'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
