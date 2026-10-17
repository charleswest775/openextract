---
name: run-openextract
description: Build, run and drive the OpenExtract desktop app (Electron + Python engine) with a test backup, and take screenshots of its screens. Use when asked to run, start, launch, screenshot or click through OpenExtract, open a backup in it, check a UI change in the real app, or run its Python tests.
---

OpenExtract is an Electron app whose renderer is a Vite/React dev server and whose engine is
`python/main.py`, spawned by Electron. Drive it with `.claude/skills/run-openextract/driver.mjs`:
a small Playwright `_electron` server you start once in the background and send commands to
with `curl`. All paths are relative to the repository root.

Verified on macOS (Apple silicon), Node 20, Python 3.11. Linux hasn't been tried with this driver.

## Setup

```bash
npm ci --no-audit --no-fund
npm install --no-save --no-audit --no-fund playwright-core@1.59.1
```

`npm ci` also downloads the Electron binary. Playwright isn't a project dependency, hence
`--no-save` (the next `npm ci` removes it again).

The engine needs a venv at the repository root. `python/requirements.txt` installs
ios-backup-core from `../../ios-backup-core`, which only resolves when the two repos are
siblings, so install it from an explicit checkout instead:

```bash
IOS_BACKUP_CORE=~/dev/openextract-suite/ios-backup-core   # your ios-backup-core checkout
python3 -m venv .venv
sed '/^-e /d' python/requirements.txt > .venv/requirements.txt
.venv/bin/pip install -q -r .venv/requirements.txt -e "$IOS_BACKUP_CORE"
```

## Build

```bash
npx tsc -p tsconfig.electron.json
```

This rewrites `dist-electron/`, which is committed (and usually stale). Put it back when you're
done: `git checkout -- dist-electron`.

## Test data

Use a synthetic backup from ios-backup-core's `backupgen`, never a real one. `maren` fills every
screen, `einstein` has only Messages and Contacts (empty states), `testpersona` is small and full
of edge cases. Encrypted ones use the password `test`. backupgen lives in the ios-backup-core
checkout (on `master` once ios-backup-core#14 merges):

```bash
OUT=$(mktemp -d)
(cd "$IOS_BACKUP_CORE" && "$OLDPWD/.venv/bin/python" -m backupgen generate maren --snapshot ios26 --password test --out "$OUT")
ls "$OUT"/*/
```

The backup folder is `$OUT/maren-ios26-encrypted/00008140-71766CB0FCFEEA02`. Maren's photos are
downloaded from Wikimedia Commons on first use (about 130 MB, cached in `~/.cache/backupgen/media`).

## Run (agent path)

1. **Start the renderer.** In Claude Code, `preview_start` the `openextract-renderer-any-port`
   configuration from `.claude/launch.json` and note the port it reports (5179 if free).
2. **Start the driver** in the background (in Claude Code, with `run_in_background`):

   ```bash
   node .claude/skills/run-openextract/driver.mjs
   ```

3. **Send commands** (one per request; the reply is the result):

   ```bash
   D() { curl -s --max-time 300 127.0.0.1:7311 --data "$*"; }
   D launch
   D goto http://127.0.0.1:54803        # the renderer port from step 1
   D open-backup "$OUT/maren-ios26-encrypted/00008140-71766CB0FCFEEA02" test
   D tab Messages
   D click-text Karin Lindqvist
   D eval "(() => { const imgs = [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().left > 400); imgs.at(-1)?.scrollIntoView({block: 'center'}); return imgs.length; })()"
   D ss verify-thread
   D quit
   ```

Screenshots go to `$TMPDIR/openextract-shots/<name>.png` (`SHOT_DIR` overrides), at 2880×1674
on a Retina screen (the window is 1440×900). **Look at them.**

| Command | Does |
|---|---|
| `launch [profile-dir]` | Starts Electron with a fresh throwaway profile, closes DevTools, sizes the window to 1440×900 |
| `goto [url]` | Points the window at a renderer (default `http://127.0.0.1:5179`) |
| `open-backup <folder> [password]` | Answers the folder picker, clicks "Explore my data", unlocks, waits for the Overview |
| `tab <name>` | Sidebar: Overview, Timeline, Messages, Photos, Contacts, Calls, Notes, Voicemail, History, Recover, Export |
| `click-text <text>` | Clicks the button/link whose text is, or starts with, `<text>` |
| `ss <name>` | Screenshot |
| `text`, `buttons` | The page's visible text; its buttons, links and inputs |
| `click <selector>`, `fill <selector> <text>`, `press <key>`, `wait <ms>` | As named |
| `stub-folder <folder>`, `size <w> <h>`, `eval <js>`, `quit` | As named |

## Test

```bash
.venv/bin/pip install -q -r python/requirements-dev.txt
.venv/bin/python -m pytest python/tests -q
```

## Gotchas

- **Your real profile leaks into screenshots.** A dev Electron uses the app's normal profile, whose
  "Recent" list shows the paths of real backups (including personal ones). `launch` always uses a
  fresh `--user-data-dir`; don't take screenshots any other way.
- **The window always loads `127.0.0.1:5179` first** (hard-coded, `strictPort`) and opens DevTools.
  If another worktree's Vite owns 5179, you'll silently get *its* renderer. `goto` your own port;
  the preload bridge (`window.openextract`) survives the navigation.
- **The folder picker is a native dialog** Playwright can't click. `open-backup`/`stub-folder`
  replace `dialog.showOpenDialog` in the main process.
- **In a git worktree, Node and Python fall back to the parent checkout.** Without `node_modules`
  here, Node resolves the parent's (missing newer deps); without `.venv` here, Electron walks up
  and uses the parent's venv, with whatever ios-backup-core it has. Install both in the unit.
- **`pytypedstream` imports as `typedstream`.**
- **Message threads open at the newest message.** To show a photo bubble, scroll to the last
  `img` in the thread (the `eval` above).
- **Photos have no full-size viewer yet** (`PhotoExplorer.handlePhotoClick` only opens videos), so
  clicking a photo does nothing.
- **Unlocking an encrypted backup takes 5–10 s**; `open-backup` waits for it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Vite overlay: `Failed to resolve import "@fontsource/fraunces/400.css"` | `npm ci` in this checkout (it was using a parent checkout's `node_modules`) |
| Engine: `ModuleNotFoundError` for `typedstream`/`pytypedstream` | The venv Electron found lacks the engine's deps: build `.venv` here as above |
| `preview_start`: port 5179 or 5180 in use by another chat's server | Use `openextract-renderer-any-port`, then `goto` the port it reports |
| `rm -rf node_modules` says "Directory not empty" | Something still had files open (a Vite server); stop it and rerun |
