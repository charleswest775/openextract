/**
 * OpenExtract AI, the add-on the Ask AI screen offers (docs: FRIENDS-BUILD.md in the
 * openextract-ai repository). This file finds AI apps, downloads and unpacks the add-on,
 * connects it, and asks it how many free questions are left. Everything that counts
 * questions or checks access keys lives in the add-on, never here: the free app holds
 * no such code.
 *
 * Off unless switched on: only builds made with OPENEXTRACT_AI_INDEX_URL set (aiIndexUrl
 * below), or carrying the add-on inside the app (OPENEXTRACT_AI_BUNDLED_MCPB, bundledAddon
 * below), have the screen. Without either nothing here runs.
 *
 * Nothing in this file touches the network except installAddon, which runs only when the
 * person clicks Install or Connect, and not even then when the app carries the add-on. AI apps are found by looking at a few fixed places
 * (detectAiApps), never by searching the disk, and what's found is never sent anywhere.
 */
export declare const AI_INDEX_URL_ENV = "OPENEXTRACT_AI_INDEX_URL";
/**
 * Written beside the built main process by scripts/write-build-info.mjs, during
 * `npm run build:electron`, from the build's environment, the way the engine's
 * build_info.json is (python/build_info.py). A packaged app reads it; package.json's
 * build.files packs it.
 */
export declare const BUILD_INFO_FILE = "build-info.json";
/** index.json and the downloads: https, or http to this computer (a test server). No user:password@. */
export declare function isAllowedUrl(value: unknown): value is string;
/**
 * The add-on's index.json, or null when Ask AI is off. A packaged app takes it only from
 * build-info.json, baked in at build time; its environment can't switch the screen on.
 * A development build (unpackaged) reads OPENEXTRACT_AI_INDEX_URL, as the engine reads
 * package.json when run from source: a build-info.json there could be a stale leftover.
 */
export declare function aiIndexUrl({ isPackaged, buildInfoDir, env }: {
    isPackaged: boolean;
    buildInfoDir: string;
    env: Record<string, string | undefined>;
}): string | null;
/**
 * The friends-and-family build carries the add-on inside the app instead of downloading it:
 * scripts/package-friends.mjs builds the app with OPENEXTRACT_AI_BUNDLED_MCPB set to a .mcpb,
 * scripts/write-build-info.mjs records its name, size and SHA-256 in build-info.json, and
 * electron-builder copies it into the app's resources/ai-addon/. Install then checks it and
 * unpacks it, with nothing downloaded.
 */
export declare const BUNDLED_MCPB_ENV = "OPENEXTRACT_AI_BUNDLED_MCPB";
/** Its folder inside a packaged app's resources (process.resourcesPath). */
export declare const BUNDLED_DIR = "ai-addon";
/** 'unrestricted': the friends-and-family edition, with no question limit and no keys (openextract-ai's
 * packaging/build.py --unrestricted). null: the usual one. */
export type Edition = 'unrestricted' | null;
export interface BundledAddon {
    /** The .mcpb, inside the app. */
    file: string;
    /** The add-on's version, with "-unrestricted" for that edition, so it unpacks into a folder of its own. */
    version: string;
    platform: PlatformKey;
    sha256: string;
    size: number;
    edition: Edition;
}
/** openextract-ai-0.2.3-unrestricted-mac-arm64.mcpb (as packaging/build.py names it): its version, edition
 * and computer, or null for any other name. */
export declare function parseMcpbName(name: unknown): {
    version: string;
    platform: PlatformKey;
    edition: Edition;
} | null;
/** build-info.json's aiAddon, checked field by field: the add-on in `dir`, or null. */
export declare function bundledFrom(info: any, dir: string): BundledAddon | null;
/**
 * The add-on this app carries, or null. A packaged app takes it only from build-info.json, baked in at build
 * time, and finds the file in its resources; a development build reads OPENEXTRACT_AI_BUNDLED_MCPB (a path to
 * a .mcpb named as packaging/build.py names it) and checks it as it is now.
 */
