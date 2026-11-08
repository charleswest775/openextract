// Installs the release packages built for this OS the way people install them, checks what
// landed where, starts the installed app and runs the end-to-end smoke suite against it,
// upgrades over the previous release, then uninstalls and checks nothing is left behind.
// Run by .github/workflows/installers.yml on each OS, both on unsigned builds and on a
// release's signed draft before it's published.
//
//   node scripts/installers/test-installers.mjs --dir <packages> --backups <backups.json>
//        [--previous <dir with the previous release's packages>] [--signed] [--out <dir>]
//
//   macOS    OpenExtract-<v>-arm64.dmg and -mac.zip: copy out, signature (Gatekeeper when
//            --signed), launch, delete
//   Windows  OpenExtract-Setup-<v>.exe: silent per-user install, Start menu and uninstall
//            entries, launch, upgrade, silent uninstall
//   Linux    openextract_<v>_amd64.deb with apt (dependencies resolve), desktop entry, launch,
//            upgrade, remove; OpenExtract-<v>.AppImage launched as people run it; the
//            engine started on the oldest distros we support (Docker)
//
// Every OS also checks the auto-update metadata (latest*.yml) against the files it names:
// a wrong size or sha512 there makes every user's update fail. Needs sudo on Linux. Changes
// the machine it runs on (installs and uninstalls OpenExtract): run it on a CI runner or a
// throwaway VM, not your own computer.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { check, results, ROOT, setSuite, sleep, timing } from '../e2e/harness.mjs';

const { values: opts } = parseArgs({
  options: {
    dir: { type: 'string' },
    backups: { type: 'string' },
    previous: { type: 'string' },
    signed: { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(ROOT, 'installer-out') },
  },
});
if (!opts.dir || !opts.backups) {
  console.error('usage: node scripts/installers/test-installers.mjs --dir <packages> --backups <backups.json> [--previous <dir>] [--signed] [--out <dir>]');
  process.exit(2);
}
const DIR = path.resolve(opts.dir);
const OUT = path.resolve(opts.out);
fs.mkdirSync(OUT, { recursive: true });
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version;
const backups = JSON.parse(fs.readFileSync(opts.backups, 'utf-8'));
for (const b of Object.values(backups)) {
  const expected = path.join(path.dirname(b.dir), 'expected.json');
  b.expected = fs.existsSync(expected) ? JSON.parse(fs.readFileSync(expected, 'utf-8')) : null;
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-installers-'));
results.kind = 'installers';
results.version = VERSION;
results.signed = opts.signed;

const files = dir => (dir && fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const find = (dir, re) => files(dir).filter(f => re.test(f)).map(f => path.join(dir, f))[0];
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf-8', timeout: 600_000, ...o });
const sh = (cmd, args, o) => execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();

/** Runs the end-to-end smoke suite (scripts/e2e) against an installed executable. */
function smoke(label, exe, env = {}) {
  const out = path.join(OUT, `smoke-${label}`);
  const args = [path.join(ROOT, 'scripts/e2e/run.mjs'), '--app', exe, '--suites', 'smoke', '--backups', opts.backups, '--out', out];
  const cmd = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : process.execPath;
  const full = cmd === 'xvfb-run' ? ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, ...args] : args;
  const t0 = performance.now();
  const r = run(cmd, full, { env: { ...process.env, ...env }, stdio: 'inherit', timeout: 900_000 });
  timing(`installed app smoke run (${label})`, performance.now() - t0);
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf-8')).summary; } catch {}
  return check(`${label}: the installed app passes the smoke suite`, r.status === 0, { status: r.status, summary });
}

/** Starts the bundled engine directly and asks it to open a backup, as the app would. */
async function engine(label, exe) {
  const b = backups['maren-encrypted'];
  const p = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OPENEXTRACT_LOG_PATH: path.join(work, `engine-${label}.log`) } });
  const lines = [];
  let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; });
  const next = async ms => { const t0 = Date.now(); while (!lines.length && Date.now() - t0 < ms && p.exitCode === null) await sleep(50); return lines.length ? JSON.parse(lines.shift()) : null; };
  const call = async (id, method, params) => { p.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return next(120_000); };
  try {
    const t0 = performance.now();
    const ready = await next(120_000);
    timing(`bundled engine start (${label})`, performance.now() - t0);
    if (!check(`${label}: the bundled engine starts`, ready?.status === 'ready', { ready, stderr: stderr.slice(-800) })) return;
    const udid = path.basename(b.dir);
    const opened = await call(1, 'open_backup', { udid, backup_dir: b.dir, password: b.password });
    const convos = await call(2, 'list_conversations', { udid });
    const list = Array.isArray(convos?.result) ? convos.result : convos?.result?.conversations;
    check(`${label}: the bundled engine opens an encrypted backup`, opened?.result?.status === 'open' && list?.length === b.expected.conversations.length,
      { opened: opened?.result?.status ?? opened?.error, conversations: list?.length });
  } finally {
    p.stdin.end();
    p.kill();
  }
}

