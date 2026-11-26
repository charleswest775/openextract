$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.20.0/OpenExtract-Setup-0.20.0.exe'
  checksum64     = 'd6751f8c855770f0e54a53eb0bc73e6696a4eeea486d4cf15b021a7b2799fecd'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
