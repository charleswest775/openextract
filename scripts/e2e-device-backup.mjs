// End-to-end check of the "Back up my iPhone" screens: what a user sees before OpenExtract
// can reach an iPhone, and the steps that get them there. Windows users need Apple's
// usbmuxd, which only Apple's software provides (#184), so most of this is about Windows.
//
//   npm install --no-save playwright-core@1.59.1
//   node scripts/e2e-device-backup.mjs --out <dir> --app <app-executable> [options]
//   node scripts/e2e-device-backup.mjs --out <dir> --dev <renderer-url> [options]
//
// Run it from the repository root. --app drives a packaged build; --dev drives this
// checkout's Electron (node_modules/electron) against a running Vite renderer.
//
// With no options it checks what a computer without Apple software shows, as on
// GitHub's hosted runners (prerelease-check.yml):
//   Windows  the "Install Apple Devices first" card, with Install Apple Devices and Check again
//   Linux    the "Can't reach your iPhone" card, which says to install usbmuxd
//   macOS    no card (macOS always has usbmuxd): a device list or "No devices found"
// and that Check again brings the same card back (the engine survived the error).
//
// Options, for a Windows PC (the windows-smoke-test skill runs them on the test PC):
//   --apple-devices   the whole Windows sequence. The setup card: real if Apple Devices
//                     isn't installed, otherwise simulated by answering the first
//                     backup.list_devices with DEVICE_SERVICE_REQUIRED in the main process.
//                     Then stop Apple's service, click Install Apple Devices (winget if it
//                     isn't installed; either way the engine starts Apple's service), stop
//                     the service again and click Refresh (the engine starts it again), and
//                     read the device list.
//   --require-device  fail unless the device list shows at least one iPhone or iPad
//   --start-backup    back up the first device into a temporary folder until files arrive,
//                     then quit (which stops the backup) and delete the folder. Someone may
//                     need to unlock the iPhone or enter its passcode.
//
// Writes <out>/results.json and screenshots to <out>; exits 1 if any check failed.
// Screenshots can show the name of a connected iPhone, nothing else from it.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string' },
    app: { type: 'string' },
    dev: { type: 'string' },
    'apple-devices': { type: 'boolean', default: false },
    'require-device': { type: 'boolean', default: false },
    'start-backup': { type: 'boolean', default: false },
  },
});
if (!opts.out || !!opts.app === !!opts.dev) {
  console.error('usage: node scripts/e2e-device-backup.mjs --out <dir> (--app <app-executable> | --dev <renderer-url>) [--apple-devices] [--require-device] [--start-backup]');
  process.exit(2);
}
if (opts['apple-devices'] && process.platform !== 'win32') {
  console.error('--apple-devices is for Windows');
  process.exit(2);
}

const REPO = process.cwd();
const require = createRequire(path.join(REPO, 'package.json'));
const { _electron: electron } = require('playwright-core');
fs.mkdirSync(opts.out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { platform: `${process.platform}-${process.arch}`, app: opts.app || `dev ${opts.dev}`, checks: [], notes: [], devices: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  return !!ok;
};
const note = text => { results.notes.push(text); console.log('NOTE ' + text); };

// What the engine says on Windows when Apple Devices is missing (python/device_backup.py).
// The card shows its own words on Windows; only the prefix matters.
const DEVICE_SERVICE_REQUIRED = 'DEVICE_SERVICE_REQUIRED: To find your iPhone, OpenExtract needs Apple Devices, '
  + "Apple's free iPhone app for Windows, and it isn't installed. Install it from the Microsoft Store, then search again.";

// ── Apple's side, on Windows ───────────────────────────────────────────────────

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
}
const appleDevicesVersion = () => powershell('(Get-AppxPackage AppleInc.AppleDevices | Select-Object -First 1).Version') || null;

// Apple Devices' usbmuxd listens on 127.0.0.1:27015.
const usbmuxdListening = () => new Promise(resolve => {
  const socket = net.connect(27015, '127.0.0.1');
  const done = up => { socket.destroy(); resolve(up); };
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.setTimeout(1000, () => done(false));
});

