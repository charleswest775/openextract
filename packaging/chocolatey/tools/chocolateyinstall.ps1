$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'openextract'
  fileType       = 'exe'
  url64bit       = 'https://github.com/charleswest775/openextract/releases/download/v0.15.1/OpenExtract-Setup-0.15.1.exe'
  checksum64     = '996a8100e57edf51afe79a7ab8ef57218e13f317a40a054c63b1adf872cb315e'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
