$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.22.0/OpenExtract-Setup-0.22.0.exe'
  checksum64     = '1128cce2744892a7dbb0974e3eac8334dfac035234edf0f7c3cedcd759502ae3'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
