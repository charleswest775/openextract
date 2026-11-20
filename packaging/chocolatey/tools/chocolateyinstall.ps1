$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.18.0/OpenExtract-Setup-0.18.0.exe'
  checksum64     = 'e982ba9ec0fce8554117fcf56bbd82ceb92d9a0cc7f83e1e5f4f97e178f8fe6d'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
