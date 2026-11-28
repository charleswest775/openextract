// The friends-and-family build: an app that carries the OpenExtract AI add-on (a .mcpb) inside
// itself instead of downloading it (electron/aiAddon.ts bundledAddon, scripts/write-build-info.mjs,
// scripts/package-friends.mjs). Its name says its version, edition and computer; build-info.json
// records its size and SHA-256; Install copies and checks it and unpacks it with nothing fetched;
// the unrestricted edition unpacks beside the usual one, and Claude counts as connected only
// when it has that edition.
// Everything happens in temp folders; nothing touches the network or the real home folder.
// Run with: node --test scripts/ai-addon-bundled.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createElectron, freshDir, loadElectronModule, root } from './test-helpers/electron-env.mjs';
import { makeZip } from './test-helpers/zip.mjs';

const A = loadElectronModule('aiAddon').module;
const { registerAskAi } = loadElectronModule('askAi').module;
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
const hostRun = (_file, args) => A.extractZip(args.at(-2), args.at(-1), { platform: process.platform, env: process.env });
const NAME = 'openextract-ai-0.2.3-unrestricted-mac-arm64.mcpb';
const noFetch = async url => { throw new Error(`nothing should be fetched, but ${url} was`); };

function mcpb(marker = 'unrestricted') {
  return makeZip([
    { name: 'manifest.json', data: '{"name": "openextract-ai", "display_name": "OpenExtract AI (unrestricted)"}' },
    { name: 'server/', dir: true },
    { name: 'server/openextract-ai', data: `#!/bin/sh\necho ${marker}\n`, mode: 0o644 },
  ]);
}

/** A packaged app's resources/ai-addon/<name> and its dist-electron/build-info.json. */
function packagedApp(zip = mcpb(), name = NAME, info = {}) {
  const resources = freshDir('resources');
  touch(path.join(resources, A.BUNDLED_DIR, name), zip);
  const buildInfoDir = mkdir(path.join(resources, 'app', 'dist-electron'));
  fs.writeFileSync(path.join(buildInfoDir, A.BUILD_INFO_FILE),
    JSON.stringify({ aiIndexUrl: null, aiAddon: { file: name, size: zip.length, sha256: sha(zip), ...info } }));
  return { resources, buildInfoDir };
}

describe('the name says the version, the edition and the computer', () => {
  test('as openextract-ai\'s packaging/build.py names them', () => {
    assert.deepEqual(A.parseMcpbName('openextract-ai-0.2.3-unrestricted-mac-arm64.mcpb'),
      { version: '0.2.3-unrestricted', platform: 'mac-arm64', edition: 'unrestricted' });
    assert.deepEqual(A.parseMcpbName('openextract-ai-0.2.3-win-x64.mcpb'), { version: '0.2.3', platform: 'win-x64', edition: null });
    for (const bad of ['openextract-ai-0.2.3-linux-x64.mcpb', 'openextract-ai-0.2.3-mac-arm64.zip', '../openextract-ai-0.2.3-mac-arm64.mcpb',
      'x/openextract-ai-0.2.3-mac-arm64.mcpb', 'openextract-ai-0.2-mac-arm64.mcpb', 'openextract-ai-0.2.3-free-mac-arm64.mcpb', '', null, 5]) {
      assert.equal(A.parseMcpbName(bad), null, String(bad));
    }
  });
});