export declare function bundledAddon({ isPackaged, buildInfoDir, resourcesPath, env }: {
    isPackaged: boolean;
    buildInfoDir: string;
    /** process.resourcesPath (undefined outside Electron). */
    resourcesPath: string | undefined;
    env: Record<string, string | undefined>;
}): BundledAddon | null;
export interface Place {
    platform: string;
    env: Record<string, string | undefined>;
    homedir: string;
}
/** The add-on's folder ("home"), shared by every AI app on the computer. OPENEXTRACT_AI_HOME overrides it. */
export declare function addonHome({ platform, env, homedir }: Place): string;
export type PlatformKey = 'mac-arm64' | 'win-x64';
/**
 * Which download fits this computer, or null when there's none. `translated`: this app runs
 * under Rosetta or Windows-on-Arm's x64 emulation (app.runningUnderARM64Translation), so a
 * Mac is Apple silicon even when this app is the Intel build.
 */
export declare function platformKey(platform: string, arch: string, translated?: boolean): PlatformKey | null;
export declare function executableName(platform: string): string;
export type AiAppId = 'claude' | 'chatgpt' | 'claude-code';
export declare const AI_APPS: AiAppId[];
export interface Look {
    /** 'file', 'dir', or null when nothing is there (fs.statSync, following links). */
    kind: (p: string) => 'file' | 'dir' | null;
    /** The names in one folder, or [] when it can't be read. Never recursive. */
    list: (dir: string) => string[];
}
export declare const realLook: Look;
export interface DetectOptions extends Place {
    look?: Look;
    /** The system's Applications folder on macOS (a test points it at a temp folder). */
    systemApps?: string;
    /** macOS folders a command-line `claude` is often in but an app opened from Finder doesn't
     * have on its PATH: Homebrew's and /usr/local/bin (a test points them at temp folders). */
    macBinDirs?: string[];
}
/**
 * The AI apps found, in a fixed order, by looking only at the places in FRIENDS-BUILD.md's
 * table: a handful of files and folders, two folder listings on Windows (the app packages),
 * and `claude` in each folder on PATH. Nothing is run, searched for or sent.
 *
 * On Windows, a `claude.exe` in WindowsApps isn't counted as Claude Code: that folder holds
 * Store apps' launchers, which is where Claude (desktop) would put one.
 */
export declare function detectAiApps(options: DetectOptions): AiAppId[];
/** Where Claude (desktop) unpacks the extensions it installs, or null on other systems. */
export declare function claudeExtensionsDir({ platform, env, homedir }: Place): string | null;
/**
 * Claude for Windows from its installer from claude.ai is a Microsoft Store (MSIX) package, which keeps its
 * data in the package's own folder (LocalCache\Roaming\Claude), not in %APPDATA%\Claude. Seen on a real
 * PC on 2026-11-25: the package folder was Packages\Claude_pzs8sxrjxfjjc.
 */
export declare function claudePackageExtensionsDirs({ platform, env, homedir }: Place, look?: Look): string[];
/** The unrestricted edition's manifest says so in its display name (openextract-ai's packaging/build.py). */
export declare function isUnrestrictedExtension(dir: string): boolean;
/**
 * Connected to Claude (desktop) = one of its extensions folders holds the add-on (named after its manifest).
 * An app carrying the unrestricted edition counts only that edition, so someone who has the usual one in
 * Claude is offered Install, which replaces it.
 */
export declare function claudeHasAddon(place: Place, look?: Look, edition?: Edition): boolean;
/**
 * The newest version of the add-on Claude (desktop) has, from its manifest.json, or null when Claude doesn't
 * have it or its manifest can't be read. Compared with what this app carries, to offer an update.
 */