/** The engine is a folder (scripts/bundle-engine.mjs): the executable next to _internal/. */
function engineFolder(label, dir, exe) {
  const internal = path.join(dir, '_internal');
  check(`${label}: the engine is the folder build (no unpacking at start)`,
    fs.existsSync(path.join(dir, exe)) && fs.existsSync(internal) && fs.statSync(internal).isDirectory(), files(dir));
}

/**
 * Notarization rejects an app if any executable or library in it lacks its own signature
 * with the hardened runtime, and when --signed, our Developer ID and a secure timestamp.
 * The engine has a hundred or more of them (.so, .dylib); electron-builder signs each one.
 */
function engineSignatures(label, app) {
  const dir = path.join(app, 'Contents/Resources/python');
  const MACH_O = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe];
  const machO = fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => {
    if (!fs.lstatSync(f).isFile()) return false;
    const head = Buffer.alloc(4);
    const fd = fs.openSync(f, 'r');
    try { return fs.readSync(fd, head, 0, 4, 0) === 4 && MACH_O.includes(head.readUInt32BE(0)); } finally { fs.closeSync(fd); }
  });
  const bad = [];
  for (const f of machO) {
    const info = run('codesign', ['-dv', '--verbose=2', f]).stderr;
    const ok = /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(info)
      && (!opts.signed || (/^Authority=Developer ID Application:/m.test(info) && /^Timestamp=/m.test(info)));
    if (!ok) bad.push(`${path.relative(dir, f)}: ${info.split('\n').filter(l => /flags=|Authority=|Timestamp=|not signed/.test(l)).join('; ')}`);
  }
  check(`${label}: every binary in the engine is signed with ${opts.signed ? 'our Developer ID, a timestamp and ' : ''}the hardened runtime`,
    machO.length > 0 && bad.length === 0, { binaries: machO.length, bad: bad.slice(0, 10) });
}

/** latest*.yml lists each update file with its size and sha512; both must match the file. */
function updateMetadata(name) {
  const yml = path.join(DIR, name);
  if (!check(`update metadata ${name} is present`, fs.existsSync(yml))) return;
  const text = fs.readFileSync(yml, 'utf-8');
  check(`${name} names version ${VERSION}`, new RegExp(`^version: ${VERSION.replace(/\./g, '\\.')}$`, 'm').test(text), text.split('\n')[0]);
  const entries = [...text.matchAll(/- url: (\S+)\s+sha512: (\S+)\s+size: (\d+)/g)];
  check(`${name} lists at least one file`, entries.length > 0);
  for (const [, url, sha512, size] of entries) {
    // Unsigned local builds keep electron-builder's spaces ("OpenExtract Setup 0.10.1.exe"); the
    // yml names the dashed file GitHub serves, which is what a release's assets are called.
    const file = path.join(DIR, files(DIR).find(f => f === url || f.replace(/ /g, '-') === url) ?? url);
    if (!check(`${name}: ${url} exists`, fs.existsSync(file))) continue;
    const data = fs.readFileSync(file);
    check(`${name}: ${url} size matches`, data.length === Number(size), { yml: Number(size), file: data.length });
    check(`${name}: ${url} sha512 matches`, crypto.createHash('sha512').update(data).digest('base64') === sha512);
  }
}

// ── macOS ────────────────────────────────────────────────────────────────────

