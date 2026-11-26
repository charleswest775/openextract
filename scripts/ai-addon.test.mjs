// electron/aiAddon.ts, the Ask AI screen's main-process logic: the build-time switch
// (build-info.json, written by scripts/write-build-info.mjs), the add-on's folder, finding AI
// apps in fixed places on macOS and Windows layouts (fake folders), index.json, the download
// and its size and SHA-256 check (a local server), unzipping with the system's tool,
// program/current.json, the add-on's --status (a fake program) and Claude Code's command.
// ChatGPT's settings file has its own tests: scripts/ai-addon-codex.test.mjs.
// Nothing here touches the real home folder, /Applications or the network.
// Run with: node --test scripts/ai-addon.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshDir, loadElectronModule, root } from './test-helpers/electron-env.mjs';
import { makeZip } from './test-helpers/zip.mjs';

const A = loadElectronModule('aiAddon').module;
const posix = process.platform !== 'win32';
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const touch = (file, data = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const mkdir = dir => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── The build-time switch ───────────────────────────────────────────────────

describe('off unless the build sets OPENEXTRACT_AI_INDEX_URL', () => {
  test('index.json must be https, or http to this computer', () => {
    for (const ok of ['https://downloads.openextract.app/ai/index.json', 'http://127.0.0.1:8123/index.json', 'http://localhost/i.json', 'http://[::1]:9/i.json']) {
      assert.equal(A.isAllowedUrl(ok), true, ok);
    }
    for (const bad of ['', 'http://example.com/index.json', 'file:///etc/passwd', 'ftp://x/y', 'https://user:pw@x.com/i.json', 'not a url', null, 7]) {
      assert.equal(A.isAllowedUrl(bad), false, String(bad));
    }
  });

  test('a packaged app reads only build-info.json; its environment can\'t switch Ask AI on', () => {
    const dir = freshDir('build-info');
    const env = { OPENEXTRACT_AI_INDEX_URL: 'https://x.test/index.json' };
    assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: dir, env }), null, 'no build-info.json: off');
    fs.writeFileSync(path.join(dir, A.BUILD_INFO_FILE), '{"aiIndexUrl": null}\n');
    assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: dir, env }), null, 'a build without it: off');
    fs.writeFileSync(path.join(dir, A.BUILD_INFO_FILE), '{"aiIndexUrl": "https://dl.test/ai/index.json"}\n');
    assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: dir, env: {} }), 'https://dl.test/ai/index.json');
    for (const broken of ['{"aiIndexUrl": "http://evil.test/i.json"}', '{"aiIndexUrl": 5}', 'not json', '[]']) {
      fs.writeFileSync(path.join(dir, A.BUILD_INFO_FILE), broken);
      assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: dir, env }), null, broken);
    }
  });

  test('a development build reads the environment, never a build-info.json left from a build', () => {
    const dir = freshDir('build-info');
    fs.writeFileSync(path.join(dir, A.BUILD_INFO_FILE), '{"aiIndexUrl": "https://stale.test/index.json"}\n');
    assert.equal(A.aiIndexUrl({ isPackaged: false, buildInfoDir: dir, env: {} }), null);
    assert.equal(A.aiIndexUrl({ isPackaged: false, buildInfoDir: dir, env: { OPENEXTRACT_AI_INDEX_URL: '  http://127.0.0.1:5/i.json ' } }), 'http://127.0.0.1:5/i.json');
    assert.equal(A.aiIndexUrl({ isPackaged: false, buildInfoDir: dir, env: { OPENEXTRACT_AI_INDEX_URL: 'http://lan.test/i.json' } }), null);
  });

  function writeBuildInfo(env) {
    const out = freshDir('dist-electron');
    const clean = { ...process.env };
    delete clean.OPENEXTRACT_AI_INDEX_URL;
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'write-build-info.mjs'), '--out', out], { env: { ...clean, ...env }, encoding: 'utf-8' });
    return { r, out, file: path.join(out, 'build-info.json') };
  }

  test('scripts/write-build-info.mjs bakes the URL in, and a packaged app reads it back', () => {
    const on = writeBuildInfo({ OPENEXTRACT_AI_INDEX_URL: 'https://dl.test/ai/index.json' });
    assert.equal(on.r.status, 0, on.r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(on.file, 'utf-8')), { aiIndexUrl: 'https://dl.test/ai/index.json' });
    assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: on.out, env: {} }), 'https://dl.test/ai/index.json');

    // Without it (every public build) the file is still written, saying null, so a leftover can't switch it on.
    const off = writeBuildInfo({});
    assert.equal(off.r.status, 0, off.r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(off.file, 'utf-8')), { aiIndexUrl: null });
    assert.equal(A.aiIndexUrl({ isPackaged: true, buildInfoDir: off.out, env: {} }), null);
  });

  test('a build with a URL the app would refuse stops, saying why', () => {
    const bad = writeBuildInfo({ OPENEXTRACT_AI_INDEX_URL: 'http://downloads.example.com/index.json' });
    assert.equal(bad.r.status, 1);
    assert.match(bad.r.stderr, /must be an https:\/\/ address/);
    assert.equal(fs.existsSync(bad.file), false);
  });

  test('every build writes it and electron-builder packs it; git ignores it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    assert.match(pkg.scripts['build:electron'], /^tsc -p tsconfig\.electron\.json && node scripts\/write-build-info\.mjs$/);
    assert.match(pkg.scripts.build, /npm run build:electron/);
    assert.ok(pkg.build.files.includes('dist-electron/build-info.json'), 'package.json build.files must include dist-electron/build-info.json');
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8'), /^dist-electron\/build-info\.json$/m);
  });
});