export declare function claudeAddonVersion(place: Place, look?: Look, edition?: Edition): string | null;
/** 0.3.0 is newer than 0.2.4 (and 0.10.0 than 0.9.9). Only the numbers count: 0.2.3-unrestricted is 0.2.3. */
export declare function newerVersion(a: string, b: string): boolean;
export interface AddonDownload {
    name: string;
    version: string;
    url: string;
    sha256: string;
    size: number;
}
/** A bigger download than this is a mistake in index.json, not the add-on. */
export declare const MAX_DOWNLOAD_BYTES: number;
export declare const ERRORS: {
    offline: string;
    badIndex: string;
    notForThisComputer: string;
    server: (status: number) => string;
    stalled: string;
    corrupt: string;
    diskFull: string;
    cantSave: (detail: string) => string;
    cantUnpack: string;
    bundledDamaged: string;
    noProgram: string;
    inUse: string;
};
/** Reads index.json for this computer's download, or says in plain words why it can't. */
export declare function parseIndex(json: unknown, key: PlatformKey): {
    ok: true;
    download: AddonDownload;
} | {
    ok: false;
    error: string;
};
export type Fetch = (url: string, init?: any) => Promise<any>;
export type InstallStep = 'index' | 'download' | 'verify' | 'unpack';
export interface InstallProgress {
    step: InstallStep;
    received?: number;
    total?: number;
}
/** The SHA-256 of a file, or null when it can't be read. */
export declare function fileSha256(file: string): Promise<string | null>;
/**
 * Downloads `url` to `dest`, checking its size and SHA-256 as it comes in. It's written
 * to `<dest>.part` and renamed only once it checks out, so `dest` is always a whole, good
 * file. A good file already at `dest` is kept and not downloaded again.
 */
export declare function downloadVerified({ url, size, sha256, dest, fetch: fetchFn, onProgress, stallMs }: {
    url: string;
    size: number;
    sha256: string;
    dest: string;
    fetch: Fetch;
    onProgress?: (p: InstallProgress) => void;
    stallMs?: number;
}): Promise<void>;
/** Runs a program and waits for it; rejects when it can't start or exits with an error. */
export type Run = (file: string, args: string[], options?: {
    env?: Record<string, string | undefined>;
}) => Promise<void>;
export declare const realRun: Run;
/**
 * Unzips a whole .mcpb into `dest` with the system's own tool, so no zip code ships in the
 * app: ditto on macOS, tar (bsdtar, in Windows since 10 1803) on Windows with PowerShell's
 * Expand-Archive if tar can't start, unzip elsewhere.
 */
export declare function extractZip(zip: string, dest: string, { platform, env, run }: {
    platform: string;
    env: Record<string, string | undefined>;
    run?: Run;
}): Promise<void>;
/**
 * Unzips the .mcpb's server/ folder into program/<version>/ and returns the program's path.
 * It's unpacked beside the final folder first and moved into place whole, so a
 * program/<version>/ with the program in it is always complete; one that's already there is kept.
 */
export declare function unpackServer({ mcpb, programDir, version, platform, env, run }: {
    mcpb: string;
    programDir: string;
    version: string;
    platform: string;
    env: Record<string, string | undefined>;
    run?: Run;
}): Promise<string>;
export interface Installed {
    version: string;
    command: string;
}
export declare function programDir(home: string): string;
/** Writes program/current.json, which the AI apps other than Claude (desktop) start the add-on from. */
export declare function writeCurrent(home: string, installed: Installed): void;
/** What program/current.json names, when the program it names is there, inside program/. Otherwise null. */
export declare function readCurrent(home: string, look?: Look): Installed | null;
/** The add-on is installed: program/current.json is there (FRIENDS-BUILD.md section 3). */
export declare function addonInstalled(home: string): boolean;
/** `<add-on home>/backups.json`, which the add-on reads to find backups outside the usual folders. */
export interface BackupsFile {
    version: 1;
    /** The backup folder open in OpenExtract now, or the last one opened; null if none. */
    open: string | null;
    /** Folders known to hold backups: the open backup's parent, then those of the others. */
    folders: string[];
}
export declare const BACKUPS_FILE = "backups.json";
/**
 * What backups.json holds: `open`, and the folder each backup is in (the open one's first, then
 * `others`: the backups OpenExtract found or was pointed at). Absolute paths only, each folder
 * once (ignoring case on Windows, whose paths don't care about it).
 */
