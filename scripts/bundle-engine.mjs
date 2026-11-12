// Builds the Python engine with PyInstaller into python/dist (npm run python:bundle).
//
// Every OS gets a folder: openextract-engine (.exe on Windows) next to _internal/, which
// package.json's extraResources copies to resources/python. A single-file engine unpacks
// itself into a temp folder on every start, which took about 8 s on macOS; the folder
// build starts in well under a second. It also lets the signing tools reach every
// library: electron-builder signs each DLL and .pyd on Windows (win.signExts), where a
// single-file engine's unsigned copies in %TEMP% were refused by Smart App Control
// (#169), and each dylib and .so on macOS, which notarization requires.
//
// PyInstaller builds for the chip of the Python that runs it, so the release builds the
// Mac engine twice, once with an arm64 Python and once with an x64 one under Rosetta
// (.github/actions/intel-mac-engine), and packages both in one electron-builder run, which
// writes a single latest-mac.yml for both. On macOS the engine therefore goes into
// python/dist/<arm64|x64>/openextract-engine, the folder package.json's mac.extraResources
// names with ${arch}; elsewhere into python/dist/openextract-engine.
//
//   node scripts/bundle-engine.mjs [--python <path>]
//
// --python picks the interpreter (default: python on Windows, python3 elsewhere); it needs
// PyInstaller and python/requirements.txt installed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { python: { type: 'string' } } });
const python = opts.python || (process.platform === 'win32' ? 'python' : 'python3');
const cwd = fileURLToPath(new URL('../python', import.meta.url));

function run(args) {
  const r = spawnSync(python, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r.stdout.trim();
}

const args = ['-m', 'PyInstaller', '--onedir', '--noconfirm', '--name', 'openextract-engine'];
if (process.platform === 'darwin') {
  const machine = run(['-c', 'import platform; print(platform.machine())']);
  const arch = { arm64: 'arm64', x86_64: 'x64' }[machine];
  if (!arch) throw new Error(`${python} is a ${machine} Python; the Mac engine is built for arm64 or x86_64`);
  console.log(`Building the ${arch} engine with ${python}`);
  args.push('--distpath', `dist/${arch}`, '--workpath', `build/${arch}`);
}

const result = spawnSync(python, [...args, 'main.py'], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
