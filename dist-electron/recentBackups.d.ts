/**
 * Which remembered backups the home screen lists.
 *
 * The app remembers the folder of each backup it opened (the last 20). A backup deleted since,
 * with Finder's or Apple Devices' Delete Backup or by putting its folder in the Trash or the
 * Recycle Bin, used to stay in the list and fail to open (in-app report OE-214). It's left out
 * now, but not forgotten: if the folder comes back, so does its row, with its saves count.
 *
 * Only a backup whose own folder is gone while the folder it was in is still there counts as
 * deleted. One on a drive that isn't plugged in has neither, and stays listed, because plugging
 * the drive in opens it again; the "Can't find this backup" alert offers Find it and Remove from
 * list for it (src/App.tsx). When the system won't say (macOS privacy controls, a locked folder,
 * a network folder that doesn't answer), the backup stays listed too.
 */
export type FolderState = 'here' | 'gone' | 'unknown';
type Stat = (target: string) => Promise<{
    isDirectory(): boolean;
}>;
export declare const FOLDER_CHECK_MS = 2000;
export declare function backupFolderState(dir: unknown, stat?: Stat, timeoutMs?: number): Promise<FolderState>;
/** The sessions to list: every one but those whose backup was deleted. Order is kept. */
export declare function listedSessions<T extends {
    backupDir?: unknown;
}>(sessions: T[], stateOf?: (dir: unknown) => Promise<FolderState>): Promise<T[]>;
export {};
