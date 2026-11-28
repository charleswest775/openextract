// electron/askAi.ts: what the window can ask the main process about Ask AI. Off (a build
// without OPENEXTRACT_AI_INDEX_URL), every channel answers that it's off and touches nothing:
// no place is looked at, nothing is fetched, run, opened or saved. On, the handlers find AI
// apps, install from a local server, ask the add-on for its --status, open the .mcpb for
// Claude, change ChatGPT's settings file only with the person's OK, keep the add-on's
// backups.json, offer the Full Disk Access settings, and check what the window sends.
// Everything happens in temp folders; the real home folder is never used.
// (main.ts's wiring of the switch is tested in scripts/main-ipc.test.mjs.)
// Run with: node --test scripts/ask-ai-ipc.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElectron, freshDir, loadElectronModule } from './test-helpers/electron-env.mjs';
import { makeZip } from './test-helpers/zip.mjs';

const { registerAskAi, ASK_AI_OFF } = loadElectronModule('askAi').module;
const A = loadElectronModule('aiAddon').module;
const OFF = { ok: false, error: ASK_AI_OFF };
const { FULL_DISK_ACCESS_URL } = loadElectronModule('askAi').module;
const CHANNELS = ['ask-ai:state', 'ask-ai:status', 'ask-ai:install', 'ask-ai:connect-claude', 'ask-ai:connect-chatgpt', 'ask-ai:set-hidden', 'ask-ai:note-seen',
  'ask-ai:open-full-disk-access'];
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mkdir = dir => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const touch = (file, data = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const hasHostTool = process.platform !== 'linux' || spawnSync('unzip', ['-v']).status === 0;
/** Unzips with this computer's own tool whatever system the code thinks it's on. */
const hostRun = (_file, args) => A.extractZip(args.at(-2), args.at(-1), { platform: process.platform, env: process.env });

function memoryStore() {
  const data = {};
  const gets = [];
  const sets = [];
  return {
    data, gets, sets,
    get(key, fallback) { gets.push(key); return key in data ? data[key] : fallback; },
    set(key, value) { sets.push([key, value]); data[key] = value; },
  };
}

/** A Mac with the AI apps asked for, all in a temp folder. */
function macLayout(apps = ['claude', 'chatgpt', 'claude-code']) {
  const base = freshDir('ask-ai-mac');
  const home = mkdir(path.join(base, 'Users', 'sam'));
  const systemApps = mkdir(path.join(base, 'Applications'));
  const bin = mkdir(path.join(base, 'bin'));
  const aiHome = path.join(base, 'ai-home');
  if (apps.includes('claude')) mkdir(path.join(systemApps, 'Claude.app'));
  if (apps.includes('chatgpt')) mkdir(path.join(home, 'Applications', 'ChatGPT.app'));
  if (apps.includes('claude-code')) touch(path.join(home, '.local', 'bin', 'claude'));
  return { base, home, systemApps, aiHome, env: { PATH: bin, OPENEXTRACT_AI_HOME: aiHome } };
}

function setup({ indexUrl, layout = macLayout(), platform = 'darwin', arch = 'arm64', fetchFn = fetch, look, run = hostRun, statusRunner, openPath, sessions } = {}) {
  const electron = createElectron();
  const store = memoryStore();
  if (sessions) store.data.sessions = sessions;
  const opened = [];
  const shell = {
    openPath: async p => { opened.push(p); return openPath ? openPath(p) : ''; },
    showItemInFolder: p => opened.push(['folder', p]),
    openExternal: async url => { opened.push(['external', url]); },
  };
  const hooks = registerAskAi({
    ipcMain: electron.electron.ipcMain, shell, store, indexUrl, platform, arch, env: layout.env, homedir: layout.home,
    fetch: fetchFn, look, systemApps: layout.systemApps, macBinDirs: [], run, statusRunner,
  });
  return { invoke: electron.invoke, sent: electron.senderSent, handlers: electron.handlers, store, opened, layout, hooks };
}

const backupsJson = layout => {
  const file = path.join(layout.aiHome, 'backups.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
};

async function serve(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    route(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: p => `http://127.0.0.1:${port}${p}`,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const ZIP = makeZip([
  { name: 'manifest.json', data: '{"name": "openextract-ai"}' },
  { name: 'server/', dir: true },
  { name: 'server/openextract-ai', data: '#!/bin/sh\nexit 0\n' },
]);

async function addonServer(t, { delayIndexMs = 0 } = {}) {
  let s;
  s = await serve({
    '/index.json': (_req, res) => setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'OpenExtract AI', version: '0.2.0',
        files: { 'mac-arm64': { url: s.url('/openextract-ai-0.2.0-mac-arm64.mcpb'), sha256: sha(ZIP), size: ZIP.length } },
      }));
    }, delayIndexMs),
    '/openextract-ai-0.2.0-mac-arm64.mcpb': (_req, res) => {
      res.writeHead(200, { 'Content-Length': ZIP.length });
      res.end(ZIP);
    },
  });
  t.after(s.close);
  return s;
}

