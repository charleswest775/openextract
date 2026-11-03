$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.9.0/OpenExtract-Setup-0.9.0.exe'
  checksum64     = 'b52c0fa2fe24b3a97bd00a858a1ac2ee08fb03fbf20ada2431787a208ab936c1'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
