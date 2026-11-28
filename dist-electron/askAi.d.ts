import { type AiAppId, type BundledAddon, type Edition, type Fetch, type Look, type Run, type StatusRunner } from './aiAddon';
/**
 * The Ask AI screen's side of the main process: what the window may ask for, and nothing
 * more. The window never names a path, a URL or a program; it can only say "install",
 * "connect Claude", "connect ChatGPT" (with the person's OK), "hide this" and "open the Full
 * Disk Access settings" (one fixed address).
 *
 * It also keeps the add-on's backups.json (FRIENDS-BUILD.md section 3): which backup is open
 * and the folders OpenExtract knows hold backups, so the add-on finds backups outside Finder's
 * folder. main.ts tells it what the engine found and opened (the hooks registerAskAi returns).
 *
 * Ask AI is off unless the build was made with OPENEXTRACT_AI_INDEX_URL (aiIndexUrl in
 * aiAddon.ts) or carries the add-on (OPENEXTRACT_AI_BUNDLED_MCPB, bundledAddon). Off, the
 * handlers are still registered, so the window's bridge is the same in every build, but each answers that it's off and touches nothing: no folder is
 * looked at, nothing is downloaded or run, and nothing is saved, backups.json included.
 */
interface Store {
    get(key: string, fallback?: any): any;
    set(key: string, value: any): void;
}
export interface AskAiOptions {
    ipcMain: {
        handle(channel: string, listener: (event: any, ...args: any[]) => any): void;
    };
    shell: {
        openPath(file: string): Promise<string>;
        showItemInFolder?(file: string): void;
        openExternal(url: string): Promise<void>;
    };
    store: Store;
    /** index.json, or null. */
    indexUrl: string | null;
    /** The add-on this app carries, or null. With one, Install uses it instead of index.json. */
    bundled?: BundledAddon | null;
    platform: string;
    arch: string;
    translated?: boolean;
    env: Record<string, string | undefined>;
    homedir: string;
    fetch: Fetch;
    look?: Look;
    systemApps?: string;
    macBinDirs?: string[];
    run?: Run;
    statusRunner?: StatusRunner;
    stallMs?: number;
}
/** What every call answers in a build without Ask AI. */
export declare const ASK_AI_OFF = "Ask AI isn't part of this copy of OpenExtract.";
export type AskAiState = {
    enabled: false;
} | {
    enabled: true;
    /** The AI apps found, in a fixed order. */
    apps: AiAppId[];
    /** There's a download for this computer. */
    available: boolean;
    /** "Don't show this again" (undone in Settings). */
    hidden: boolean;
    /** The "New" note on Home has been seen (closed, or Ask AI opened). */
    noteSeen: boolean;
    installed: {
        version: string;
    } | null;
    /**
     * The add-on this copy of OpenExtract carries, when it's newer than the one installed: Install
     * again puts it in place (the older one stays, for anything still pointing at it).
     */
    update: {
        version: string;
    } | null;
    /** `outdated`: Claude has an older version than this app carries, so Install there updates it. */
    claude: {
        connected: boolean;
        version: string | null;
        outdated: boolean;
    } | null;
    /** `current`: the entry runs the installed program (not an older one). */
    chatgpt: {
        connected: boolean;
        current: boolean;
        settingsFile: string;
    } | null;
    /** The command to paste, once the add-on is installed. */
    claudeCode: {
        command: string | null;
    } | null;
    /**
     * macOS, and the open (or last opened) backup is in Finder's backup folder: Claude and ChatGPT
     * need Full Disk Access to read it.
     */
    fullDiskAccess: boolean;
    /** 'unrestricted' when this app carries the friends-and-family edition (no limit, no keys). */
    edition: Edition;
};
export type AskAiResult = {
    ok: true;
    message?: string;
} | {
    ok: false;
    error: string;
};
/** Claude for Windows doesn't open .mcpb files (its package declares no file types), so the file is
 * shown in its folder and the screen says where it goes in Claude. Checked on a real PC 2026-11-25. */
export declare const WINDOWS_CLAUDE_STEPS: string;
/** System Settings > Privacy & Security > Full Disk Access. The only address ask-ai:open-full-disk-access opens. */
export declare const FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
/** What main.ts tells Ask AI about backups, for backups.json. Both do nothing when Ask AI is off. */
export interface AskAiHooks {
    /** A backup was opened (its folder, from open_backup). Writes backups.json if the add-on is installed. */
    backupOpened(backupDir: unknown): void;
    /** The engine listed backups (list_backups: Finder's folders, or a folder the person chose). */
    backupsFound(backupDirs: unknown[]): void;
}
export declare function registerAskAi(o: AskAiOptions): AskAiHooks;
export {};
