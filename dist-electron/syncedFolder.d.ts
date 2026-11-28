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
/** "OneDrive", "iCloud Drive", "Dropbox", "Google Drive", "Box", or null. Doesn't touch the disk. */
export declare function syncedFolderService(folder: string, { platform, env, home }: Where): string | null;
/** The same for a folder chosen on this computer, links followed first. */
export declare function syncedFolderAt(folder: unknown): string | null;
export declare const NOT_ENOUGH_SPACE = "Not enough free space for this backup.";
/** What a not-enough-space error adds when the folder is in `service`. */
export declare function syncedFolderNote(service: string): string;
/**
 * The engine's not-enough-space error with syncedFolderNote() before its advice, or `message`
 * unchanged when the folder isn't synced or the error is about something else.
 */
export declare function withSyncedFolderNote(message: string, service: string | null): string;
export {};
