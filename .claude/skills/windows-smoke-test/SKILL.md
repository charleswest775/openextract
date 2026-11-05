---
name: windows-smoke-test
description: Test OpenExtract on the real Windows test PC over SSH in one go — copy a commit (or install a release build), run the Python suite and npm test there, then drive Back up my iPhone in the signed-in user's session (setup card, Install Apple Devices, Apple's service auto-start, device list, optionally a real backup) and bring back screenshots. Use for any change that could behave differently on Windows, for device-backup changes, and before publishing a release.
---

Windows users are the majority, and their problems (Apple Devices missing, Smart App
Control, paths, a standard user account) don't show up on a Mac. This runs a commit or a
release on a real Windows PC the way a user runs it, and reports what it saw.

```bash
.claude/skills/windows-smoke-test/smoke.sh                       # HEAD, dev build
.claude/skills/windows-smoke-test/smoke.sh --working-tree        # with uncommitted changes
.claude/skills/windows-smoke-test/smoke.sh --release v0.11.0 --require-device --start-backup
```

Run it in the background (in Claude Code, `run_in_background`): the first run takes about
ten minutes (npm ci and the venv), later ones three or four. It streams the PC's log,
then prints a summary and where the results went (`$TMPDIR/openextract-windows-smoke/<run>/`).
**Look at the screenshots** in `device/`. Exit code 0 means everything passed.

## Setup (once per Mac)

`smoke.sh` reaches the PC with ssh/scp, using `~/.config/openextract/windows-smoke.env`:

```bash
OPENEXTRACT_SMOKE_HOST=user@host            # the Windows PC; OpenSSH server on, key login
OPENEXTRACT_SMOKE_SSH_OPTS="-o HostKeyAlias=..."   # optional extra ssh options
```

For the maintainer's PC the values are in Claude's notes (memory: the CI runner PC).
The PC needs Node and Git for Windows, someone signed in at its screen, and Windows's
own `tar` and `curl`. Python isn't needed: the first run unpacks python.org's NuGet
package into `%USERPROFILE%\oe-smoke\python`. ios-backup-core comes from your checkout
next to the main openextract checkout (`OPENEXTRACT_IOS_BACKUP_CORE` overrides it), at
`origin/master` like CI (`--ios-backup-core <ref>` for another).

## What it does

On the Mac, `smoke.sh` makes a `git archive` of the commit (or a tar of the working
tree, or the tag plus the release's `OpenExtract-Setup-*.exe`, drafts included) and of
ios-backup-core, copies them and `pc/*.ps1` to `%USERPROFILE%\oe-smoke\runs\<run>\` on the
PC, and starts `pc/start.ps1`. That registers `pc/run.ps1` as the scheduled task
`OE-Smoke` with an **Interactive, Limited** principal for whoever is signed in: an SSH
session is elevated and has no desktop, but the app runs in the user's session with a
standard token, so that's where the test runs. `run.ps1`:

1. checks it is in the console session and not elevated, and notes the Windows build,
   Apple Devices' and the installed OpenExtract's versions;
2. unpacks the code into `%USERPROFILE%\oe-smoke\repo`, keeping `node_modules` and `.venv`,
   which are rebuilt only when `package-lock.json` or the requirements change;
3. runs `pytest python/tests` and `npm test`;
4. starts the app: the dev build (Electron from `node_modules`, Vite on port 5290), or with
   `--release`, installs the release per user with `/S` and drives the installed app;
5. runs `scripts/e2e-device-backup.mjs --apple-devices`, which drives Back up my iPhone:
   - **the setup card** ("Install Apple Devices first"). With Apple Devices installed it is
     simulated (the first `backup.list_devices` answers `DEVICE_SERVICE_REQUIRED` in the
     main process); with `--fresh-apple-devices` it's real;
   - **Install Apple Devices**, with Apple's service stopped first: the engine runs winget
     if Apple Devices is missing, and starts Apple's service either way;
   - **auto-start**: stops Apple's service again and clicks Refresh; the engine must start it;
   - **the device list**; `--require-device` fails if no iPhone is listed;
   - `--start-backup` backs up the first device into a temp folder until files arrive, then
     quits (which stops the backup) and deletes the folder.
6. writes `summary.txt`, `results.json`, a `.txt` per step and the screenshots to `out\`,
   which `smoke.sh` copies back. It keeps the last ten runs on the PC.

## Ask the maintainer first

Running tests on the PC is fine. These change it, so ask in chat each time:

- `--release` installs that build over the PC's OpenExtract.
- `--fresh-apple-devices` uninstalls Apple Devices; the run's Install button installs it
  again with winget (accepting the Microsoft Store's and Apple's terms).

Every run with the app also stops and restarts Apple's iPhone service and talks to any
iPhone plugged in, which can show a Trust prompt on it. If someone else is working with
the iPhone on that PC, check with them first.

## Gotchas

- **The app opens on the PC's screen** during the run; leave it alone until the run says
  `Finished`. Screenshots are taken by Playwright, so a locked screen is fine.
- **One run at a time**: `start.ps1` refuses while `OE-Smoke` is running. A run that dies
  without writing `done.txt` shows as "stopped before it finished"; look at
  `%USERPROFILE%\oe-smoke\runs\<run>\out\log.txt`.
- **Its ports and folders are its own** (Vite 5290, `oe-smoke\`), so it can run beside
  another dev copy on the PC (the run-openextract skill's 5179/7311).
- **`--release` refuses while OpenExtract is running** on the PC; close it first.
- **Electron's installer sometimes unpacks only `locales\`** on that PC; `run.ps1` then
  unpacks the cached `electron-v*-win32-x64.zip` itself.
- **Nothing personal comes back** except the name of a connected iPhone in the device-list
  screenshot; `--start-backup` deletes the backup it made.
- `smoke.sh` talks to Windows's `cmd` over SSH and runs PowerShell files with `-File`:
  PowerShell reading a script from stdin silently drops everything after a multi-line block.

## Related

- CI covers what needs no iPhone on GitHub's `windows-latest`: `windows-device-support.yml`
  (dev build, real winget install), the pre-release check (packaged app) and the App
  Control check (signed engine). This skill adds a real PC, a standard user and an iPhone.
- `packaging/README.md`, "Before publishing: back up a real iPhone", uses this for releases.
- `.claude/skills/run-openextract/` drives the app interactively, one command at a time.