// ── The add-on's folder ─────────────────────────────────────────────────────

describe('addonHome and platformKey', () => {
  test('one folder per system, as FRIENDS-BUILD.md says; OPENEXTRACT_AI_HOME overrides it', () => {
    const home = path.join(path.sep, 'Users', 'sam');
    assert.equal(A.addonHome({ platform: 'darwin', env: {}, homedir: home }), path.join(home, 'Library', 'Application Support', 'OpenExtract AI'));
    assert.equal(A.addonHome({ platform: 'win32', env: { APPDATA: path.join(home, 'Roaming') }, homedir: home }), path.join(home, 'Roaming', 'OpenExtract AI'));
    assert.equal(A.addonHome({ platform: 'win32', env: {}, homedir: home }), path.join(home, 'AppData', 'Roaming', 'OpenExtract AI'));
    assert.equal(A.addonHome({ platform: 'linux', env: {}, homedir: home }), path.join(home, '.config', 'openextract-ai'));
    assert.equal(A.addonHome({ platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'cfg') }, homedir: home }), path.join(home, 'cfg', 'openextract-ai'));
    const custom = freshDir('ai-home');
    assert.equal(A.addonHome({ platform: 'darwin', env: { OPENEXTRACT_AI_HOME: custom }, homedir: home }), custom);
  });

  test('downloads exist for Apple silicon Macs and 64-bit Windows', () => {
    assert.equal(A.platformKey('darwin', 'arm64'), 'mac-arm64');
    assert.equal(A.platformKey('darwin', 'x64', true), 'mac-arm64', 'the Intel build under Rosetta is on Apple silicon');
    assert.equal(A.platformKey('darwin', 'x64'), null);
    assert.equal(A.platformKey('win32', 'x64'), 'win-x64');
    assert.equal(A.platformKey('win32', 'arm64'), null);
    assert.equal(A.platformKey('linux', 'x64'), null);
  });
});

// ── Finding AI apps ─────────────────────────────────────────────────────────

/** A Look that remembers every place it was asked about. */
function recording() {
  const touched = [];
  return {
    touched,
    look: {
      kind: p => { touched.push(p); return A.realLook.kind(p); },
      list: d => { touched.push(d); return A.realLook.list(d); },
    },
  };
}

function macLayout() {
  const base = freshDir('mac');
  const home = mkdir(path.join(base, 'Users', 'sam'));
  const systemApps = mkdir(path.join(base, 'Applications'));
  const bin = mkdir(path.join(base, 'opt', 'bin'));
  const brew = mkdir(path.join(base, 'opt', 'homebrew', 'bin'));
  const usrLocal = mkdir(path.join(base, 'usr', 'local', 'bin'));
  const rec = recording();
  const detect = () => A.detectAiApps({ platform: 'darwin', homedir: home, env: { PATH: `${bin}:relative/bin` }, systemApps,
    macBinDirs: [brew, usrLocal], look: rec.look });
  return { base, home, systemApps, bin, brew, usrLocal, detect, touched: rec.touched };
}

function windowsLayout() {
  const base = freshDir('win');
  const profile = mkdir(path.join(base, 'Users', 'Sam Lee'));
  const local = mkdir(path.join(profile, 'AppData', 'Local'));
  const roaming = mkdir(path.join(profile, 'AppData', 'Roaming'));
  const windowsApps = mkdir(path.join(local, 'Microsoft', 'WindowsApps'));
  const packages = mkdir(path.join(local, 'Packages'));
  const bin = mkdir(path.join(base, 'npm'));
  const rec = recording();
  const env = { LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: profile, PATH: [bin, windowsApps].join(';') };
  const detect = () => A.detectAiApps({ platform: 'win32', homedir: profile, env, look: rec.look });
  return { base, profile, local, roaming, windowsApps, packages, bin, env, detect, touched: rec.touched };
}

