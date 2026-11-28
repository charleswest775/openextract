export {};
/**
 * The folder an update replaces, given the running executable: the folder holding
 * OpenExtract.exe on Windows (and Linux), and the outermost .app bundle on macOS
 * (the executable is at OpenExtract.app/Contents/MacOS/OpenExtract).
 */
export declare function installFolderFor(exePath: string, platform?: string): string;
/**
 * True when `candidate` is `folder` itself or anywhere below it. Both are resolved first,
 * so trailing separators, `.` and `..` don't matter, and a sibling whose name only starts
 * the same way (OpenExtract2 next to OpenExtract) is outside. Doesn't touch the disk:
 * pass paths through resolveReal() first to see through links and short names.
 */
export declare function isInsideFolder(candidate: string, folder: string, platform?: string): boolean;
/**
 * The real path of `target` on this computer: links and junctions followed, Windows
 * 8.3 short names (C:\Users\CHARLE~1) expanded, and the on-disk case on Windows and
 * macOS. A save dialog returns a file that doesn't exist yet, so the deepest part of
 * the path that does exist is resolved and the rest is added back on.
 */
export declare function resolveReal(target: string): string;
/** What to tell someone who picked a folder inside the program folder. */
export declare function installFolderWarning(platform?: string): {
    message: string;
    detail: string;
};