async function mac() {
  setSuite('macos');
  updateMetadata('latest-mac.yml');
  const dmg = find(DIR, /\.dmg$/);
  const zip = find(DIR, /-mac\.zip$/);
  check('a .dmg and a -mac.zip were built', dmg && zip, files(DIR));
  const apps = [];
  if (dmg) {
    const mnt = path.join(work, 'dmg');
    fs.mkdirSync(mnt);
    const att = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, dmg]);
    if (check('the .dmg mounts', att.status === 0, att.stderr)) {
      check('the .dmg holds OpenExtract.app and an Applications link', fs.existsSync(path.join(mnt, 'OpenExtract.app')) && fs.lstatSync(path.join(mnt, 'Applications')).isSymbolicLink(), files(mnt));
      const dest = path.join(work, 'Applications-dmg');
      fs.mkdirSync(dest);
      run('ditto', [path.join(mnt, 'OpenExtract.app'), path.join(dest, 'OpenExtract.app')]);
      run('hdiutil', ['detach', mnt, '-force']);
      apps.push(['dmg', path.join(dest, 'OpenExtract.app')]);
    }
  }
  if (zip) {
    const dest = path.join(work, 'Applications-zip');
    const r = run('ditto', ['-x', '-k', zip, dest]);
    if (check('the -mac.zip (what auto-update downloads) unpacks', r.status === 0 && fs.existsSync(path.join(dest, 'OpenExtract.app')), r.stderr)) apps.push(['zip', path.join(dest, 'OpenExtract.app')]);
  }
  for (const [label, app] of apps) {
    const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf-8');
    check(`${label}: Info.plist has version ${VERSION} and bundle id com.openextract.app`, plist.includes(`<string>${VERSION}</string>`) && plist.includes('<string>com.openextract.app</string>'));
    const eng = path.join(app, 'Contents/Resources/python/openextract-engine');
    check(`${label}: the engine is bundled and executable`, fs.existsSync(eng) && (fs.statSync(eng).mode & 0o111) !== 0);
    engineFolder(label, path.dirname(eng), 'openextract-engine');
    // Unsigned test builds are signed ad hoc by electron-builder (installers.yml), the same
    // way a release is signed, minus the Developer ID: Apple silicon won't launch without it.
    const v = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    check(`${label}: code signature is valid`, v.status === 0, v.stderr.slice(-600));
    engineSignatures(label, app);
    if (opts.signed) {
      // As if downloaded: Gatekeeper must accept it (Developer ID, notarized and stapled).
      // The ticket is stapled (build/notarize.js), so this needs no answer from Apple.
      run('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', app]);
      const g = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
      check(`${label}: Gatekeeper accepts it as downloaded`, g.status === 0 && /Notarized Developer ID/.test(g.stderr), g.stderr.slice(-600));
      const st = run('xcrun', ['stapler', 'validate', app]);
      check(`${label}: the notarization ticket is stapled`, st.status === 0, st.stdout.slice(-300));
      run('xattr', ['-d', 'com.apple.quarantine', app]);
    }
    await engine(label, eng);
    smoke(label, path.join(app, 'Contents/MacOS/OpenExtract'));
  }
  // "Uninstalling" on macOS is deleting the app; settings stay in Application Support.
  for (const [, app] of apps) fs.rmSync(path.dirname(app), { recursive: true, force: true });
  check('deleting the app removes it', apps.every(([, app]) => !fs.existsSync(app)));
}

// ── Windows ──────────────────────────────────────────────────────────────────

const WIN_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenExtract');
const START_MENU = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenExtract.lnk');

/**
 * Installers built with electron-builder 26.8.1 (0.11.0 and earlier) crash in NSIS's System.dll on
 * about one fresh install in four (see windows-app-control.yml), so the previous release gets
 * `attempts` tries. Once the previous release is built with 26.12 or later, it needs only one.
 */
function nsisInstall(installer, attempts = 1) {
  let r;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    r = run(installer, ['/S'], { timeout: 300_000 });
    if (r.status === 0) return { ok: true, attempts: attempt };
    console.log(`Silent install attempt ${attempt} exited with ${r.status}`);
    if (attempt < attempts) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
  }
  return { ok: false, status: r.status };
}

function uninstallEntry() {
  // /f searches value data, so it prints only the matching values: find the key, then read all of it.
  const search = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'OpenExtract', '/d']);
  const keys = [...new Set(search.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^HKEY_/.test(l)))];
  for (const key of keys) {
    const values = run('reg', ['query', key]).stdout;
    if (!/DisplayName\s+REG_SZ\s+OpenExtract\b/.test(values)) continue;
    return { found: true, key, version: values.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1], publisher: values.match(/Publisher\s+REG_SZ\s+(.+)/)?.[1]?.trim() };
  }
  return { found: false };
}