describe('detectAiApps: macOS', () => {
  test('nothing installed: nothing found', () => {
    assert.deepEqual(macLayout().detect(), []);
  });

  test('each place in the table, on its own', () => {
    const cases = [
      [m => mkdir(path.join(m.systemApps, 'Claude.app', 'Contents')), ['claude']],
      [m => mkdir(path.join(m.home, 'Applications', 'Claude.app')), ['claude']],
      [m => mkdir(path.join(m.systemApps, 'ChatGPT.app')), ['chatgpt']],
      [m => mkdir(path.join(m.home, 'Applications', 'ChatGPT.app')), ['chatgpt']],
      [m => touch(path.join(m.bin, 'claude')), ['claude-code']],
      [m => touch(path.join(m.home, '.local', 'bin', 'claude')), ['claude-code']],
      [m => touch(path.join(m.home, '.claude', 'local', 'claude')), ['claude-code']],
      // Not on a Finder-opened app's PATH, so looked in by name
      [m => touch(path.join(m.brew, 'claude')), ['claude-code']],
      [m => touch(path.join(m.usrLocal, 'claude')), ['claude-code']],
      [m => touch(path.join(m.home, '.npm-global', 'bin', 'claude')), ['claude-code']],
    ];
    for (const [make, expected] of cases) {
      const m = macLayout();
      make(m);
      assert.deepEqual(m.detect(), expected, make.toString());
    }
  });

  test('all three, always in the same order', () => {
    const m = macLayout();
    touch(path.join(m.home, '.local', 'bin', 'claude'));
    mkdir(path.join(m.systemApps, 'ChatGPT.app'));
    mkdir(path.join(m.systemApps, 'Claude.app'));
    assert.deepEqual(m.detect(), ['claude', 'chatgpt', 'claude-code']);
  });

  test('a folder named claude on PATH isn\'t Claude Code', () => {
    const m = macLayout();
    mkdir(path.join(m.bin, 'claude'));
    assert.deepEqual(m.detect(), []);
  });

  test('looks only at the fixed places: no folder is listed, nothing searched', () => {
    const m = macLayout();
    m.detect();
    const expected = [
      path.join(m.systemApps, 'Claude.app'), path.join(m.home, 'Applications', 'Claude.app'),
      path.join(m.systemApps, 'ChatGPT.app'), path.join(m.home, 'Applications', 'ChatGPT.app'),
      path.join(m.bin, 'claude'), path.join(m.home, '.local', 'bin', 'claude'), path.join(m.home, '.claude', 'local', 'claude'),
      path.join(m.brew, 'claude'), path.join(m.usrLocal, 'claude'), path.join(m.home, '.npm-global', 'bin', 'claude'),
    ];
    assert.deepEqual([...new Set(m.touched)].sort(), expected.sort());
  });
});

