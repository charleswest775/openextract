// Move an older backup to the Trash (the Recycle Bin on Windows). The window can only ask: the
// engine decides whether that folder may go (python/older_backups.py), the person says yes in
// this process's own dialog, and the engine is asked again before anything moves.
// Nothing here deletes: shell.trashItem is the only thing that touches the folder, and when it
// can't use the Trash it fails rather than deleting (python/trash_room.py has what was measured).
const net = require('net');
const os = require('os');

// A big backup on a slow drive takes a while to read through.
export const CHECK_OLDER_TIMEOUT_MS = 3_600_000;
// How much bigger the older backup is before the dialog points it out.
const NOTABLY_BIGGER = 1.05;
const LONGEST_NAME = 60;
const LONGEST_PATH = 160;

export interface BackupFacts {
  backup_dir: string;
  device_name: string;
  phone_number: string;
  last_backup: string;
  encrypted: boolean;
  bytes: number;
}

type Check =
  | { allowed: false; reason: string }
  | { allowed: true; older: BackupFacts; newer: BackupFacts; stamp: string };

export type TrashOlderResult =
  | { status: 'moved' }
  | { status: 'cancelled' }
  | { status: 'refused' | 'failed'; message: string };

export interface TrashOlderDeps {
  platform: string;
  /** null when another OpenExtract is moving one. */
  lock: () => Promise<(() => void) | null>;
  check: (udid: string, backupDir: string) => Promise<Check>;
  confirm: (options: Record<string, unknown>) => Promise<{ response: number }>;
  trashItem: (target: string) => Promise<void>;
  /** null when it can't tell. */
  exists: (target: string) => boolean | null;
}

/**
 * On Windows, one move at a time across every OpenExtract that's open: two could each find room
 * in the Recycle Bin, and the second would erase what the first put there. A named pipe, because
 * Windows lets go of it if the app is killed. The Mac's Trash has no limit.
 */
export function takeMoveLock(platform: string): Promise<(() => void) | null> {
  if (platform !== 'win32') return Promise.resolve(() => {});
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    const user = String(os.homedir()).replace(/[^a-zA-Z0-9]/g, '_');
    server.listen(`\\\\.\\pipe\\openextract-move-backup-${user}`, () => resolve(() => server.close()));
  });
}

const trashName = (platform: string) => (platform === 'win32' ? 'Recycle Bin' : 'Trash');

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Names and folders come from the backup, which may be someone else's: none may add lines to
// the question, turn its text around, or push the warnings out of sight.
function oneLine(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

function shortName(value: unknown): string {
  const name = Array.from(oneLine(value));
  return name.length > LONGEST_NAME ? `${name.slice(0, LONGEST_NAME).join('')}…` : name.join('');
}

// Both ends of a long path matter: which drive, and which backup.
function shortPath(value: unknown): string {
  const chars = Array.from(oneLine(value));
  if (chars.length <= LONGEST_PATH) return chars.join('');
  const half = Math.floor(LONGEST_PATH / 2);
  return `${chars.slice(0, half).join('')}…${chars.slice(-half).join('')}`;
}

/** The dialog. Warnings come first. The first button keeps the backup, as does closing it. */
export function confirmation(older: BackupFacts, newer: BackupFacts, platform: string) {
  const trash = trashName(platform);
  const warnings: string[] = [];
  if (older.encrypted && !newer.encrypted) {
    warnings.push(
      "The older backup is encrypted and the newer one isn't, so only the older one has Health data, saved passwords, call history and web history.",
    );
  }
  if (older.bytes > newer.bytes * NOTABLY_BIGGER) {
    warnings.push(
      `The older backup is bigger (${size(older.bytes)}, against ${size(newer.bytes)}), so it probably has things the newer one doesn't.`,
    );
  }
  const otherName = older.device_name && newer.device_name && older.device_name !== newer.device_name;
  const otherNumber = older.phone_number && newer.phone_number && older.phone_number !== newer.phone_number;
  if (otherName || otherNumber) {
    warnings.push(
      "The iPhone's name or number was different then. If it was erased or handed on, the older backup may be the only copy of what was on it.",
    );
  }
  const detail = [
    ...warnings,
    'Anything that left the iPhone between the two, such as messages and photos that were deleted or moved to iCloud, may be only in the older one.',
    `Older backup: ${shortName(older.device_name)}, ${when(older.last_backup)}, ${size(older.bytes)}\n${shortPath(older.backup_dir)}`,
    `Newer backup, which stays: ${shortName(newer.device_name)}, ${when(newer.last_backup)}, ${size(newer.bytes)}\n${shortPath(newer.backup_dir)}`,
    "Don't move it while it's being restored or copied.",
    `You can take it back out until the ${trash} is emptied, which some computers do by themselves. It takes up the same space until then.`,
  ].join('\n\n');
  return {
    type: 'warning',
    message: `Move the backup from ${when(older.last_backup)} to the ${trash}?`,
    detail,
    buttons: ['Keep it', `Move to ${trash}`],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

const ALREADY_MOVING: TrashOlderResult = {
  status: 'refused',
  message: 'OpenExtract is already moving a backup. Try again when it has finished.',
};

let busy = false;

export async function trashOlderBackup(deps: TrashOlderDeps, udid: unknown, backupDir: unknown): Promise<TrashOlderResult> {
  if (typeof udid !== 'string' || !udid || typeof backupDir !== 'string' || !backupDir) {
    return { status: 'refused', message: "OpenExtract didn't get which backup to move." };
  }
  if (busy) return ALREADY_MOVING;
  busy = true;
  let release: (() => void) | null = null;
  try {
    release = await deps.lock();
    if (!release) return ALREADY_MOVING;
    const first = await deps.check(udid, backupDir);
    if (first.allowed !== true) return { status: 'refused', message: first.reason };

    const { response } = await deps.confirm(confirmation(first.older, first.newer, deps.platform));
    if (response !== 1) return { status: 'cancelled' };

    // The dialog may have been up for hours: a drive swapped, a backup written, the bin filled.
    // Everything the person was told has to still be so.
    const now = await deps.check(udid, backupDir);
    if (now.allowed !== true) return { status: 'refused', message: now.reason };
    const told = (c: { older: BackupFacts; newer: BackupFacts; stamp: string }) => JSON.stringify([c.older, c.newer, c.stamp]);
    if (told(now) !== told(first)) {
      return { status: 'refused', message: "That backup changed while you were deciding, so OpenExtract didn't move it." };
    }

    const target = now.older.backup_dir;
    const trash = trashName(deps.platform);
    let failed = false;
    try {
      await deps.trashItem(target);
    } catch (err) {
      console.error('Moving a backup to the Trash failed', err);
      failed = true;
    }
    const there = deps.exists(target);
    if (there === null) {
      return { status: 'failed', message: `OpenExtract couldn't tell whether that backup moved. Look in its folder and in the ${trash}.` };
    }
    if (there) {
      return {
        status: 'failed',
        message: `The ${trash} didn't take that backup, so it's still where it was. Another app may have it open, or OpenExtract may not be allowed to move it.`,
      };
    }
    if (failed) {
      return { status: 'failed', message: `That backup isn't where it was. It may be in the ${trash}, or another app may have moved it.` };
    }
    return { status: 'moved' };
  } finally {
    release?.();
    busy = false;
  }
}