async function windows() {
  setSuite('windows');
  updateMetadata('latest.yml');
  const installer = find(DIR, /^OpenExtract[- ]Setup[- ][\d.]+\.exe$/);
  if (!check('an NSIS installer was built', !!installer, files(DIR))) return;
  // Settings from an earlier run must survive upgrades and uninstalls.
  const userData = path.join(process.env.APPDATA, 'OpenExtract');
  fs.mkdirSync(userData, { recursive: true });
  const marker = path.join(userData, 'installer-test-marker.txt');
  fs.writeFileSync(marker, 'keep me');

  const previous = find(opts.previous, /^OpenExtract[- ]Setup[- ][\d.]+\.exe$/);
  if (previous) {
    const p = nsisInstall(previous, 10);
    check(`the previous release (${path.basename(previous)}) installs`, p.ok, p);
    check('the previous release is registered', !!uninstallEntry().found);
  }
  const t0 = performance.now();
  const r = nsisInstall(installer);
  timing('silent install', performance.now() - t0);
  check(previous ? 'the new installer upgrades the previous release silently' : 'the installer installs silently (/S)', r.ok, r);
  const exe = path.join(WIN_DIR, 'OpenExtract.exe');
  check('installed per user under %LOCALAPPDATA%\\Programs\\OpenExtract', fs.existsSync(exe), files(WIN_DIR));
  const entry = uninstallEntry();
  check(`"Apps & features" lists OpenExtract ${VERSION}`, entry.found && entry.version === VERSION, entry);
  check('a Start menu shortcut was created', fs.existsSync(START_MENU));
  const eng = path.join(WIN_DIR, 'resources', 'python', 'openextract-engine.exe');
  check('the engine is the folder build (signable DLLs, #169)', fs.existsSync(eng) && fs.existsSync(path.join(WIN_DIR, 'resources', 'python', '_internal')));
  check('settings from before the upgrade are kept', fs.existsSync(marker));
  await engine('nsis', eng);
  smoke('nsis', exe);

  const uninstaller = path.join(WIN_DIR, 'Uninstall OpenExtract.exe');
  if (check('the uninstaller is installed', fs.existsSync(uninstaller))) {
    run(uninstaller, ['/S'], { timeout: 300_000 });
    // The uninstaller copies itself to %TEMP% and returns before it's done.
    // The uninstaller copies itself to %TEMP% and returns before it's done; the uninstall entry
    // and shortcuts go last.
    for (let i = 0; i < 180 && (fs.existsSync(exe) || fs.existsSync(START_MENU) || uninstallEntry().found); i++) await sleep(1000);
    check('silent uninstall removes the app', !fs.existsSync(exe), files(WIN_DIR));
    check('silent uninstall removes the "Apps & features" entry', !uninstallEntry().found);
    check('silent uninstall removes the Start menu shortcut', !fs.existsSync(START_MENU));
    check('uninstalling keeps the user\'s settings', fs.existsSync(marker));
  }
  fs.rmSync(marker, { force: true });
}

// ── Linux ────────────────────────────────────────────────────────────────────

/** Starts `exe` as the desktop entry does (no --no-sandbox) for 15 s; reports whether it stayed up. */
async function startsSandboxed(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-sandbox-profile-'));
  const args = [`--user-data-dir=${profile}`];
  const p = process.env.DISPLAY ? spawn(exe, args, { detached: true }) : spawn('xvfb-run', ['-a', exe, ...args], { detached: true });
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; });
  p.stdout.on('data', () => {});
  await sleep(15_000);
  const running = p.exitCode === null;
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  await sleep(1000);
  try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  const error = stderr.split('\n').find(l => /sandbox/i.test(l) && /(not configured|No usable|FATAL|failed)/i.test(l));
  return { running, exitCode: p.exitCode, error, tail: running ? undefined : stderr.slice(-600) };
}

