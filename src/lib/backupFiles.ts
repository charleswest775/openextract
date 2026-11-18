// Files a backup lists that aren't in its folder (in-app report OE-102).
//
// OE-102's backup listed its photos, but the photo files weren't in the folder, and nothing
// said why: every photo was a grey tile. The engine's check_backup_files counts such files
// (python/backup_files.py); this says so in plain words, above every screen of the backup.

/** check_backup_files' answer. `photos` counts files, so a Live Photo is two. */
export interface BackupFilesCheck {
  listed: number;
  missing: number;
  missing_by_area?: { photos?: number; messages?: number; other?: number };
}

// What can't be opened, by where the missing files are: some of them, and one of them.
const AREAS = [
  { key: 'photos', some: 'photos and videos', one: 'a photo or video' },
  { key: 'messages', some: 'message attachments', one: 'a message attachment' },
  { key: 'other', some: 'other things', one: 'something in it' },
] as const;

function listWords(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * The banner over a backup whose folder is missing files, or null when nothing is missing:
 * "1,234 of this backup's files are missing from its folder, so some photos and videos won't
 * open. If you copied or moved this backup, copy the whole folder again, or make a new backup."
 */
export function missingFilesMessage(check: BackupFilesCheck | null | undefined): string | null {
  const missing = check?.missing ?? 0;
  if (missing <= 0) return null;
  const byArea = check?.missing_by_area ?? {};
  const areas = AREAS.filter(a => (byArea[a.key] ?? 0) > 0);
  let what: string;
  if (missing === 1) {
    what = (areas[0] ?? AREAS[2]).one;
  } else if (areas.length === 0 || (areas.length === 1 && areas[0].key === 'other')) {
    what = 'some things in it';
  } else {
    what = `some ${listWords(areas.map(a => a.some))}`;
  }
  const count = missing === 1
    ? "1 of this backup's files is missing from its folder"
    : `${missing.toLocaleString()} of this backup's files are missing from its folder`;
  return `${count}, so ${what} won't open. If you copied or moved this backup, copy the whole folder again, or make a new backup.`;
}
