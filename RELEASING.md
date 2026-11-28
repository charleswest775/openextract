# Releasing OpenExtract

The release itself is one workflow run. What takes care is everything around it: the checks
before, the merge after, and the stores and download sites outside this repo that only learn
about a new version if someone tells them. This file lists all of it in order.

## 1. Before the release

- [ ] Make sure `## [Unreleased]` in `CHANGELOG.md` says everything users will notice, in words
      you're happy to publish. Start it with a short plain-words paragraph, above the `###`
      headings, when you can: the workflow uses that paragraph as the Flatpak's release notes
      (without one it uses the bullets, leaving out ones that start "Windows:" or "macOS:").
- [ ] A release builds the ios-backup-core commit pinned in `ios-backup-core.ref` on `main`, not
      ios-backup-core's `master`. If ios-backup-core has fixes this release should ship, move the
      pin first: `scripts/bump-ios-backup-core.sh` (it prints what changed since the current pin),
      run the tests, open a PR with the new `ios-backup-core.ref` and merge it
      ([docs/TESTING.md](docs/TESTING.md#which-ios-backup-core)).
- [ ] The Mac and Windows apps carry the OpenExtract AI add-on pinned in `ai-addon.json`
      ([below](#openextract-ai)). If this release should ship a new add-on, publish it on
      openextract-ai-releases and move the pin first; the release fails if the pinned files
      aren't published there.
- [ ] Credentials that have broken releases before:
  - Apple: if notarization answers 403 "A required agreement is missing", accept the new
    agreement at developer.apple.com/account.
  - Azure Trusted Signing: the `AZURE_CLIENT_SECRET` repository secret expires around
    October 2028.

You don't need to run **Pre-release check** first any more: the release runs it. Run it by hand
when you want to know whether `main` (or a branch, or an ios-backup-core branch) would pass
before releasing.

## 2. The release

- [ ] Run **Release** (Actions tab) with the new version, for example `0.16.0`. Leave
      **ios_backup_core_ref** blank to build against the commit pinned in `ios-backup-core.ref`
      (bump it first, above, when ios-backup-core has fixes to ship), or give a branch, tag or
      full commit SHA. It takes about 15 to 20 minutes. On its own it:
  - picks one ios-backup-core commit (the pinned one, unless you gave another) that every job
    below builds and tests against, and names it in the run summary and at the foot of the
    release notes;
  - creates `release/vX.Y.Z` with the version in `package.json`, `## [X.Y.Z] - <date>` under an
    empty `## [Unreleased]` in `CHANGELOG.md`, and the version label in `website/static/index.html`;
  - tags it and creates a draft release;
  - side by side: builds, signs (Windows), notarizes (macOS) and uploads every file; runs the
    TypeScript checks, ruff and the Python tests; and runs **Pre-release check** on the tag (the
    backup corpus and every end-to-end suite on Linux, macOS and Windows);
  - gives Windows updates their own copy of the installer, `OpenExtract-Update-X.Y.Z.exe`,
    which `latest.yml` names, so download counts tell updates from new installs
    (`scripts/update-feed.mjs`);
  - tests the draft's signed packages: the Windows App Control check (see `packaging/README.md`)
    and installing, upgrading and uninstalling on fresh runners (`installers.yml`);
  - checks the release has every file the website's download links will give, and publishes
    once all of the above has passed;
  - checks openextract.app's download links give the new version. They follow the newest
    published release on their own (`website/static/api/_lib/download.js`), so they switch
    within a minute or two of publishing, without waiting for the sync PR;
  - adds the winget, Chocolatey and Flatpak files for the new version to the release branch
    (`scripts/release-files.mjs`), and opens the sync PR `chore: release vX.Y.Z`.
- [ ] If it fails: fix, delete the draft **and** the tag (`gh release delete vX.Y.Z --cleanup-tag`),
      and run it again. The app's updater only sees published releases, so nobody gets a draft.
      A job that failed for a reason outside the code (a macOS runner that was never assigned,
      a test that passes on a second try) can be re-run instead: `gh run rerun <id> --failed`.
      If preflight failed after pushing the tag but before making the draft, there's no draft
      to delete: delete the tag on its own with `git push origin :refs/tags/vX.Y.Z`. The next
      run starts `release/vX.Y.Z` again from `main` by itself.

## 3. Straight after publishing

- [ ] Add "What's new" to the release notes. The workflow publishes with only GitHub's generated
      list of PRs, so do this first. This takes the version's section of the changelog at the
      tag (preflight dated it there, so nothing merged since creeps in), puts it above the
      generated list as **What's new in X.Y.Z** with `### Added` renamed `### New`, and keeps
      the rest of the notes, which end with the ios-backup-core commit:
      ```bash
      git fetch origin tag vX.Y.Z
      { echo "## What's new in X.Y.Z"; git show vX.Y.Z:CHANGELOG.md | awk -v h='## [X.Y.Z]' 'index($0, h) == 1 {f=1; next} /^## \[/ {f=0} f' | sed 's/^### Added$/### New/'; echo; gh release view vX.Y.Z --json body --jq .body; } > notes.md
      ```
      Read `notes.md`, then `gh release edit vX.Y.Z --notes-file notes.md`.
- [ ] Look over the sync PR, then merge it. It carries the version bump, the CHANGELOG
      heading, the home page's written version label and the `packaging/` files. If the run's
      summary says the packaging files weren't added, add them to the release branch by hand
      first (`packaging/README.md`). If the workflow couldn't open the PR, open it by hand from
      `release/vX.Y.Z`. openextract.app's download links already give the new version. Before
      merging:
  - Expect no real checks on it. The workflow opens the PR and pushes its commits with
    `GITHUB_TOKEN`, and GitHub starts no runs for those: **CI** and **Installers** either don't
    appear or show "failure" with no jobs. That isn't a real failure, because the release run
    tested the tag. The packaging commit comes after the tag, though, so the Flatpak files are
    first linted once the PR merges. To run CI and the **Flatpak** lint on the PR first, close
    and reopen it. A commit you push to the branch starts real checks too: wait for those.
  - Check the changelog that `main` will end up with. A PR merged to `main` while the release
    ran added its line under `[Unreleased]` there, and the merge can put that line under
    `[X.Y.Z]` instead, in a release it isn't in:
    ```bash
    git fetch origin main release/vX.Y.Z
    git diff vX.Y.Z "$(git merge-tree --write-tree origin/main origin/release/vX.Y.Z | head -n1)" -- CHANGELOG.md
    ```
    The tag already has the dated `[X.Y.Z]` section, so any line this adds under `[X.Y.Z]`
    came from such a PR: move it back under `[Unreleased]` in a commit to `release/vX.Y.Z`.
- [ ] If the release run warned that the download links don't give the new version, check each
      stable link by hand:
      ```bash
      for p in windows mac linux linux-appimage; do curl -sI https://www.openextract.app/download/$p/file | grep -i '^location'; done
      ```
- [ ] Read the new `<release>` in `packaging/flathub/app.openextract.OpenExtract.metainfo.xml`.
      If it came from the bullets and reads badly, shorten it in a follow-up PR; it only needs
      to be right by the time Flathub picks it up.

## 4. Outside this repo

Every place OpenExtract is listed or downloadable. **Needs a step** rows go stale silently if
skipped. When adding a new listing, give it the stable `https://www.openextract.app/download/<platform>`
links instead of a versioned GitHub file wherever the form takes a link, and add a row here.

### Needs a step every release

| Where | What to do |
|---|---|
| winget (`OpenExtract.OpenExtract`) | Open an `Update: OpenExtract.OpenExtract version <version>` PR to microsoft/winget-pkgs with `packaging/winget/<version>/` (the release adds that folder). Steps in `packaging/README.md`. |
| Chocolatey (`openextract`) | Once the sync PR has merged (it updates `packaging/chocolatey/`), run **Windows stores** with "Push to Chocolatey" ticked. Moderation takes a few days. Steps in `packaging/README.md`. |
| Uptodown (two apps: Windows and Mac) | In the Uptodown developer console, open each app → Files → **+ Add new version**, tick "Use url" and paste the release's GitHub link to the `.exe` (Windows app) or `.dmg` (Mac app), with the version. This works while the app is still in review too. The minimum and maximum OS fields reset with each new version, so set them again. Add a line under "New features", then Submit for review. Uptodown's editors may also add versions themselves. |
| Softonic (once listed) | In the Softonic Publishing Center, upload the new `.exe` and `.dmg` (both must be signed, which they are). |
| MacUpdate (once listed) | Submit the new version number and a one-line "What's new" (the download link is the stable one, so it doesn't change). |

### Updates itself (check now and then)

| Where | Why nothing is needed |
|---|---|
| openextract.app | The download links and the home page's version label follow the newest published release (`website/static/api/_lib/download.js`); other pages don't name the current version. |
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
      README) only now: once the release is published and the stable links above give the new
      version. Keep such a PR a draft until then. Merged earlier, the pages promise a feature that
      the download buttons don't have yet.

## OpenExtract AI

The add-on is built in the private openextract-ai repository and published, as one `.mcpb` per
computer, on the public charleswest775/openextract-ai-releases. OpenExtract's Mac and Windows
builds carry the version pinned in `ai-addon.json`, so Ask AI's Install needs no download
(`scripts/ai-addon-pin.mjs`; Linux carries none and has no Ask AI). When the app carries a newer
add-on than the one someone installed, Ask AI offers Update. To ship a new add-on:

- [ ] In openextract-ai: tests on the Mac (three time zones) and the PC, then `packaging/build.py`
      for the Mac `.mcpb` (`--notarize openextract-notary`) and the Build add-on workflow for the
      Windows one. The Windows add-on must be signed: Smart App Control refuses unsigned code (#169),
      and Claude runs the add-on's program on the user's PC.
- [ ] Publish both files and `index.json` as a release `v<version>` on openextract-ai-releases.
      Marking it Latest also moves `openextract.app/ai/addon/index.json`, which older
      experimental builds download from.
- [ ] Put the version and both files' names, sizes and SHA-256s in `ai-addon.json` (the release's
      `index.json` has them), run `node scripts/ai-addon-pin.mjs fetch` on the Mac to check the
      pin against the published file, and open a PR. Its Installers check builds with it.
- [ ] Add a CHANGELOG line for what's new in the add-on, if people will notice.

To try an add-on before it's published: `node scripts/package-friends.mjs --mcpb <file>
--notarize openextract-notary --version <x.y.z-test.n>` builds a signed, notarized Mac app
carrying that file, published nowhere.

## Bumping pymobiledevice3

`python/requirements.txt` pins one exact pymobiledevice3 version, so CI, the Pre-release check
and the release all build with the same one. It ships 11.x releases almost daily, and the
engine turns some of its error messages into plain words by matching how they're worded
(`python/device_backup.py`), so a new version can change what users see. A new version can
also break backups outright: 0.15.0 picked up 11.54.0 on its own, which needed a package
metadata file the engine didn't bundle, and every backup failed (fixed in 0.15.1). Nothing
moves the pin by itself. To move it, in its own PR and not in the days just before a release:

- [ ] Read pymobiledevice3's release notes since the pinned version for anything about
      backups (MobileBackup2, DeviceLink), usbmuxd, pairing or error messages.
- [ ] Change the pin. CI's fake-iPhone tests (`python/tests/test_fake_iphone_backup.py`, all three
      OSes) run pymobiledevice3's real backup code against a scripted iPhone, including errors
      whose wording the engine matches, such as the iPhone's "not enough space" and "device
      locked" refusals. The Installers check on the PR builds the engine and runs its
      self-check, which loads every import the way the packaged app does.
- [ ] Check what `Mobilebackup2Service.backup()` and `change_password()` write into the folder
      they're given before the iPhone answers. OpenExtract never gives them a folder that holds a
      backup (`python/backup_beside.py`); any new call that takes a backup folder must not either.
- [ ] Back up a real iPhone with the dev app, on a Mac and on Windows, once with encryption on.
- [ ] Run **Pre-release check** by hand on the PR's branch for the packaged engine.

## Bumping Electron

- [ ] Check that `shell.trashItem` still fails when it can't use the Trash, rather than deleting
      (`shell/common/platform_util_*` in Electron's source at that version). Move to Trash for
      older backups depends on it (`python/trash_room.py` says what was measured).