describe('which add-on the app carries', () => {
  test('a packaged app reads build-info.json and finds the file in its resources; its environment can\'t add one', () => {
    const { resources, buildInfoDir } = packagedApp();
    const zip = fs.readFileSync(path.join(resources, A.BUNDLED_DIR, NAME));
    assert.deepEqual(A.bundledAddon({ isPackaged: true, buildInfoDir, resourcesPath: resources, env: {} }), {
      file: path.join(resources, A.BUNDLED_DIR, NAME), version: '0.2.3-unrestricted', platform: 'mac-arm64',
      sha256: sha(zip), size: zip.length, edition: 'unrestricted',
    });
    const plain = freshDir('build-info');
    fs.writeFileSync(path.join(plain, A.BUILD_INFO_FILE), '{"aiIndexUrl": null, "aiAddon": null}');
    const env = { [A.BUNDLED_MCPB_ENV]: path.join(resources, A.BUNDLED_DIR, NAME) };
    assert.equal(A.bundledAddon({ isPackaged: true, buildInfoDir: plain, resourcesPath: resources, env }), null);
    assert.equal(A.bundledAddon({ isPackaged: true, buildInfoDir, resourcesPath: undefined, env: {} }), null, 'outside Electron');
  });

  test('build-info.json\'s fields are checked one by one', () => {
    for (const info of [{ file: 'evil.mcpb' }, { file: `../${NAME}` }, { sha256: 'nope' }, { sha256: 'F'.repeat(63) }, { size: 0 }, { size: -1 },
      { size: 1.5 }, { size: '5' }, { size: 3 * 1024 ** 3 }]) {
      const { resources, buildInfoDir } = packagedApp(mcpb(), NAME, info);
      assert.equal(A.bundledAddon({ isPackaged: true, buildInfoDir, resourcesPath: resources, env: {} }), null, JSON.stringify(info));
    }
    assert.equal(A.bundledFrom(null, '/x'), null);
    assert.equal(A.bundledFrom('a string', '/x'), null);
  });

  test('a development build reads OPENEXTRACT_AI_BUNDLED_MCPB, as the file is now', () => {
    const zip = mcpb();
    const file = touch(path.join(freshDir('dev'), NAME), zip);
    const stale = packagedApp(Buffer.from('old'));
    const b = A.bundledAddon({ isPackaged: false, buildInfoDir: stale.buildInfoDir, resourcesPath: stale.resources, env: { [A.BUNDLED_MCPB_ENV]: ` ${file} ` } });
    assert.deepEqual(b, { file, version: '0.2.3-unrestricted', platform: 'mac-arm64', sha256: sha(zip), size: zip.length, edition: 'unrestricted' });
    assert.equal(A.bundledAddon({ isPackaged: false, buildInfoDir: stale.buildInfoDir, resourcesPath: stale.resources, env: {} }), null,
      'never a build-info.json left from a build');
    assert.equal(A.bundledAddon({ isPackaged: false, buildInfoDir: '/x', resourcesPath: '/x', env: { [A.BUNDLED_MCPB_ENV]: '/nowhere/' + NAME } }), null);
  });
});

describe('scripts/write-build-info.mjs with OPENEXTRACT_AI_BUNDLED_MCPB', () => {
  function writeBuildInfo(env) {
    const out = freshDir('dist-electron');
    const clean = { ...process.env };
    delete clean.OPENEXTRACT_AI_INDEX_URL;
    delete clean.OPENEXTRACT_AI_BUNDLED_MCPB;
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'write-build-info.mjs'), '--out', out], { env: { ...clean, ...env }, encoding: 'utf-8' });
    return { r, out, file: path.join(out, 'build-info.json') };
  }

  test('records the file\'s name, size and SHA-256, and a packaged app reads them back', () => {
    const zip = mcpb();
    const file = touch(path.join(freshDir('mcpb'), NAME), zip);
    const on = writeBuildInfo({ OPENEXTRACT_AI_BUNDLED_MCPB: file });
    assert.equal(on.r.status, 0, on.r.stderr);
    assert.match(on.r.stdout, /Ask AI on, carrying openextract-ai-0\.2\.3-unrestricted-mac-arm64\.mcpb/);
    const info = JSON.parse(fs.readFileSync(on.file, 'utf-8'));
    assert.deepEqual(info, { aiIndexUrl: null, aiAddon: { file: NAME, size: zip.length, sha256: sha(zip) } });
    const resources = freshDir('resources');
    touch(path.join(resources, A.BUNDLED_DIR, NAME), zip);
    assert.equal(A.bundledAddon({ isPackaged: true, buildInfoDir: on.out, resourcesPath: resources, env: {} }).edition, 'unrestricted');
  });

  test('a file named otherwise, or one that isn\'t there, stops the build', () => {
    const wrong = touch(path.join(freshDir('mcpb'), 'addon.mcpb'), mcpb());
    const bad = writeBuildInfo({ OPENEXTRACT_AI_BUNDLED_MCPB: wrong });
    assert.equal(bad.r.status, 1);
    assert.match(bad.r.stderr, /must be a \.mcpb named as openextract-ai's build names them/);
    assert.equal(fs.existsSync(bad.file), false);
    const gone = writeBuildInfo({ OPENEXTRACT_AI_BUNDLED_MCPB: path.join(freshDir('mcpb'), NAME) });
    assert.equal(gone.r.status, 1);
    assert.match(gone.r.stderr, /can't read/);
  });
});

