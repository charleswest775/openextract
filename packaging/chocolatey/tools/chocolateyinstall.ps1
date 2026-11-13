$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.15.0/OpenExtract-Setup-0.15.0.exe'
  checksum64     = '607bf6bd3e225802c659f9434a6bd8b674c4114e2e5771d794f94545fcc9ff36'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
