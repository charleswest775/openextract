# Store packages

Files for the app stores and package managers OpenExtract can be listed in.
Nothing here is published by itself.

| Folder | Store | Checked by |
|---|---|---|
| `flathub/` | Flathub (Linux) | the Flatpak workflow |
| `winget/<version>/` | winget (Windows Package Manager) | the Windows stores workflow |
| `chocolatey/` | Chocolatey (Windows) | the Windows stores workflow |

## Each release

1. Add `winget/<new version>/` (copy the last folder) and change the version,
   URL, `InstallerSha256` and `ReleaseDate`. The checksum is on the release
   page next to the `.exe`.
2. In `chocolatey/`, change the version in `openextract.nuspec`, and the URL
   and checksum in `tools/chocolateyinstall.ps1`.
3. The Windows stores workflow downloads the installer, checks the checksum,
   installs it silently, lists any unsigned files, and test-installs the
   Chocolatey package.

## winget

The first version goes in by a pull request to `microsoft/winget-pkgs`,
adding the three files under `manifests/o/OpenExtract/OpenExtract/<version>/`.
It can be done in the browser: fork the repo, then Add file > Upload files.

## Chocolatey

Push from GitHub, no Windows machine needed: add the API key from your
community.chocolatey.org account as the `CHOCOLATEY_API_KEY` repository
secret, then run the Windows stores workflow by hand with
"Push to Chocolatey" ticked. Moderation takes a few days.
