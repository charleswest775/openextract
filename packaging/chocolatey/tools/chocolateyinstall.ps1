$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.11.0/OpenExtract-Setup-0.11.0.exe'
  checksum64     = 'aa97a2cd2466044725bfd98e341c2113975e45fe1b60b5307ce0f56de6c279d2'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
