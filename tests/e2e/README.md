# Regression tests

## Running

```
npm install
npm run regression
```

One command. Works on macOS, Linux, Windows. It:

1. Creates `.venv`, clones `ios-backup-core` as a sibling, installs Python sidecar deps
2. Downloads Playwright's Chromium bundle (best-effort — Electron tests don't need it)
3. Builds Electron + renderer
4. Runs the Playwright suite (wraps with `xvfb-run` on headless Linux). Playwright's
   global setup generates the synthetic backups first.

Re-running is idempotent — cached steps skip quickly.

## The test backup

`tests/fixtures/build_fixture.py` generates a synthetic, fully fictional iPhone
backup laid out exactly like a real unencrypted iTunes/Finder backup
(`Manifest.db` + hashed file paths). It contains:

| Data | Contents |
|---|---|
| Contacts | 5 (phone numbers in mixed formats, one organization-only) |
| Messages | 4 conversations — 1:1 iMessage with a PNG attachment, 1:1 SMS, a named group chat, an unknown sender — plus one recently-deleted and one orphaned message |
| Calls | 6 records incl. FaceTime video; a missed call + same-minute voicemail that must dedupe |
| Voicemail | 2, with transcripts and AMR audio |
| Notes | 3, stored as gzipped protobuf like iOS NoteStore |
| Photos | 4 PNGs, one favorite with GPS, a "Vacation" album, one trashed (must be hidden) |
| Safari | 3 sites, 4 visits |

It's regenerated on every run into gitignored folders because the app reads
unencrypted backups in place. The values tests assert on live in `EXPECTED`
at the bottom of the builder and are written to `expected.json` alongside the
backup, so fixture and assertions can't drift apart.

A second backup has only the encrypted flag set — enough to drive the password
prompt, but it can't actually be decrypted.

## What's covered

- `smoke.spec.ts` — Electron + preload + Python sidecar boot and round-trip a `ping`.
- `backup.spec.ts` — opens the backup through the UI (dashboard renders); the encrypted
  variant shows the password dialog.
- `data.spec.ts` — calls every extractor through the real Electron → Python bridge and
  checks exact values: dashboard totals, contact-name resolution, message counts,
  attachment bytes, search, call/voicemail dedupe, note decoding, trashed-photo
  filtering, thumbnails, album counts, voicemail audio, browser history, and message
  recovery.
- `tabs.spec.ts` — walks every sidebar tab and asserts real fixture content is on
  screen (conversation text, contact names, photo thumbnails, note titles, history
  entries, recovered messages). Fails on any uncaught renderer error.

## Watching the tests run

Each spec takes ~2s. To step through one with the Playwright Inspector:

```
PWDEBUG=1 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/tabs.spec.ts
```

## Debugging a failure

Traces land in `test-results/` on failure:

```
npx playwright show-trace test-results/<name>/trace.zip
```

## CI

`.github/workflows/ci.yml` runs `npm run regression` on `ubuntu-latest`,
`macos-latest`, and `windows-latest` on every push and PR. Failed runs
upload trace artifacts.
