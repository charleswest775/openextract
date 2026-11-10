$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.12.0/OpenExtract-Setup-0.12.0.exe'
  checksum64     = '350846b04499af482ec1a6cff04335548f6d0633c419e26a0e4e8666637d3fcc'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
