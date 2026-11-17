$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.17.0/OpenExtract-Setup-0.17.0.exe'
  checksum64     = '4612a5ea397dc6c29653dd1599487caa1168054f00afdc7715da42dcadb73343'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
