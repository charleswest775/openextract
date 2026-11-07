// Tests for electron/main.ts: the IPC handlers it registers inside app.whenReady,
// the JSON state file behind them, and a guard that every IPC channel is wired
// through electron/preload.ts. Electron is stubbed (test-helpers/electron-env.mjs);
// so are ./sidecar, ./pdfExport and ./feedback* unless a test loads the real ones.
// Run with: node --test scripts/main-ipc.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  root,
  electronDir,
  createElectron,
  loadElectronModule,
  captureLongTimers,
  withInstantTimers,
  freshDir,
  quietConsole,
  waitFor,
  flush,
} from './test-helpers/electron-env.mjs';

// The channels the renderer relies on today. New ones are fine; the guard tests below
// make sure they're wired through preload.
const EXPECTED_CHANNELS = [
  'add-session', 'app:get-version', 'app:relaunch', 'clipboard:writeText', 'dialog:saveFile',
  'dialog:saveFolder', 'dialog:selectFolder', 'export:pdf', 'feedback:export-check-opt-out',
  'feedback:fixed-reports', 'feedback:get-diagnostics', 'feedback:mark-announced', 'feedback:saved-email',
  'feedback:send', 'fs:writeFile', 'get-app-state', 'get-recent-sessions', 'increment-export-count',
  'remove-session', 'set-first-launch-completed', 'shell:openExternal', 'shell:openPath',
  'shell:showItemInFolder', 'sidecar:call', 'text-size:get', 'text-size:set', 'updates:check',
  'updates:download', 'updates:get-state', 'updates:install', 'updates:set-auto-check',
];

// Development-only switches in main.ts that a developer's shell might have set.
for (const name of ['OPENEXTRACT_E2E', 'OPENEXTRACT_PYTHON', 'OPENEXTRACT_FEEDBACK_SITE']) delete process.env[name];

const quiet = quietConsole([
  'Python sidecar started', 'Failed to start Python sidecar', '[shell:openExternal]', 'Sidecar call failed',
  'PDF export failed', 'Failed to write app state', '[local-media]', '[pdf-export]',
]);
process.on('exit', () => quiet.restore());

// ── Fakes for main.ts's own modules ─────────────────────────────────────────

function fakeModules() {
  const f = { sidecars: [], updaterInits: [], pdfCalls: [], staleCleanups: 0, recorders: [], reports: [] };
  f.pdfAnswer = async () => ({ files: ['Mom.pdf'], message_count: 3 });

  class PythonSidecar {
    constructor(pythonPath, pythonArgs, logPath) {
      Object.assign(this, { pythonPath, pythonArgs, logPath, calls: [], starts: 0, stops: 0, running: false, notificationHandler: null });
      this.answer = async method => ({ answered: method });
      f.sidecars.push(this);
    }
    async start() {
      this.starts++;
      this.running = true;
    }
    async call(method, params, timeoutMs) {
      this.calls.push({ method, params, timeoutMs });
      // Like the real one: once stopped, calls fail.
      if (!this.running) throw new Error('Python sidecar is not running');
      return this.answer(method, params, timeoutMs);
    }
    stop() {
      if (this.running) this.stops++;
      this.running = false;
    }
  }

  class FeedbackRecorder {
    constructor(logPath, version) {
      Object.assign(this, { logPath, version, recorded: [] });
      f.recorders.push(this);
    }
    recordCall(method, params, outcome) {
      this.recorded.push({ method, params, outcome });
    }
    diagnostics(reportedError) {
      return { reportedError, appVersion: this.version };
    }
  }

  class FeedbackReports {
    constructor(store, fetch, version, site) {
      Object.assign(this, { store, fetch, version, site, sent: [], announced: [], due: false });
      f.reports.push(this);
    }
    async send(input) {
      this.sent.push(input);
      return { ok: true, reference: 'OE-7' };
    }
    fixedToAnnounce() {
      return [{ reference: 'OE-7' }];
    }
    markAnnounced(reference) {
      this.announced.push(reference);
    }
    async checkIfDue() {
      return this.due;
    }
  }

  f.stubs = {
    './sidecar': { PythonSidecar },
    './updater': { initUpdater: options => f.updaterInits.push(options) },
    './pdfExport': {
      exportMessagesPdf: async (sidecar, method, params) => {
        f.pdfCalls.push({ sidecar, method, params });
        return f.pdfAnswer(method, params);
      },
      removeStaleStagingDirs: () => f.staleCleanups++,
    },
    './feedback': { FeedbackRecorder },
    './feedbackReports': { FeedbackReports },
  };
  return f;
}

