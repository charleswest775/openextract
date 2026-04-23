# End-to-end regression tests

Playwright drives a real Electron build. Each spec in this folder launches the
app, exercises a user flow, and asserts on rendered UI plus JSON-RPC responses
from the Python sidecar.

## Why Playwright (not Selenium)

Selenium has no first-class Electron launcher; the historical answer
(Spectron) was archived in 2022. Playwright ships `_electron.launch` which
drives both the Electron main process and any `BrowserWindow`, handles
auto-waiting, and produces traces / videos for failed runs.

## How the harness boots the app

`tests/e2e/fixtures.ts` launches Electron against the **built** renderer
(`dist/index.html`) and a Python sidecar running directly from source
(`python/main.py`), not from the PyInstaller binary. Three env vars gate
test-only behavior in the product code:

| Env var | Effect |
|---|---|
| `OPENEXTRACT_TEST_MODE=1` | Replaces native file/folder dialogs with env-var paths. Playwright can't click OS pickers. |
| `OPENEXTRACT_PYTHON_FROM_SOURCE=1` | `electron/main.ts` spawns `python3 python/main.py` instead of the bundled engine binary. |
| `OPENEXTRACT_TEST_OPEN_PATH` | Return value of `dialog:selectFolder`. Points at the fixture backup. |
| `OPENEXTRACT_TEST_SAVE_PATH` | Return value of `dialog:saveFile` / `dialog:saveFolder`. |
| `OPENEXTRACT_TEST_PYTHON` | Optional: override the `python3` interpreter (e.g. a venv path). |
| `OPENEXTRACT_E2E_NO_SANDBOX=1` | Adds `--no-sandbox` to Electron args. Needed when running as root in CI/containers. |

## Running locally

```bash
# 1. Install Python sidecar deps (ios-backup-core must be a sibling checkout)
npm run python:install

# 2. Build the renderer and Electron main bundle
npm run build

# 3. Regenerate fixtures if build_fixture.py changed (files are committed)
npm run test:fixtures

# 4. Run the E2E suite
npm run test:e2e
```

On Linux headless environments (including CI) wrap with `xvfb-run`:

```bash
xvfb-run -a npm run test:e2e
# In containers running as root, also:
OPENEXTRACT_E2E_NO_SANDBOX=1 xvfb-run -a npm run test:e2e
```

Trace files land in `test-results/` on failure. Open them with
`npx playwright show-trace <trace.zip>`.

## Test fixture

`tests/fixtures/synthetic_backup/` is a committed, reproducible iPhone-backup
stub containing a valid `Manifest.db`, `Info.plist`, and `Manifest.plist`.
It is deliberately empty of user data — just enough structure for
`list_backups` and `open_backup` to recognize it as a backup. Regenerate
with `npm run test:fixtures`.

## Adding a new spec

1. Copy `smoke.spec.ts` as a template.
2. Import `{ test, expect }` from `./fixtures`.
3. Use the `firstWindow` fixture to get a `Page` handle.
4. Drive the UI with Playwright's built-in auto-waiting. Avoid `sleep`.
5. For sidecar assertions, call `firstWindow.evaluate(...)` and invoke
   `window.openextract.call(method, params)`.

## Scope and future layers

This harness covers the UI / main process / sidecar end-to-end. Out of
scope here:

- Python-side unit tests — lives in `python/tests/` (`npm run python:test`)
- Live device backup (2-hour `backup.start` flow) — stays manual
- CI integration — tests run locally only until the suite is proven
