"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installFolderFor = installFolderFor;
exports.isInsideFolder = isInsideFolder;
exports.resolveReal = resolveReal;
exports.installFolderWarning = installFolderWarning;
const path = require('path');
const fs = require('fs');
function pathFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}
/** The default file systems on Windows and macOS ignore case, so the comparison does too. */
function ignoresCase(platform) {
    return platform === 'win32' || platform === 'darwin';
}
/**
 * The folder an update replaces, given the running executable: the folder holding
 * OpenExtract.exe on Windows (and Linux), and the outermost .app bundle on macOS
 * (the executable is at OpenExtract.app/Contents/MacOS/OpenExtract).
 */
function installFolderFor(exePath, platform = process.platform) {
    const p = pathFor(platform);
    const exeDir = p.dirname(p.resolve(exePath));
    if (platform === 'darwin') {
        let bundle = null;
        for (let dir = exeDir; dir !== p.dirname(dir); dir = p.dirname(dir)) {
            if (dir.toLowerCase().endsWith('.app'))
                bundle = dir;
        }
        if (bundle)
            return bundle;
    }
    return exeDir;
}
/**
 * True when `candidate` is `folder` itself or anywhere below it. Both are resolved first,
 * so trailing separators, `.` and `..` don't matter, and a sibling whose name only starts
 * the same way (OpenExtract2 next to OpenExtract) is outside. Doesn't touch the disk:
 * pass paths through resolveReal() first to see through links and short names.
 */
function isInsideFolder(candidate, folder, platform = process.platform) {
    const p = pathFor(platform);
    let child = p.resolve(candidate);
    let parent = p.resolve(folder);
    if (ignoresCase(platform)) {
        child = child.toLowerCase();
        parent = parent.toLowerCase();
    }
    const rel = p.relative(parent, child);
    if (rel === '')
        return true;
    // Another drive on Windows gives an absolute path back.
    return !p.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + p.sep);
}
/**
 * The real path of `target` on this computer: links and junctions followed, Windows
 * 8.3 short names (C:\Users\CHARLE~1) expanded, and the on-disk case on Windows and
 * macOS. A save dialog returns a file that doesn't exist yet, so the deepest part of
 * the path that does exist is resolved and the rest is added back on.
 */
function resolveReal(target) {
    const missing = [];
    let current = path.resolve(target);
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(current), ...missing);
        }
        catch {
            const parent = path.dirname(current);
            if (parent === current)
                return path.resolve(target);
            missing.unshift(path.basename(current));
            current = parent;
        }
    }
}
/** What to tell someone who picked a folder inside the program folder. */
function installFolderWarning(platform = process.platform) {
    const where = platform === 'darwin' ? 'inside the OpenExtract app' : "inside OpenExtract's program folder";
    return {
        message: `This folder is ${where}, which is replaced every time OpenExtract updates.`,
        detail: 'Anything saved there would be deleted. Choose another folder.',
    };
}
