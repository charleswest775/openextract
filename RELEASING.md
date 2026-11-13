# Releasing OpenExtract

The release itself is one workflow run. What takes care is everything around it: the checks
before, the merge after, and the stores and download sites outside this repo that only learn
about a new version if someone tells them. This file lists all of it in order.

## 1. Before the release

- [ ] Run **Pre-release check** (Actions tab) on `main` and wait for it to pass. `release.yml`
      always tags and publishes, so this is the only dry run: it builds the engine and app on
      Linux, macOS and Windows, runs the backup corpus and every end-to-end suite. Its summary
      gives the ios-backup-core commit it tested: copy that SHA for the release.
- [ ] Read the changes under `## [Unreleased]` in `CHANGELOG.md` as someone who uses the app
      would: they become the release's "What's new" section (step 3). The workflow never edits
      the changelog.
- [ ] Credentials that have broken releases before:
  - Apple: if notarization answers 403 "A required agreement is missing", accept the new
    agreement at developer.apple.com/account.
  - Azure Trusted Signing: the `AZURE_CLIENT_SECRET` repository secret expires around
    October 2028.

## 2. The release

- [ ] Run **Release** (Actions tab) with the new version, for example `0.13.0`, and in
      **ios_backup_core_ref** the SHA the Pre-release check tested (left blank, it takes
      ios-backup-core's `master` as it is when the run starts). It takes about 25 to 30 minutes.
      On its own it:
  - creates `release/vX.Y.Z` with the version in `package.json`, the version pill and file names
    in `website/static/index.html`, and the `/download/*` redirects in
    `website/static/vercel.json`;
  - builds every OS against that one ios-backup-core commit, and names it in the run summary
    and at the foot of the release notes;
  - tags it, builds, signs (Windows), notarizes (macOS) and uploads every file;
  - gives Windows updates their own copy of the installer, `OpenExtract-Update-X.Y.Z.exe`,
    which `latest.yml` names, so download counts tell updates from new installs
    (`scripts/update-feed.mjs`);
  - runs the Windows App Control check on the draft (see `packaging/README.md`);
  - checks the `/download/*` redirects match the release's files, publishes, and opens the
    sync PR `chore: release vX.Y.Z`.
- [ ] If it fails: fix, delete the draft **and** the tag (`gh release delete vX.Y.Z --cleanup-tag`),
      and run it again. The app's updater only sees published releases, so nobody gets a draft.
      If it failed after pushing the tag but before making the draft, there's no draft to delete:
      delete the tag on its own with `git push origin :refs/tags/vX.Y.Z`. The next run starts
      `release/vX.Y.Z` again from `main` by itself.

## 3. Straight after publishing

- [ ] Add "What's new" to the release notes. The workflow publishes with only GitHub's generated
      list of PRs, so do this first. This takes the `[Unreleased]` changes from the changelog
      as it was at the tag (so nothing merged since creeps in), puts them above the generated
      list as **What's new in X.Y.Z** with `### Added` renamed `### New`, and keeps the rest of
      the notes, which end with the ios-backup-core commit:
      ```bash
      git fetch origin --tags
      { echo "## What's new in X.Y.Z"; git show vX.Y.Z:CHANGELOG.md | awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' | sed 's/^### Added$/### New/'; echo; gh release view vX.Y.Z --json body --jq .body; } > notes.md
      ```
      Read `notes.md`, then `gh release edit vX.Y.Z --notes-file notes.md`.
- [ ] Add a commit to `release/vX.Y.Z` that puts `## [X.Y.Z] - YYYY-MM-DD` under an empty
      `## [Unreleased]` in `CHANGELOG.md`.
- [ ] Merge the sync PR (if the workflow couldn't open it, open it by hand from
      `release/vX.Y.Z`). **Until it's merged, openextract.app's download buttons still give the
      old version.** Before merging:
  - Wait for the checks your changelog commit starts. The PR's first **CI** and **Installers**
    runs show "failure" with no jobs: the workflow opens the PR with `GITHUB_TOKEN`, so those
    first runs never get any jobs. They aren't real failures.
  - Check the changelog that `main` will end up with. A PR merged to `main` while the release
    ran added its line under `[Unreleased]` there, and the merge can put that line under
    `[X.Y.Z]` instead, in a release it isn't in:
    ```bash
    git fetch origin main release/vX.Y.Z
    git diff vX.Y.Z "$(git merge-tree --write-tree origin/main origin/release/vX.Y.Z | head -n1)" -- CHANGELOG.md
    ```
    Any line added under `[X.Y.Z]` that isn't from your changelog commit came from such a PR:
    move it back under `[Unreleased]` in another commit to `release/vX.Y.Z`.
- [ ] After Vercel deploys, check each stable link gives the new file (`/download/<platform>` is
      a page; its `/file` is the redirect to the release's file):
      ```bash
      for p in windows mac linux linux-appimage; do curl -sI https://www.openextract.app/download/$p/file | grep -i '^location'; done
      ```
- [ ] Flatpak files, in a PR (the **Flatpak** workflow builds and lints them):
  - in `packaging/flathub/app.openextract.OpenExtract.yml`, point the `.deb` source at the new
    release and change its `sha256` to the bare hex (shown on the release page next to the
    file, or
    `gh api repos/charleswest775/openextract/releases/tags/vX.Y.Z --jq '.assets[] | select(.name|endswith(".deb")) | .digest | ltrimstr("sha256:")'`);
  - add a `<release>` entry at the top of `<releases>` in
    `packaging/flathub/app.openextract.OpenExtract.metainfo.xml`, in plain words.
  These matter now for the Flatpak build, and become a Flathub update once it's listed there.

## 4. Outside this repo

Every place OpenExtract is listed or downloadable. **Needs a step** rows go stale silently if
skipped. When adding a new listing, give it the stable `https://www.openextract.app/download/<platform>`
links instead of a versioned GitHub file wherever the form takes a link, and add a row here.

### Needs a step every release

| Where | What to do |
|---|---|
| winget (`OpenExtract.OpenExtract`) | Add `packaging/winget/<version>/` and open an `Update: OpenExtract.OpenExtract version <version>` PR to microsoft/winget-pkgs. Steps in `packaging/README.md`. |
| Chocolatey (`openextract`) | Bump `packaging/chocolatey/`, then run **Windows stores** with "Push to Chocolatey" ticked. Moderation takes a few days. Steps in `packaging/README.md`. |
| Uptodown (two apps: Windows and Mac) | In the Uptodown developer console, open each app → Files → **+ Add new version**, tick "Use url" and paste the release's GitHub link to the `.exe` (Windows app) or `.dmg` (Mac app), with the version. This works while the app is still in review too. The minimum and maximum OS fields reset with each new version, so set them again. Add a line under "New features", then Submit for review. Uptodown's editors may also add versions themselves. |
| Softonic (once listed) | In the Softonic Publishing Center, upload the new `.exe` and `.dmg` (both must be signed, which they are). |
| MacUpdate (once listed) | Submit the new version number and a one-line "What's new" (the download link is the stable one, so it doesn't change). |

### Updates itself (check now and then)

| Where | Why nothing is needed |
|---|---|
| openextract.app | The sync PR moves the download links and the version pill; other pages don't name the current version. |
| GitHub releases | The release itself; the in-app updater reads it. |
| SourceForge (once mirrored) | GitHub integration copies each release automatically, as long as the files are on the release when it's published (the workflow uploads everything before publishing). |
| FileHorse, MajorGeeks, TechSpot | Their editors track new versions. If a listing still shows an old version a week later, send them the stable links. |
| AlternativeTo, OpenAlternative | No version or file on the listing. Update the features or screenshots there when the app changes visibly. |

## 5. Afterwards

- [ ] If the release fixes a problem listed in `website/static/api/_lib/known-fixes.js`, set its
      `fixedIn` to the new version and its text to "update to X.Y.Z", then run
      `node scripts/build-fixes-page.mjs` to rebuild `fixes.html` (`npm test` fails until you do).
- [ ] If the listings' facts changed (new data types, new platform, new screenshots), update
      `website/static/llms.txt`, the README's feature list, and the listings that show features.
- [ ] Merge any PR that announces a feature new in this release (site pages, `llms.txt`, the
      README) only now: after the sync PR has merged and the stable links above give the new
      version. Keep such a PR a draft until then. Merged earlier, the pages promise a feature that
      the download buttons don't have yet.

## Bumping pymobiledevice3

`python/requirements.txt` pins one exact pymobiledevice3 version, so CI, the Pre-release check
and the release all build with the same one. It ships 11.x releases almost daily, and the
engine turns some of its error messages into plain words by matching how they're worded
(`python/device_backup.py`), so a new version can change what users see. Nothing moves the
pin by itself. To move it, in its own PR and not in the days just before a release:

- [ ] Read pymobiledevice3's release notes since the pinned version for anything about
      backups (MobileBackup2, DeviceLink), usbmuxd, pairing or error messages.
- [ ] Change the pin. CI's fake-iPhone tests (`python/tests/test_fake_iphone_backup.py`, all three
      OSes) run pymobiledevice3's real backup code against a scripted iPhone, including errors
      whose wording the engine matches, such as the iPhone's "not enough space" and "device
      locked" refusals.
- [ ] Back up a real iPhone with the dev app, on a Mac and on Windows, once with encryption on.
- [ ] The Pre-release check before the next release then covers the packaged engine.
