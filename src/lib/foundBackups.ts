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
