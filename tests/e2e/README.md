# Regression tests

## Running

```
npm install
npm run regression
```

One command. Works on macOS, Linux, Windows. It:

1. Creates `.venv`, clones `ios-backup-core` as a sibling, installs Python sidecar deps
2. Downloads Playwright's Chromium bundle (best-effort — Electron tests don't need it)
3. Regenerates the synthetic-backup fixtures
4. Builds Electron + renderer
5. Runs the Playwright suite (wraps with `xvfb-run` on headless Linux)

Re-running is idempotent — cached steps skip quickly.

## What's covered

- `smoke.spec.ts` — Electron + preload + Python sidecar boot and round-trip a `ping` call.
- `backup.spec.ts` — opens the unencrypted synthetic backup end-to-end (Dashboard h1 asserted); opens the encrypted variant and confirms the password dialog appears.
- `tabs.spec.ts` — after opening the fixture, walks every sidebar tab (Overview, Timeline, Messages, Photos, Contacts, Calls, Notes, Voicemail, Recover, Export) and asserts each panel renders; fails if any `pageerror` fires during the walk.

## Watching the tests run

Playwright is fast — each spec takes ~2s and the Electron window flashes by.
To step through an individual test:

```
PWDEBUG=1 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/backup.spec.ts
```

The Inspector pauses before each action. Click ▶ to advance.

To just watch at full speed (no Inspector) with a longer timeout:

```
npx playwright test --config tests/e2e/playwright.config.ts --timeout=0 tests/e2e/tabs.spec.ts
```

## Debugging a failure

Traces land in `test-results/` on failure. Open with:

```
npx playwright show-trace test-results/<name>/trace.zip
```

## CI

`.github/workflows/ci.yml` runs `npm run regression` on `ubuntu-latest`,
`macos-latest`, and `windows-latest` on every push and PR. Failed runs
upload trace artifacts.
