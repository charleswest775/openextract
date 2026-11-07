// Builds the Python engine with PyInstaller into python/dist (npm run python:bundle).
//
// Every OS gets a folder: openextract-engine (.exe on Windows) next to _internal/, which
// package.json's extraResources copies to resources/python. A single-file engine unpacks
// itself into a temp folder on every start, which took about 8 s on macOS; the folder
// build starts in well under a second. It also lets the signing tools reach every
// library: electron-builder signs each DLL and .pyd on Windows (win.signExts), where a
// single-file engine's unsigned copies in %TEMP% were refused by Smart App Control
// (#169), and each dylib and .so on macOS, which notarization requires.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('pyinstaller', ['--onedir', '--noconfirm', '--name', 'openextract-engine', 'main.py'], {
  cwd: fileURLToPath(new URL('../python', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
