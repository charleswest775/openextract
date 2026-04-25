# Regression tests

## Running

```
npm install
npm run regression
```

One command. Works on macOS, Linux, Windows. It:

1. Creates `.venv`, clones `ios-backup-core` as a sibling, installs Python sidecar deps
2. Downloads Playwright's Chromium bundle
3. Regenerates the synthetic-backup fixtures
4. Builds Electron + renderer
5. Runs the Playwright suite (wraps with `xvfb-run` on headless Linux)

Re-running is idempotent — cached steps skip quickly.

## What's covered

- `smoke.spec.ts` — the full stack boots and the Python sidecar responds.
- `backup.spec.ts` — opens unencrypted + encrypted backups end-to-end; asserts dashboard / password dialog.
- `tabs.spec.ts` — after opening the fixture, every sidebar tab (Dashboard, Timeline, Messages, Photos, Contacts, Calls, Notes, Voicemail, Record Recovery, Export) renders without throwing a renderer error.

## Debugging a failure

```
npx playwright show-trace test-results/<name>/trace.zip
```

## CI

`.github/workflows/ci.yml` runs `npm run regression` on ubuntu-latest, macos-latest, and windows-latest on every push to `main` or a `claude/**` branch and on every PR. Failed runs upload trace artifacts.