// ── Off ─────────────────────────────────────────────────────────────────────

describe('Ask AI off (a build without OPENEXTRACT_AI_INDEX_URL)', () => {
  test('every channel answers that it\'s off, and nothing is looked at, fetched, run, opened or saved', async () => {
    const touched = [];
    const look = { kind: p => { touched.push(p); return null; }, list: d => { touched.push(d); return []; } };
    const calls = { fetch: 0, run: 0, status: 0 };
    const layout = macLayout();
    const a = setup({
      indexUrl: null, layout, look,
      fetchFn: async () => { calls.fetch++; throw new Error('no network'); },
      run: async () => { calls.run++; },
      statusRunner: async () => { calls.status++; return ''; },
    });
    // The bridge is the same in every build: the channels exist.
    assert.deepEqual([...a.handlers.keys()].sort(), [...CHANNELS].sort());

    assert.deepEqual(await a.invoke('ask-ai:state'), { enabled: false });
    assert.deepEqual(await a.invoke('ask-ai:status'), OFF);
    assert.deepEqual(await a.invoke('ask-ai:install'), OFF);
    assert.deepEqual(await a.invoke('ask-ai:connect-claude'), OFF);
    assert.deepEqual(await a.invoke('ask-ai:connect-chatgpt', true), OFF);
    assert.equal(await a.invoke('ask-ai:set-hidden', true), undefined);
    assert.equal(await a.invoke('ask-ai:note-seen'), undefined);
    assert.deepEqual(await a.invoke('ask-ai:open-full-disk-access'), OFF);
    a.hooks.backupsFound([path.join(layout.base, 'backups', 'A')]);
    a.hooks.backupOpened(path.join(layout.base, 'backups', 'A'));

    assert.deepEqual(touched, [], 'no place looked at');
    assert.deepEqual(calls, { fetch: 0, run: 0, status: 0 });
    assert.deepEqual(a.opened, []);
    assert.deepEqual(a.sent, [], 'no progress sent');
    assert.deepEqual(a.store.gets, [], 'no setting read');
    assert.deepEqual(a.store.sets, [], 'no setting saved');
    assert.equal(fs.existsSync(layout.aiHome), false, 'no add-on folder made');
    assert.equal(fs.existsSync(path.join(layout.home, '.codex')), false, 'ChatGPT\'s settings untouched');
  });

  test('no backups.json, even with the add-on already installed and backups opened', async () => {
    const layout = macLayout();
    const current = touch(path.join(layout.aiHome, 'program', 'current.json'), '{"version": "0.2.0", "command": "/x"}');
    const a = setup({ indexUrl: null, layout, sessions: [{ id: 'A', backupDir: path.join(layout.base, 'old', 'A'), lastOpened: '2026-11-20T00:00:00Z' }] });
    a.hooks.backupsFound([path.join(layout.base, 'found', 'B')]);
    a.hooks.backupOpened(path.join(layout.home, 'Library', 'Application Support', 'MobileSync', 'Backup', 'C'));
    await a.invoke('ask-ai:install');
    await a.invoke('ask-ai:connect-chatgpt', true);
    assert.deepEqual(fs.readdirSync(layout.aiHome), ['program']);
    assert.deepEqual(fs.readdirSync(path.dirname(current)), ['current.json']);
    assert.deepEqual(a.store.gets, [], 'not even the recent list is read');
    assert.deepEqual(a.opened, []);
  });
});

