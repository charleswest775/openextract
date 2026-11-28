"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHECK_OLDER_TIMEOUT_MS = void 0;
exports.takeMoveLock = takeMoveLock;
exports.confirmation = confirmation;
exports.backupConfirmation = backupConfirmation;
exports.trashOlderBackup = trashOlderBackup;
exports.trashBackup = trashBackup;
// Move a backup to the Trash (the Recycle Bin on Windows): an older one from inside a newer one
// (Backup details), or any one from the list of backups on the home screen. The window can only
// ask: the engine decides whether that folder may go (python/older_backups.py,
// python/trash_backup.py), the person says yes in this process's own dialog, and the engine is
// asked again before anything moves.
// Nothing here deletes: shell.trashItem is the only thing that touches the folder, and when it
// can't use the Trash it fails rather than deleting (python/trash_room.py has what was measured).
const net = require('net');
const os = require('os');
// A big backup on a slow drive takes a while to read through.
exports.CHECK_OLDER_TIMEOUT_MS = 3600000;
// How much bigger the older backup is before the dialog points it out.
const NOTABLY_BIGGER = 1.05;
const LONGEST_NAME = 60;
const LONGEST_PATH = 160;
/**
 * On Windows, one move at a time across every OpenExtract that's open: two could each find room
 * in the Recycle Bin, and the second would erase what the first put there. A named pipe, because
 * Windows lets go of it if the app is killed. The Mac's Trash has no limit.
 */
