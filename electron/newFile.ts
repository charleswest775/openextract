/**
 * Files the main process writes into a folder the person chose: PDFs, and what the
 * window builds (the Timeline). None replaces a file that's there.
 */
const path = require('path');
const fs = require('fs');

// What can't be in a file name: folders, characters Windows refuses, control characters
// and the marks that reverse the direction of text (python/record_document.py's rule).
// eslint-disable-next-line no-control-regex
const FILE_NAME_UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A file's name from what the window sent: one file name, never a path, never empty. */
export function safeBaseName(name: unknown): string {
  const cleaned = String(name ?? '').replace(FILE_NAME_UNSAFE, ' ').replace(/\s+/g, ' ').trim()
    // A leading dot hides a file on a Mac; Windows drops trailing dots and spaces
    .replace(/^[.\s]+/, '').slice(0, 120).replace(/[.\s]+$/, '');
  if (!cleaned) return 'export';
  // Names Windows keeps for devices, with or without an extension ("CON.pdf")
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\s|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Whether something has this path, a link to nowhere included. */
function isThere(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to `target`, or to "Mom (2).pdf" and so on when that's taken, and return
 * the path written. The name is claimed as the file is created ('wx'), not looked up
 * beforehand: printing takes minutes, and another save or the person can take it meanwhile.
 */
export function writeNewFile(target: string, data: string | Buffer): string {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let n = 1; ; n++) {
    const file = n === 1 ? target : path.join(dir, `${base} (${n})${ext}`);
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err: any) {
      // Windows doesn't always say EEXIST, for a folder of that name for one
      if (err?.code === 'EEXIST' || isThere(file)) continue;
      throw err;
    }
    try {
      try {
        fs.writeFileSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      // No half-written file (a full disk): it's the one just created here, so it's ours
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Nothing more to do; the error below is what the user sees.
      }
      throw err;
    }
    return file;
  }
}