function fakeAutoUpdater() {
  const au = new EventEmitter();
  au.isUpdaterActive = () => true;
  au.checkForUpdates = async () => {
    throw new Error('no network in tests');
  };
  return au;
}

/**
 * Load a fresh main.ts and wait for app.whenReady's handler to finish. `state` is
 * written to the state file first (an object as JSON, a string as is). With
 * `real`, the real updater, pdfExport and feedback modules are used (only the
 * engine is faked).
 */
async function loadMain({ userData = freshDir('main-userdata'), state, isPackaged = true, real = false } = {}) {
  const stateFile = path.join(userData, 'openextract-state.json');
  if (state !== undefined) fs.writeFileSync(stateFile, typeof state === 'string' ? state : JSON.stringify(state));
  const env = createElectron({ paths: { userData, temp: freshDir('main-temp') }, isPackaged });
  const fakes = fakeModules();
  const stubs = { electron: env.electron, 'electron-updater': { autoUpdater: fakeAutoUpdater() } };
  Object.assign(stubs, real ? { './sidecar': fakes.stubs['./sidecar'] } : fakes.stubs);

  const { timers } = await captureLongTimers(async () => {
    loadElectronModule('main', stubs);
    // clipboard:writeText is the last handler main.ts registers.
    await waitFor(() => env.handlers.has('clipboard:writeText'), { what: 'main.ts to finish starting' });
  });
  return {
    env,
    invoke: env.invoke,
    fakes,
    sidecar: fakes.sidecars[0],
    recorder: fakes.recorders[0],
    window: env.windows[0],
    timers,
    userData,
    stateFile,
    readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
  };
}

/** Run fn with process.platform reporting `platform`. */
async function asPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const sorted = list => [...list].sort();
const minus = (a, b) => sorted([...a].filter(x => !b.has(x)));

// ── Channel wiring ──────────────────────────────────────────────────────────

function channelsIn(files, pattern) {
  const found = new Set();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(pattern)) found.add(m[2]);
  }
  return found;
}

const mainSideFiles = fs
  .readdirSync(electronDir)
  .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== 'preload.ts')
  .map(f => path.join(electronDir, f));
