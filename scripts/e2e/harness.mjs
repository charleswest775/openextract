// Shared plumbing for the end-to-end suites in scripts/e2e/suites: launching OpenExtract under
// Playwright, finding things on screen, the shared Save dialog and in-app notices, and
// recording checks and timings. See scripts/e2e/run.mjs for how a run is put together.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const num = s => (s == null ? null : Number(String(s).replace(/,/g, '')));

// ── Results ──────────────────────────────────────────────────────────────────

export const results = { platform: `${process.platform}-${process.arch}`, started: new Date().toISOString(), checks: [], timings: [] };
let currentSuite = '';
export function setSuite(name) { currentSuite = name; }

// Checks that fail because of a known app bug, by full name ("suite: check"). Like the corpus's
// known_issues.json these are strict: a listed check that passes fails the run, so the entry
// gets removed in the PR that fixes the bug.
const KNOWN = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'e2e', 'known-issues.json'), 'utf-8'))
  .issues.filter(i => !i.platforms || i.platforms.includes(process.platform)).map(i => [i.check, i.reason]));

export function check(name, ok, detail) {
  const full = `${currentSuite}: ${name}`;
  const known = KNOWN[full];
  if (known !== undefined) {
    const entry = { name: full, ok: !ok, xfail: true, reason: known, detail };
    results.checks.push(entry);
    console.log(ok ? `FAIL ${full} — listed in scripts/e2e/known-issues.json but passes now: remove the entry` : `XFAIL ${full} (${known})`);
    return !!ok;
  }
  results.checks.push({ name: full, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${full}${detail !== undefined && !ok ? ' — ' + JSON.stringify(detail).slice(0, 1500) : ''}`);
  return !!ok;
}

// Timings feed the performance budgets in scripts/e2e/budgets.json. Budgets are per OS and
// generous enough for a slow CI runner; going over one fails the run. Every timing is kept in
// results.json, so slowdowns show up as a trend before they cross a budget.
const BUDGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'e2e', 'budgets.json'), 'utf-8'));
export function timing(name, ms) {
  const budget = BUDGETS[name]?.[process.platform] ?? BUDGETS[name]?.default;
  results.timings.push({ name, ms: Math.round(ms), budget });
  console.log(`TIME ${name}: ${Math.round(ms)} ms${budget ? ` (budget ${budget})` : ''}`);
  if (budget) check(`${name} within ${budget} ms`, ms <= budget, { ms: Math.round(ms) });
}

export async function timed(name, fn) {
  const t0 = performance.now();
  const value = await fn();
  timing(name, performance.now() - t0);
  return value;
}

// ── Launching ────────────────────────────────────────────────────────────────

/** The Electron executable for the unpackaged development build in node_modules. */
function devElectron() {
  if (process.platform === 'darwin') return path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  return path.join(ROOT, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

/**
 * Starts OpenExtract with a throwaway profile (or `profile`, to test what a second launch
 * remembers). With `target.app` it starts that executable (a packaged or installed build);
 * otherwise the development build from this checkout, with the renderer from dist/ and the
 * engine from python/ (OPENEXTRACT_E2E=1, see electron/main.ts).
 */
export async function launch(target, { profile, extraArgs = [], env = {} } = {}) {
  const { _electron: electron } = require('playwright-core');
  const userData = profile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-profile-'));
  const args = [`--user-data-dir=${userData}`, ...extraArgs];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const options = { args, timeout: 120_000, env: { ...process.env, ...env } };
  if (target.app) {
    options.executablePath = target.app;
  } else {
    options.executablePath = devElectron();
    options.args.push(ROOT);
    options.cwd = ROOT;
    options.env.OPENEXTRACT_E2E = '1';
  }
  const t0 = performance.now();
  const app = await electron.launch(options);
  // Links the app opens in the browser are recorded instead (globalThis.__opened, read with
  // App.opened()): a real browser would open on the tester's screen, and on Linux the one it
  // starts keeps the app from closing, so the run hangs.
  // Right after launch the main process can still swap its execution context, and an
  // evaluate that lands then fails with "Execution context was destroyed" (seen on GitHub's
  // macOS runners on the first launch of a run). Wait a moment and try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await app.evaluate(({ shell }) => {
        globalThis.__opened = [];
        shell.openExternal = async url => { globalThis.__opened.push(['external', url]); };
      });
      break;
    } catch (e) {
      if (attempt >= 10 || !/Execution context was destroyed/.test(String(e?.message))) throw e;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.waitForLoadState('domcontentloaded');
  // The app is ready once the home screen offers to open a backup.
  // Interval polling, not requestAnimationFrame: a window that isn't painted (no display)
  // never fires animation frames.
  await page.waitForFunction(() => /Open a backup folder|All backups|Your backups/.test(document.body.innerText), null, { timeout: 120_000, polling: 250 });
  const launchMs = performance.now() - t0;
  return new App(app, page, errors, userData, launchMs);
}

// ── Driving the app ──────────────────────────────────────────────────────────

export class App {
  constructor(app, page, errors, profile, launchMs) {
    Object.assign(this, { app, page, errors, profile, launchMs });
  }

  /** Errors from the renderer, minus Chromium noise that isn't the app's. */
  seriousErrors() {
    return this.errors.filter(e => !/Autofill|DevTools|favicon|Electron Security Warning/i.test(e));
  }

  async close() { await this.app.close().catch(() => {}); }

  /** What the app asked the shell to open since the last call, as [kind, target] pairs. */
  opened() { return this.app.evaluate(() => globalThis.__opened.splice(0)); }

  eval(fn, arg) { return this.page.evaluate(fn, arg); }

  /** The next folder and file pickers answer with `dir` (and `dir/<suggested name>` for files). */
  stubDialogs(dir) {
    // Runs in the main process, where `require` isn't in scope; path.sep comes from this side.
    return this.app.evaluate(({ dialog }, [dir, sep]) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: dir + sep + String((o && o.defaultPath) || 'export').split(/[\\/]/).pop() });
    }, [dir, path.sep]);
  }

  /** The next pickers are cancelled. */
  cancelDialogs() {
    return this.app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
    });
  }

  text() { return this.page.evaluate(() => document.body.innerText); }

  /** Clicks the first button/link/tab whose text is `label` (or starts with it). */
  click(label, { within } = {}) {
    return this.page.evaluate(([label, within]) => {
      const root = within ? document.querySelector(within) : document;
      if (!root) return false;
      const els = [...root.querySelectorAll('button, a, [role="button"], [role="tab"], [role="radio"]')].filter(e => !e.disabled);
      const el = els.find(e => e.textContent?.trim() === label) ?? els.find(e => e.getAttribute('aria-label') === label)
        ?? els.find(e => e.textContent?.trim().startsWith(label));
      if (!el) return false;
      el.click();
      return true;
    }, [label, within ?? null]);
  }

  /** Waits until `fn` (run in the page) returns something truthy; returns it, or null on timeout. */
  async waitFor(fn, arg, ms = 30_000) {
    try {
      const handle = await this.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
      return await handle.jsonValue();
    } catch { return null; }
  }

  waitForText(re, ms = 30_000) {
    return this.waitFor(src => new RegExp(src, 'i').test(document.body.innerText), re.source, ms);
  }

  async home() {
    await this.page.evaluate(() => document.querySelector('.titlebar button[title=Home]')?.click());
    await this.waitFor(() => document.querySelector('button[aria-label^="Messages"], button[aria-label^="Timeline"]'), null, 15_000);
  }

  /** Closes the open backup ("All backups" is on its home page) and waits for the backups list. */
  async closeBackup() {
    await this.home();
    await this.click('All backups');
    return !!(await this.waitFor(() => !document.querySelector('.titlebar input[type=search]')
      && [...document.querySelectorAll('button')].some(b => b.textContent.includes('Open a backup')), null, 15_000));
  }

  /** The home page's tiles once their counts have loaded (they arrive after the page). */
  async homeTiles() {
    await this.home();
    await this.waitFor(() => /^Messages, [\d,]+$/.test(document.querySelector('button[aria-label^="Messages"]')?.getAttribute('aria-label') ?? ''), null, 30_000);
    return this.tiles();
  }

  /** The backup home page's tiles: { Messages: 1410, Photos: 170, Timeline: null, ... }. */
  tiles() {
    return this.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('button[aria-label]')]
      .map(b => b.getAttribute('aria-label').split(', '))
      .filter(([n]) => !['Help', 'Settings', 'Dismiss', 'Close'].includes(n))
      .map(([n, c]) => [n, c == null ? null : Number(c.replace(/,/g, ''))])));
  }

  /** Opens a screen from the backup home page by its tile or link text; resolves once `ready` matches. */
  async open(name, ready) {
    await this.home();
    const clicked = await this.page.evaluate(n => {
      const tile = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label').split(',')[0] === n);
      const el = tile ?? [...document.querySelectorAll('button, a')].find(b => b.textContent.trim().startsWith(n));
      if (!el) return false;
      el.click();
      return true;
    }, name);
    if (!clicked) return false;
    if (ready) return !!(await this.waitForText(ready, 60_000));
    await sleep(800);
    return true;
  }

  // In-app notices: role=status for "Saved …", role=alert for errors. Successes fade after a
  // few seconds, so trackNotices() records each one as it appears and waitNotice() reads that.
  notices() {
    return this.page.evaluate(() => [...document.querySelectorAll('[aria-live] > [role=status], [aria-live] > [role=alert]')]
      .map(n => ({ kind: n.getAttribute('role'), text: n.innerText.trim() })));
  }

  clearNotices() {
    return this.page.evaluate(() => document.querySelectorAll('[aria-live] button[aria-label=Dismiss]').forEach(b => b.click()));
  }

  /** From now on, record every notice that appears (window.__seenNotices). */
  trackNotices() {
    return this.page.evaluate(() => {
      window.__seenNotices = [];
      window.__noticeObserver?.disconnect();
      const seen = new Set();
      const scan = () => document.querySelectorAll('[aria-live] > [role=status], [aria-live] > [role=alert]').forEach(n => {
        if (seen.has(n)) return;
        seen.add(n);
        window.__seenNotices.push({ kind: n.getAttribute('role'), text: n.innerText.trim() });
      });
      window.__noticeObserver = new MutationObserver(scan);
      window.__noticeObserver.observe(document.body, { childList: true, subtree: true });
    });
  }

  /** The first notice since trackNotices(), waiting up to `ms` for one. */
  async waitNotice(ms = 120_000) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const n = await this.page.evaluate(() => window.__seenNotices ?? null);
      if (n === null) { const now = await this.notices(); if (now.length) return { ms: performance.now() - t0, notice: now[0] }; }
      else if (n.length) return { ms: performance.now() - t0, notice: n[0] };
      await sleep(100);
    }
    return { ms, notice: null };
  }

  /** The formats the open Save dialog offers. */
  saveFormats() {
    return this.waitFor(() => {
      const d = document.querySelector('[role=dialog]');
      return d && [...d.querySelectorAll('input[name=save-format]')].map(i => i.value);
    }, null, 10_000);
  }

  /** In the open Save dialog: pick a format (and one file per conversation or all in one), then Save. */
  async saveAs(format, mode) {
    await this.saveFormats();
    return this.page.evaluate(([format, mode]) => {
      const d = document.querySelector('[role=dialog]');
      // No format (or 'only'): take the first, for screens that offer just one.
      const radio = format && format !== 'only' ? d?.querySelector(`input[name=save-format][value=${format}]`) : d?.querySelector('input[name=save-format]');
      if (!radio) return false;
      radio.click();
      if (mode) [...d.querySelectorAll('input[name=save-mode]')][mode === 'merged' ? 1 : 0]?.click();
      const save = [...d.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save');
      save.click();
      return true;
    }, [format, mode ?? null]);
  }

  /** Clicks `button`, saves as `format` into a fresh folder, and returns the notice and files. */
  async exportTo(dir, button, format, { mode, within, timeoutMs } = {}) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await this.stubDialogs(dir);
    await this.clearNotices();
    await this.trackNotices();
    const t0 = performance.now();
    const clicked = typeof button === 'function' ? await button() : await this.click(button, { within });
    if (!clicked) return { clicked: false, files: [] };
    // Kinds with one format skip the Save dialog and start right away.
    const next = await this.waitFor(() => document.querySelector('[role=dialog] input[name=save-format]') ? 'dialog'
      : window.__seenNotices?.length ? 'notice' : null, null, 15_000);
    const saved = next === 'dialog' ? await this.saveAs(format, mode) : next === 'notice' ? 'no dialog' : false;
    const { notice } = await this.waitNotice(timeoutMs);
    // Some exports report before the last file is closed; give the folder a moment to settle.
    await sleep(300);
    return { clicked: true, saved, notice, ms: performance.now() - t0, files: listFiles(dir) };
  }

  /** Calls window.openextract.<path>(...args) in the renderer, through the preload bridge. */
  api(apiPath, ...args) {
    return this.page.evaluate(async ([apiPath, args]) => {
      const fn = apiPath.split('.').reduce((o, k) => o?.[k], window.openextract);
      if (typeof fn !== 'function') return { __missing: apiPath };
      try { return { value: await fn(...args) }; } catch (e) { return { __error: String(e?.message ?? e) }; }
    }, [apiPath, args]);
  }

  /** Opens the backup in `dir` from the welcome / backups screen; answers the password prompt if one appears. */
  async openBackup(dir, password) {
    await this.stubDialogs(dir);
    await this.waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Open a backup')), null, 15_000);
    const t0 = performance.now();
    if (!(await this.click('Open a backup folder')) && !(await this.click('Open a backup'))) {
      return { opened: false, error: 'no "Open a backup folder" button', screen: (await this.text()).slice(0, 300) };
    }
    let state;
    let unlockStarted = null;
    for (let i = 0; i < 1200; i++) {
      await sleep(100);
      state = await this.page.evaluate(() => ({
        password: !!document.querySelector('input[type=password]'),
        passwordError: document.querySelector('input[type=password]')?.closest('[role=dialog], form, div')?.querySelector('.text-apple-error')?.textContent.trim(),
        opened: !!document.querySelector('.titlebar input[type=search]'),
        error: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent.trim()).filter(Boolean)[0],
      }));
      if (state.opened || state.error) break;
      if (state.password && password !== undefined) {
        if (state.passwordError && unlockStarted) break;
        if (!unlockStarted) {
          await this.page.fill('input[type=password]', password);
          await this.click('Unlock');
          unlockStarted = performance.now();
        }
      } else if (state.password) break;
    }
    return { ...state, ms: performance.now() - t0, unlockMs: unlockStarted ? performance.now() - unlockStarted : undefined };
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Every file under `dir`, as paths relative to it with forward slashes. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    out.push(path.relative(dir, full).split(path.sep).join('/'));
  }
  return out.sort();
}

const MAGIC = {
  pdf: b => b.subarray(0, 5).toString() === '%PDF-',
  jpg: b => b[0] === 0xff && b[1] === 0xd8,
  jpeg: b => b[0] === 0xff && b[1] === 0xd8,
  png: b => b.subarray(1, 4).toString() === 'PNG',
  heic: b => b.subarray(4, 8).toString() === 'ftyp',
  mov: b => b.subarray(4, 8).toString() === 'ftyp' || b.subarray(4, 8).toString() === 'moov' || b.subarray(4, 8).toString() === 'wide',
  mp4: b => b.subarray(4, 8).toString() === 'ftyp',
  m4a: b => b.subarray(4, 8).toString() === 'ftyp',
  amr: b => b.subarray(0, 5).toString() === '#!AMR',
  html: b => /<html|<!doctype html/i.test(b.subarray(0, 2048).toString('utf-8')),
  vcf: b => b.subarray(0, 64).toString('utf-8').replace(/^﻿/, '').startsWith('BEGIN:VCARD'),
};

/** Whether `file` starts the way its extension says it should. Unknown extensions pass if non-empty. */
export function looksValid(file) {
  const b = fs.readFileSync(file);
  if (b.length === 0) return false;
  const ext = path.extname(file).slice(1).toLowerCase();
  return MAGIC[ext] ? MAGIC[ext](b) : true;
}

/** Rows in a CSV file (excluding the header), counting quoted newlines correctly. */
export function csvRows(file) {
  const s = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
  let rows = 0, inQuotes = false, sawContent = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '\n' && !inQuotes) { if (sawContent) rows++; sawContent = false; continue; }
    if (ch !== '\r') sawContent = true;
  }
  if (sawContent) rows++;
  return Math.max(0, rows - 1);
}

/**
 * Embedded photos in a PDF: images with a side over 200 px. Chromium also embeds color emoji
 * as small bitmaps on Linux and macOS but draws them as vectors on Windows, so the raw image
 * count differs by OS while the photo count doesn't.
 */
export function pdfStats(file) {
  const d = fs.readFileSync(file);
  const s = d.toString('latin1');
  let photos = 0;
  for (const [, dict] of s.matchAll(/\d+\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream/g)) {
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const side = Math.max(Number(dict.match(/\/Width\s+(\d+)/)?.[1] ?? 0), Number(dict.match(/\/Height\s+(\d+)/)?.[1] ?? 0));
    if (side > 200) photos++;
  }
  return {
    kb: Math.round(d.length / 1024),
    header: d.subarray(0, 5).toString() === '%PDF-',
    pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length,
    photos,
  };
}
