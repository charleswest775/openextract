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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pythonDir = fileURLToPath(new URL('../python', import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: pythonDir, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// --recursive-copy-metadata: some packages read their own installed metadata when imported
// (pyimg4 and apple_compress call importlib.metadata.version), and PyInstaller only collects
// metadata when asked. pymobiledevice3 11.54 began importing pyimg4 on its way to a backup,
// so 0.15.0's engine couldn't make one (OE-50, OE-51, OE-54). This collects the metadata of
// pymobiledevice3 and every package it needs on this OS (apple_compress only on macOS).
const built = run('pyinstaller', [
  '--onedir', '--noconfirm', '--name', 'openextract-engine',
  '--recursive-copy-metadata', 'pymobiledevice3',
  'main.py',
]);
if (built !== 0) process.exit(built);

// Most of the engine's imports only run when a feature does, so an engine that starts can
// still fail the first time someone backs up or saves a PDF. python/self_check.py runs each
// of them in the engine just built, and a failure stops the build here instead.
const engine = path.join(pythonDir, 'dist', 'openextract-engine',
  process.platform === 'win32' ? 'openextract-engine.exe' : 'openextract-engine');
process.exit(run(engine, ['--self-check', pythonDir]));