// ── On ──────────────────────────────────────────────────────────────────────

describe('Ask AI on', () => {
  test('state: the AI apps found, and that nothing is installed or connected yet', async () => {
    const a = setup({ indexUrl: 'https://dl.test/index.json' });
    assert.deepEqual(await a.invoke('ask-ai:state'), {
      enabled: true,
      apps: ['claude', 'chatgpt', 'claude-code'],
      available: true,
      hidden: false,
      noteSeen: false,
      installed: null,
      update: null,
      claude: { connected: false, version: null, outdated: false },
      chatgpt: { connected: false, current: false, settingsFile: path.join('~', '.codex', 'config.toml') },
      claudeCode: { command: null },
      fullDiskAccess: false,
      edition: null,
    });
    const one = setup({ indexUrl: 'https://dl.test/index.json', layout: macLayout(['claude-code']) });
    const s = await one.invoke('ask-ai:state');
    assert.deepEqual([s.apps, s.claude, s.chatgpt, s.claudeCode], [['claude-code'], null, null, { command: null }]);
    const linux = await setup({ indexUrl: 'https://dl.test/index.json', platform: 'linux', arch: 'x64' }).invoke('ask-ai:state');
    assert.deepEqual([linux.apps, linux.available], [[], false]);
    const intel = await setup({ indexUrl: 'https://dl.test/index.json', arch: 'x64' }).invoke('ask-ai:state');
    assert.equal(intel.available, false);
  });

  test('install: progress to the window, then installed, with Claude Code\'s command', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const a = setup({ indexUrl: s.url('/index.json') });
    assert.deepEqual(await a.invoke('ask-ai:install'), { ok: true });
    const steps = a.sent.filter(m => m[0] === 'ask-ai:progress').map(m => m[1].step);
    assert.deepEqual([...new Set(steps)], ['index', 'download', 'verify', 'unpack']);
    const command = path.join(a.layout.aiHome, 'program', '0.2.0', 'openextract-ai');
    const state = await a.invoke('ask-ai:state');
    assert.deepEqual(state.installed, { version: '0.2.0' });
    assert.deepEqual(state.claudeCode, { command: A.claudeCodeCommand(command, 'darwin') });
  });

  test('two clicks at once make one install', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t, { delayIndexMs: 100 });
    const a = setup({ indexUrl: s.url('/index.json') });
    const [one, two] = await Promise.all([a.invoke('ask-ai:install'), a.invoke('ask-ai:install')]);
    assert.deepEqual([one, two], [{ ok: true }, { ok: true }]);
    assert.deepEqual(s.requests, ['/index.json', '/openextract-ai-0.2.0-mac-arm64.mcpb']);
  });

  test('a failed install says why, and nothing counts as installed', async t => {
    const s = await serve({});
    t.after(s.close);
    const a = setup({ indexUrl: s.url('/index.json') });
    assert.deepEqual(await a.invoke('ask-ai:install'), { ok: false, error: A.ERRORS.server(404) });
    assert.equal((await a.invoke('ask-ai:state')).installed, null);
  });

  test('status: asks the installed program, never before it\'s installed', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const runs = [];
    const statusRunner = async (command, args, timeoutMs) => {
      runs.push([command, args, timeoutMs]);
      return '{"version": "0.2.0", "key": {"name": "Sarah", "kind": "friends", "until": "2027-03-31"}, "free_questions": 3, "free_questions_left": 1}\n';
    };
    const a = setup({ indexUrl: s.url('/index.json'), statusRunner });
    assert.deepEqual(await a.invoke('ask-ai:status'), { ok: false, error: "OpenExtract AI isn't installed yet." });
    assert.deepEqual(runs, []);
    await a.invoke('ask-ai:install');
    assert.deepEqual(await a.invoke('ask-ai:status'), {
      ok: true,
      status: {
        version: '0.2.0',
        key: { name: 'Sarah', kind: 'friends', until: '2027-03-31', phone: null },
        keys: [{ name: 'Sarah', kind: 'friends', until: '2027-03-31', phone: null }],
        freeQuestions: 3,
        freeQuestionsLeft: 1,
      },
    });
    assert.deepEqual(runs, [[path.join(a.layout.aiHome, 'program', '0.2.0', 'openextract-ai'), ['--status'], A.STATUS_TIMEOUT_MS]]);
  });

  test('Claude: opens the downloaded .mcpb; connected once Claude\'s extensions folder holds it', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const a = setup({ indexUrl: s.url('/index.json') });
    assert.deepEqual(await a.invoke('ask-ai:connect-claude'), { ok: true });
    const mcpb = path.join(a.layout.aiHome, 'downloads', 'openextract-ai-0.2.0-mac-arm64.mcpb');
    assert.deepEqual(a.opened, [mcpb]);
    assert.deepEqual((await a.invoke('ask-ai:state')).claude, { connected: false, version: null, outdated: false });
    mkdir(path.join(a.layout.home, 'Library', 'Application Support', 'Claude', 'Claude Extensions', 'local.mcpb.charles-west.openextract-ai'));
    assert.deepEqual((await a.invoke('ask-ai:state')).claude, { connected: true, version: null, outdated: false });
  });

  test('Claude: if it doesn\'t open the file, the screen says where the file is', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const a = setup({ indexUrl: s.url('/index.json'), openPath: () => 'No application knows how to open this file' });
    const r = await a.invoke('ask-ai:connect-claude');
    assert.equal(r.ok, false);
    assert.match(r.error, /^Claude didn't open OpenExtract AI\. In Claude, open Settings, then Extensions, and install this file: .*openextract-ai-0\.2\.0-mac-arm64\.mcpb$/);
  });

  test('connecting an app that isn\'t on this computer is refused before anything downloads', async () => {
    let fetched = 0;
    const a = setup({ indexUrl: 'https://dl.test/index.json', layout: macLayout([]), fetchFn: async () => { fetched++; throw new Error('x'); } });
    assert.deepEqual(await a.invoke('ask-ai:connect-claude'), { ok: false, error: "Claude isn't on this computer." });
    assert.deepEqual(await a.invoke('ask-ai:connect-chatgpt', true), { ok: false, error: "ChatGPT isn't on this computer." });
    assert.equal(fetched, 0);
  });

  test('ChatGPT: nothing happens without the person\'s OK', async () => {
    let fetched = 0;
    const a = setup({ indexUrl: 'https://dl.test/index.json', fetchFn: async () => { fetched++; throw new Error('x'); } });
    for (const consent of [undefined, false, 'yes', 1, { ok: true }, [true]]) {
      assert.deepEqual(await a.invoke('ask-ai:connect-chatgpt', consent), { ok: false, error: 'Nothing was changed.' }, String(consent));
    }
    assert.equal(fetched, 0);
    assert.equal(fs.existsSync(path.join(a.layout.home, '.codex')), false);
  });

  test('ChatGPT: with the OK, the settings file gets the block (backed up first) and shows as connected', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const a = setup({ indexUrl: s.url('/index.json') });
    const file = touch(path.join(a.layout.home, '.codex', 'config.toml'), 'model = "o3"\n');
    assert.deepEqual(await a.invoke('ask-ai:connect-chatgpt', true), { ok: true });
    const command = path.join(a.layout.aiHome, 'program', '0.2.0', 'openextract-ai');
    assert.equal(fs.readFileSync(file, 'utf-8'), `model = "o3"\n\n${A.codexBlock(command)}`);
    assert.equal(fs.readFileSync(path.join(a.layout.home, '.codex', A.CODEX_BACKUP), 'utf-8'), 'model = "o3"\n');
    assert.deepEqual((await a.invoke('ask-ai:state')).chatgpt, { connected: true, current: true, settingsFile: path.join('~', '.codex', 'config.toml') });

    // An entry from an older version shows as connected but not current.
    fs.writeFileSync(file, A.codexBlock('/old/openextract-ai'));
    assert.deepEqual((await a.invoke('ask-ai:state')).chatgpt, { connected: true, current: false, settingsFile: path.join('~', '.codex', 'config.toml') });
  });

  test('ChatGPT: a settings file OpenExtract can\'t follow is left alone, with a plain error', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const a = setup({ indexUrl: s.url('/index.json') });
    const file = touch(path.join(a.layout.home, '.codex', 'config.toml'), 'model = "o3\n');
    assert.deepEqual(await a.invoke('ask-ai:connect-chatgpt', true), { ok: false, error: A.CODEX_ERRORS.unreadable });
    assert.equal(fs.readFileSync(file, 'utf-8'), 'model = "o3\n');
  });

  test('"Don\'t show this again" and the note: only true or false is kept', async () => {
    const a = setup({ indexUrl: 'https://dl.test/index.json' });
    for (const bad of [undefined, 'true', 1, null, {}]) await a.invoke('ask-ai:set-hidden', bad);
    assert.deepEqual(a.store.sets, []);
    await a.invoke('ask-ai:set-hidden', true);
    assert.equal((await a.invoke('ask-ai:state')).hidden, true);
    await a.invoke('ask-ai:set-hidden', false);
    await a.invoke('ask-ai:note-seen', 'anything');
    const state = await a.invoke('ask-ai:state');
    assert.deepEqual([state.hidden, state.noteSeen], [false, true]);
    assert.deepEqual(a.store.sets, [['askAiHidden', true], ['askAiHidden', false], ['askAiNoteSeen', true]]);
  });
});