export declare function backupsFile(open: unknown, others: Iterable<unknown>, platform: string): BackupsFile;
/** Writes backups.json whole (a temp file renamed over it), so the add-on never reads half of one. */
export declare function writeBackupsFile(home: string, file: BackupsFile): void;
/** Whether a backup is in Finder's backup folder, which macOS keeps behind Full Disk Access. */
export declare function inMobileSync(backupDir: unknown, homedir: string): boolean;
export interface InstallOptions extends Place {
    /** index.json, when the add-on is downloaded. */
    indexUrl?: string | null;
    /** The add-on this app carries: used instead of index.json when there is one. */
    bundled?: BundledAddon | null;
    arch: string;
    translated?: boolean;
    fetch: Fetch;
    run?: Run;
    onProgress?: (p: InstallProgress) => void;
    stallMs?: number;
}
export type InstallResult = {
    ok: true;
    installed: Installed;
    mcpb: string;
} | {
    ok: false;
    error: string;
};
/**
 * Only when the person clicks: index.json, then this computer's .mcpb into downloads/
 * (size and SHA-256 checked), then server/ into program/<version>/ and program/current.json.
 * An app carrying the add-on copies its own .mcpb into downloads/ instead, with nothing downloaded.
 */
export declare function installAddon(options: InstallOptions): Promise<InstallResult>;
export interface AddonKey {
    name: string;
    kind: string;
    /** Its last day (a week's key), or null for no end. */
    until: string | null;
    /** The phone code of the one iPhone it's for (a bought key), or null for any iPhone. */
    phone: string | null;
}
export interface AddonStatus {
    version: string;
    /** The first good key (as the add-on's `key`), or null. */
    key: AddonKey | null;
    /** Every good key on this computer (0.2.4 on; older add-ons give only `key`). */
    keys: AddonKey[];
    freeQuestions: number;
    freeQuestionsLeft: number;
}
export declare const STATUS_TIMEOUT_MS = 20000;
/** Runs `<command> --status` and gives back its answer; a runner can be passed in for tests. */
export type StatusRunner = (command: string, args: string[], timeoutMs: number) => Promise<string>;
export declare const realStatusRunner: StatusRunner;
/** The add-on's one JSON line, checked field by field. */
export declare function parseStatus(stdout: string): AddonStatus | null;
export declare function addonStatus(command: string, { runner, timeoutMs }?: {
    runner?: StatusRunner;
    timeoutMs?: number;
}): Promise<{
    ok: true;
    status: AddonStatus;
} | {
    ok: false;
    error: string;
}>;
/** The command a Claude Code user pastes into a terminal. */
export declare function claudeCodeCommand(command: string, platform: string): string;
export declare const CODEX_COMMENT = "# Added by OpenExtract. Delete these lines to disconnect.";
export declare const CODEX_BACKUP = "config.toml.openextract-backup";
export declare function codexConfigPath({ env, homedir }: Place): string;
/** A TOML basic string. */
export declare function tomlString(value: string): string;
export declare function codexBlock(command: string, eol?: string): string;
export type CodexEntry = {
    state: 'absent';
} | {
    state: 'block';
    command: string | null;
}
/** openextract is in the file some other way (a dotted key, an inline table, twice): left alone. */
 | {
    state: 'other';
} | {
    state: 'unreadable';
};
/** Whether ChatGPT's settings file has the openextract entry, and what it runs. */
export declare function codexEntry(text: string): CodexEntry;
export declare const CODEX_ERRORS: {
    unreadable: string;
    other: string;
    notText: string;
};
/**
 * `text` with the openextract block added at the end, or put in place of the one that's
 * there (with the comment line above it, and up to its last key: comments and blank lines
 * after it belong to what follows). Every other byte stays as it was, line breaks included;
 * the block uses the file's own (CRLF if it has any).
 */
export declare function withCodexBlock(text: string, command: string): {
    ok: true;
    text: string;
} | {
    ok: false;
    error: string;
};
/**
 * Connects ChatGPT (desktop): backs config.toml up to config.toml.openextract-backup, then
 * writes it with the openextract block added or replaced. A file that's a link is written
 * where it leads, so the link stays. A missing file or folder is created. Unchanged when the
 * block is already right (no backup then either).
 */
export declare function connectCodex(configPath: string, command: string): {
    ok: true;
    changed: boolean;
} | {
    ok: false;
    error: string;
};