describe('detectAiApps: Windows', () => {
  test('nothing installed: nothing found', () => {
    assert.deepEqual(windowsLayout().detect(), []);
  });

  test('each place in the table, on its own', () => {
    const cases = [
      [w => touch(path.join(w.local, 'AnthropicClaude', 'claude.exe')), ['claude']],
      [w => mkdir(path.join(w.packages, 'Claude_pzs8sxrjxfjjc')), ['claude']],
      [w => mkdir(path.join(w.packages, 'AnthropicPBC.Claude_1a2b3c4d5e6f7')), ['claude']],
      [w => mkdir(path.join(w.windowsApps, 'Claude_pzs8sxrjxfjjc')), ['claude']],
      [w => mkdir(path.join(w.packages, 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0')), ['chatgpt']],
      [w => touch(path.join(w.windowsApps, 'ChatGPT.exe')), ['chatgpt']],
      [w => touch(path.join(w.bin, 'claude.cmd')), ['claude-code']],
      [w => touch(path.join(w.bin, 'claude.exe')), ['claude-code']],
      [w => touch(path.join(w.profile, '.local', 'bin', 'claude.exe')), ['claude-code']],
    ];
    for (const [make, expected] of cases) {
      const w = windowsLayout();
      make(w);
      assert.deepEqual(w.detect(), expected, make.toString());
    }
  });

  test('other packages and a claude.exe Store launcher don\'t count', () => {
    const w = windowsLayout();
    mkdir(path.join(w.packages, 'NotClaude_abc123'));
    mkdir(path.join(w.packages, 'OpenAI.Whisper_abc'));
    mkdir(path.join(w.packages, 'Microsoft.WindowsCalculator_8wekyb3d8bbwe'));
    // WindowsApps is on PATH and holds Store apps' launchers, where Claude (desktop) would put one.
    touch(path.join(w.windowsApps, 'claude.exe'));
    assert.deepEqual(w.detect(), []);
  });

  test('looks only at the fixed places: two package folders listed, nothing else', () => {
    const w = windowsLayout();
    w.detect();
    const expected = [
      path.join(w.local, 'AnthropicClaude', 'claude.exe'), w.packages, w.windowsApps, path.join(w.windowsApps, 'ChatGPT.exe'),
      path.join(w.bin, 'claude.exe'), path.join(w.bin, 'claude.cmd'), path.join(w.profile, '.local', 'bin', 'claude.exe'),
    ];
    assert.deepEqual([...new Set(w.touched)].sort(), expected.sort());
  });
});

describe('detectAiApps: other systems', () => {
  test('Linux has no table: nothing is looked at or found', () => {
    const rec = recording();
    const home = freshDir('linux-home');
    touch(path.join(home, '.local', 'bin', 'claude'));
    assert.deepEqual(A.detectAiApps({ platform: 'linux', homedir: home, env: { PATH: path.join(home, '.local', 'bin') }, look: rec.look }), []);
    assert.deepEqual(rec.touched, []);
  });
});

describe('Claude (desktop) connected', () => {
  test('= its extensions folder holds the add-on (macOS and Windows layouts)', () => {
    const home = freshDir('claude-home');
    const mac = { platform: 'darwin', env: {}, homedir: home };
    const macDir = path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions');
    assert.equal(A.claudeExtensionsDir(mac), macDir);
    assert.equal(A.claudeHasAddon(mac), false);
    mkdir(path.join(macDir, 'ant.dir.ant.anthropic.filesystem'));
    assert.equal(A.claudeHasAddon(mac), false);
    mkdir(path.join(macDir, 'local.mcpb.charles-west.openextract-ai'));
    assert.equal(A.claudeHasAddon(mac), true);

    const roaming = mkdir(path.join(home, 'AppData', 'Roaming'));
    const win = { platform: 'win32', env: { APPDATA: roaming }, homedir: home };
    assert.equal(A.claudeExtensionsDir(win), path.join(roaming, 'Claude', 'Claude Extensions'));
    assert.equal(A.claudeHasAddon(win), false);
    mkdir(path.join(roaming, 'Claude', 'Claude Extensions', 'local.dxt.OpenExtract'));
    assert.equal(A.claudeHasAddon(win), true);
    assert.equal(A.claudeExtensionsDir({ platform: 'linux', env: {}, homedir: home }), null);
  });
});

// ── index.json ──────────────────────────────────────────────────────────────

const HASH = 'a'.repeat(64);
const index = (files, extra = {}) => ({ name: 'OpenExtract AI', version: '0.2.0', files, ...extra });

describe('parseIndex', () => {
  test('picks this computer\'s file', () => {
    const r = A.parseIndex(index({
      'mac-arm64': { url: 'https://dl.test/openextract-ai-0.2.0-mac-arm64.mcpb', sha256: HASH.toUpperCase(), size: 61234567 },
      'win-x64': { url: 'https://dl.test/openextract-ai-0.2.0-win-x64.mcpb', sha256: 'b'.repeat(64), size: 58234567 },
    }), 'win-x64');
    assert.deepEqual(r, { ok: true, download: { name: 'OpenExtract AI', version: '0.2.0', url: 'https://dl.test/openextract-ai-0.2.0-win-x64.mcpb', sha256: 'b'.repeat(64), size: 58234567 } });
    assert.equal(A.parseIndex(index({ 'mac-arm64': { url: 'https://x.test/a', sha256: HASH, size: 1 } }), 'mac-arm64').download.sha256, HASH);
  });

  test('no file for this computer says so', () => {
    assert.deepEqual(A.parseIndex(index({ 'mac-arm64': { url: 'https://x.test/a', sha256: HASH, size: 1 } }), 'win-x64'),
      { ok: false, error: A.ERRORS.notForThisComputer });
  });

  test('anything off is refused in plain words', () => {
    const good = { url: 'https://x.test/a.mcpb', sha256: HASH, size: 10 };
    const bad = [
      null, [], 'x', { version: '0.2.0' }, index({ 'mac-arm64': good }, { version: '../../evil' }), index({ 'mac-arm64': good }, { version: '0.2' }),
      index({ 'mac-arm64': { ...good, url: 'http://x.test/a.mcpb' } }), index({ 'mac-arm64': { ...good, url: 'file:///a' } }),
      index({ 'mac-arm64': { ...good, sha256: 'xyz' } }), index({ 'mac-arm64': { ...good, size: 0 } }), index({ 'mac-arm64': { ...good, size: 1.5 } }),
      index({ 'mac-arm64': { ...good, size: A.MAX_DOWNLOAD_BYTES + 1 } }), index({ 'mac-arm64': null }),
    ];
    for (const json of bad) assert.deepEqual(A.parseIndex(json, 'mac-arm64'), { ok: false, error: A.ERRORS.badIndex }, JSON.stringify(json));
  });
});

// ── A local server for downloads ────────────────────────────────────────────

async function serve(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    route(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: p => `http://127.0.0.1:${port}${p}`,
    requests,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
const sendBytes = buf => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
  res.end(buf);
};
const sendJson = obj => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

describe('downloadVerified', () => {
  const body = crypto.randomBytes(300_000);

  test('downloads, reporting progress, and keeps the file only once size and SHA-256 match', async t => {
    const s = await serve({ '/a.mcpb': sendBytes(body) });
    t.after(s.close);
    const dest = path.join(freshDir('dl'), 'downloads', 'a.mcpb');
    const progress = [];
    await A.downloadVerified({ url: s.url('/a.mcpb'), size: body.length, sha256: sha(body), dest, fetch, onProgress: p => progress.push(p) });
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.equal(fs.existsSync(`${dest}.part`), false);
    assert.deepEqual(progress[0], { step: 'download', received: 0, total: body.length });
    assert.deepEqual(progress.at(-1), { step: 'verify', received: body.length, total: body.length });
    assert.ok(progress.filter(p => p.step === 'download').length >= 2);
  });

  test('a good file already there isn\'t downloaded again', async t => {
    const s = await serve({ '/a.mcpb': sendBytes(body) });
    t.after(s.close);
    const dest = touch(path.join(freshDir('dl'), 'a.mcpb'), body);
    await A.downloadVerified({ url: s.url('/a.mcpb'), size: body.length, sha256: sha(body), dest, fetch });
    assert.deepEqual(s.requests, []);
  });

  test('the wrong file (hash, or more bytes than it should have) is thrown away, with a plain error', async t => {
    const s = await serve({ '/a.mcpb': sendBytes(body), '/big.mcpb': sendBytes(Buffer.concat([body, Buffer.from('x')])) });
    t.after(s.close);
    const dir = freshDir('dl');
    const dest = path.join(dir, 'a.mcpb');
    await assert.rejects(A.downloadVerified({ url: s.url('/a.mcpb'), size: body.length, sha256: 'f'.repeat(64), dest, fetch }), { message: A.ERRORS.corrupt });
    await assert.rejects(A.downloadVerified({ url: s.url('/big.mcpb'), size: body.length, sha256: sha(body), dest, fetch }), { message: A.ERRORS.corrupt });
    await assert.rejects(A.downloadVerified({ url: s.url('/a.mcpb'), size: body.length + 10, sha256: sha(body), dest, fetch }), { message: A.ERRORS.corrupt });
    assert.deepEqual(fs.readdirSync(dir), [], 'neither the file nor a .part is left');
  });

  test('a stale bad file is replaced by a good download', async t => {
    const s = await serve({ '/a.mcpb': sendBytes(body) });
    t.after(s.close);
    const dest = touch(path.join(freshDir('dl'), 'a.mcpb'), 'half a file');
    await A.downloadVerified({ url: s.url('/a.mcpb'), size: body.length, sha256: sha(body), dest, fetch });
    assert.ok(fs.readFileSync(dest).equals(body));
  });

  test('the server saying no, no server at all, and a download that stops all say what happened', async t => {
    const s = await serve({
      '/stuck.mcpb': (_req, res) => {
        res.writeHead(200, { 'Content-Length': body.length });
        res.write(body.subarray(0, 1000)); // then nothing
      },
    });
    t.after(s.close);
    const dest = path.join(freshDir('dl'), 'a.mcpb');
    await assert.rejects(A.downloadVerified({ url: s.url('/gone.mcpb'), size: 10, sha256: HASH, dest, fetch }), { message: A.ERRORS.server(404) });
    await assert.rejects(A.downloadVerified({ url: 'http://127.0.0.1:9/a.mcpb', size: 10, sha256: HASH, dest, fetch }), { message: A.ERRORS.offline });
    await assert.rejects(A.downloadVerified({ url: s.url('/stuck.mcpb'), size: body.length, sha256: sha(body), dest, fetch, stallMs: 300 }), { message: A.ERRORS.stalled });
    assert.equal(fs.existsSync(`${dest}.part`), false);
  });
});

// ── Unzipping ───────────────────────────────────────────────────────────────

const PROGRAM = '#!/bin/sh\necho \'{"version": "0.2.0", "key": null, "free_questions": 3, "free_questions_left": 3}\'\n';
function mcpb({ exe = 'openextract-ai', extra = [], withServer = true } = {}) {
  return makeZip([
    { name: 'manifest.json', data: '{"name": "openextract-ai", "server": {"type": "binary", "entry_point": "server/openextract-ai"}}' },
    ...(withServer ? [
      { name: 'server/', dir: true },
      { name: `server/${exe}`, data: PROGRAM, mode: 0o644 }, // not executable in the zip: unpacking makes it so
      { name: 'server/_internal/', dir: true },
      { name: 'server/_internal/base_library.txt', data: 'library '.repeat(500), deflate: true },
    ] : []),
    ...extra,
  ]);
}

/** Unzips with this computer's own tool whatever system the code thinks it's on. */
const hostRun = (_file, args) => A.extractZip(args.at(-2), args.at(-1), { platform: process.platform, env: process.env });
const hasHostTool = process.platform !== 'linux' || spawnSync('unzip', ['-v']).status === 0;

describe('unzipping with the system\'s tool', () => {
  test('ditto on macOS, tar then PowerShell on Windows, unzip elsewhere', async () => {
    const calls = [];
    const run = async (file, args, options) => { calls.push([file, args, options?.env?.OPENEXTRACT_ZIP]); };
    await A.extractZip('/x/a.mcpb', '/x/out', { platform: 'darwin', env: {}, run });
    await A.extractZip('C:\\x\\a.mcpb', 'C:\\x\\out', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run });
    await A.extractZip('/x/a.mcpb', '/x/out', { platform: 'linux', env: {}, run });
    assert.deepEqual(calls, [
      ['/usr/bin/ditto', ['-x', '-k', '/x/a.mcpb', '/x/out'], undefined],
      [path.join('C:\\Windows', 'System32', 'tar.exe'), ['-xf', 'C:\\x\\a.mcpb', '-C', 'C:\\x\\out'], undefined],
      ['unzip', ['-q', '-o', '/x/a.mcpb', '-d', '/x/out'], undefined],
    ]);

    // Windows without tar.exe: PowerShell's Expand-Archive, the paths passed as variables, not as code.
    calls.length = 0;
    const noTar = async (file, args, options) => {
      calls.push([path.basename(file), args.at(-1), options?.env?.OPENEXTRACT_ZIP, options?.env?.OPENEXTRACT_DEST]);
      if (file.endsWith('tar.exe')) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    await A.extractZip("C:\\it's $(x)\\a.mcpb", 'C:\\out', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: noTar });
    assert.deepEqual(calls[1], ['powershell.exe', 'Expand-Archive -LiteralPath $env:OPENEXTRACT_ZIP -DestinationPath $env:OPENEXTRACT_DEST -Force', "C:\\it's $(x)\\a.mcpb", 'C:\\out']);
    // tar failing on the file itself isn't retried another way
    await assert.rejects(A.extractZip('a', 'b', { platform: 'win32', env: {}, run: async () => { throw new Error('bad zip'); } }));
  });

  test('unpacks server/ into program/<version>/, executable, and nothing else', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const dir = freshDir('unpack');
    const zip = touch(path.join(dir, 'downloads', 'a.mcpb'), mcpb());
    const programDir = path.join(dir, 'program');
    const exe = await A.unpackServer({ mcpb: zip, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun });
    assert.equal(exe, path.join(programDir, '0.2.0', 'openextract-ai'));
    assert.equal(fs.readFileSync(exe, 'utf-8'), PROGRAM);
    if (posix) assert.equal(fs.statSync(exe).mode & 0o111, 0o111, 'made executable');
    assert.equal(fs.readFileSync(path.join(programDir, '0.2.0', '_internal', 'base_library.txt'), 'utf-8'), 'library '.repeat(500));
    assert.deepEqual(fs.readdirSync(programDir), ['0.2.0'], 'no manifest, no leftover unpacking folder');
    assert.equal(fs.existsSync(path.join(programDir, '0.2.0', 'manifest.json')), false);
  });

  test('a version already unpacked is kept; a broken folder for it is replaced', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const dir = freshDir('unpack');
    const zip = touch(path.join(dir, 'a.mcpb'), mcpb());
    const programDir = path.join(dir, 'program');
    const marker = touch(path.join(programDir, '0.2.0', 'openextract-ai'), 'already here');
    let ran = 0;
    await A.unpackServer({ mcpb: zip, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: async (...a) => { ran++; return hostRun(...a); } });
    assert.equal(ran, 0);
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'already here');

    fs.rmSync(marker);
    touch(path.join(programDir, '0.2.0', 'leftover.txt'));
    await A.unpackServer({ mcpb: zip, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun });
    assert.equal(fs.readFileSync(marker, 'utf-8'), PROGRAM);
    assert.equal(fs.existsSync(path.join(programDir, '0.2.0', 'leftover.txt')), false);
  });

  test('a download without the program in it, or that won\'t unzip, says so and leaves nothing', { skip: !hasHostTool && 'no unzip here' }, async () => {
    const dir = freshDir('unpack');
    const programDir = path.join(dir, 'program');
    const noServer = touch(path.join(dir, 'a.mcpb'), mcpb({ withServer: false }));
    await assert.rejects(A.unpackServer({ mcpb: noServer, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun }), { message: A.ERRORS.noProgram });
    const wrongName = touch(path.join(dir, 'b.mcpb'), mcpb({ exe: 'something-else' }));
    await assert.rejects(A.unpackServer({ mcpb: wrongName, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun }), { message: A.ERRORS.noProgram });
    const notZip = touch(path.join(dir, 'c.mcpb'), 'this is not a zip');
    await assert.rejects(A.unpackServer({ mcpb: notZip, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun }), { message: A.ERRORS.cantUnpack });
    assert.deepEqual(fs.readdirSync(programDir), []);
    await assert.rejects(A.unpackServer({ mcpb: notZip, programDir, version: '../x', platform: 'darwin', env: process.env, run: hostRun }), { message: A.ERRORS.badIndex });
  });

  test('a link that leads out of the program\'s folder is refused', { skip: (!posix || !hasHostTool) && 'links need macOS or Linux' }, async () => {
    const dir = freshDir('unpack');
    const programDir = path.join(dir, 'program');
    const zip = touch(path.join(dir, 'a.mcpb'), mcpb({ extra: [{ name: 'server/_internal/escape', symlink: '../../../../../etc' }] }));
    await assert.rejects(A.unpackServer({ mcpb: zip, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun }), { message: A.ERRORS.cantUnpack });
    assert.deepEqual(fs.readdirSync(programDir), []);
    // A link inside it (PyInstaller makes these on macOS) is fine.
    const inside = touch(path.join(dir, 'b.mcpb'), mcpb({ extra: [{ name: 'server/_internal/Python', symlink: 'base_library.txt' }] }));
    await A.unpackServer({ mcpb: inside, programDir, version: '0.2.0', platform: 'darwin', env: process.env, run: hostRun });
    assert.equal(fs.readlinkSync(path.join(programDir, '0.2.0', '_internal', 'Python')), 'base_library.txt');
  });
});

