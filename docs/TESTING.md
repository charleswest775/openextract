# Testing OpenExtract

Every pull request is tested on Linux, macOS and Windows, from small unit tests up to the real
app driven end to end. The packages people download are tested by installing them. This page
says what each layer covers, how to run it, and how the suite keeps itself up to date.

All test data is fictional or public. The generated backups come from ios-backup-core's
`backupgen`: **maren** has every kind of data, **einstein** has only messages and contacts (for
empty states), and encrypted ones use the password `test`. Never test with a real person's
backup, and never put one in a screenshot, issue or log.

## The layers

| Layer | What it covers | Where | Runs |
|---|---|---|---|
| Renderer logic | every module in `src/lib`, the hooks' pure logic, dates in several time zones | `scripts/*.test.mjs` | every PR, 3 OSes |
| Electron main process | the engine client (`sidecar.ts`), every IPC handler, the updater, PDF export, feedback | `scripts/*.test.mjs` | every PR, 3 OSes |
| Engine | parsing, exports, error handling | `python/tests/test_*.py` | every PR, 3 OSes |
| Backing up an iPhone | the whole backup path (the engine, pymobiledevice3's MobileBackup2 and DeviceLink, files on disk) against a scripted fake iPhone: dropped and reset connections, unplugging, slow and full disks, folders in use, the iPhone's own errors, passcode waits, replayed traces; backups cut off partway and then opened | `python/tests/test_fake_iphone_backup.py`, `python/tests/test_unfinished_backup.py`, `python/tests/fake_iphone` | every PR, 3 OSes |
| Engine contract | every JSON-RPC method over stdin/stdout on generated backups, empty states, malformed requests, speed limits | `python/tests/test_rpc_contract.py` | every PR, 3 OSes |
| Corpus | generated backups against their answer keys; real public backups weekly | `python/tests/corpus` | every PR (generated), weekly (public) |
| End to end | the real app window: every screen, every export and format, the IPC bridge, recents, passwords, empty states, performance budgets, no network traffic | `scripts/e2e` | every PR on a development build, 3 OSes; before a release on the packaged app |
| Installers | dmg and zip, NSIS installer, deb and AppImage: install, layout, signatures, launch, upgrade, uninstall, update metadata, old Linux distros | `scripts/installers` | weekly, on PRs that touch packaging, and on every release's draft before it's published |

The workflows: `ci.yml` (every PR), `installers.yml` (weekly, packaging PRs, and called by
`release.yml`), `prerelease-check.yml` (called by `release.yml` on the new tag, or by hand), `corpus-weekly.yml`,
`windows-app-control.yml` (Smart App Control, called by `release.yml`).

## Running them

From the repository root, with the engine's Python environment set up as in the README:

```bash
npm test                              # renderer, main process, guards (about 5 s)
pytest python/tests/ -v               # engine and engine contract
pytest python/tests -m fake_iphone    # only the backups from the fake iPhone (python/tests/fake_iphone/README.md)
pytest python/tests/corpus -m corpus  # generated corpus (and any public items you fetched)
```

`npm test` also runs the engine client's checks against the real engine when it finds a Python
with the engine's dependencies (`$OPENEXTRACT_TEST_PYTHON`, then `.venv`, then `python3`).

End to end:

```bash
npm install --no-save playwright-core@1.59.1
python scripts/e2e/backups.py e2e-backups.json   # generates the test backups (photos download once, ~140 MB)
npm run build
npm run test:e2e                                  # all suites, about 2 minutes
node scripts/e2e/run.mjs --backups e2e-backups.json --suites screens,exports   # some suites
node scripts/e2e/run.mjs --list                   # what each suite covers
```

A window opens and clicks through the app by itself; leave it alone until it closes. On Linux
without a display, put `xvfb-run -a` in front. Results, timings and screenshots of the
fictional backups go to `e2e-out/`. `--app <path>` runs the suites against a packaged or
installed build instead of this checkout.

The installer tests install and uninstall OpenExtract on the machine they run on, so leave them
to CI (`installers.yml`) or run them in a throwaway VM:
`node scripts/installers/test-installers.mjs --dir release --backups e2e-backups.json`.

## Keeping the suite up to date

Guard tests fail CI when the app grows something the tests don't cover yet. Each failure says
exactly what to add:

- **A new engine method** in `python/main.py` → add a case to `CONTRACT` in `python/tests/test_rpc_contract.py`.
- **A new IPC channel** → wire it in `electron/preload.ts`, and test its handler in `scripts/main-ipc.test.mjs`.
- **A new function on `window.openextract`** → call it in `scripts/e2e/suites/ipc.mjs` and add it to `BRIDGE`.
- **A new screen** in `ExploreLayout` → visit it in `scripts/e2e/suites/screens.mjs` and add it to `SCREENS`.
- **A new export kind or format** on "Save to this computer" → export it in `scripts/e2e/suites/exports.mjs` and add it to `PANEL_EXPORTS`.
- **A new module in `src/lib`** → add a `scripts/<name>.test.mjs` that loads it.
- **A new performance budget** → measure it in a suite; `budgets.json` entries nothing measures fail.

When a fix changes what the app shows, update the suite in the same PR.

## Known issues

A test that exposes a bug nobody has fixed yet is kept as an expected failure, so CI stays green
and the bug stays visible:

- Python: `pytest.mark.xfail(strict=True, reason=...)`.
- JavaScript: `{ todo: 'BUG: ...' }`.
- End to end and installers: an entry in `scripts/e2e/known-issues.json` (optionally for some OSes).
- Corpus: `corpus/known_issues.json`.

All of them are strict: once the bug is fixed the test passes, the run fails, and the fix's PR
removes the entry.

## Performance

The engine contract test and the end-to-end suites time the things people wait for: starting
the app, opening a plain or encrypted backup, each screen, the photo grid, search, and each
export. Budgets are in `python/tests/test_rpc_contract.py` and `scripts/e2e/budgets.json`, set
at roughly three times what a GitHub-hosted runner measures, so they catch real slowdowns
rather than noise. Every timing is kept in the run's `results.json` artifact. Raise a budget
only with a reason in the PR.