async function stopAppleService() {
  powershell('Stop-Process -Name AppleMobileDeviceProcess, AppleMobileDeviceLauncher -Force -ErrorAction SilentlyContinue');
  for (let i = 0; i < 20 && await usbmuxdListening(); i++) await sleep(500);
  return check("Apple's service stopped (nothing on 127.0.0.1:27015)", !(await usbmuxdListening()));
}

// ── The app ────────────────────────────────────────────────────────────────────

function devElectron() {
  const dist = path.join(REPO, 'node_modules', 'electron', 'dist');
  return process.platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron');
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-device-profile-'));
  const args = [`--user-data-dir=${profile}`];
  if (opts.dev) args.push(REPO);
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await electron.launch({ executablePath: opts.app || devElectron(), args, cwd: REPO, timeout: 120_000 });
  await app.firstWindow();
  await sleep(3000);
  const page = app.windows().find(w => !w.url().startsWith('devtools://'));
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().startsWith('devtools://'));
    win.webContents.closeDevTools();
    win.setContentSize(1280, 820);
    win.center();
  });
  // A dev build loads 127.0.0.1:5179 first; point it at our renderer. The first load can
  // time out on Windows while Vite prepares its files, so try twice.
  if (opts.dev) {
    for (let attempt = 1; ; attempt++) {
      try { await page.goto(opts.dev, { timeout: 60_000 }); await page.waitForLoadState('networkidle'); break; }
      catch (e) { if (attempt === 2) throw e; }
    }
    errors.length = 0;  // whatever 127.0.0.1:5179 said before we got there
  }
  await page.waitForLoadState('domcontentloaded');
  return { app, page, errors, profile };
}

// Answer the first backup.list_devices with DEVICE_SERVICE_REQUIRED, as the engine does
// when Apple Devices isn't installed. Wraps the main process's sidecar:call handler
// (ipcMain keeps handlers in _invokeHandlers; Electron has no public way to wrap one).
function simulateMissingAppleDevices(app) {
  return app.evaluate(({ ipcMain }, message) => {
    const handlers = ipcMain._invokeHandlers;
    const real = handlers?.get('sidecar:call');
    if (!real) throw new Error("couldn't find the sidecar:call handler to wrap");
    let remaining = 1;
    handlers.set('sidecar:call', (event, method, params) => {
      if (method === 'backup.list_devices' && remaining > 0) {
        remaining--;
        return { success: false, error: message };
      }
      return real(event, method, params);
    });
  }, DEVICE_SERVICE_REQUIRED);
}

// The parts of the Back up my iPhone screen these checks look at.
function screenState(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const section = document.querySelector('section');  // "1. Select device"
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
    const card = ['Install Apple Devices first', "Can't reach your iPhone"].find(t => text.includes(t)) ?? null;
    const cardBox = card && [...document.querySelectorAll('p')].find(p => p.textContent.trim() === card)?.closest('div.rounded-lg');
    return {
      onScreen: [...document.querySelectorAll('h1')].some(h => h.textContent.trim() === 'Back up my iPhone'),
      scanning: text.includes('Scanning for devices') || buttons.includes('Scanning...'),
      installing: text.includes('Installing Apple Devices'),
      card,
      cardText: cardBox?.innerText.replace(/\s+/g, ' ').trim() ?? null,
      installButton: buttons.includes('Install Apple Devices'),
      checkAgainButton: buttons.includes('Check again'),
      installError: cardBox?.querySelector('.text-red-600')?.innerText.split('\n')[0].trim() ?? null,
      error: section?.querySelector('.bg-red-50')?.innerText.split('\n')[0].trim() ?? null,
      noDevices: text.includes('No devices found.'),
      devices: [...(section?.querySelectorAll('.space-y-2 > button') ?? [])].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
    };
  });
}