async function linux() {
  setSuite('linux');
  updateMetadata('latest-linux.yml');
  const deb = find(DIR, /^openextract_[\d.]+_amd64\.deb$/);
  const appimage = find(DIR, /\.AppImage$/);
  check('a .deb and an AppImage were built', deb && appimage, files(DIR));
  if (deb) {
    const info = sh('dpkg-deb', ['--field', deb, 'Package', 'Version', 'Depends']);
    check(`.deb is package openextract ${VERSION}`, info.includes('Package: openextract') && info.includes(`Version: ${VERSION}`), info);
    const previous = find(opts.previous, /^openextract_[\d.]+_amd64\.deb$/);
    if (previous) {
      const p = run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', previous]);
      check(`the previous release (${path.basename(previous)}) installs with apt`, p.status === 0, p.stderr.slice(-800));
    }
    const t0 = performance.now();
    const r = run('sudo', ['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', deb]);
    timing('apt install', performance.now() - t0);
    check(previous ? 'apt upgrades the previous release, dependencies resolved' : 'apt installs it, dependencies resolved', r.status === 0, r.stderr.slice(-1200));
    const status = run('dpkg-query', ['-W', '-f=${Version} ${Status}', 'openextract']).stdout;
    check(`dpkg reports ${VERSION} installed`, status === `${VERSION} install ok installed`, status);
    const exe = '/opt/OpenExtract/openextract';
    check('installed to /opt/OpenExtract', fs.existsSync(exe));
    const desktop = '/usr/share/applications/openextract.desktop';
    const entry = fs.existsSync(desktop) ? fs.readFileSync(desktop, 'utf-8') : '';
    check('a desktop entry launches /opt/OpenExtract/openextract', /^Exec=.*\/opt\/OpenExtract\/openextract/m.test(entry) && /^Name=OpenExtract$/m.test(entry), entry);
    const icon = entry.match(/^Icon=(.+)$/m)?.[1];
    check('its icon is installed', !!icon && run('sh', ['-c', `ls /usr/share/icons/hicolor/*/apps/${icon}.png`]).status === 0, icon);
    const v = run('desktop-file-validate', [desktop]);
    if (v.error?.code !== 'ENOENT') check('the desktop entry is valid', v.status === 0, v.stdout + v.stderr);
    // The desktop entry starts the app with Chromium's sandbox on (the smoke run turns it off).
    // electron-builder's postinst makes chrome-sandbox setuid only where user namespaces are
    // missing, so check the outcome: the app keeps running, with no sandbox error.
    const sandboxed = await startsSandboxed(exe);
    check('the installed app starts with the Chromium sandbox on, as the desktop entry runs it', sandboxed.running && !sandboxed.error, sandboxed);
    const eng = '/opt/OpenExtract/resources/python/openextract-engine';
    engineFolder('deb', path.dirname(eng), 'openextract-engine');
    await engine('deb', eng);
    smoke('deb', exe);
    const rm = run('sudo', ['apt-get', 'remove', '-y', 'openextract']);
    check('apt removes it', rm.status === 0 && !fs.existsSync(exe) && !fs.existsSync(desktop), rm.stderr.slice(-400));

    // The engine bundles the build system's glibc needs; it must start on the oldest
    // distros we support (built on ubuntu-24.04 it needed GLIBC_2.38, see release.yml).
    if (run('docker', ['version']).status === 0) {
      const x = path.join(work, 'deb-x');
      run('dpkg-deb', ['-x', deb, x]);
      for (const image of ['ubuntu:22.04', 'debian:12']) {
        const d = run('docker', ['run', '--rm', '-v', `${x}:/x:ro`, image, 'sh', '-c',
          'printf \'{"id":1,"method":"ping","params":{}}\\n\' | OPENEXTRACT_LOG_PATH=/tmp/l /x/opt/OpenExtract/resources/python/openextract-engine'], { timeout: 300_000 });
        check(`the engine starts and answers on ${image}`, d.status === 0 && /"status": ?"ok"/.test(d.stdout), (d.stdout + d.stderr).slice(-800));
      }
    }
  }
  if (appimage) {
    fs.chmodSync(appimage, 0o755);
    // Launched the way people run it, minus FUSE, which CI runners don't have.
    smoke('appimage', appimage, { APPIMAGE_EXTRACT_AND_RUN: '1' });
  }
}

try {
  if (process.platform === 'darwin') await mac();
  else if (process.platform === 'win32') await windows();
  else await linux();
} catch (e) {
  check('no exception', false, String(e.stack || e).slice(0, 1500));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const failed = results.checks.filter(c => !c.ok);
results.summary = `${results.checks.length - failed.length}/${results.checks.length} passed`;
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.summary}`);
for (const f of failed) console.log(`  FAILED ${f.name}${f.detail !== undefined ? ' — ' + JSON.stringify(f.detail).slice(0, 400) : ''}`);
process.exit(failed.length ? 1 : 0);