describe('installing the add-on the app carries', () => {
  function bundledIn(zip = mcpb()) {
    const file = touch(path.join(freshDir('resources'), A.BUNDLED_DIR, NAME), zip);
    return { file, version: '0.2.3-unrestricted', platform: 'mac-arm64', sha256: sha(zip), size: zip.length, edition: 'unrestricted' };
  }

  test('copied into downloads/, checked, unpacked into program/0.2.3-unrestricted/, with nothing fetched', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const home = freshDir('ai-home');
    const progress = [];
    const options = { platform: 'darwin', arch: 'arm64', env: { OPENEXTRACT_AI_HOME: home }, homedir: '/nonexistent', indexUrl: null,
      bundled: bundledIn(), fetch: noFetch, run: hostRun, onProgress: p => progress.push(p.step) };
    const r = await A.installAddon(options);
    const command = path.join(home, 'program', '0.2.3-unrestricted', 'openextract-ai');
    const copy = path.join(home, 'downloads', NAME);
    assert.deepEqual(r, { ok: true, installed: { version: '0.2.3-unrestricted', command }, mcpb: copy });
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(options.bundled.file));
    assert.deepEqual(progress, ['verify', 'unpack']);
    assert.deepEqual(A.readCurrent(home), { version: '0.2.3-unrestricted', command });
    assert.equal((await A.installAddon(options)).ok, true, 'again: the copy and the program are kept');
  });

  test('a usual edition already unpacked at the same version isn\'t taken for it', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const home = freshDir('ai-home');
    touch(path.join(home, 'program', '0.2.3', 'openextract-ai'), '#!/bin/sh\necho usual\n');
    const r = await A.installAddon({ platform: 'darwin', arch: 'arm64', env: { OPENEXTRACT_AI_HOME: home }, homedir: '/x', bundled: bundledIn(), fetch: noFetch, run: hostRun });
    assert.equal(r.ok, true);
    assert.match(fs.readFileSync(r.installed.command, 'utf-8'), /echo unrestricted/);
  });

  test('a damaged copy inside the app, or one for another computer, installs nothing', async () => {
    const home = freshDir('ai-home');
    let unzipped = 0;
    const base = { env: { OPENEXTRACT_AI_HOME: home }, homedir: '/x', fetch: noFetch, run: async () => { unzipped++; } };
    const damaged = bundledIn();
    fs.appendFileSync(damaged.file, 'x');
    assert.deepEqual(await A.installAddon({ ...base, platform: 'darwin', arch: 'arm64', bundled: damaged }), { ok: false, error: A.ERRORS.bundledDamaged });
    const other = { ...bundledIn(), sha256: sha(Buffer.from('something else')) };
    assert.deepEqual(await A.installAddon({ ...base, platform: 'darwin', arch: 'arm64', bundled: other }), { ok: false, error: A.ERRORS.bundledDamaged });
    assert.deepEqual(await A.installAddon({ ...base, platform: 'win32', arch: 'x64', bundled: bundledIn() }), { ok: false, error: A.ERRORS.notForThisComputer });
    assert.equal(unzipped, 0);
    assert.equal(A.readCurrent(home), null);
    assert.deepEqual(fs.existsSync(path.join(home, 'downloads')) ? fs.readdirSync(path.join(home, 'downloads')) : [], []);
  });

  test('neither index.json nor a carried add-on: nothing to install from', async () => {
    const r = await A.installAddon({ platform: 'darwin', arch: 'arm64', env: { OPENEXTRACT_AI_HOME: freshDir('ai-home') }, homedir: '/x', fetch: noFetch });
    assert.deepEqual(r, { ok: false, error: A.ERRORS.notForThisComputer });
  });
});