// Wait for a scan (or an install) to finish, then return what the screen shows.
async function settle(page, timeoutMs = 120_000) {
  const start = Date.now();
  let state;
  do {
    await sleep(500);
    state = await screenState(page);
    if (state.onScreen && !state.scanning && !state.installing
        && (state.card || state.error || state.noDevices || state.devices.length)) break;
  } while (Date.now() - start < timeoutMs);
  return { ...state, seconds: Math.round((Date.now() - start) / 100) / 10 };
}

const click = (page, label) => page.evaluate(t => {
  const els = [...document.querySelectorAll('button, a, [role="button"]')];
  const el = els.find(e => e.textContent?.trim() === t) ?? els.find(e => e.textContent?.trim().startsWith(t));
  if (!el) return false;
  el.click();
  return true;
}, label);
const shot = (page, name) => page.screenshot({ path: path.join(opts.out, `${name}.png`) });

async function openBackupScreen(page) {
  let found = false;
  for (let i = 0; i < 60 && !(found = await click(page, 'Back up my iPhone')); i++) await sleep(500);
  check('home page has "Back up my iPhone"', found);
  return settle(page);
}

const deviceListShown = s => !s.card && !s.error && (s.noDevices || s.devices.length > 0);

// ── Scenarios ──────────────────────────────────────────────────────────────────

// A computer without Apple's software (GitHub's runners).
async function withoutAppleSoftware({ page }) {
  const s = await openBackupScreen(page);
  await shot(page, 'device-setup');
  if (process.platform === 'win32') {
    check('Windows: "Install Apple Devices first" card', s.card === 'Install Apple Devices first', s);
    check('Windows: card offers Install Apple Devices and Check again', s.installButton && s.checkAgainButton);
  } else if (process.platform === 'linux') {
    check('Linux: "Can\'t reach your iPhone" card about usbmuxd', s.card === "Can't reach your iPhone" && /usbmuxd/.test(s.cardText), s);
    check('Linux: no Install button, a Check again button', !s.installButton && s.checkAgainButton);
  } else {
    check('macOS: a device list, no setup card', deviceListShown(s), s);
  }
  check('no red error box ("Report this problem")', !s.error, s.error);
  if (s.card) {
    await click(page, 'Check again');
    const again = await settle(page);
    check('Check again: same card (the engine answered again)', again.card === s.card && !again.error, again);
  }
}

// The whole Windows sequence, on a PC that may have Apple Devices and an iPhone.
async function appleDevicesSequence({ app, page }) {
  const before = appleDevicesVersion();
  note(before ? `Apple Devices ${before} is installed, so the setup card is simulated` : 'Apple Devices is not installed: the setup card is real, and Install runs winget');
  if (before) {
    await simulateMissingAppleDevices(app);
    await stopAppleService();
  }

  // 1. The setup card.
  const card = await openBackupScreen(page);
  await shot(page, '1-setup-card');
  check('setup card: "Install Apple Devices first"', card.card === 'Install Apple Devices first', card);
  check('setup card: Install Apple Devices and Check again', card.installButton && card.checkAgainButton);
  check('setup card: no red error box', !card.error, card.error);

  // 2. Install Apple Devices (winget if it's missing), which also starts Apple's service.
  await click(page, 'Install Apple Devices');
  await sleep(1000);
  const during = await screenState(page);
  await shot(page, '2-installing');
  const installed = await settle(page, 16 * 60_000);
  await shot(page, '3-after-install');
  check('Install Apple Devices: spinner while it works', during.installing || installed.seconds < 2, { seconds: installed.seconds });
  check('Install Apple Devices: no install error', !installed.installError, installed.installError);
  check('Install Apple Devices: device list, no card or error', deviceListShown(installed), installed);
  check('Install Apple Devices: Apple Devices installed', !!appleDevicesVersion());
  check("Install Apple Devices: Apple's service is running", await usbmuxdListening());
  note(`Install Apple Devices took ${installed.seconds + 1} s`);

  // 3. The engine starts Apple's service by itself when it's stopped.
  if (await stopAppleService()) {
    await click(page, 'Refresh');
    const restarted = await settle(page);
    await shot(page, '4-service-auto-started');
    check('stopped service, Refresh: device list, no card or error', deviceListShown(restarted), restarted);
    check("stopped service, Refresh: Apple's service is running again", await usbmuxdListening());
    note(`Refresh with Apple's service stopped took ${restarted.seconds} s`);
  }
}

