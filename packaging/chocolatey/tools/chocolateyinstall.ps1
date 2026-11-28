$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.21.0/OpenExtract-Setup-0.21.0.exe'
  checksum64     = '8a0891ff5e1c22f77f3f5459a61c0826f45ba58f4d208b6254128726fef18d30'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
