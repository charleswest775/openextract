// Shared helpers for the Electron main-process tests (scripts/*.test.mjs).
//
// Electron isn't available under node:test, so these tests transpile electron/*.ts
// to CommonJS in a temp folder (like load() in feedback.test.mjs) and answer the
// modules' require('electron'), require('electron-updater') and, where a test asks
// for it, require('./sidecar') and friends with stubs. Every load gets its own
// folder, so module-level state (the updater's status, main's JSON store, ...)
// starts fresh each time.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const electronDir = path.join(root, 'electron');

// realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var), and the code
// under test realpaths some of its folders.
export const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oe-electron-test-')));
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may still hold a file open for a moment; the OS cleans temp up.
  }
});

let dirCounter = 0;
/** A fresh, empty folder inside this test run's temp folder. */
export function freshDir(label = 'dir') {
  const dir = path.join(tmpRoot, `${label}-${++dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Loading electron/*.ts with stubbed requires ─────────────────────────────

const stubsByDir = new Map();
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename) {
    const stubs = stubsByDir.get(path.dirname(parent.filename));
    if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  }
  return originalLoad.call(this, request, parent, isMain);
};

const transpiled = new Map();
function transpile(file) {
  if (!transpiled.has(file)) {
    const src = fs.readFileSync(path.join(electronDir, file), 'utf-8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: file,
    }).outputText;
    transpiled.set(file, out);
  }
  return transpiled.get(file);
}

/**
 * Transpile every electron/*.ts into a new folder (as .js, so `require('./sidecar')`
 * between them resolves), and require `entry` from it. `stubs` maps a request string
 * ('electron', './sidecar', ...) to the exports it should get; the map is read at
 * require time, so a test may add to it later (electron-updater is required lazily).
 */
export function loadElectronModule(entry, stubs = {}) {
  const dir = freshDir('electron');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  for (const file of fs.readdirSync(electronDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    fs.writeFileSync(path.join(dir, file.replace(/\.ts$/, '.js')), transpile(file));
  }
  stubsByDir.set(dir, stubs);
  return { module: require(path.join(dir, `${entry}.js`)), dir };
}

// ── Electron stub ───────────────────────────────────────────────────────────

/**
 * A stand-in for require('electron') with just enough of the API for the main
 * process, recording what the code does with it.
 */
export function createElectron({
  paths = {},
  isPackaged = true,
  version = '1.2.3',
  locale = 'en-US',
  countryCode = 'US',
} = {}) {
  const calls = [];
  const record = (name, ...args) => calls.push([name, ...args]);

  // ipcMain: Electron throws on a second handler for the same channel, so the stub does too.
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, fn);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  /** Messages handlers sent back to the invoking renderer (event.sender.send). */
  const senderSent = [];
  async function invoke(channel, ...args) {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    const event = { sender: { send: (ch, ...a) => senderSent.push([ch, ...a]) } };
    return fn(event, ...args);
  }

  const appEvents = new EventEmitter();
  const app = {
    isPackaged,
    setName: name => record('app.setName', name),
    getName: () => 'OpenExtract',
    getVersion: () => version,
    getPath(name) {
      if (!paths[name]) throw new Error(`stub app.getPath: no path for '${name}'`);
      return paths[name];
    },
    whenReady: () => Promise.resolve(),
    on(event, fn) {
      appEvents.on(event, fn);
      return app;
    },
    emit: (event, ...args) => appEvents.emit(event, ...args),
    relaunch: () => record('app.relaunch'),
    exit: code => record('app.exit', code),
    quit: () => record('app.quit'),
    getLocale: () => (typeof locale === 'function' ? locale() : locale),
    getLocaleCountryCode: () => (typeof countryCode === 'function' ? countryCode() : countryCode),
  };

  // Hooks a test can replace to shape what a window does.
  const hooks = {
    /** (win, filePath) => Promise, runs inside win.loadFile */
    loadFile: async () => {},
    /** (win, options) => Promise<Buffer>, runs inside webContents.printToPDF */
    printToPDF: async () => Buffer.from('%PDF-1.4\n% stub\n'),
  };

  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.loaded = [];
      const wc = new EventEmitter();
      wc.sent = [];
      wc.zoomFactors = [];
      wc.send = (ch, ...args) => wc.sent.push([ch, ...args]);
      wc.setZoomFactor = f => wc.zoomFactors.push(f);
      wc.openDevTools = () => record('openDevTools');
      wc.setWindowOpenHandler = fn => {
        wc.windowOpenHandler = fn;
      };
      wc.printToPDF = async opts => {
        wc.printOptions = opts;
        return hooks.printToPDF(this, opts);
      };
      this.webContents = wc;
      windows.push(this);
    }
    static getAllWindows() {
      return windows.filter(w => !w.destroyed);
    }
    async loadURL(url) {
      this.loaded.push(['url', url]);
    }
    async loadFile(file) {
      this.loaded.push(['file', file]);
      await hooks.loadFile(this, file);
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.closeCalled = true;
      setImmediate(() => {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
      });
    }
    destroy() {
      this.destroyCalled = true;
      this.destroyed = true;
    }
  }

  const sessions = new Map();
  function makeSession(name) {
    return {
      name,
      spellChecker: [],
      beforeRequest: [],
      permissionHandlers: [],
      webRequest: {
        onBeforeRequest(fn) {
          sessions.get(name).beforeRequest.push(fn);
        },
      },
      setSpellCheckerEnabled(v) {
        this.spellChecker.push(['enabled', v]);
      },
      setSpellCheckerLanguages(langs) {
        this.spellChecker.push(['languages', langs]);
      },
      setPermissionRequestHandler(fn) {
        this.permissionHandlers.push(fn);
      },
    };
  }
  const session = {
    fromPartition(name) {
      if (!sessions.has(name)) sessions.set(name, makeSession(name));
      return sessions.get(name);
    },
    get defaultSession() {
      return session.fromPartition('<default>');
    },
  };

  const dialogResults = { open: { canceled: true, filePaths: [] }, save: { canceled: true, filePath: '' } };
  const dialog = {
    async showOpenDialog(win, options) {
      record('dialog.showOpenDialog', win, options);
      return dialogResults.open;
    },
    async showSaveDialog(win, options) {
      record('dialog.showSaveDialog', win, options);
      return dialogResults.save;
    },
  };

  const shell = {
    openExternal: url => {
      record('shell.openExternal', url);
      return Promise.resolve();
    },
    openPath: p => {
      record('shell.openPath', p);
      return Promise.resolve('');
    },
    showItemInFolder: p => record('shell.showItemInFolder', p),
  };

  const electron = {
    app,
    ipcMain,
    BrowserWindow,
    session,
    dialog,
    shell,
    Menu: {
      buildFromTemplate: template => ({ template }),
      setApplicationMenu: menu => record('Menu.setApplicationMenu', menu),
    },
    protocol: {
      registerSchemesAsPrivileged: schemes => record('protocol.registerSchemesAsPrivileged', schemes),
      handle: (scheme, fn) => record('protocol.handle', scheme, fn),
    },
    net: {
      fetch: async (url, init) => {
        record('net.fetch', url, init);
        throw new Error('stub net.fetch: no network in tests');
      },
    },
    clipboard: { writeText: text => record('clipboard.writeText', text) },
  };

  return {
    electron,
    app,
    handlers,
    invoke,
    senderSent,
    calls,
    callsTo: name => calls.filter(c => c[0] === name).map(c => c.slice(1)),
    windows,
    sessions,
    hooks,
    dialogResults,
  };
}

// ── Timers, console, waiting ────────────────────────────────────────────────

/**
 * Run fn with setTimeout patched so delays of at least `minMs` are recorded
 * instead of scheduled (a test can fire them by hand). Shorter delays run normally.
 * Restores setTimeout when fn's promise settles.
 */
export async function captureLongTimers(fn, minMs = 5_000) {
  const timers = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function (cb, ms, ...args) {
    if (typeof ms === 'number' && ms >= minMs) {
      const handle = { cb: () => cb(...args), ms, unref() { return this; }, ref() { return this; }, hasRef: () => false, refresh() { return this; } };
      timers.push(handle);
      return handle;
    }
    return real(cb, ms, ...args);
  };
  try {
    const result = await fn();
    return { result, timers };
  } finally {
    globalThis.setTimeout = real;
  }
}

/** Run fn with every setTimeout firing on the next turn instead of after its delay. */
export async function withInstantTimers(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, _ms, ...args) => real(cb, 0, ...args);
  try {
    return await fn();
  } finally {
    globalThis.setTimeout = real;
  }
}

/**
 * Keep the app modules' console output out of the test report, but keep it so
 * tests can look at it. Lines that don't come from the app still print.
 */
export function quietConsole(prefixes) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : String(a))).join(' ');
      if (prefixes.some(p => text.startsWith(p))) lines.push(`${level}: ${text}`);
      else original[level](...args);
    };
  }
  return { lines, restore: () => Object.assign(console, original) };
}

/** Poll until check() returns a truthy value or the time runs out. */
export async function waitFor(check, { timeoutMs = 5_000, intervalMs = 10, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** Let pending promise callbacks and setImmediate callbacks run. */
export const flush = () => new Promise(resolve => setImmediate(resolve));

/** Whether a process with this pid still exists (works on Windows too). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
