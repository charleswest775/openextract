$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.8.1/OpenExtract-Setup-0.8.1.exe'
  checksum64     = '45f5b521bf9a1172b191aafdeb1d2bc4652d327235925b84869f827d161dfd2c'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