// ── current.json ────────────────────────────────────────────────────────────

describe('program/current.json', () => {
  test('written with the version and the program\'s absolute path; read back only if it\'s really there', () => {
    const home = freshDir('ai-home');
    const command = touch(path.join(home, 'program', '0.2.0', 'openextract-ai'), PROGRAM);
    A.writeCurrent(home, { version: '0.2.0', command });
    const file = path.join(home, 'program', 'current.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { version: '0.2.0', command });
    assert.deepEqual(A.readCurrent(home), { version: '0.2.0', command });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['0.2.0', 'current.json'], 'no temp file left');

    fs.rmSync(command);
    assert.equal(A.readCurrent(home), null, 'the program is gone');
    const elsewhere = touch(path.join(freshDir('elsewhere'), 'openextract-ai'));
    fs.writeFileSync(file, JSON.stringify({ version: '0.2.0', command: elsewhere }));
    assert.equal(A.readCurrent(home), null, 'a program outside program/ is never run');
    fs.writeFileSync(file, JSON.stringify({ version: '0.2.0', command: 'openextract-ai' }));
    assert.equal(A.readCurrent(home), null, 'not an absolute path');
    fs.writeFileSync(file, 'garbage');
    assert.equal(A.readCurrent(home), null);
    assert.equal(A.readCurrent(freshDir('empty-home')), null);
  });
});

