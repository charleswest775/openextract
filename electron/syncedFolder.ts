const path = require('path');
const os = require('os');
import { isInsideFolder, resolveReal } from './installFolder';

/**
 * Whether a chosen backup folder is in OneDrive, iCloud Drive, Dropbox or Google Drive.
 *
 * A backup there is still written to this computer's own drive, which is the only space the
 * iPhone checks. The space in the online account doesn't count, so "OneDrive has 85% of 1 TB
 * available" ran into "the drive you chose has 175 GB free" (OE-212). The sync app also
 * uploads each file as it's written and holds it open meanwhile, which Windows won't let the
 * backup rename (_FOLDER_IN_USE in python/device_backup.py).
 *
 * Folder paths are taken out of feedback reports, so a report can't show this unless the app
 * says it in its own words: the backup screen warns when the folder is chosen
 * (src/components/backup/BackupFlow.tsx), and a not-enough-space error says it too.
 *
 * Only the paths are looked at, which costs nothing and can't hang on a cloud folder. The
 * functions take the platform, environment and home folder so the tests can check Windows
 * paths on any computer.
 */

interface Where {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
}

// The folders OneDrive syncs on Windows: personal, then work or school.
const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];

// Each app's folder name, where the default one is named after the app. Case is ignored.
// "OneDrive - Contoso" is a work or school account, "Dropbox (Personal)" one of two accounts;
// iCloud for Windows uses iCloudDrive, Google Drive's old Backup and Sync "Google Drive".
const BY_FOLDER_NAME: [RegExp, string][] = [
  [/^onedrive(?: - .+)?$/i, 'OneDrive'],
  [/^dropbox(?: \(.+\))?$/i, 'Dropbox'],
  [/^icloud ?drive$/i, 'iCloud Drive'],
  [/^google drive$/i, 'Google Drive'],
];

// macOS keeps the sync apps that use its File Provider (OneDrive, Dropbox, Google Drive, Box)
// in ~/Library/CloudStorage/<App>-<account>, e.g. OneDrive-Personal or GoogleDrive-ana@….
const CLOUD_STORAGE_APPS: [RegExp, string][] = [
  [/^onedrive/i, 'OneDrive'],
  [/^dropbox/i, 'Dropbox'],
  [/^googledrive/i, 'Google Drive'],
  [/^box/i, 'Box'],
];

function pathFor(platform: string) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** "OneDrive", "iCloud Drive", "Dropbox", "Google Drive", "Box", or null. Doesn't touch the disk. */
export function syncedFolderService(folder: string, { platform, env, home }: Where): string | null {
  if (!folder) return null;
  const p = pathFor(platform);
  const resolved = p.resolve(folder);

  if (platform === 'win32') {
    for (const name of ONEDRIVE_ENV) {
      const synced = env[name];
      if (synced && isInsideFolder(resolved, synced, platform)) return 'OneDrive';
    }
  }
  if (platform === 'darwin' && home) {
    const cloudStorage = p.join(home, 'Library', 'CloudStorage');
    if (isInsideFolder(resolved, cloudStorage, platform) && !isInsideFolder(cloudStorage, resolved, platform)) {
      const app = p.relative(cloudStorage, resolved).split(p.sep)[0];
      const known = CLOUD_STORAGE_APPS.find(([pattern]) => pattern.test(app));
      return known ? known[1] : app.split('-')[0] || null;
    }
    // iCloud Drive is ~/Library/Mobile Documents/com~apple~CloudDocs, and each app's own
    // iCloud folder is beside it.
    if (isInsideFolder(resolved, p.join(home, 'Library', 'Mobile Documents'), platform)) return 'iCloud Drive';
  }

  const parts = resolved.slice(p.parse(resolved).root.length).split(p.sep).filter(Boolean);
  for (const part of parts) {
    const found = BY_FOLDER_NAME.find(([pattern]) => pattern.test(part));
    if (found) return found[1];
  }
  // Google Drive for desktop on Windows is a drive of its own (G:), with My Drive at the top.
  if (platform === 'win32' && /^my drive$/i.test(parts[0] ?? '')) return 'Google Drive';
  return null;
}

/** The same for a folder chosen on this computer, links followed first. */
export function syncedFolderAt(folder: unknown): string | null {
  if (typeof folder !== 'string' || !folder) return null;
  const where = { platform: process.platform, env: process.env, home: os.homedir() };
  // A link to the folder (~/OneDrive pointing into ~/Library/CloudStorage) counts as where it leads.
  return syncedFolderService(resolveReal(folder), where) ?? syncedFolderService(folder, where);
}

// The engine's words for a backup the drive has no room for (python/device_backup.py,
// _NO_SPACE and _disk_full_message), which the note goes into.
export const NOT_ENOUGH_SPACE = 'Not enough free space for this backup.';
const ADVICE = 'Free up space or choose a folder';

/** What a not-enough-space error adds when the folder is in `service`. */
export function syncedFolderNote(service: string): string {
  return `The folder you chose is in ${service}, so the space in your ${service} account doesn't count: `
    + "the backup is saved on this computer's own drive.";
}

/**
 * The engine's not-enough-space error with syncedFolderNote() before its advice, or `message`
 * unchanged when the folder isn't synced or the error is about something else.
 */
export function withSyncedFolderNote(message: string, service: string | null): string {
  if (!service || !message.includes(NOT_ENOUGH_SPACE)) return message;
  const note = syncedFolderNote(service);
  const at = message.indexOf(ADVICE);
  return at < 0 ? `${message.trimEnd()} ${note}` : `${message.slice(0, at)}${note} ${message.slice(at)}`;
}