// ── backups.json (FRIENDS-BUILD.md section 3) ───────────────────────────────

describe('backups.json', () => {
  test('not written while the add-on isn\'t installed; written once it is, then on every backup opened', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const layout = macLayout();
    const older = path.join(layout.base, 'Volumes', 'Drive', 'Backups', '00008030-OLD');
    const a = setup({
      indexUrl: s.url('/index.json'), layout,
      sessions: [
        { id: 'X', backupDir: older, lastOpened: '2026-10-01T00:00:00Z' },
        { id: 'Y', name: 'no folder', lastOpened: '2026-11-01T00:00:00Z' },
      ],
    });
    const finder = path.join(layout.home, 'Library', 'Application Support', 'MobileSync', 'Backup');
    const chosen = path.join(layout.base, 'iphone-backups');
    // Home's list of Finder's folder, then a folder the person chose with two backups in it
    a.hooks.backupsFound([path.join(finder, '00008110-F1'), path.join(finder, '00008120-F2')]);
    a.hooks.backupsFound([path.join(chosen, '00008140-C1'), path.join(chosen, '00008101-C2'), 'relative', null]);
    a.hooks.backupOpened(path.join(chosen, '00008140-C1'));
    assert.equal(backupsJson(layout), null, 'not installed: nothing written');

    assert.deepEqual(await a.invoke('ask-ai:install'), { ok: true });
    assert.deepEqual(backupsJson(layout), { version: 1, open: path.join(chosen, '00008140-C1'), folders: [chosen, finder, path.dirname(older)] });

    a.hooks.backupOpened(path.join(finder, '00008110-F1'));
    assert.deepEqual(backupsJson(layout), { version: 1, open: path.join(finder, '00008110-F1'), folders: [finder, chosen, path.dirname(older)] });
    a.hooks.backupOpened('not/absolute');
    a.hooks.backupOpened(undefined);
    assert.equal(backupsJson(layout).open, path.join(finder, '00008110-F1'), 'ignored');
    assert.deepEqual(fs.readdirSync(layout.aiHome).sort(), ['backups.json', 'downloads', 'program'], 'nothing else written there, no temp file left');
  });

  test('with no backup opened in this run, open is the last one opened (the newest in the recent list)', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const layout = macLayout();
    const newer = path.join(layout.base, 'b', 'NEW');
    const old = path.join(layout.base, 'a', 'OLD');
    const a = setup({
      indexUrl: s.url('/index.json'), layout,
      sessions: [{ id: 'o', backupDir: old, lastOpened: '2026-01-01T00:00:00Z' }, { id: 'n', backupDir: newer, lastOpened: '2026-11-24T00:00:00Z' }],
    });
    await a.invoke('ask-ai:connect-claude');
    assert.deepEqual(backupsJson(layout), { version: 1, open: newer, folders: [path.dirname(newer), path.dirname(old)] });
  });

  test('nothing known at all: open is null, folders empty', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const layout = macLayout();
    const a = setup({ indexUrl: s.url('/index.json'), layout });
    await a.invoke('ask-ai:install');
    assert.deepEqual(backupsJson(layout), { version: 1, open: null, folders: [] });
  });

  test('connecting ChatGPT writes it too; a failed install doesn\'t', async t => {
    const broken = await serve({});
    t.after(broken.close);
    const layout = macLayout();
    const a = setup({ indexUrl: broken.url('/index.json'), layout });
    a.hooks.backupOpened(path.join(layout.base, 'x', 'A'));
    assert.equal((await a.invoke('ask-ai:connect-chatgpt', true)).ok, false);
    assert.equal(backupsJson(layout), null);
    if (!hasHostTool) return;
    const s = await addonServer(t);
    const b = setup({ indexUrl: s.url('/index.json'), layout });
    b.hooks.backupOpened(path.join(layout.base, 'x', 'A'));
    assert.deepEqual(await b.invoke('ask-ai:connect-chatgpt', true), { ok: true });
    assert.deepEqual(backupsJson(layout), { version: 1, open: path.join(layout.base, 'x', 'A'), folders: [path.join(layout.base, 'x')] });
  });

  test('a backups.json that can\'t be written never gets in the way of opening a backup', () => {
    const layout = macLayout();
    touch(path.join(layout.aiHome, 'program', 'current.json'), '{}');
    mkdir(path.join(layout.aiHome, 'backups.json')); // a folder where the file goes: the rename fails
    const a = setup({ indexUrl: 'https://dl.test/index.json', layout });
    const errors = [];
    const real = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      assert.doesNotThrow(() => a.hooks.backupOpened(path.join(layout.base, 'x', 'A')));
    } finally {
      console.error = real;
    }
    assert.match(errors.join('\n'), /backups\.json not written/);
    assert.deepEqual(fs.readdirSync(layout.aiHome).sort(), ['backups.json', 'program'], 'no temp file left');
  });
});