// ── Installing, start to finish ─────────────────────────────────────────────

describe('installAddon', () => {
  async function addonServer(t, { zip = mcpb(), files } = {}) {
    let s;
    const routes = {
      '/ai/index.json': (req, res) => sendJson(index(files ?? {
        'mac-arm64': { url: s.url('/ai/openextract-ai-0.2.0-mac-arm64.mcpb'), sha256: sha(zip), size: zip.length },
        'win-x64': { url: s.url('/ai/openextract-ai-0.2.0-win-x64.mcpb'), sha256: sha(zip), size: zip.length },
      }))(req, res),
      '/ai/openextract-ai-0.2.0-mac-arm64.mcpb': sendBytes(zip),
    };
    s = await serve(routes);
    t.after(s.close);
    return s;
  }

  test('index.json, the .mcpb into downloads/, server/ into program/0.2.0/, then current.json', { skip: !hasHostTool && 'no unzip here' }, async t => {
    const s = await addonServer(t);
    const home = freshDir('ai-home');
    const progress = [];
    const options = {
      platform: 'darwin', arch: 'arm64', env: { OPENEXTRACT_AI_HOME: home }, homedir: '/nonexistent-home',
      indexUrl: s.url('/ai/index.json'), fetch, run: hostRun, onProgress: p => progress.push(p.step),
    };
    const r = await A.installAddon(options);
    const command = path.join(home, 'program', '0.2.0', 'openextract-ai');
    const mcpbPath = path.join(home, 'downloads', 'openextract-ai-0.2.0-mac-arm64.mcpb');
    assert.deepEqual(r, { ok: true, installed: { version: '0.2.0', command }, mcpb: mcpbPath });
    assert.ok(fs.existsSync(mcpbPath));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'program', 'current.json'), 'utf-8')), { version: '0.2.0', command });
    assert.deepEqual([...new Set(progress)], ['index', 'download', 'verify', 'unpack']);
    assert.deepEqual(s.requests, ['/ai/index.json', '/ai/openextract-ai-0.2.0-mac-arm64.mcpb']);

    // Again: index.json is asked for, but the file already checks out and the program is there.
    assert.equal((await A.installAddon(options)).ok, true);
    assert.deepEqual(s.requests.slice(2), ['/ai/index.json']);
  });

  test('a computer with no download, a missing index and a bad download fail in plain words, installing nothing', async t => {
    const s = await addonServer(t, { files: { 'mac-arm64': { url: 'http://127.0.0.1:9/a.mcpb', sha256: 'f'.repeat(64), size: 5 } } });
    const home = freshDir('ai-home');
    const base = { env: { OPENEXTRACT_AI_HOME: home }, homedir: '/nonexistent-home', fetch, run: hostRun };
    assert.deepEqual(await A.installAddon({ ...base, platform: 'linux', arch: 'x64', indexUrl: s.url('/ai/index.json') }), { ok: false, error: A.ERRORS.notForThisComputer });
    assert.deepEqual(s.requests, [], 'nothing asked for when there\'s nothing to get');
    assert.deepEqual(await A.installAddon({ ...base, platform: 'win32', arch: 'x64', indexUrl: s.url('/ai/index.json') }), { ok: false, error: A.ERRORS.notForThisComputer });
    assert.deepEqual(await A.installAddon({ ...base, platform: 'darwin', arch: 'arm64', indexUrl: s.url('/nope.json') }), { ok: false, error: A.ERRORS.server(404) });
    assert.deepEqual(await A.installAddon({ ...base, platform: 'darwin', arch: 'arm64', indexUrl: 'http://127.0.0.1:9/index.json' }), { ok: false, error: A.ERRORS.offline });
    const notFound = await A.installAddon({ ...base, platform: 'darwin', arch: 'arm64', indexUrl: s.url('/ai/index.json') });
    assert.deepEqual(notFound, { ok: false, error: A.ERRORS.offline }, 'nothing answers where index.json says the file is');
    assert.equal(A.readCurrent(home), null);
    assert.equal(fs.existsSync(path.join(home, 'program', 'current.json')), false);
  });

  test('a download whose SHA-256 doesn\'t match index.json is never unpacked', async t => {
    const zip = mcpb();
    let s;
    s = await serve({
      '/i.json': (req, res) => sendJson(index({ 'mac-arm64': { url: s.url('/a.mcpb'), sha256: sha(Buffer.from('other')), size: zip.length } }))(req, res),
      '/a.mcpb': sendBytes(zip),
    });
    t.after(s.close);
    const home = freshDir('ai-home');
    let unzipped = 0;
    const r = await A.installAddon({ platform: 'darwin', arch: 'arm64', env: { OPENEXTRACT_AI_HOME: home }, homedir: '/x', indexUrl: s.url('/i.json'), fetch, run: async () => { unzipped++; } });
    assert.deepEqual(r, { ok: false, error: A.ERRORS.corrupt });
    assert.equal(unzipped, 0);
    assert.deepEqual(fs.readdirSync(path.join(home, 'downloads')), []);
  });
});