const preloadFile = path.join(electronDir, 'preload.ts');
const handled = channelsIn(mainSideFiles, /ipcMain\.handle\(\s*(['"`])([^'"`]+)\1/g);
const sentToRenderer = channelsIn(mainSideFiles, /\.send\(\s*(['"`])([^'"`]+)\1/g);
const invoked = channelsIn([preloadFile], /ipcRenderer\.invoke\(\s*(['"`])([^'"`]+)\1/g);
const listened = channelsIn([preloadFile], /ipcRenderer\.on\(\s*(['"`])([^'"`]+)\1/g);

describe('IPC channel wiring', () => {
  test('main registers every channel the renderer relies on, each once', async () => {
    const m = await loadMain({ real: true }); // the stub ipcMain throws on a second handler, like Electron
    assert.deepEqual(minus(EXPECTED_CHANNELS, new Set(m.env.handlers.keys())), []);
  });

  test('the channel list read from the source matches what main registers at runtime', async () => {
    const m = await loadMain({ real: true });
    // If this fails, a handler is registered with a channel name the guard below can't read.
    assert.deepEqual(sorted(m.env.handlers.keys()), sorted(handled));
  });

  test('every ipcMain.handle channel is exposed by preload.ts', () => {
    assert.ok(handled.size >= EXPECTED_CHANNELS.length);
    assert.deepEqual(minus(handled, invoked), [], 'handled in main but preload.ts never invokes it');
  });

  test('every channel preload.ts invokes has a handler in main', () => {
    assert.deepEqual(minus(invoked, handled), [], 'preload.ts invokes it but nothing handles it');
  });

  test('every message main sends to the window is listened for in preload.ts, and the reverse', () => {
    assert.ok(sentToRenderer.size > 0);
    assert.deepEqual(minus(sentToRenderer, listened), [], 'main sends it but preload.ts never listens');
    assert.deepEqual(minus(listened, sentToRenderer), [], 'preload.ts listens but main never sends it');
  });
});

// ── Startup ─────────────────────────────────────────────────────────────────

describe('startup', () => {
  test('starts the engine with its log in userData and forwards its notifications to the window', async () => {
    const m = await loadMain();
    assert.equal(m.fakes.sidecars.length, 1);
    assert.equal(m.sidecar.starts, 1);
    assert.equal(m.sidecar.logPath, path.join(m.userData, 'python_log.txt'));
    assert.equal(m.recorder.logPath, m.sidecar.logPath);
    const exe = process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine';
    assert.equal(path.basename(m.sidecar.pythonPath), exe);
    assert.equal(path.basename(path.dirname(m.sidecar.pythonPath)), 'python');
    assert.deepEqual(m.sidecar.pythonArgs, []);

    const progress = { jsonrpc: '2.0', method: 'backup.progress', params: { percent: 5 } };
    m.sidecar.notificationHandler(progress);
    assert.deepEqual(m.window.webContents.sent, [['sidecar:notification', progress]]);
    m.window.destroyed = true;
    assert.doesNotThrow(() => m.sidecar.notificationHandler(progress));
  });

  test('the window is isolated from Node and makes no spell-check downloads', async () => {
    const m = await loadMain();
    const prefs = m.window.options.webPreferences;
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.spellcheck, false);
    assert.equal(path.basename(prefs.preload), 'preload.js');
    assert.deepEqual(m.env.sessions.get('<default>').spellChecker, [['enabled', false], ['languages', []]]);
    // A packaged build loads the built renderer from disk, with no dev tools.
    assert.equal(m.window.loaded[0][0], 'file');
    assert.ok(m.window.loaded[0][1].endsWith(path.join('dist', 'index.html')));
    assert.deepEqual(m.env.callsTo('openDevTools'), []);
  });

  test('cleans up old PDF staging folders and starts the updater with the store and window', async () => {
    const m = await loadMain();
    assert.equal(m.fakes.staleCleanups, 1);
    assert.equal(m.fakes.updaterInits.length, 1);
    const opts = m.fakes.updaterInits[0];
    assert.equal(opts.getWindow(), m.window);
    opts.store.set('updatesAutoCheck', true);
    assert.equal(m.readState().updatesAutoCheck, true);
  });

  test('the updater\'s beforeInstall stops the engine, so the installer can replace it', async () => {
    const m = await loadMain();
    await withInstantTimers(() => m.fakes.updaterInits[0].beforeInstall());
    assert.equal(m.sidecar.stops, 1);
    assert.equal(m.sidecar.running, false);
  });

  test('closing the last window stops the engine; Windows and Linux quit, macOS stays open', async () => {
    for (const [platform, quits] of [['win32', true], ['linux', true], ['darwin', false]]) {
      const m = await loadMain();
      await asPlatform(platform, () => m.env.app.emit('window-all-closed'));
      assert.equal(m.sidecar.stops, 1, platform);
      assert.equal(m.env.callsTo('app.quit').length, quits ? 1 : 0, platform);
    }
  });

  test('on macOS, reopening the window after closing it still has a working engine', async () => {
    const m = await loadMain();
    await asPlatform('darwin', async () => {
      m.env.app.emit('window-all-closed');
      m.window.destroyed = true; // the user closed it
      m.env.app.emit('activate');
      await waitFor(() => m.env.windows.length === 2, { what: 'a new window' });
    });
    const result = await m.invoke('sidecar:call', 'list_backups', {});
    assert.deepEqual(result, { success: true, data: { answered: 'list_backups' } });
  });
});

// ── shell:openExternal ──────────────────────────────────────────────────────

describe('shell:openExternal', () => {
  const allowed = [
    ['https://www.openextract.app/help', 'https://www.openextract.app/help'],
    ['http://example.com/a?b=c#d', 'http://example.com/a?b=c#d'],
    ['HTTPS://GitHub.com/charleswest775', 'https://github.com/charleswest775'],
    ['mailto:help@openextract.app?subject=Hi', 'mailto:help@openextract.app?subject=Hi'],
    ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'],
    ['ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K', 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K'],
  ];
  const rejected = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(document.cookie)',
    'file:///etc/passwd',
    'file:///C:/Windows/System32/calc.exe',
    'smb://attacker.example/share',
    'ms-msdt:/id PCWDiagnostic /skip force',
    'ms-settings:privacy',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/file',
    'tel:+15035550123',
    'openextract://anything',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    'ms-windows-store://pdp/?ProductId=SOMETHINGELSE',
    'not a url',
    '//example.com/no-scheme',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ];

  test('opens web and mail links, and the two app links the app shows', async () => {
    const m = await loadMain();
    for (const [url] of allowed) assert.equal(await m.invoke('shell:openExternal', url), undefined);
    assert.deepEqual(m.env.callsTo('shell.openExternal').map(([u]) => u), allowed.map(([, opened]) => opened));
  });

  test('refuses everything else without throwing', async () => {
    const m = await loadMain();
    for (const url of rejected) {
      await assert.doesNotReject(m.invoke('shell:openExternal', url), String(url));
    }
    assert.deepEqual(m.env.callsTo('shell.openExternal'), []);
  });

  test('the app links the renderer uses are the ones main allows', async () => {
    const m = await loadMain();
    const links = new Set();
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          for (const match of fs.readFileSync(p, 'utf-8').matchAll(/['"`]((?:x-apple\.systempreferences|ms-windows-store|ms-settings):[^'"`]*)['"`]/g)) {
            links.add(match[1]);
          }
        }
      }
    };
    walk(path.join(root, 'src'));
    assert.ok(links.size > 0, 'found no app links in src/');
    for (const link of links) await m.invoke('shell:openExternal', link);
    assert.deepEqual(sorted(m.env.callsTo('shell.openExternal').map(([u]) => u)), sorted(links));
  });
});

// ── Other shell, app, clipboard, dialog and file handlers ───────────────────

describe('small handlers', () => {
  test('shell:openPath, shell:showItemInFolder, clipboard:writeText, app:get-version, app:relaunch', async () => {
    const m = await loadMain();
    const file = path.join(m.userData, 'video.mov');
    assert.equal(await m.invoke('shell:openPath', file), '');
    assert.deepEqual(m.env.callsTo('shell.openPath'), [[file]]);

    await m.invoke('shell:showItemInFolder', file);
    for (const bad of ['', null, undefined, 42, {}]) await m.invoke('shell:showItemInFolder', bad);
    assert.deepEqual(m.env.callsTo('shell.showItemInFolder'), [[file]]);

    await m.invoke('clipboard:writeText', 'https://www.openextract.app');
    await m.invoke('clipboard:writeText', undefined);
    await m.invoke('clipboard:writeText', null);
    await m.invoke('clipboard:writeText', 12);
    assert.deepEqual(m.env.callsTo('clipboard.writeText').map(([t]) => t), ['https://www.openextract.app', '', '', '12']);

    assert.equal(await m.invoke('app:get-version'), '1.2.3');
    await m.invoke('app:relaunch');
    assert.deepEqual(m.env.callsTo('app.relaunch'), [[]]);
    assert.deepEqual(m.env.callsTo('app.exit'), [[0]]);
  });

  test('folder and file dialogs return the choice, or null when cancelled', async () => {
    const m = await loadMain();
    const chosen = path.join(m.userData, 'Backups');
    assert.equal(await m.invoke('dialog:selectFolder'), null);
    assert.equal(await m.invoke('dialog:saveFolder'), null);
    assert.equal(await m.invoke('dialog:saveFile', { title: 'Save contacts' }), null);

    m.env.dialogResults.open = { canceled: false, filePaths: [chosen] };
    m.env.dialogResults.save = { canceled: false, filePath: path.join(chosen, 'contacts.vcf') };
    assert.equal(await m.invoke('dialog:selectFolder'), chosen);
    assert.equal(await m.invoke('dialog:saveFolder'), chosen);
    const filters = [{ name: 'vCard', extensions: ['vcf'] }];
    assert.equal(await m.invoke('dialog:saveFile', { title: 'Save contacts', defaultPath: 'contacts.vcf', filters }), path.join(chosen, 'contacts.vcf'));
    assert.equal(await m.invoke('dialog:saveFile', {}), path.join(chosen, 'contacts.vcf'));

    const opens = m.env.callsTo('dialog.showOpenDialog');
    for (const [win] of opens) assert.equal(win, m.window, 'dialog not attached to the window');
    assert.deepEqual(opens[0][1].properties, ['openDirectory']);
    assert.deepEqual(opens[1][1].properties, ['openDirectory', 'createDirectory']);
    const saves = m.env.callsTo('dialog.showSaveDialog');
    assert.deepEqual(saves[1][1], { title: 'Save contacts', defaultPath: 'contacts.vcf', filters });
    assert.equal(saves[2][1].title, 'Save File');
  });

  test('fs:writeFile writes UTF-8 exactly, with no BOM and line endings untouched', async () => {
    const m = await loadMain();
    const file = path.join(freshDir('main-write'), 'Zoë 🙂 timeline.html');
    const content = '<p>Zoë 🙂 — café</p>\r\nline two\nline three';
    await m.invoke('fs:writeFile', file, content);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(content, 'utf-8'));
    await m.invoke('fs:writeFile', file, 'shorter');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'shorter');
  });
});

// ── Text size ───────────────────────────────────────────────────────────────

describe('text size', () => {
  test('text-size:set keeps valid sizes, zooms the window, and ignores unknown ones', async () => {
    const m = await loadMain();
    assert.equal(await m.invoke('text-size:get'), 'default');
    await m.invoke('text-size:set', 'large');
    assert.equal(await m.invoke('text-size:get'), 'large');
    assert.equal(m.readState().textSize, 'large');
    await m.invoke('text-size:set', 'larger');
    assert.deepEqual(m.window.webContents.zoomFactors, [1.15, 1.3]);

    for (const bad of ['huge', 'LARGE', '', ' large', null, undefined, 1.3]) await m.invoke('text-size:set', bad);
    assert.equal(await m.invoke('text-size:get'), 'larger');
    assert.equal(m.readState().textSize, 'larger');
    assert.deepEqual(m.window.webContents.zoomFactors, [1.15, 1.3]);
  });

  test('text-size:set ignores names that only exist on Object.prototype', async () => {
    const m = await loadMain();
    for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      await m.invoke('text-size:set', bad).catch(() => {});
    }
    assert.equal(await m.invoke('text-size:get'), 'default');
    for (const f of m.window.webContents.zoomFactors) assert.equal(typeof f, 'number');
  });

  test('the saved size is applied when the page loads, after a restart too', async () => {
    const userData = freshDir('main-userdata');
    const first = await loadMain({ userData });
    await first.invoke('text-size:set', 'large');
    const second = await loadMain({ userData });
    assert.deepEqual(second.window.webContents.zoomFactors, []);
    second.window.webContents.emit('did-finish-load');
    assert.deepEqual(second.window.webContents.zoomFactors, [1.15]);
  });

  test('a saved size that isn\'t one of the sizes loads at 100%', async () => {
    for (const textSize of ['toString', 'huge', 7]) {
      const m = await loadMain({ state: { textSize } });
      m.window.webContents.emit('did-finish-load');
      assert.deepEqual(m.window.webContents.zoomFactors, [1], String(textSize));
    }
  });
});

// ── App state: sessions, first launch, exports ──────────────────────────────

const session = (id, lastOpened, extra = {}) => ({ id, name: `Backup ${id}`, lastOpened, ...extra });

describe('app state', () => {
  test('get-app-state: first visit, then returned with no data, then has data', async () => {
    const m = await loadMain();
    let state = await m.invoke('get-app-state');
    assert.deepEqual(state, {
      state: 'first_visit',
      sessions: [],
      stats: { totalExports: 0 },
      totalDevices: 0,
      totalSizeGB: 0,
      totalMessages: 0,
      totalExports: 0,
    });
    await m.invoke('set-first-launch-completed');
    assert.equal((await m.invoke('get-app-state')).state, 'returned_no_data');
    await m.invoke('add-session', session('a', '2026-01-01T00:00:00Z'));
    state = await m.invoke('get-app-state');
    assert.equal(state.state, 'has_data');
  });

  test('get-app-state sorts sessions newest first and totals devices and sizes', async () => {
    const m = await loadMain({
      state: {
        firstLaunchCompleted: true,
        sessions: [
          session('old', '2025-03-01T10:00:00Z', { type: 'device', sizeGB: 64.5 }),
          session('newest', '2026-11-04T09:00:00Z', { type: 'folder', sizeGB: 1.5 }),
          session('middle', '2026-06-15T12:30:00+02:00', { type: 'device' }),
        ],
        stats: { totalExports: 9 },
      },
    });
    const state = await m.invoke('get-app-state');
    assert.deepEqual(state.sessions.map(s => s.id), ['newest', 'middle', 'old']);
    assert.equal(state.totalDevices, 2);
    assert.equal(state.totalSizeGB, 66);
    assert.equal(state.totalExports, 9);
    assert.deepEqual(state.stats, { totalExports: 9 });
  });

  test('a session without sessions saved but a first launch done counts as returned_no_data, even after removing the last one', async () => {
    const m = await loadMain({ state: { firstLaunchCompleted: true, sessions: [session('a', '2026-01-01T00:00:00Z')] } });
    assert.equal((await m.invoke('get-app-state')).state, 'has_data');
    await m.invoke('remove-session', 'a');
    assert.equal((await m.invoke('get-app-state')).state, 'returned_no_data');
  });

  test('add-session merges by id, puts the latest first and keeps 20', async () => {
    const m = await loadMain();
    await m.invoke('add-session', session('a', '2026-01-01T00:00:00Z', { type: 'device', sizeGB: 10, deviceName: 'iPhone' }));
    await m.invoke('add-session', session('b', '2026-01-02T00:00:00Z'));
    // Re-opening "a" updates it in place and moves it to the front, keeping fields it didn't send.
    await m.invoke('add-session', { id: 'a', lastOpened: '2026-02-01T00:00:00Z', sizeGB: 11 });
    let sessions = await m.invoke('get-recent-sessions');
    assert.deepEqual(sessions.map(s => s.id), ['a', 'b']);
    assert.deepEqual(sessions[0], { id: 'a', name: 'Backup a', lastOpened: '2026-02-01T00:00:00Z', type: 'device', sizeGB: 11, deviceName: 'iPhone' });

    for (let i = 0; i < 25; i++) await m.invoke('add-session', session(`s${i}`, `2026-03-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    sessions = await m.invoke('get-recent-sessions');
    assert.equal(sessions.length, 20);
    assert.equal(sessions[0].id, 's24');
    assert.equal(sessions[19].id, 's5');
    assert.ok(!sessions.some(s => s.id === 'a' || s.id === 'b'));
    assert.equal(m.readState().sessions.length, 20);
  });

  test('remove-session removes only that session and persists it', async () => {
    const m = await loadMain();
    for (const id of ['a', 'b', 'c']) await m.invoke('add-session', session(id, '2026-01-01T00:00:00Z'));
    await m.invoke('remove-session', 'b');
    await m.invoke('remove-session', 'not-there');
    assert.deepEqual((await m.invoke('get-recent-sessions')).map(s => s.id), ['c', 'a']);
    assert.deepEqual(m.readState().sessions.map(s => s.id), ['c', 'a']);
  });

  test('state survives a restart', async () => {
    const userData = freshDir('main-userdata');
    const first = await loadMain({ userData });
    await first.invoke('set-first-launch-completed');
    await first.invoke('add-session', session('a', '2026-01-01T00:00:00Z'));
    await first.invoke('increment-export-count');
    const second = await loadMain({ userData });
    const state = await second.invoke('get-app-state');
    assert.equal(state.state, 'has_data');
    assert.equal(state.totalExports, 1);
    assert.deepEqual(state.sessions.map(s => s.id), ['a']);
  });

  for (const [label, contents] of [
    ['truncated JSON', '{"sessions": [{"id": "a", "lastOp'],
    ['an empty file', ''],
    ['binary junk', '\u0000\u0000\u0000'],
    ['not JSON at all', 'hello'],
  ]) {
    test(`a state file with ${label} falls back to the defaults and is rewritten cleanly`, async () => {
      const m = await loadMain({ state: contents });
      assert.equal((await m.invoke('get-app-state')).state, 'first_visit');
      assert.equal(await m.invoke('text-size:get'), 'default');
      await m.invoke('text-size:set', 'large');
      const saved = m.readState();
      assert.equal(saved.textSize, 'large');
      assert.deepEqual(saved.sessions, []);
      assert.equal(saved.firstLaunchCompleted, false);
      assert.equal(saved.updatesAutoCheck, null);
    });
  }

  test('a state file from an older version gets the newer defaults for what it lacks', async () => {
    const m = await loadMain({ state: { firstLaunchCompleted: true, textSize: 'larger' } });
    assert.equal(await m.invoke('text-size:get'), 'larger');
    const state = await m.invoke('get-app-state');
    assert.equal(state.state, 'returned_no_data');
    assert.equal(state.totalExports, 0);
    assert.equal(await m.invoke('feedback:saved-email'), '');
  });
});

describe('after an export: share prompt and export check', () => {
  test('share prompt on the first export ever, then the export check once per run', async () => {
    const userData = freshDir('main-userdata');
    const run1 = await loadMain({ userData });
    assert.equal(await run1.invoke('increment-export-count', 'messages'), 1);
    assert.deepEqual(run1.env.senderSent, [['share-prompt:show']]);
    assert.equal(await run1.invoke('increment-export-count', 'calls'), 2);
    assert.deepEqual(run1.env.senderSent.at(-1), ['export-check:show', 'calls']);
    assert.equal(await run1.invoke('increment-export-count', 'notes'), 3);
    assert.equal(run1.env.senderSent.length, 2);
    assert.equal(run1.readState().sharePromptShown, true);
    assert.equal(run1.readState().stats.totalExports, 3);

    // Next run: no share prompt ever again; the export check comes back once.
    const run2 = await loadMain({ userData });
    assert.equal(await run2.invoke('increment-export-count', 42), 4);
    assert.equal(await run2.invoke('increment-export-count', 'photos'), 5);
    assert.deepEqual(run2.env.senderSent, [['export-check:show', undefined]]);
  });

  test('"Don\'t ask again" stops the export check, in this run and the next', async () => {
    const userData = freshDir('main-userdata');
    const run1 = await loadMain({ userData, state: { sharePromptShown: true } });
    await run1.invoke('feedback:export-check-opt-out');
    await run1.invoke('increment-export-count', 'messages');
    assert.deepEqual(run1.env.senderSent, []);
    assert.equal(run1.readState().exportCheckOptOut, true);

    const run2 = await loadMain({ userData });
    for (let i = 0; i < 3; i++) await run2.invoke('increment-export-count', 'messages');
    assert.deepEqual(run2.env.senderSent, []);
    assert.equal(run2.readState().stats.totalExports, 4);
  });
});

// ── Engine and PDF bridges ──────────────────────────────────────────────────

describe('sidecar:call', () => {
  test('wraps answers as {success, data} and failures as {success: false, error}', async () => {
    const m = await loadMain();
    m.sidecar.answer = async (method, params) => {
      if (method === 'open_backup' && params.password === 'wrong') throw new Error('Wrong password');
      return { status: 'ready', echo: params };
    };
    assert.deepEqual(await m.invoke('sidecar:call', 'list_notes', { backup_dir: 'B' }), {
      success: true,
      data: { status: 'ready', echo: { backup_dir: 'B' } },
    });
    assert.deepEqual(await m.invoke('sidecar:call', 'open_backup', { password: 'wrong' }), {
      success: false,
      error: 'Wrong password',
    });
    assert.deepEqual(
      m.recorder.recorded.map(r => [r.method, r.outcome.ok, r.outcome.error]),
      [['list_notes', true, undefined], ['open_backup', false, 'Wrong password']],
    );
  });

  test('backups, the Apple Devices install and exports get long timeouts; everything else the default', async () => {
    const m = await loadMain();
    const methods = ['backup.start', 'backup.install_device_support', 'export_photos', 'export_conversations', 'list_messages', 'ping'];
    for (const method of methods) {
      await m.invoke('sidecar:call', method, {});
    }
    assert.deepEqual(
      m.sidecar.calls.map(c => [c.method, c.timeoutMs]),
      [
        ['backup.start', 7_200_000], ['backup.install_device_support', 900_000],
        ['export_photos', 21_600_000], ['export_conversations', 21_600_000],
        ['list_messages', undefined], ['ping', undefined],
      ],
    );
  });

  test('open_backup results, good and bad, are noted in the engine log', async () => {
    const m = await loadMain();
    m.sidecar.answer = async (_method, params) => {
      if (params.udid === 'bad') throw new Error('Manifest.db is missing');
      return { status: 'ready' };
    };
    await m.invoke('sidecar:call', 'open_backup', { udid: 'U1', backup_dir: 'D1' });
    await m.invoke('sidecar:call', 'open_backup', { udid: 'bad', backup_dir: 'D2' });
    const log = fs.readFileSync(m.sidecar.logPath, 'utf-8');
    assert.match(log, /\[Electron\] open_backup → status=ready udid=U1 dir=D1/);
    assert.match(log, /\[Electron\] open_backup FAILED: Manifest\.db is missing \| udid=bad dir=D2/);
  });

  test('a stopped engine comes back as a failure, not a throw', async () => {
    const m = await loadMain();
    m.sidecar.stop();
    assert.deepEqual(await m.invoke('sidecar:call', 'ping', {}), { success: false, error: 'Python sidecar is not running' });
  });
});

describe('export:pdf', () => {
  test('passes the engine, method and params through and wraps the answer', async () => {
    const m = await loadMain();
    const params = { chat_id: 1, output_dir: m.userData };
    assert.deepEqual(await m.invoke('export:pdf', 'export_conversation', params), {
      success: true,
      data: { files: ['Mom.pdf'], message_count: 3 },
    });
    const [call] = m.fakes.pdfCalls;
    assert.equal(call.sidecar, m.sidecar);
    assert.equal(call.method, 'export_conversation');
    assert.deepEqual(call.params, params);
  });

  test('a failed PDF export is wrapped and recorded for feedback', async () => {
    const m = await loadMain();
    m.fakes.pdfAnswer = async () => {
      throw new Error('Choose a folder to save the PDF in.');
    };
    assert.deepEqual(await m.invoke('export:pdf', 'export_conversations', { output_dir: '' }), {
      success: false,
      error: 'Choose a folder to save the PDF in.',
    });
    assert.deepEqual(m.recorder.recorded, [
      { method: 'pdf:export_conversations', params: { output_dir: '' }, outcome: { ok: false, error: 'Choose a folder to save the PDF in.' } },
    ]);
  });
});

// ── Feedback ────────────────────────────────────────────────────────────────

describe('feedback handlers', () => {
  test('pass through to the recorder and reports, coercing what the renderer sends', async () => {
    const m = await loadMain({ state: { feedbackEmail: 'me@example.com' } });
    const reports = m.fakes.reports[0];
    assert.equal(reports.version, '1.2.3');
    assert.equal(reports.site, undefined, 'a packaged build must use the real site');

    assert.deepEqual(await m.invoke('feedback:get-diagnostics', 'Backup is encrypted'), { reportedError: 'Backup is encrypted', appVersion: '1.2.3' });
    assert.deepEqual(await m.invoke('feedback:get-diagnostics', { not: 'a string' }), { reportedError: undefined, appVersion: '1.2.3' });
    assert.deepEqual(await m.invoke('feedback:send', { kind: 'bug' }), { ok: true, reference: 'OE-7' });
    await m.invoke('feedback:send', undefined);
    assert.deepEqual(reports.sent, [{ kind: 'bug' }, {}]);
    assert.equal(await m.invoke('feedback:saved-email'), 'me@example.com');
    assert.deepEqual(await m.invoke('feedback:fixed-reports'), [{ reference: 'OE-7' }]);
    await m.invoke('feedback:mark-announced', 7);
    assert.deepEqual(reports.announced, ['7']);
  });

  test('15 seconds after startup, fixed reports are announced to the window if there are any', async () => {
    const m = await loadMain();
    const timer = m.timers.find(t => t.ms === 15_000);
    assert.ok(timer, 'no delayed report check was scheduled');
    m.fakes.reports[0].due = true;
    await timer.cb();
    await flush();
    assert.deepEqual(m.window.webContents.sent.filter(([ch]) => ch === 'feedback:fixed'), [['feedback:fixed']]);

    const none = await loadMain();
    await none.timers.find(t => t.ms === 15_000).cb();
    await flush();
    assert.deepEqual(none.window.webContents.sent, []);
  });
});
