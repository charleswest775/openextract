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

## Windows App Control check

Smart App Control (on by default on new Windows 11 PCs) won't load code
that isn't signed, and GitHub's runners and our own PCs have it off. In
0.9.0 that hid #169: the engine's unsigned DLLs were blocked and the app
said "Python sidecar is not running".

**When it runs:** `release.yml` runs `windows-app-control.yml` on the draft
release, after the Windows build and before publishing. To check any
release, drafts included, run "Windows App Control check" from the Actions
tab with its tag.

**What it does:** on a fresh runner it installs the release's installer
with `/S`, checks that every PE file installed is validly signed (found by
content, so an `.exe` or `.dll` under another name counts too), and turns
on an enforced App Control policy that allows only Microsoft's code and
ours (Azure Trusted Signing, publisher "Charles West"). That's stricter
than Smart App Control, so what passes here passes there. Then it opens
the generated encrypted Maren backup with the installed engine, starts the
app, and looks for blocks in the CodeIntegrity event log.

**If it fails,** the release stays a draft. The job summary lists unsigned
files and blocked loads, and the `app-control-…` artifact has the engine's
stderr, the event list and the policy. Usually something new in the engine
or the app isn't being signed: a file type outside `win.signExts`, or code
unpacked at run time. Fix the build and release again (delete the draft
and its tag first). If the step "Check the policy blocks the canary"
fails, the policy itself isn't working on that runner image, so the check
proves nothing until it's fixed. The check against v0.9.0, which must
fail, shows what a real failure looks like.

## winget

The first version goes in by a pull request to `microsoft/winget-pkgs`,
adding the three files under `manifests/o/OpenExtract/OpenExtract/<version>/`.
It can be done in the browser:

1. Fork `microsoft/winget-pkgs`, open your fork, and go to `manifests/o/`.
2. Add file > Upload files, with the three files from `winget/<version>/`,
   committed under `manifests/o/OpenExtract/OpenExtract/<version>/`
   (type that path into the commit's file name box before uploading).
3. Open the pull request titled `New package: OpenExtract.OpenExtract version <version>`
   and sign Microsoft's Contributor License Agreement when the bot asks.
4. Microsoft's bot installs the app silently in a clean Windows VM. Labels
   on the PR show the result; `Validation-Unattended-Failed` means that install
   didn't finish on its own (what happened to the v0.5.1 attempt, #424355,
   under the old ID `OpenExtractContributors.OpenExtract`). The Windows
   stores workflow runs the same `/S` install, so check it is green first.

Later versions are `Update: OpenExtract.OpenExtract version <version>` PRs
with the new folder.

## Chocolatey

Push from GitHub, no Windows machine needed: add the API key from your
community.chocolatey.org account as the `CHOCOLATEY_API_KEY` repository
secret, then run the Windows stores workflow by hand with
"Push to Chocolatey" ticked. Moderation takes a few days.

## Flathub

The first version goes in by a pull request to `flathub/flathub`, against
its `new-pr` branch (not `master`):

1. Fork `flathub/flathub` with "Copy the master branch only" unticked, so the
   fork has `new-pr`.
2. In the fork, switch to `new-pr`, create a branch from it, and upload every
   file in `flathub/` to the top level: the `.yml` manifest, `.desktop`,
   `.metainfo.xml`, `.svg` and `flathub.json` (which limits the build to
   x86_64, the only `.deb` we ship).
3. Open the pull request into `flathub/flathub:new-pr`, titled
   `Add app.openextract.OpenExtract`, and fill in its checklist.
   Reviewers start a test build by commenting `bot, build`.
4. Once accepted, Flathub creates `flathub/app.openextract.OpenExtract` and
   invites you; later versions are pull requests there.
5. Then log in to flathub.org, open the app in the Developer Portal, copy
   the verification token, and add it under the app ID in
   `website/static/.well-known/org.flathub.VerifiedApps.txt`.

Reviewers may ask about two choices, both explained in comments in the
manifest: it repackages the release `.deb` instead of building from source,
and it asks for the home folder because that is where iPhone backups live.
In a Flatpak the app turns off its own updater, since Flathub updates it.