// ── --status ────────────────────────────────────────────────────────────────

describe('the add-on\'s --status', () => {
  const line = obj => JSON.stringify(obj);

  test('free questions left, or whose key it has, checked field by field', () => {
    assert.deepEqual(A.parseStatus(line({ version: '0.2.0', key: null, free_questions: 3, free_questions_left: 1 })),
      { version: '0.2.0', key: null, freeQuestions: 3, freeQuestionsLeft: 1 });
    assert.deepEqual(A.parseStatus(`starting\n${line({ version: '0.2.0', key: { name: ' Sarah ', kind: 'friends', until: '2027-03-31' }, free_questions: 3, free_questions_left: 0 })}\r\n`),
      { version: '0.2.0', key: { name: 'Sarah', kind: 'friends', until: '2027-03-31' }, freeQuestions: 3, freeQuestionsLeft: 0 });
    assert.equal(A.parseStatus(line({ version: '0.2.0', key: { name: 'Al', kind: 'dev', until: null }, free_questions: 3, free_questions_left: 9 })).freeQuestionsLeft, 3);
    for (const bad of ['', 'not json', line({ version: 2, key: null, free_questions: 3, free_questions_left: 1 }),
      line({ version: '0.2.0', key: null, free_questions: -1, free_questions_left: 1 }), line({ version: '0.2.0', key: { name: '' }, free_questions: 3, free_questions_left: 1 }),
      line({ version: '0.2.0', key: 'Sarah', free_questions: 3, free_questions_left: 1 })]) {
      assert.equal(A.parseStatus(bad), null, bad);
    }
  });

  function fakeProgram(script) {
    const exe = touch(path.join(freshDir('fake-addon'), 'openextract-ai'), `#!/bin/sh\n${script}\n`);
    fs.chmodSync(exe, 0o755);
    return exe;
  }

  test('runs the program with --status and reads its one line', { skip: !posix && 'a shell script stands in for the program' }, async () => {
    const exe = fakeProgram(`if [ "$1" = "--status" ]; then echo '${line({ version: '0.2.0', key: { name: 'Sarah', kind: 'friends', until: '2027-03-31' }, free_questions: 3, free_questions_left: 3 })}'; exit 0; fi\nexit 3`);
    assert.deepEqual(await A.addonStatus(exe), { ok: true, status: { version: '0.2.0', key: { name: 'Sarah', kind: 'friends', until: '2027-03-31' }, freeQuestions: 3, freeQuestionsLeft: 3 } });
  });

  test('a program that hangs is stopped at the time limit; one that fails or mumbles says so', { skip: !posix && 'a shell script stands in for the program' }, async () => {
    const started = Date.now();
    const hang = await A.addonStatus(fakeProgram('exec sleep 10'), { timeoutMs: 300 });
    assert.deepEqual(hang, { ok: false, error: "OpenExtract AI didn't answer in time. Try again." });
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await A.addonStatus(fakeProgram('exit 1')), { ok: false, error: "OpenExtract AI couldn't be started. Try installing it again." });
    assert.deepEqual(await A.addonStatus(path.join(freshDir('none'), 'openextract-ai')), { ok: false, error: "OpenExtract AI couldn't be started. Try installing it again." });
    assert.deepEqual(await A.addonStatus(fakeProgram('echo hello')), { ok: false, error: "OpenExtract AI's answer couldn't be read. Try installing it again." });
  });

  test('the runner gets the command, --status and the time limit', async () => {
    const calls = [];
    const runner = async (...args) => { calls.push(args); return line({ version: '0.2.0', key: null, free_questions: 3, free_questions_left: 2 }); };
    const r = await A.addonStatus('C:\\Users\\Sam\\AppData\\Roaming\\OpenExtract AI\\program\\0.2.0\\openextract-ai.exe', { runner });
    assert.equal(r.ok && r.status.freeQuestionsLeft, 2);
    assert.deepEqual(calls, [['C:\\Users\\Sam\\AppData\\Roaming\\OpenExtract AI\\program\\0.2.0\\openextract-ai.exe', ['--status'], A.STATUS_TIMEOUT_MS]]);
  });
});

// ── Claude Code ─────────────────────────────────────────────────────────────

describe('Claude Code\'s command', () => {
  test('quoted for the system\'s shell', () => {
    assert.equal(A.claudeCodeCommand('/Users/sam/Library/Application Support/OpenExtract AI/program/0.2.0/openextract-ai', 'darwin'),
      'claude mcp add --scope user openextract -- "/Users/sam/Library/Application Support/OpenExtract AI/program/0.2.0/openextract-ai"');
    assert.equal(A.claudeCodeCommand('/Users/$am/`x`/"q"/a\\b', 'darwin'), 'claude mcp add --scope user openextract -- "/Users/\\$am/\\`x\\`/\\"q\\"/a\\\\b"');
    assert.equal(A.claudeCodeCommand('C:\\Users\\Sam Lee\\AppData\\Roaming\\OpenExtract AI\\program\\0.2.0\\openextract-ai.exe', 'win32'),
      'claude mcp add --scope user openextract -- "C:\\Users\\Sam Lee\\AppData\\Roaming\\OpenExtract AI\\program\\0.2.0\\openextract-ai.exe"');
  });
});
