$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.16.0/OpenExtract-Setup-0.16.0.exe'
  checksum64     = '676bea4b6059603d8b02b67b97e5dfe134ae8c70904d06797a0bce409fe9606c'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
