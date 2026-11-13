# Releasing OpenExtract

The release itself is one workflow run. What takes care is everything around it: the checks
before, the merge after, and the stores and download sites outside this repo that only learn
about a new version if someone tells them. This file lists all of it in order.

## 1. Before the release

- [ ] Make sure `## [Unreleased]` in `CHANGELOG.md` says everything users will notice, in words
      you're happy to publish. Start it with a short plain-words paragraph, above the `###`
      headings, when you can: the workflow uses that paragraph as the Flatpak's release notes
      (without one it uses the bullets, leaving out ones that start "Windows:" or "macOS:").
- [ ] Credentials that have broken releases before:
  - Apple: if notarization answers 403 "A required agreement is missing", accept the new
    agreement at developer.apple.com/account.
  - Azure Trusted Signing: the `AZURE_CLIENT_SECRET` repository secret expires around
    October 2028.

You don't need to run **Pre-release check** first any more: the release runs it. Run it by hand
when you want to know whether `main` (or a branch, or an ios-backup-core branch) would pass
before releasing.

## 2. The release

- [ ] Run **Release** (Actions tab) with the new version, for example `0.16.0`. It takes about
      15 to 20 minutes. On its own it:
  - creates `release/vX.Y.Z` with the version in `package.json`, `## [X.Y.Z] - <date>` under an
    empty `## [Unreleased]` in `CHANGELOG.md`, the version pill and file names in
    `website/static/index.html`, and the `/download/*` redirects in `website/static/vercel.json`;
  - tags it and creates a draft release;
  - side by side: builds, signs (Windows), notarizes (macOS) and uploads every file; runs the
    TypeScript checks, ruff and the Python tests; and runs **Pre-release check** on the tag (the
    backup corpus and every end-to-end suite on Linux, macOS and Windows);
  - gives Windows updates their own copy of the installer, `OpenExtract-Update-X.Y.Z.exe`,
    which `latest.yml` names, so download counts tell updates from new installs
    (`scripts/update-feed.mjs`);
  - tests the draft's signed packages: the Windows App Control check (see `packaging/README.md`)
    and installing, upgrading and uninstalling on fresh runners (`installers.yml`);
  - checks the `/download/*` redirects match the release's files, and publishes once all of the
    above has passed;
  - adds the winget, Chocolatey and Flatpak files for the new version to the release branch
    (`scripts/release-files.mjs`), and opens the sync PR `chore: release vX.Y.Z`.
- [ ] If it fails: fix, delete the draft **and** the tag (`gh release delete vX.Y.Z --cleanup-tag`),
      and run it again. The app's updater only sees published releases, so nobody gets a draft.
      A job that failed for a reason outside the code (a macOS runner that was never assigned,
      a test that passes on a second try) can be re-run instead: `gh run rerun <id> --failed`.

## 3. Straight after publishing

- [ ] Look over the sync PR, then merge it. It carries the version bump, the CHANGELOG
      heading, the website links and the `packaging/` files. If the run's summary says the
      packaging files weren't added, add them to the release branch by hand first
      (`packaging/README.md`). If the workflow couldn't open the PR, open it by hand from
      `release/vX.Y.Z`. **Until it's merged, openextract.app's download buttons still give the
      old version.**
- [ ] After Vercel deploys, check each stable link gives the new file:
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
| Uptodown (two apps: Windows and Mac) | In the Uptodown developer console, open each app → Files → **+ Add new version**, tick "Use url" and paste the release's GitHub link to the `.exe` (Windows app) or `.dmg` (Mac app), with the version. Add a line under "New features", then Submit for review. Uptodown's editors may also add versions themselves. |
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
