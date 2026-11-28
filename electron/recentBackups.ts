const fs = require('fs');
const path = require('path');

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

type Stat = (target: string) => Promise<{ isDirectory(): boolean }>;

// A network folder that's away can take most of a minute to answer, and the home screen waits
// for this list, so a folder that hasn't answered by then stays listed.
export const FOLDER_CHECK_MS = 2000;

// The folder isn't there: ENOTDIR when part of the path is now a file.
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

export async function backupFolderState(
  dir: unknown,
  stat: Stat = fs.promises.stat,
  timeoutMs: number = FOLDER_CHECK_MS,
): Promise<FolderState> {
  if (typeof dir !== 'string' || !dir) return 'unknown';

  const check = async (): Promise<FolderState> => {
    try {
      await stat(dir);
      return 'here';
    } catch (e: any) {
      if (!NOT_THERE.has(e?.code)) return 'unknown';
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) return 'unknown';
    try {
      return (await stat(parent)).isDirectory() ? 'gone' : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<FolderState>(resolve => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  try {
    return await Promise.race([check(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The sessions to list: every one but those whose backup was deleted. Order is kept. */
export async function listedSessions<T extends { backupDir?: unknown }>(
  sessions: T[],
  stateOf: (dir: unknown) => Promise<FolderState> = dir => backupFolderState(dir),
): Promise<T[]> {
  const states = await Promise.all(sessions.map(s => stateOf(s?.backupDir).catch(() => 'unknown' as FolderState)));
  return sessions.filter((_, i) => states[i] !== 'gone');
}