describe('Claude counts as connected only with the edition the app carries', () => {
  function claudeWith(displayName) {
    const home = freshDir('claude-home');
    const ext = mkdir(path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions', 'local.mcpb.charles-west.openextract-ai'));
    if (displayName) fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ name: 'openextract-ai', display_name: displayName }));
    return { platform: 'darwin', env: {}, homedir: home };
  }

  test('the usual add-on in Claude is enough for the usual app, not for the unrestricted one', () => {
    const usual = claudeWith('OpenExtract AI');
    assert.equal(A.claudeHasAddon(usual), true);
    assert.equal(A.claudeHasAddon(usual, undefined, 'unrestricted'), false);
    const free = claudeWith('OpenExtract AI (unrestricted)');
    assert.equal(A.claudeHasAddon(free, undefined, 'unrestricted'), true);
    assert.equal(A.claudeHasAddon(free), true);
    assert.equal(A.claudeHasAddon(claudeWith(null), undefined, 'unrestricted'), false, 'no manifest');
  });
});

describe('the Ask AI channels with a carried add-on and no index.json', () => {
  function setup({ platform = 'darwin', arch = 'arm64', claude = null } = {}) {
    const base = freshDir('ask-ai-bundled');
    const home = mkdir(path.join(base, 'Users', 'sam'));
    const systemApps = mkdir(path.join(base, 'Applications'));
    mkdir(path.join(systemApps, 'Claude.app'));
    if (claude) {
      const ext = mkdir(path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions', 'local.mcpb.charles-west.openextract-ai'));
      fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ display_name: claude }));
    }
    const zip = mcpb();
    const file = touch(path.join(base, 'resources', A.BUNDLED_DIR, NAME), zip);
    const bundled = { file, version: '0.2.3-unrestricted', platform: 'mac-arm64', sha256: sha(zip), size: zip.length, edition: 'unrestricted' };
    const electron = createElectron();
    const opened = [];
    const data = {};
    registerAskAi({
      ipcMain: electron.electron.ipcMain,
      shell: { openPath: async p => { opened.push(p); return ''; }, showItemInFolder: p => opened.push(['folder', p]), openExternal: async () => {} },
      store: { get: (k, f) => (k in data ? data[k] : f), set: (k, v) => { data[k] = v; } },
      indexUrl: null, bundled, platform, arch, env: { PATH: mkdir(path.join(base, 'bin')), OPENEXTRACT_AI_HOME: path.join(base, 'ai-home') },
      homedir: home, fetch: noFetch, systemApps, macBinDirs: [], run: hostRun,
    });
    return { invoke: electron.invoke, opened, base };
  }

  test('Ask AI is on and says which edition it carries', async () => {
    const state = await setup().invoke('ask-ai:state');
    assert.equal(state.enabled, true);
    assert.equal(state.edition, 'unrestricted');
    assert.equal(state.available, true);
    assert.deepEqual(state.claude, { connected: false });
    assert.equal((await setup({ platform: 'win32', arch: 'x64' }).invoke('ask-ai:state')).available, false, 'a Mac add-on on Windows');
  });

  test('the usual add-on in Claude still offers Install; the unrestricted one counts as connected', async () => {
    assert.deepEqual((await setup({ claude: 'OpenExtract AI' }).invoke('ask-ai:state')).claude, { connected: false });
    assert.deepEqual((await setup({ claude: 'OpenExtract AI (unrestricted)' }).invoke('ask-ai:state')).claude, { connected: true });
  });

  test('Install in Claude\'s card opens the copy in downloads/, with nothing fetched', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const a = setup();
    assert.deepEqual(await a.invoke('ask-ai:connect-claude'), { ok: true });
    assert.deepEqual(a.opened, [path.join(a.base, 'ai-home', 'downloads', NAME)]);
    assert.deepEqual((await a.invoke('ask-ai:state')).installed, { version: '0.2.3-unrestricted' });
  });
});
