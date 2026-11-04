$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.10.0/OpenExtract-Setup-0.10.0.exe'
  checksum64     = '4edc3a627248a12579bbea3695e92c65f7b7f6194a06351ff6571744eacb1c9a'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
