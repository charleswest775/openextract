# End-to-end regression tests

Playwright drives a real Electron build. Each spec in this folder launches the
app, exercises a user flow, and asserts on rendered UI plus JSON-RPC responses
from the Python sidecar.

## Why Playwright (not Selenium)

Selenium has no first-class Electron launcher; the historical answer
(Spectron) was archived in 2022. Playwright ships `_electron.launch` which
drives both the Electron main process and any `BrowserWindow`, handles
auto-waiting, and produces traces / videos for failed runs.

## Quick start

```bash
# One-time: create venv, install Python + Playwright deps, build fixtures, build Electron.
npm install
npm run setup

# Run the suite.
npm run test:e2e                # macOS / Windows with a display
npm run test:e2e:ci             # Linux / headless — wraps with xvfb-run + --no-sandbox
```

`npm run test:e2e` runs `npm run build` first (see `pretest:e2e`). When
iterating on a single spec without touching product code, skip that with:

```bash
npm run test:e2e:fast -- -g "password dialog"
```

### Windows notes

- `npm run setup` works in PowerShell or `cmd`. It auto-detects the `py`
  launcher and falls back to `python` on PATH.
- Use `npm run test:e2e`, **not** `test:e2e:ci` — the latter is the
  Linux/CI wrapper and uses POSIX-only `xvfb-run`.
- If `npm run setup` fails at the `python` step, install Python 3.11+
  from python.org with "Add to PATH" checked.

## How the harness boots the app

`tests/e2e/fixtures.ts` launches Electron against the **built** renderer
(`dist/index.html`) and a Python sidecar running directly from source
(`python/main.py`), not from the PyInstaller binary. Each run gets a fresh
`--user-data-dir` so persisted state doesn't leak between tests. Env vars
gate test-only behavior in the product code:

| Env var | Effect |
|---|---|
| `OPENEXTRACT_TEST_MODE=1` | Replaces native file/folder dialogs with env-var paths. Playwright can't click OS pickers. |
| `OPENEXTRACT_PYTHON_FROM_SOURCE=1` | `electron/main.ts` spawns Python on `python/main.py` instead of the bundled engine binary. |
| `OPENEXTRACT_TEST_OPEN_PATH` | Return value of `dialog:selectFolder`. Points at the fixture backup. |
| `OPENEXTRACT_TEST_SAVE_PATH` | Return value of `dialog:saveFile` / `dialog:saveFolder`. |
| `OPENEXTRACT_TEST_PYTHON` | Optional: override the Python interpreter. Defaults to the project `.venv`, falling back to `python3`. |
| `OPENEXTRACT_E2E_NO_SANDBOX=1` | Adds `--no-sandbox` to Electron args. Needed when running as root in CI/containers. |

## Running individual specs

```bash
# By file
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/backup.spec.ts

# By test name
npx playwright test --config tests/e2e/playwright.config.ts -g "unencrypted"
```

Traces land in `test-results/` on failure. Open them with:

```bash
npx playwright show-trace test-results/<name>/trace.zip
```

## Test fixtures

`tests/fixtures/synthetic_backup/` and `tests/fixtures/synthetic_backup_encrypted/`
are committed, reproducible iPhone-backup stubs containing a valid
`Manifest.db`, `Info.plist`, and `Manifest.plist`. They are deliberately empty
of user data — just enough structure for `list_backups` and `open_backup`
to recognize them. Regenerate with `npm run test:fixtures`.

## Adding a new spec

1. Copy `smoke.spec.ts` or `backup.spec.ts` as a template.
2. Import `{ test, expect }` from `./fixtures`.
3. Use the `firstWindow` fixture to get a `Page` handle.
4. To drive a non-default backup path, `test.use({ backupPath: ... })`.
5. For sidecar assertions, call `firstWindow.evaluate(...)` and invoke
   `window.openextract.call(method, params)`.

## Scope and future layers

This harness covers the UI / main process / sidecar end-to-end. Out of
scope here:

- Python-side unit tests — lives in `python/tests/` (`npm run python:test`)
- Live device backup (2-hour `backup.start` flow) — stays manual
- CI integration — tests run locally only until the suite is proven
