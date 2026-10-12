// Drive the OpenExtract Electron app (dev build) with Playwright.
//
// Start it once in the background:   node .claude/skills/run-openextract/driver.mjs
// then send one command per request: curl -s 127.0.0.1:7311 --data 'launch'
// The response body is the command's output. Commands are listed in COMMANDS below
// and in SKILL.md.
//
// Env: DRIVER_PORT (7311), SHOT_DIR (<tmp>/openextract-shots).
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(path.join(APP_DIR, 'package.json'));
const { _electron: electron } = require('playwright-core');
const PORT = Number(process.env.DRIVER_PORT || 7311);
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'openextract-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const ELECTRON = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron');

let app = null;
let page = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mainWindow(fn, arg) {
  return app.evaluate(({ BrowserWindow }, [source, a]) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'));
    return new Function('win', 'a', source)(win, a);
  }, [fn, arg]);
}

const COMMANDS = {
  // Launch with a throwaway profile, so the user's own "Recent" backups (real paths) never
  // show up in screenshots and nothing is written to their settings.
  async launch(profile) {
    if (app) return 'already launched';
    const userData = profile || fs.mkdtempSync(path.join(os.tmpdir(), 'openextract-profile-'));
    app = await electron.launch({ executablePath: ELECTRON, args: [`--user-data-dir=${userData}`, APP_DIR], cwd: APP_DIR, timeout: 60_000 });
    await app.firstWindow();
    await sleep(3000);
    page = app.windows().find(w => !w.url().startsWith('devtools://'));
    // Dev builds open DevTools docked into the window; close it and use a screenshot-friendly size.
    await mainWindow('win.webContents.closeDevTools(); win.setContentSize(1440, 900); win.center();');
    return `launched (profile ${userData}); window at ${page.url()}`;
  },
  // Point the window at a renderer. Dev Electron always loads 127.0.0.1:5179; use this when
  // Vite runs elsewhere. The preload bridge (window.openextract) survives navigation.
  async goto(url = 'http://127.0.0.1:5179') {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    return 'at ' + page.url();
  },
  async size(width, height) {
    await mainWindow('win.setContentSize(a[0], a[1]); win.center();', [Number(width), Number(height)]);
    return `content size ${width}x${height}`;
  },
  // Answer the native folder picker with this folder (Playwright can't click OS dialogs).
  async 'stub-folder'(folder) {
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    }, folder);
    return 'folder picker now returns ' + folder;
  },
  // The whole open flow: pick the folder, enter the password if asked, wait for the Overview.
  async 'open-backup'(folder, password) {
    await COMMANDS['stub-folder'](folder);
    const clicked = await COMMANDS['click-text']('Explore', 'my', 'data');
    if (clicked.includes('NOT_FOUND')) return clicked;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const state = await page.evaluate(() => ({
        password: !!document.querySelector('input[type=password]'),
        overview: document.body.innerText.includes('OVERVIEW'),
        error: [...document.querySelectorAll('[role=alert], .text-red-600, .text-apple-error')].map(e => e.textContent.trim()).filter(Boolean)[0],
      }));
      if (state.overview) return 'opened';
      if (state.password && password) {
        await page.fill('input[type=password]', password);
        await COMMANDS['click-text']('Unlock');
        password = null;
      } else if (state.password && password === undefined) {
        return 'password required: open-backup <folder> <password>';
      }
      if (state.error) return 'error: ' + state.error;
    }
    return 'timed out waiting for the Overview';
  },
  async tab(name) { return COMMANDS['click-text'](name); },
  async ss(name = `ss-${Date.now()}`) {
    const file = path.join(SHOT_DIR, name + '.png');
    await page.screenshot({ path: file });
    return 'screenshot: ' + file;
  },
  // Click via the DOM rather than coordinates: exact text first, then text that starts with it.
  async 'click-text'(...words) {
    const text = words.join(' ');
    const r = await page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
      const el = els.find(e => e.textContent?.trim() === t) ?? els.find(e => e.textContent?.trim().startsWith(t));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK: ' + el.textContent.trim().slice(0, 60);
    }, text);
    return `click-text ${JSON.stringify(text)} -> ${r}`;
  },
  async click(selector) { await page.click(selector, { timeout: 10_000 }); return 'clicked ' + selector; },
  async fill(selector, ...words) { await page.fill(selector, words.join(' ')); return 'filled ' + selector; },
  async press(key) { await page.keyboard.press(key); return 'pressed ' + key; },
  async wait(ms) { await sleep(Number(ms)); return 'waited ' + ms; },
  async text() { return (await page.evaluate(() => document.body.innerText)).slice(0, 6000); },
  async buttons() {
    return page.evaluate(() => [...document.querySelectorAll('button, a, [role="tab"], input')]
      .map(e => `${e.tagName.toLowerCase()} ${(e.textContent || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 60)}`)
      .filter(s => s.trim()).join('\n'));
  },
  // Run JavaScript in the page and return the result as JSON.
  async eval(...code) { return JSON.stringify(await page.evaluate(code.join(' '))); },
  async quit() {
    if (app) await app.close();
    app = null;
    setTimeout(() => process.exit(0), 200);
    return 'bye';
  },
};

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', async () => {
    const [command, ...args] = body.trim().split(/\s+/);
    try {
      if (command !== 'launch' && command !== 'quit' && !app) throw new Error('launch first');
      const fn = COMMANDS[command];
      res.end((fn ? await fn(...args) : `unknown command ${command}; try: ${Object.keys(COMMANDS).join(', ')}`) + '\n');
    } catch (e) {
      res.end('ERROR: ' + (e?.message || e) + '\n');
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`driver listening on 127.0.0.1:${PORT}; screenshots go to ${SHOT_DIR}`));
