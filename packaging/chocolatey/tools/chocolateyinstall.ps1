$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.20.1/OpenExtract-Setup-0.20.1.exe'
  checksum64     = 'ce262694b509b406399ea6b0d4b68c012f3fcb51131321447b9bf42bebc52894'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
