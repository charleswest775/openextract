"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOT_ENOUGH_SPACE = void 0;
exports.syncedFolderService = syncedFolderService;
exports.syncedFolderAt = syncedFolderAt;
exports.syncedFolderNote = syncedFolderNote;
exports.withSyncedFolderNote = withSyncedFolderNote;
const path = require('path');
const os = require('os');
const installFolder_1 = require("./installFolder");
// The folders OneDrive syncs on Windows: personal, then work or school.
const ONEDRIVE_ENV = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'];
// Each app's folder name, where the default one is named after the app. Case is ignored.
// "OneDrive - Contoso" is a work or school account, "Dropbox (Personal)" one of two accounts;
// iCloud for Windows uses iCloudDrive, Google Drive's old Backup and Sync "Google Drive".
const BY_FOLDER_NAME = [
    [/^onedrive(?: - .+)?$/i, 'OneDrive'],
    [/^dropbox(?: \(.+\))?$/i, 'Dropbox'],
    [/^icloud ?drive$/i, 'iCloud Drive'],
    [/^google drive$/i, 'Google Drive'],
];
// macOS keeps the sync apps that use its File Provider (OneDrive, Dropbox, Google Drive, Box)
// in ~/Library/CloudStorage/<App>-<account>, e.g. OneDrive-Personal or GoogleDrive-ana@….
const CLOUD_STORAGE_APPS = [
    [/^onedrive/i, 'OneDrive'],
    [/^dropbox/i, 'Dropbox'],
    [/^googledrive/i, 'Google Drive'],
    [/^box/i, 'Box'],
];
function pathFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}
/** "OneDrive", "iCloud Drive", "Dropbox", "Google Drive", "Box", or null. Doesn't touch the disk. */
function syncedFolderService(folder, { platform, env, home }) {
    if (!folder)
        return null;
    const p = pathFor(platform);
    const resolved = p.resolve(folder);
    if (platform === 'win32') {
        for (const name of ONEDRIVE_ENV) {
            const synced = env[name];
            if (synced && (0, installFolder_1.isInsideFolder)(resolved, synced, platform))
                return 'OneDrive';
        }
    }
    if (platform === 'darwin' && home) {
        const cloudStorage = p.join(home, 'Library', 'CloudStorage');
        if ((0, installFolder_1.isInsideFolder)(resolved, cloudStorage, platform) && !(0, installFolder_1.isInsideFolder)(cloudStorage, resolved, platform)) {
            const app = p.relative(cloudStorage, resolved).split(p.sep)[0];
            const known = CLOUD_STORAGE_APPS.find(([pattern]) => pattern.test(app));
            return known ? known[1] : app.split('-')[0] || null;
        }
        // iCloud Drive is ~/Library/Mobile Documents/com~apple~CloudDocs, and each app's own
        // iCloud folder is beside it.
        if ((0, installFolder_1.isInsideFolder)(resolved, p.join(home, 'Library', 'Mobile Documents'), platform))
            return 'iCloud Drive';
    }
    const parts = resolved.slice(p.parse(resolved).root.length).split(p.sep).filter(Boolean);
    for (const part of parts) {
        const found = BY_FOLDER_NAME.find(([pattern]) => pattern.test(part));
        if (found)
            return found[1];
    }
    // Google Drive for desktop on Windows is a drive of its own (G:), with My Drive at the top.
    if (platform === 'win32' && /^my drive$/i.test(parts[0] ?? ''))
        return 'Google Drive';
    return null;
}
/** The same for a folder chosen on this computer, links followed first. */
function syncedFolderAt(folder) {
    if (typeof folder !== 'string' || !folder)
        return null;
    const where = { platform: process.platform, env: process.env, home: os.homedir() };
    // A link to the folder (~/OneDrive pointing into ~/Library/CloudStorage) counts as where it leads.
    return syncedFolderService((0, installFolder_1.resolveReal)(folder), where) ?? syncedFolderService(folder, where);
}
// The engine's words for a backup the drive has no room for (python/device_backup.py,
// _NO_SPACE and _disk_full_message), which the note goes into.
exports.NOT_ENOUGH_SPACE = 'Not enough free space for this backup.';
const ADVICE = 'Free up space or choose a folder';
/** What a not-enough-space error adds when the folder is in `service`. */
function syncedFolderNote(service) {
    return `The folder you chose is in ${service}, so the space in your ${service} account doesn't count: `
        + "the backup is saved on this computer's own drive.";
}
/**
 * The engine's not-enough-space error with syncedFolderNote() before its advice, or `message`
 * unchanged when the folder isn't synced or the error is about something else.
 */
function withSyncedFolderNote(message, service) {
    if (!service || !message.includes(exports.NOT_ENOUGH_SPACE))
        return message;
    const note = syncedFolderNote(service);
    const at = message.indexOf(ADVICE);
    return at < 0 ? `${message.trimEnd()} ${note}` : `${message.slice(0, at)}${note} ${message.slice(at)}`;
}
