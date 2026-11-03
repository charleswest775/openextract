// Builds the Python engine with PyInstaller into python/dist (npm run python:bundle).
//
// macOS and Linux get a single file. Windows gets a folder, openextract-engine.exe
// next to _internal\, so electron-builder can sign every DLL and .pyd in it
// (win.signExts). A single-file engine unpacks them into %TEMP% as they came from
// PyPI, mostly unsigned, and Smart App Control refuses to load those (#169).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.platform === 'win32' ? '--onedir' : '--onefile';
const result = spawnSync('pyinstaller', [mode, '--noconfirm', '--name', 'openextract-engine', 'main.py'], {
  cwd: fileURLToPath(new URL('../python', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
