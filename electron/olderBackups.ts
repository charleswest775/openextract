// Move an older backup to the Trash (the Recycle Bin on Windows). The window can only ask: the
// engine decides whether that folder may go (python/older_backups.py), the person says yes in
// this process's own dialog, and the engine is asked again before anything moves.
// Nothing here deletes: shell.trashItem is the only thing that touches the folder, and when it
// can't use the Trash it fails rather than deleting (python/trash_room.py has what was measured).

// A big backup on a slow drive takes a while to read through.
export const CHECK_OLDER_TIMEOUT_MS = 3_600_000;
// How much bigger the older backup is before the dialog points it out.
const NOTABLY_BIGGER = 1.05;

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
  check: (udid: string, backupDir: string) => Promise<Check>;
  confirm: (options: Record<string, unknown>) => Promise<{ response: number }>;
  trashItem: (target: string) => Promise<void>;
  exists: (target: string) => boolean;
}

const trashName = (platform: string) => (platform === 'win32' ? 'Recycle Bin' : 'Trash');

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The dialog. The first button keeps the backup, and is what Return and Esc press. */
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
    `Older backup: ${older.device_name}, ${when(older.last_backup)}, ${size(older.bytes)}\n${older.backup_dir}`,
    `Newer backup, which stays: ${newer.device_name}, ${when(newer.last_backup)}, ${size(newer.bytes)}\n${newer.backup_dir}`,
    ...warnings,
    "Anything deleted from the iPhone between the two, such as messages and photos, is only in the older one.",
    `You can put it back until the ${trash} is emptied, which some computers do by themselves. It takes up the same space until then.`,
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

// One at a time: two dialogs could each have been checked against a Recycle Bin with room for one.
let busy = false;

export async function trashOlderBackup(deps: TrashOlderDeps, udid: unknown, backupDir: unknown): Promise<TrashOlderResult> {
  if (typeof udid !== 'string' || !udid || typeof backupDir !== 'string' || !backupDir) {
    return { status: 'refused', message: "OpenExtract didn't get which backup to move." };
  }
  if (busy) return { status: 'refused', message: 'OpenExtract is already moving a backup. Try again when it has finished.' };
  busy = true;
  try {
    const trash = trashName(deps.platform);
    const first = await deps.check(udid, backupDir);
    if (first.allowed !== true) return { status: 'refused', message: first.reason };

    const { response } = await deps.confirm(confirmation(first.older, first.newer, deps.platform));
    if (response !== 1) return { status: 'cancelled' };

    // The dialog may have been up for hours: a drive swapped, a backup written, the bin filled.
    const now = await deps.check(udid, backupDir);
    if (now.allowed !== true) return { status: 'refused', message: now.reason };
    if (now.stamp !== first.stamp || now.older.backup_dir !== first.older.backup_dir
        || now.newer.backup_dir !== first.newer.backup_dir) {
      return { status: 'refused', message: "That backup changed while you were deciding, so OpenExtract didn't move it." };
    }

    const target = now.older.backup_dir;
    let failed = false;
    try {
      await deps.trashItem(target);
    } catch (err) {
      console.error('Moving a backup to the Trash failed', err);
      failed = true;
    }
    if (deps.exists(target)) {
      return {
        status: 'failed',
        message: `The ${trash} didn't take that backup, so it's still where it was. Another app may have it open, or OpenExtract may not be allowed to move it.`,
      };
    }
    if (failed) {
      return { status: 'failed', message: `That backup isn't where it was. Look for it in the ${trash}.` };
    }
    return { status: 'moved' };
  } finally {
    busy = false;
  }
}
