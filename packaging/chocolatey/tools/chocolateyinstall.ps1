$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.19.0/OpenExtract-Setup-0.19.0.exe'
  checksum64     = '2ea815d7529429eb3083d9489299b304549fa5b9f464b40eb5838dfa9a4fb88d'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
