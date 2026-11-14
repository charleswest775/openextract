/**
 * Backups the engine found in the usual folders (Finder, iTunes, Apple Devices),
 * which the home screen offers without asking for a folder.
 */
import type { BackupInfo } from '../hooks/useBackup';
import type { RecentSession } from './appState';

/** What list_backups returns when called without a folder. */
export interface FoundBackups {
  backups: BackupInfo[];
  /** Usual folders that exist but the system wouldn't let the engine read. */
  permission_denied?: string[];
}

// Windows paths compare without case; any path ignores a trailing separator.
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/[\\/]+$/, '');
    return /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('\\\\') ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/** The found backups that aren't already in the recent list. */
export function notYetOpened(found: BackupInfo[], sessions: RecentSession[]): BackupInfo[] {
  return found.filter(b => !sessions.some(s =>
    s.backupDir ? samePath(s.backupDir, b.backup_dir) : s.id === b.udid,
  ));
}

/**
 * What the home screen says when looking for backups failed, above its Look again
 * button, instead of leaving out the found list without a word (in-app report OE-27).
 * `error` is the failed list_backups call's message.
 */
export function lookFailedMessage(error: string): string {
  // The engine has exited (it used to on an iOS 6 backup's photos) and the app
  // doesn't start it again by itself, so only reopening it helps.
  if (/sidecar is not running|sidecar exited/i.test(error)) {
    return "OpenExtract couldn't look for other backups on this computer because its engine stopped. Quit and reopen OpenExtract to look again.";
  }
  return "OpenExtract couldn't look for other backups on this computer.";
}

/** How the engine's error starts when a backup isn't where the app said it was (python/backup.py). */
export const BACKUP_MISSING_PREFIX = 'BACKUP_MISSING:';

/**
 * The words to show when opening a backup failed because it isn't where it was (moved,
 * renamed, deleted, or on a drive that isn't plugged in), under the title "Can't find
 * this backup" and next to a Find it button. The engine's first sentence says what the
 * title does, so it's left out. null for any other error. In-app report OE-40.
 */
export function backupMissingMessage(error: string | null | undefined): string | null {
  if (!error?.startsWith(BACKUP_MISSING_PREFIX)) return null;
  return error.slice(BACKUP_MISSING_PREFIX.length).trim().replace(/^OpenExtract can't find this backup\.\s*/, '');
}

/**
 * Shown on a backup that stopped partway, once it's open (the engine's
 * backup_status.UNFINISHED says the same).
 */
export const UNFINISHED_MESSAGE =
  "This backup didn't finish, so some things may be missing or won't open. Make a new backup to see everything.";

/** The label beside a backup's name in a list when it stopped partway. */
export const UNFINISHED_LABEL = "Didn't finish";

/**
 * When a backup was made, for a list: "Backed up Nov 3, 2026". A backup that
 * stopped partway gives the day it was started, because that's all its date says.
 */
export function whenLine(b: Pick<BackupInfo, 'last_backup' | 'unfinished'>, formatDate: (iso: string) => string): string | undefined {
  const date = b.last_backup ? formatDate(b.last_backup) : '';
  if (!date) return undefined;
  return b.unfinished ? `Started ${date}` : `Backed up ${date}`;
}
