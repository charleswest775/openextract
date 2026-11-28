export declare const CHECK_OLDER_TIMEOUT_MS = 3600000;
export interface BackupFacts {
    backup_dir: string;
    device_name: string;
    phone_number: string;
    last_backup: string;
    encrypted: boolean;
    bytes: number;
}
type Check = {
    allowed: false;
    reason: string;
} | {
    allowed: true;
    older: BackupFacts;
    newer: BackupFacts;
    stamp: string;
};
export type TrashOlderResult = {
    status: 'moved';
} | {
    status: 'cancelled';
} | {
    status: 'refused' | 'failed';
    message: string;
};
/** Another backup of the same iPhone, as python/trash_backup.py names it. */
export interface OtherBackup {
    backup_dir: string;
    device_name: string;
    last_backup: string;
    encrypted: boolean;
    unfinished: boolean;
}
export interface TrashFacts extends BackupFacts {
    unfinished: boolean;
}
type TrashCheck = {
    allowed: false;
    reason: string;
} | {
    allowed: true;
    backup: TrashFacts;
    others: OtherBackup[];
    more_others: number;
    stamp: string;
};
export interface TrashBackupDeps {
    platform: string;
    /** null when another OpenExtract is moving one. */
    lock: () => Promise<(() => void) | null>;
    /** Whether OpenExtract is making a backup now; its folder may be this one. */
    backingUp: () => boolean;
    check: (backupDir: string) => Promise<TrashCheck>;
    confirm: (options: Record<string, unknown>) => Promise<{
        response: number;
    }>;
    /** The engine closes the backup if it's open, and whatever it reads from it. */
    release: (backupDir: string) => Promise<void>;
    trashItem: (target: string) => Promise<void>;
    /** null when it can't tell. */
    exists: (target: string) => boolean | null;
}
export interface TrashOlderDeps {
    platform: string;
    /** null when another OpenExtract is moving one. */
    lock: () => Promise<(() => void) | null>;
    check: (udid: string, backupDir: string) => Promise<Check>;
    confirm: (options: Record<string, unknown>) => Promise<{
        response: number;
    }>;
    trashItem: (target: string) => Promise<void>;
    /** null when it can't tell. */
    exists: (target: string) => boolean | null;
}
/**
 * On Windows, one move at a time across every OpenExtract that's open: two could each find room
 * in the Recycle Bin, and the second would erase what the first put there. A named pipe, because
 * Windows lets go of it if the app is killed. The Mac's Trash has no limit.
 */
export declare function takeMoveLock(platform: string): Promise<(() => void) | null>;
/** The dialog. Warnings come first. The first button keeps the backup, as does closing it. */
export declare function confirmation(older: BackupFacts, newer: BackupFacts, platform: string): {
    type: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
};
/**
 * The dialog for any backup on the list. This one may be the only copy of what's in it, so that
 * comes first; then what else of this iPhone stays. The first button keeps it, as does closing it.
 */
export declare function backupConfirmation(c: {
    backup: TrashFacts;
    others: OtherBackup[];
    more_others: number;
}, platform: string): {
    type: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
};
export declare function trashOlderBackup(deps: TrashOlderDeps, udid: unknown, backupDir: unknown): Promise<TrashOlderResult>;
/**
 * Any backup on the home screen's list to the Trash: check, ask, check again, let go, move, look.
 * It may be the only copy, which the question says first (backupConfirmation).
 */
export declare function trashBackup(deps: TrashBackupDeps, backupDir: unknown): Promise<TrashOlderResult>;
export {};