async function deviceList({ page }) {
  const s = await settle(page);
  await shot(page, '5-device-list');
  results.devices = s.devices;
  note(s.devices.length ? `devices: ${s.devices.join(' | ')}` : 'no devices found');
  if (opts['require-device']) check('an iPhone or iPad is listed', s.devices.length > 0, s);
  return s;
}

// Start a backup of the first device and wait for files to arrive; quitting stops it.
async function startBackup({ app, page }, s) {
  if (!s.devices.length) return check('start a backup: a device to back up', false);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-device-backup-'));
  results.backupFolder = folder;
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, folder);
  await page.evaluate(() => document.querySelector('section .space-y-2 > button')?.click());
  await click(page, 'Choose...');
  await sleep(500);
  if (!check('start a backup: Start Backup clicked', await click(page, 'Start Backup'))) return;
  const start = Date.now();
  let last = '', progress = null, waitingShot = false;
  while (Date.now() - start < 10 * 60_000) {
    await sleep(2000);
    progress = await page.evaluate(() => {
      const box = [...document.querySelectorAll('p')].find(p => /^(Negotiating|Backing up|Finalizing)/.test(p.textContent.trim()))?.closest('div.rounded-lg');
      const failed = [...document.querySelectorAll('p')].find(p => /^(Backup failed|Trust required|Passcode required|Can't reach your iPhone)$/.test(p.textContent.trim()));
      return {
        text: box?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        files: Number(box?.innerText.match(/([\d,]+) \/ [\d,]+ files/)?.[1].replace(/,/g, '') ?? 0),
        failed: failed ? failed.closest('div.rounded-lg')?.innerText.replace(/\s+/g, ' ').trim() : null,
        done: document.body.innerText.includes('Backup complete!'),
      };
    });
    if (progress.text && progress.text !== last) { last = progress.text; console.log('  ' + last); }
    if (progress.failed || progress.done || progress.files > 0) break;
    if (!waitingShot && Date.now() - start > 30_000) {
      waitingShot = true;
      note('waiting on the iPhone: unlock it, and tap Trust or enter its passcode if it asks');
      await shot(page, '6-backup-waiting');
    }
  }
  await shot(page, '6-backup-started');
  check('start a backup: files arriving from the iPhone', progress?.files > 0 || progress?.done, progress);
  note(`the backup ran for ${Math.round((Date.now() - start) / 1000)} s, then was stopped`);
}

// ── Run ────────────────────────────────────────────────────────────────────────

let ctx;
try {
  ctx = await launch();
  if (opts['apple-devices']) await appleDevicesSequence(ctx);
  else await withoutAppleSoftware(ctx);
  if (opts['apple-devices'] || opts['require-device'] || opts['start-backup']) {
    const s = await deviceList(ctx);
    if (opts['start-backup']) await startBackup(ctx, s);
  }
} catch (e) {
  check('no exception', false, String(e.stack || e).slice(0, 800));
  if (ctx?.page) await shot(ctx.page, 'exception').catch(() => {});
} finally {
  if (ctx) {
    const serious = ctx.errors.filter(e => !/Autofill|DevTools|favicon/i.test(e));
    check('no renderer errors', serious.length === 0, serious.slice(0, 5));
    await ctx.app.close().catch(() => {});
    fs.rmSync(ctx.profile, { recursive: true, force: true, maxRetries: 5 });
  }
  // A backup of a real iPhone: don't leave it behind.
  if (results.backupFolder) fs.rmSync(results.backupFolder, { recursive: true, force: true, maxRetries: 5 });
}

results.passed = results.checks.every(c => c.ok);
fs.writeFileSync(path.join(opts.out, 'results.json'), JSON.stringify(results, null, 2));
console.log(results.passed ? 'All device-backup checks passed' : `${results.checks.filter(c => !c.ok).length} device-backup check(s) failed`);
process.exit(results.passed ? 0 : 1);
