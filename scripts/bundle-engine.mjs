// Builds the Python engine with PyInstaller into python/dist (npm run python:bundle), then
// checks that the built engine can run every import in the engine's code.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { python: { type: 'string' } } });
const python = opts.python || (process.platform === 'win32' ? 'python' : 'python3');
const pythonDir = fileURLToPath(new URL('../python', import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: pythonDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: pythonDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.trim();
}

// --recursive-copy-metadata: some packages read their own installed metadata when imported
// (pyimg4 and apple_compress call importlib.metadata.version), and PyInstaller only collects
// metadata when asked. pymobiledevice3 11.54 began importing pyimg4 on its way to a backup,
// so 0.15.0's engine couldn't make one (OE-50, OE-51, OE-54). This collects the metadata of
// pymobiledevice3 and every package it needs on this OS (apple_compress only on macOS).
const args = [
  '-m', 'PyInstaller', '--onedir', '--noconfirm', '--name', 'openextract-engine',
  '--recursive-copy-metadata', 'pymobiledevice3',
];
let distDir = 'dist';
if (process.platform === 'darwin') {
  const machine = output(python, ['-c', 'import platform; print(platform.machine())']);
  const arch = { arm64: 'arm64', x86_64: 'x64' }[machine];
  if (!arch) throw new Error(`${python} is a ${machine} Python; the Mac engine is built for arm64 or x86_64`);
  console.log(`Building the ${arch} engine with ${python}`);
  distDir = path.join('dist', arch);
  args.push('--distpath', distDir, '--workpath', path.join('build', arch));
}

const built = run(python, [...args, 'main.py']);
if (built !== 0) process.exit(built);

// Most of the engine's imports only run when a feature does, so an engine that starts can
// still fail the first time someone backs up or saves a PDF. python/self_check.py runs each
// of them in the engine just built, and a failure stops the build here instead. The Intel
// Mac engine, built on Apple Silicon, runs this under Rosetta.
const engine = path.join(pythonDir, distDir, 'openextract-engine',
  process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine');
process.exit(run(engine, ['--self-check', pythonDir]));
