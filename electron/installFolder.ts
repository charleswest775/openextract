export {};
const path = require('path');
const fs = require('fs');

/**
 * Keeps backups and exports out of OpenExtract's own program folder, which an update
 * replaces wholesale.
 *
 * On Windows, electron-builder's NSIS updater runs the old uninstaller, which deletes
 * the install folder (per-user default %LOCALAPPDATA%\Programs\openextract) with
 * everything inside it, including anything a user chose to save there. App data in
 * %APPDATA% is kept, so the Recent list survives and points at a folder that's gone.
 * On macOS an update swaps the whole OpenExtract.app bundle. On Linux the AppImage
 * mount and /opt/OpenExtract are read-only or root-owned, so the check rarely matters
 * there, but it costs nothing.
 *
 * The functions take a platform so the tests can check Windows paths on any computer.
 */

type PathApi = typeof path.posix;

function pathFor(platform: string): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** The default file systems on Windows and macOS ignore case, so the comparison does too. */
function ignoresCase(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * The folder an update replaces, given the running executable: the folder holding
 * OpenExtract.exe on Windows (and Linux), and the outermost .app bundle on macOS
 * (the executable is at OpenExtract.app/Contents/MacOS/OpenExtract).
 */
export function installFolderFor(exePath: string, platform: string = process.platform): string {
  const p = pathFor(platform);
  const exeDir = p.dirname(p.resolve(exePath));
  if (platform === 'darwin') {
    let bundle: string | null = null;
    for (let dir = exeDir; dir !== p.dirname(dir); dir = p.dirname(dir)) {
      if (dir.toLowerCase().endsWith('.app')) bundle = dir;
    }
    if (bundle) return bundle;
  }
  return exeDir;
}

/**
 * True when `candidate` is `folder` itself or anywhere below it. Both are resolved first,
 * so trailing separators, `.` and `..` don't matter, and a sibling whose name only starts
 * the same way (OpenExtract2 next to OpenExtract) is outside. Doesn't touch the disk:
 * pass paths through resolveReal() first to see through links and short names.
 */
export function isInsideFolder(candidate: string, folder: string, platform: string = process.platform): boolean {
  const p = pathFor(platform);
  let child = p.resolve(candidate);
  let parent = p.resolve(folder);
  if (ignoresCase(platform)) {
    child = child.toLowerCase();
    parent = parent.toLowerCase();
  }
  const rel = p.relative(parent, child);
  if (rel === '') return true;
  // Another drive on Windows gives an absolute path back.
  return !p.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + p.sep);
}

/**
 * The real path of `target` on this computer: links and junctions followed, Windows
 * 8.3 short names (C:\Users\CHARLE~1) expanded, and the on-disk case on Windows and
 * macOS. A save dialog returns a file that doesn't exist yet, so the deepest part of
 * the path that does exist is resolved and the rest is added back on.
 */
export function resolveReal(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** What to tell someone who picked a folder inside the program folder. */
export function installFolderWarning(platform: string = process.platform): { message: string; detail: string } {
  const where = platform === 'darwin' ? 'inside the OpenExtract app' : "inside OpenExtract's program folder";
  return {
    message: `This folder is ${where}, which is replaced every time OpenExtract updates.`,
    detail: 'Anything saved there would be deleted. Choose another folder.',
  };
}