function takeMoveLock(platform) {
    if (platform !== 'win32')
        return Promise.resolve(() => { });
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(null));
        const user = String(os.homedir()).replace(/[^a-zA-Z0-9]/g, '_');
        server.listen(`\\\\.\\pipe\\openextract-move-backup-${user}`, () => resolve(() => server.close()));
    });
}
const trashName = (platform) => (platform === 'win32' ? 'Recycle Bin' : 'Trash');
function size(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
function when(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'an unknown date' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
// Names and folders come from the backup, which may be someone else's: none may add lines to
// the question, turn its text around, or push the warnings out of sight.
function oneLine(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}
function shortName(value) {
    const name = Array.from(oneLine(value));
    return name.length > LONGEST_NAME ? `${name.slice(0, LONGEST_NAME).join('')}…` : name.join('');
}
// Both ends of a long path matter: which drive, and which backup.
function shortPath(value) {
    const chars = Array.from(oneLine(value));
    if (chars.length <= LONGEST_PATH)
        return chars.join('');
    const half = Math.floor(LONGEST_PATH / 2);
    return `${chars.slice(0, half).join('')}…${chars.slice(-half).join('')}`;
}
/** The dialog. Warnings come first. The first button keeps the backup, as does closing it. */
function confirmation(older, newer, platform) {
    const trash = trashName(platform);
    const warnings = [];
    if (older.encrypted && !newer.encrypted) {
        warnings.push("The older backup is encrypted and the newer one isn't, so only the older one has Health data, saved passwords, call history and web history.");
    }
    if (older.bytes > newer.bytes * NOTABLY_BIGGER) {
        warnings.push(`The older backup is bigger (${size(older.bytes)}, against ${size(newer.bytes)}), so it probably has things the newer one doesn't.`);
    }
    const otherName = older.device_name && newer.device_name && older.device_name !== newer.device_name;
    const otherNumber = older.phone_number && newer.phone_number && older.phone_number !== newer.phone_number;
    if (otherName || otherNumber) {
        warnings.push("The iPhone's name or number was different then. If it was erased or handed on, the older backup may be the only copy of what was on it.");
    }
    const putBack = platform === 'win32'
        ? "You can take it back out until the Recycle Bin is emptied or runs out of room. When things deleted later don't fit, Windows erases the oldest for good, without asking."
        : 'You can take it back out until the Trash is emptied, which some computers do by themselves.';
    const detail = [
        ...warnings,
        'Anything that left the iPhone between the two, such as messages and photos that were deleted or moved to iCloud, may be only in the older one.',
        `Older backup: ${shortName(older.device_name)}, ${when(older.last_backup)}, ${size(older.bytes)}\n${shortPath(older.backup_dir)}`,
        `Newer backup, which stays: ${shortName(newer.device_name)}, ${when(newer.last_backup)}, ${size(newer.bytes)}\n${shortPath(newer.backup_dir)}`,
        "Don't move it while it's being restored or copied.",
        `${putBack} It takes up the same space until then.`,
        "If you put it back and there's a folder with the same name, don't merge or replace: that could ruin a newer backup.",
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
/**
 * The dialog for any backup on the list. This one may be the only copy of what's in it, so that
 * comes first; then what else of this iPhone stays. The first button keeps it, as does closing it.
 */
function backupConfirmation(c, platform) {
    const trash = trashName(platform);
    const { backup, others } = c;
    const name = shortName(backup.device_name) || 'this iPhone';
    const warnings = [];
    // One that didn't finish isn't a copy to count on.
    const whole = others.filter(o => !o.unfinished);
    const newer = whole.filter(o => o.last_backup && backup.last_backup && o.last_backup > backup.last_backup);
    if (others.length === 0) {
        warnings.push('OpenExtract found no other backup of this iPhone in the usual backup folders or beside this one, so it may be the only copy of messages, photos and anything else that\'s no longer on the iPhone.');
    }
    else if (whole.length === 0) {
        warnings.push('The other backups of this iPhone that OpenExtract found didn\'t finish, so this may be the only whole copy of messages, photos and anything else that\'s no longer on the iPhone.');
    }
    else if (newer.length === 0) {
        warnings.push('This is the newest backup of this iPhone that OpenExtract found. The others are older, so they don\'t have what was added to the iPhone since.');
    }
    else {
        warnings.push(`A newer backup of this iPhone, from ${when(newer[0].last_backup)}, stays. Anything that left the iPhone between the two, such as messages and photos that were deleted or moved to iCloud, may be only in this one.`);
    }
    if (backup.encrypted && others.length > 0 && others.every(o => !o.encrypted)) {
        warnings.push("This backup is encrypted and the others of this iPhone aren't, so only this one has Health data, saved passwords, call history and web history.");
    }
    if (backup.unfinished) {
        warnings.push("This backup didn't finish, but what it does have may not be anywhere else.");
    }
    const putBack = platform === 'win32'
        ? "You can take it back out until the Recycle Bin is emptied or runs out of room. When things deleted later don't fit, Windows erases the oldest for good, without asking."
        : 'You can take it back out until the Trash is emptied, which some computers do by themselves.';
    const stays = others.map(o => `${when(o.last_backup)}\n${shortPath(o.backup_dir)}`);
    if (c.more_others > 0)
        stays.push(`and ${c.more_others} more`);
    const detail = [
        ...warnings,
        `This backup: ${name}, ${when(backup.last_backup)}, ${size(backup.bytes)}\n${shortPath(backup.backup_dir)}`,
        ...(stays.length ? [`Other backups of this iPhone, which stay:\n${stays.join('\n')}`] : []),
        "Don't move it while it's being restored or copied.",
        `${putBack} It takes up the same space until then.`,
        "If you put it back and there's a folder with the same name, don't merge or replace: that could ruin a newer backup.",
    ].join('\n\n');
    return {
        type: 'warning',
        message: `Move the backup of ${name} from ${when(backup.last_backup)} to the ${trash}?`,
        detail,
        buttons: ['Keep it', `Move to ${trash}`],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
}
const ALREADY_MOVING = {
    status: 'refused',
    message: 'OpenExtract is already moving a backup. Try again when it has finished.',
};
let busy = false;
async function trashOlderBackup(deps, udid, backupDir) {
    if (typeof udid !== 'string' || !udid || typeof backupDir !== 'string' || !backupDir) {
        return { status: 'refused', message: "OpenExtract didn't get which backup to move." };
    }
    if (busy)
        return ALREADY_MOVING;
    busy = true;
    let release = null;
    try {
        release = await deps.lock();
        if (!release)
            return ALREADY_MOVING;
        const first = await deps.check(udid, backupDir);
        if (first.allowed !== true)
            return { status: 'refused', message: first.reason };
        const { response } = await deps.confirm(confirmation(first.older, first.newer, deps.platform));
        if (response !== 1)
            return { status: 'cancelled' };
        // The dialog may have been up for hours: a drive swapped, a backup written, the bin filled.
        // Everything the person was told has to still be so.
        const now = await deps.check(udid, backupDir);
        if (now.allowed !== true)
            return { status: 'refused', message: now.reason };
        const told = (c) => JSON.stringify([c.older, c.newer, c.stamp]);
        if (told(now) !== told(first)) {
            return { status: 'refused', message: "That backup changed while you were deciding, so OpenExtract didn't move it." };
        }
        return await moveAndSee(deps, now.older.backup_dir);
    }
    finally {
        release?.();
        busy = false;
    }
}
/** Moves target to the Trash, then looks: what happened is what's there, not what was said. */
async function moveAndSee(deps, target) {
    const trash = trashName(deps.platform);
    let failed = false;
    try {
        await deps.trashItem(target);
    }
    catch (err) {
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
}
const BACKING_UP = {
    status: 'refused',
    message: "OpenExtract is making a backup. Move this one when that's finished.",
};
/**
 * Any backup on the home screen's list to the Trash: check, ask, check again, let go, move, look.
 * It may be the only copy, which the question says first (backupConfirmation).
 */
async function trashBackup(deps, backupDir) {
    if (typeof backupDir !== 'string' || !backupDir) {
        return { status: 'refused', message: "OpenExtract didn't get which backup to move." };
    }
    if (deps.backingUp())
        return BACKING_UP;
    if (busy)
        return ALREADY_MOVING;
    busy = true;
    let release = null;
    try {
        release = await deps.lock();
        if (!release)
            return ALREADY_MOVING;
        const first = await deps.check(backupDir);
        if (first.allowed !== true)
            return { status: 'refused', message: first.reason };
        const { response } = await deps.confirm(backupConfirmation(first, deps.platform));
        if (response !== 1)
            return { status: 'cancelled' };
        // The dialog may have been up for hours: a drive swapped, a backup started or written into it,
        // the bin filled. Everything the person was told has to still be so.
        if (deps.backingUp())
            return BACKING_UP;
        const now = await deps.check(backupDir);
        if (now.allowed !== true)
            return { status: 'refused', message: now.reason };
        const told = (c) => JSON.stringify([c.backup, c.others, c.more_others, c.stamp]);
        if (told(now) !== told(first)) {
            return { status: 'refused', message: "That backup changed while you were deciding, so OpenExtract didn't move it." };
        }
        await deps.release(now.backup.backup_dir);
        return await moveAndSee(deps, now.backup.backup_dir);
    }
    finally {
        release?.();
        busy = false;
    }
}