// ── Full Disk Access on a Mac ───────────────────────────────────────────────

describe('Full Disk Access', () => {
  test('the step shows on a Mac when the open (or last opened) backup is in Finder\'s backup folder', async () => {
    const layout = macLayout();
    const finderBackup = path.join(layout.home, 'Library', 'Application Support', 'MobileSync', 'Backup', '00008140-A');
    const elsewhere = path.join(layout.base, 'iphone-backups', '00008140-B');
    const a = setup({ indexUrl: 'https://dl.test/index.json', layout });
    assert.equal((await a.invoke('ask-ai:state')).fullDiskAccess, false, 'nothing opened yet');
    a.hooks.backupOpened(finderBackup);
    assert.equal((await a.invoke('ask-ai:state')).fullDiskAccess, true);
    a.hooks.backupOpened(elsewhere);
    assert.equal((await a.invoke('ask-ai:state')).fullDiskAccess, false);

    const last = setup({ indexUrl: 'https://dl.test/index.json', layout, sessions: [{ id: 'A', backupDir: finderBackup, lastOpened: '2026-11-24T00:00:00Z' }] });
    assert.equal((await last.invoke('ask-ai:state')).fullDiskAccess, true, 'the last one opened, from an earlier run');

    const win = setup({ indexUrl: 'https://dl.test/index.json', layout, platform: 'win32', arch: 'x64' });
    win.hooks.backupOpened(finderBackup);
    assert.equal((await win.invoke('ask-ai:state')).fullDiskAccess, false, 'never on Windows');
  });

  test('Open Settings opens only the one fixed address, whatever the window sends, and only on a Mac', async () => {
    const a = setup({ indexUrl: 'https://dl.test/index.json' });
    assert.deepEqual(await a.invoke('ask-ai:open-full-disk-access', 'https://evil.test/', 'file:///etc'), { ok: true });
    assert.deepEqual(a.opened, [['external', FULL_DISK_ACCESS_URL]]);
    assert.equal(FULL_DISK_ACCESS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    const win = setup({ indexUrl: 'https://dl.test/index.json', platform: 'win32', arch: 'x64' });
    assert.deepEqual(await win.invoke('ask-ai:open-full-disk-access'), { ok: false, error: 'Full Disk Access is a Mac setting.' });
    assert.deepEqual(win.opened, []);
  });
});
