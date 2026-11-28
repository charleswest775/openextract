"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_ERRORS = exports.CODEX_BACKUP = exports.CODEX_COMMENT = exports.realStatusRunner = exports.STATUS_TIMEOUT_MS = exports.BACKUPS_FILE = exports.realRun = exports.ERRORS = exports.MAX_DOWNLOAD_BYTES = exports.realLook = exports.AI_APPS = exports.BUNDLED_DIR = exports.BUNDLED_MCPB_ENV = exports.BUILD_INFO_FILE = exports.AI_INDEX_URL_ENV = void 0;
exports.isAllowedUrl = isAllowedUrl;
exports.aiIndexUrl = aiIndexUrl;
exports.parseMcpbName = parseMcpbName;
exports.bundledFrom = bundledFrom;
exports.bundledAddon = bundledAddon;
exports.addonHome = addonHome;
exports.platformKey = platformKey;
exports.executableName = executableName;
exports.detectAiApps = detectAiApps;
exports.claudeExtensionsDir = claudeExtensionsDir;
exports.claudePackageExtensionsDirs = claudePackageExtensionsDirs;
exports.isUnrestrictedExtension = isUnrestrictedExtension;
exports.claudeHasAddon = claudeHasAddon;
exports.claudeAddonVersion = claudeAddonVersion;
exports.newerVersion = newerVersion;
exports.parseIndex = parseIndex;
exports.fileSha256 = fileSha256;
exports.downloadVerified = downloadVerified;
exports.extractZip = extractZip;
exports.unpackServer = unpackServer;
exports.programDir = programDir;
exports.writeCurrent = writeCurrent;
exports.readCurrent = readCurrent;
exports.addonInstalled = addonInstalled;
exports.backupsFile = backupsFile;
exports.writeBackupsFile = writeBackupsFile;
exports.inMobileSync = inMobileSync;
exports.installAddon = installAddon;
exports.parseStatus = parseStatus;
exports.addonStatus = addonStatus;
exports.claudeCodeCommand = claudeCodeCommand;
exports.codexConfigPath = codexConfigPath;
exports.tomlString = tomlString;
exports.codexBlock = codexBlock;
exports.codexEntry = codexEntry;
exports.withCodexBlock = withCodexBlock;
exports.connectCodex = connectCodex;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
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
// ── Off unless switched on ──────────────────────────────────────────────────
exports.AI_INDEX_URL_ENV = 'OPENEXTRACT_AI_INDEX_URL';
/**
 * Written beside the built main process by scripts/write-build-info.mjs, during
 * `npm run build:electron`, from the build's environment, the way the engine's
 * build_info.json is (python/build_info.py). A packaged app reads it; package.json's
 * build.files packs it.
 */
exports.BUILD_INFO_FILE = 'build-info.json';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** index.json and the downloads: https, or http to this computer (a test server). No user:password@. */
function isAllowedUrl(value) {
    if (typeof value !== 'string' || !value)
        return false;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    if (url.username || url.password)
        return false;
    if (url.protocol === 'https:')
        return true;
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * The add-on's index.json, or null when Ask AI is off. A packaged app takes it only from
 * build-info.json, baked in at build time; its environment can't switch the screen on.
 * A development build (unpackaged) reads OPENEXTRACT_AI_INDEX_URL, as the engine reads
 * package.json when run from source: a build-info.json there could be a stale leftover.
 */
function aiIndexUrl({ isPackaged, buildInfoDir, env }) {
    const raw = isPackaged ? readJson(path.join(buildInfoDir, exports.BUILD_INFO_FILE))?.aiIndexUrl : env[exports.AI_INDEX_URL_ENV];
    const value = typeof raw === 'string' ? raw.trim() : '';
    return isAllowedUrl(value) ? value : null;
}
// ── An add-on carried inside the app ────────────────────────────────────────
/**
 * The friends-and-family build carries the add-on inside the app instead of downloading it:
 * scripts/package-friends.mjs builds the app with OPENEXTRACT_AI_BUNDLED_MCPB set to a .mcpb,
 * scripts/write-build-info.mjs records its name, size and SHA-256 in build-info.json, and
 * electron-builder copies it into the app's resources/ai-addon/. Install then checks it and
 * unpacks it, with nothing downloaded.
 */
exports.BUNDLED_MCPB_ENV = 'OPENEXTRACT_AI_BUNDLED_MCPB';
/** Its folder inside a packaged app's resources (process.resourcesPath). */
exports.BUNDLED_DIR = 'ai-addon';
const MCPB_NAME = /^openextract-ai-(\d{1,4}\.\d{1,4}\.\d{1,6})(-unrestricted)?-(mac-arm64|win-x64)\.mcpb$/;
/** openextract-ai-0.2.3-unrestricted-mac-arm64.mcpb (as packaging/build.py names it): its version, edition
 * and computer, or null for any other name. */
function parseMcpbName(name) {
    const m = typeof name === 'string' ? MCPB_NAME.exec(name) : null;
    if (!m)
        return null;
    const edition = m[2] ? 'unrestricted' : null;
    return { version: edition ? `${m[1]}-unrestricted` : m[1], platform: m[3], edition };
}
/** build-info.json's aiAddon, checked field by field: the add-on in `dir`, or null. */
function bundledFrom(info, dir) {
    if (!info || typeof info !== 'object')
        return null;
    const named = parseMcpbName(info.file);
    if (!named || typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(info.sha256)
        || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > exports.MAX_DOWNLOAD_BYTES)
        return null;
    return { file: path.join(dir, info.file), ...named, sha256: info.sha256.toLowerCase(), size: info.size };
}
/**
 * The add-on this app carries, or null. A packaged app takes it only from build-info.json, baked in at build
 * time, and finds the file in its resources; a development build reads OPENEXTRACT_AI_BUNDLED_MCPB (a path to
 * a .mcpb named as packaging/build.py names it) and checks it as it is now.
 */
function bundledAddon({ isPackaged, buildInfoDir, resourcesPath, env }) {
    if (isPackaged) {
        const info = readJson(path.join(buildInfoDir, exports.BUILD_INFO_FILE))?.aiAddon;
        return info && resourcesPath ? bundledFrom(info, path.join(resourcesPath, exports.BUNDLED_DIR)) : null;
    }
    const file = env[exports.BUNDLED_MCPB_ENV]?.trim();
    if (!file)
        return null;
    try {
        const bytes = fs.readFileSync(file);
        return bundledFrom({ file: path.basename(file), size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, path.dirname(path.resolve(file)));
    }
    catch {
        return null;
    }
}
/** The add-on's folder ("home"), shared by every AI app on the computer. OPENEXTRACT_AI_HOME overrides it. */
function addonHome({ platform, env, homedir }) {
    const override = env.OPENEXTRACT_AI_HOME?.trim();
    if (override)
        return path.resolve(override);
    if (platform === 'darwin')
        return path.join(homedir, 'Library', 'Application Support', 'OpenExtract AI');
    if (platform === 'win32')
        return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'OpenExtract AI');
    return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'openextract-ai');
}
/**
 * Which download fits this computer, or null when there's none. `translated`: this app runs
 * under Rosetta or Windows-on-Arm's x64 emulation (app.runningUnderARM64Translation), so a
 * Mac is Apple silicon even when this app is the Intel build.
 */
function platformKey(platform, arch, translated = false) {
    if (platform === 'darwin' && (arch === 'arm64' || translated))
        return 'mac-arm64';
    if (platform === 'win32' && arch === 'x64')
        return 'win-x64';
    return null;
}
function executableName(platform) {
    return platform === 'win32' ? 'openextract-ai.exe' : 'openextract-ai';
}
exports.AI_APPS = ['claude', 'chatgpt', 'claude-code'];
exports.realLook = {
    kind(p) {
        try {
            const s = fs.statSync(p);
            return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : null;
        }
        catch {
            return null;
        }
    },
    list(dir) {
        try {
            return fs.readdirSync(dir);
        }
        catch {
            return [];
        }
    },
};
const MAC_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
function localAppData({ env, homedir }) {
    return env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
}
function pathDirs({ platform, env }) {
    const value = env.PATH ?? env.Path ?? '';
    return value.split(platform === 'win32' ? ';' : ':').map(d => d.trim()).filter(d => d && path.isAbsolute(d));
}
// MSIX package folders are "<Name>_<publisher id>": Claude's may carry a publisher prefix.
const CLAUDE_PACKAGE = /^(?:[A-Za-z0-9-]+\.)*Claude_[A-Za-z0-9]+$/i;
const CHATGPT_PACKAGE = /^OpenAI\.ChatGPT-Desktop_/i;
/**
 * The AI apps found, in a fixed order, by looking only at the places in FRIENDS-BUILD.md's
 * table: a handful of files and folders, two folder listings on Windows (the app packages),
 * and `claude` in each folder on PATH. Nothing is run, searched for or sent.
 *
 * On Windows, a `claude.exe` in WindowsApps isn't counted as Claude Code: that folder holds
 * Store apps' launchers, which is where Claude (desktop) would put one.
 */
function detectAiApps(options) {
    const { platform, homedir } = options;
    const look = options.look ?? exports.realLook;
    const has = (p) => look.kind(p) !== null;
    const isFile = (p) => look.kind(p) === 'file';
    const found = new Set();
    if (platform === 'darwin') {
        const apps = [options.systemApps ?? '/Applications', path.join(homedir, 'Applications')];
        if (apps.some(dir => has(path.join(dir, 'Claude.app'))))
            found.add('claude');
        if (apps.some(dir => has(path.join(dir, 'ChatGPT.app'))))
            found.add('chatgpt');
        // An app opened from Finder gets a short PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew's,
        // /usr/local/bin and npm's usual global folder are looked in by name too.
        const binDirs = [...pathDirs(options), ...(options.macBinDirs ?? MAC_BIN_DIRS)];
        if (binDirs.some(dir => isFile(path.join(dir, 'claude')))
            || isFile(path.join(homedir, '.local', 'bin', 'claude'))
            || isFile(path.join(homedir, '.claude', 'local', 'claude'))
            || isFile(path.join(homedir, '.npm-global', 'bin', 'claude')))
            found.add('claude-code');
    }
    else if (platform === 'win32') {
        const local = localAppData(options);
        const packages = path.join(local, 'Packages');
        const windowsApps = path.join(local, 'Microsoft', 'WindowsApps');
        if (isFile(path.join(local, 'AnthropicClaude', 'claude.exe'))
            || look.list(packages).some(n => CLAUDE_PACKAGE.test(n))
            || look.list(windowsApps).some(n => CLAUDE_PACKAGE.test(n)))
            found.add('claude');
        if (look.list(packages).some(n => CHATGPT_PACKAGE.test(n))
            || has(path.join(windowsApps, 'ChatGPT.exe')))
            found.add('chatgpt');
        const profile = options.env.USERPROFILE || homedir;
        const notStoreLaunchers = pathDirs(options).filter(d => path.resolve(d).toLowerCase() !== path.resolve(windowsApps).toLowerCase());
        if (notStoreLaunchers.some(dir => isFile(path.join(dir, 'claude.exe')) || isFile(path.join(dir, 'claude.cmd')))
            || isFile(path.join(profile, '.local', 'bin', 'claude.exe')))
            found.add('claude-code');
    }
    return exports.AI_APPS.filter(id => found.has(id));
}
/** Where Claude (desktop) unpacks the extensions it installs, or null on other systems. */
function claudeExtensionsDir({ platform, env, homedir }) {
    if (platform === 'darwin')
        return path.join(homedir, 'Library', 'Application Support', 'Claude', 'Claude Extensions');
    if (platform === 'win32')
        return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'Claude', 'Claude Extensions');
    return null;
}
/**
 * Claude for Windows from its installer from claude.ai is a Microsoft Store (MSIX) package, which keeps its
 * data in the package's own folder (LocalCache\Roaming\Claude), not in %APPDATA%\Claude. Seen on a real
 * PC on 2026-11-25: the package folder was Packages\Claude_pzs8sxrjxfjjc.
 */
function claudePackageExtensionsDirs({ platform, env, homedir }, look = exports.realLook) {
    if (platform !== 'win32')
        return [];
    const packages = path.join(localAppData({ platform, env, homedir }), 'Packages');
    return look.list(packages).filter(name => /^Claude_/i.test(name))
        .map(name => path.join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'Claude Extensions'));
}
/** The unrestricted edition's manifest says so in its display name (openextract-ai's packaging/build.py). */
function isUnrestrictedExtension(dir) {
    const name = readJson(path.join(dir, 'manifest.json'))?.display_name;
    return typeof name === 'string' && /\(unrestricted\)\s*$/i.test(name);
}
/**
 * Connected to Claude (desktop) = one of its extensions folders holds the add-on (named after its manifest).
 * An app carrying the unrestricted edition counts only that edition, so someone who has the usual one in
 * Claude is offered Install, which replaces it.
 */
function claudeHasAddon(place, look = exports.realLook, edition = null) {
    return claudeAddonDirs(place, look, edition).length > 0;
}
/** The add-on's folders in Claude's extensions folders (normally one), as claudeHasAddon counts them. */
function claudeAddonDirs(place, look, edition) {
    const dirs = [claudeExtensionsDir(place), ...claudePackageExtensionsDirs(place, look)];
    return dirs.flatMap(dir => dir === null ? [] : look.list(dir)
        .filter(name => /openextract/i.test(name) && (edition !== 'unrestricted' || isUnrestrictedExtension(path.join(dir, name))))
        .map(name => path.join(dir, name)));
}
/**
 * The newest version of the add-on Claude (desktop) has, from its manifest.json, or null when Claude doesn't
 * have it or its manifest can't be read. Compared with what this app carries, to offer an update.
 */
function claudeAddonVersion(place, look = exports.realLook, edition = null) {
    let newest = null;
    for (const dir of claudeAddonDirs(place, look, edition)) {
        const version = readJson(path.join(dir, 'manifest.json'))?.version;
        if (typeof version === 'string' && VERSION.test(version) && (newest === null || newerVersion(version, newest)))
            newest = version;
    }
    return newest;
}
/** 0.3.0 is newer than 0.2.4 (and 0.10.0 than 0.9.9). Only the numbers count: 0.2.3-unrestricted is 0.2.3. */
function newerVersion(a, b) {
    const parts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
    const [x, y] = [parts(a), parts(b)];
    if (x.length !== 3 || y.length !== 3)
        return false;
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] > y[i];
    return false;
}
/** A bigger download than this is a mistake in index.json, not the add-on. */
exports.MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
// The version names a folder (program/<version>/), so nothing that could step out of it.
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;
exports.ERRORS = {
    offline: "Couldn't reach the OpenExtract AI download. Check your internet connection and try again.",
    badIndex: "The OpenExtract AI download list couldn't be read. Try again later.",
    notForThisComputer: "OpenExtract AI isn't available for this computer yet.",
    server: (status) => `The OpenExtract AI download isn't available right now (the server answered ${status}). Try again later.`,
    stalled: 'The download stopped partway. Check your internet connection and try again.',
    corrupt: "The download didn't come through right. Try again.",
    diskFull: "There isn't enough free space on this computer for OpenExtract AI.",
    cantSave: (detail) => `OpenExtract couldn't save the download: ${detail}`,
    cantUnpack: "OpenExtract couldn't unpack the download. Try again.",
    bundledDamaged: 'The copy of OpenExtract AI inside this app is damaged. Download this app again.',
    noProgram: "The download didn't have the OpenExtract AI program in it.",
    inUse: 'OpenExtract AI is in use. Quit the AI apps that use it, then try again.',
};
/** Reads index.json for this computer's download, or says in plain words why it can't. */
function parseIndex(json, key) {
    const index = json;
    if (!index || typeof index !== 'object' || typeof index.version !== 'string' || !VERSION.test(index.version)
        || !index.files || typeof index.files !== 'object') {
        return { ok: false, error: exports.ERRORS.badIndex };
    }
    if (!Object.prototype.hasOwnProperty.call(index.files, key))
        return { ok: false, error: exports.ERRORS.notForThisComputer };
    const file = index.files[key];
    if (!file || !isAllowedUrl(file.url) || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > exports.MAX_DOWNLOAD_BYTES) {
        return { ok: false, error: exports.ERRORS.badIndex };
    }
    return {
        ok: true,
        download: {
            name: typeof index.name === 'string' && index.name ? index.name : 'OpenExtract AI',
            version: index.version,
            url: file.url,
            sha256: file.sha256.toLowerCase(),
            size: file.size,
        },
    };
}
const INDEX_TIMEOUT_MS = 30000;
const STALL_MS = 60000;
class PlainError extends Error {
}
function diskError(err) {
    if (err instanceof PlainError)
        return err;
    if (err?.code === 'ENOSPC')
        return new PlainError(exports.ERRORS.diskFull);
    return new PlainError(exports.ERRORS.cantSave(String(err?.message ?? err)));
}
async function fetchIndex(url, fetchFn, timeoutMs = INDEX_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetchFn(url, { signal: controller.signal, cache: 'no-store' });
    }
    catch {
        clearTimeout(timer);
        throw new PlainError(exports.ERRORS.offline);
    }
    try {
        if (!res.ok)
            throw new PlainError(exports.ERRORS.server(res.status));
        return JSON.parse(await res.text());
    }
    catch (err) {
        if (err instanceof PlainError)
            throw err;
        throw new PlainError(controller.signal.aborted ? exports.ERRORS.offline : exports.ERRORS.badIndex);
    }
    finally {
        clearTimeout(timer);
    }
}
/** The SHA-256 of a file, or null when it can't be read. */
async function fileSha256(file) {
    try {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file))
            hash.update(chunk);
        return hash.digest('hex');
    }
    catch {
        return null;
    }
}
async function alreadyDownloaded(dest, size, sha256) {
    try {
        if (fs.statSync(dest).size !== size)
            return false;
    }
    catch {
        return false;
    }
    return (await fileSha256(dest)) === sha256;
}
/**
 * Downloads `url` to `dest`, checking its size and SHA-256 as it comes in. It's written
 * to `<dest>.part` and renamed only once it checks out, so `dest` is always a whole, good
 * file. A good file already at `dest` is kept and not downloaded again.
 */
async function downloadVerified({ url, size, sha256, dest, fetch: fetchFn, onProgress, stallMs = STALL_MS }) {
    if (await alreadyDownloaded(dest, size, sha256))
        return;
    const part = `${dest}.part`;
    const controller = new AbortController();
    let stalled = false;
    let timer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
    const keepAlive = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
    };
    let res;
    try {
        res = await fetchFn(url, { signal: controller.signal, cache: 'no-store' });
    }
    catch {
        clearTimeout(timer);
        throw new PlainError(stalled ? exports.ERRORS.stalled : exports.ERRORS.offline);
    }
    if (!res.ok || !res.body) {
        clearTimeout(timer);
        throw new PlainError(exports.ERRORS.server(res.status));
    }
    let out = null;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastPercent = -1;
    try {
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            out = await fs.promises.open(part, 'w');
        }
        catch (err) {
            throw diskError(err);
        }
        onProgress?.({ step: 'download', received: 0, total: size });
        const reader = res.body.getReader();
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            }
            catch {
                throw new PlainError(stalled ? exports.ERRORS.stalled : exports.ERRORS.offline);
            }
            if (chunk.done)
                break;
            const bytes = chunk.value;
            keepAlive();
            received += bytes.byteLength;
            if (received > size) {
                await reader.cancel().catch(() => { });
                throw new PlainError(exports.ERRORS.corrupt);
            }
            hash.update(bytes);
            try {
                await out.write(bytes);
            }
            catch (err) {
                await reader.cancel().catch(() => { });
                throw diskError(err);
            }
            const percent = Math.floor((received / size) * 100);
            if (percent !== lastPercent) {
                lastPercent = percent;
                onProgress?.({ step: 'download', received, total: size });
            }
        }
        onProgress?.({ step: 'verify', received, total: size });
        if (received !== size || hash.digest('hex') !== sha256)
            throw new PlainError(exports.ERRORS.corrupt);
        await out.close();
        out = null;
        try {
            fs.renameSync(part, dest);
        }
        catch (err) {
            throw diskError(err);
        }
    }
    catch (err) {
        if (out)
            await out.close().catch(() => { });
        try {
            fs.rmSync(part, { force: true });
        }
        catch {
            // A leftover .part is overwritten next time.
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
const realRun = (file, args, options = {}) => new Promise((resolve, reject) => {
    (0, child_process_1.execFile)(file, args, { windowsHide: true, timeout: 10 * 60000, maxBuffer: 16 * 1024 * 1024, env: options.env ?? process.env }, err => (err ? reject(err) : resolve()));
});
exports.realRun = realRun;
/**
 * Unzips a whole .mcpb into `dest` with the system's own tool, so no zip code ships in the
 * app: ditto on macOS, tar (bsdtar, in Windows since 10 1803) on Windows with PowerShell's
 * Expand-Archive if tar can't start, unzip elsewhere.
 */
async function extractZip(zip, dest, { platform, env, run = exports.realRun }) {
    if (platform === 'darwin')
        return run('/usr/bin/ditto', ['-x', '-k', zip, dest]);
    if (platform === 'win32') {
        const system32 = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
        try {
            return await run(path.join(system32, 'tar.exe'), ['-xf', zip, '-C', dest]);
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                throw err;
        }
        // The paths go in as environment variables, so nothing in them is read as PowerShell.
        return run(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile', '-NonInteractive', '-Command',
            'Expand-Archive -LiteralPath $env:OPENEXTRACT_ZIP -DestinationPath $env:OPENEXTRACT_DEST -Force',
        ], { env: { ...env, OPENEXTRACT_ZIP: zip, OPENEXTRACT_DEST: dest } });
    }
    return run('unzip', ['-q', '-o', zip, '-d', dest]);
}
function isInside(child, folder) {
    const rel = path.relative(folder, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
/** Whether a link anywhere under `root` leads out of it (an unpacked folder must stand on its own). */
function linkLeadsOut(root) {
    const realRoot = fs.realpathSync(root);
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                let target;
                try {
                    target = fs.realpathSync(full);
                }
                catch {
                    return true; // a link to nothing
                }
                if (!isInside(target, realRoot))
                    return true;
            }
            else if (entry.isDirectory()) {
                stack.push(full);
            }
        }
    }
    return false;
}
/**
 * Unzips the .mcpb's server/ folder into program/<version>/ and returns the program's path.
 * It's unpacked beside the final folder first and moved into place whole, so a
 * program/<version>/ with the program in it is always complete; one that's already there is kept.
 */
async function unpackServer({ mcpb, programDir, version, platform, env, run }) {
    if (!VERSION.test(version))
        throw new PlainError(exports.ERRORS.badIndex);
    const exe = executableName(platform);
    const final = path.join(programDir, version);
    const finalExe = path.join(final, exe);
    if (exports.realLook.kind(finalExe) === 'file')
        return makeRunnable(finalExe, platform);
    let tmp;
    try {
        fs.mkdirSync(programDir, { recursive: true });
        tmp = fs.mkdtempSync(path.join(programDir, `.unpack-${version}-`));
    }
    catch (err) {
        throw diskError(err);
    }
    try {
        try {
            await extractZip(mcpb, tmp, { platform, env, run });
        }
        catch {
            throw new PlainError(exports.ERRORS.cantUnpack);
        }
        const server = path.join(tmp, 'server');
        let serverIsDir = false;
        try {
            serverIsDir = fs.lstatSync(server).isDirectory();
        }
        catch {
            // no server/ folder
        }
        if (!serverIsDir || exports.realLook.kind(path.join(server, exe)) !== 'file')
            throw new PlainError(exports.ERRORS.noProgram);
        if (linkLeadsOut(server))
            throw new PlainError(exports.ERRORS.cantUnpack);
        if (fs.existsSync(final)) {
            // A folder without the program in it: what's left of something else. Replace it.
            try {
                fs.rmSync(final, { recursive: true, force: true });
            }
            catch {
                throw new PlainError(exports.ERRORS.inUse);
            }
        }
        try {
            fs.renameSync(server, final);
        }
        catch (err) {
            throw diskError(err);
        }
    }
    finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
        catch {
            // A leftover .unpack- folder holds nothing that's used.
        }
    }
    return makeRunnable(finalExe, platform);
}
function makeRunnable(exe, platform) {
    if (platform !== 'win32') {
        try {
            fs.chmodSync(exe, 0o755);
        }
        catch (err) {
            throw diskError(err);
        }
    }
    return exe;
}
function programDir(home) {
    return path.join(home, 'program');
}
/** Writes program/current.json, which the AI apps other than Claude (desktop) start the add-on from. */
function writeCurrent(home, installed) {
    const file = path.join(programDir(home), 'current.json');
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify({ version: installed.version, command: installed.command }, null, 2)}\n`, 'utf-8');
        fs.renameSync(tmp, file);
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // nothing to tidy
        }
        throw diskError(err);
    }
}
/** What program/current.json names, when the program it names is there, inside program/. Otherwise null. */
function readCurrent(home, look = exports.realLook) {
    const data = readJson(path.join(programDir(home), 'current.json'));
    if (!data || typeof data.version !== 'string' || typeof data.command !== 'string')
        return null;
    if (!path.isAbsolute(data.command) || !isInside(path.resolve(data.command), programDir(home)))
        return null;
    if (look.kind(data.command) !== 'file')
        return null;
    return { version: data.version, command: data.command };
}
/** The add-on is installed: program/current.json is there (FRIENDS-BUILD.md section 3). */
function addonInstalled(home) {
    return fs.existsSync(path.join(programDir(home), 'current.json'));
}
exports.BACKUPS_FILE = 'backups.json';
/**
 * What backups.json holds: `open`, and the folder each backup is in (the open one's first, then
 * `others`: the backups OpenExtract found or was pointed at). Absolute paths only, each folder
 * once (ignoring case on Windows, whose paths don't care about it).
 */
function backupsFile(open, others, platform) {
    const usable = (p) => typeof p === 'string' && p.trim() !== '' && path.isAbsolute(p);
    const openDir = usable(open) ? path.resolve(open) : null;
    const folders = [];
    const seen = new Set();
    for (const backup of [openDir, ...others]) {
        if (!usable(backup))
            continue;
        const dir = path.resolve(backup);
        const parent = path.dirname(dir);
        if (parent === dir)
            continue; // a backup can't be the root of a drive
        const key = platform === 'win32' ? parent.toLowerCase() : parent;
        if (seen.has(key))
            continue;
        seen.add(key);
        folders.push(parent);
    }
    return { version: 1, open: openDir, folders };
}
/** Writes backups.json whole (a temp file renamed over it), so the add-on never reads half of one. */
function writeBackupsFile(home, file) {
    const target = path.join(home, exports.BACKUPS_FILE);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
        fs.renameSync(tmp, target);
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // nothing to tidy
        }
        throw err;
    }
}
/** Whether a backup is in Finder's backup folder, which macOS keeps behind Full Disk Access. */
function inMobileSync(backupDir, homedir) {
    if (typeof backupDir !== 'string' || !path.isAbsolute(backupDir))
        return false;
    const mobileSync = path.join(homedir, 'Library', 'Application Support', 'MobileSync');
    // Macs' disks ignore case unless set up otherwise
    return isInside(path.resolve(backupDir).toLowerCase(), mobileSync.toLowerCase());
}
/**
 * The add-on this app carries, copied into downloads/ (where Claude opens it from, as it would a
 * download), checked against build-info.json's size and SHA-256 before and after. A good copy already
 * there is kept.
 */
async function copyBundled(bundled, dest) {
    if (await alreadyDownloaded(dest, bundled.size, bundled.sha256))
        return;
    if (!(await alreadyDownloaded(bundled.file, bundled.size, bundled.sha256)))
        throw new PlainError(exports.ERRORS.bundledDamaged);
    const part = `${dest}.part`;
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(bundled.file, part);
        fs.renameSync(part, dest);
    }
    catch (err) {
        try {
            fs.rmSync(part, { force: true });
        }
        catch {
            // nothing to tidy
        }
        throw diskError(err);
    }
    if (!(await alreadyDownloaded(dest, bundled.size, bundled.sha256))) {
        fs.rmSync(dest, { force: true });
        throw new PlainError(exports.ERRORS.corrupt);
    }
}
/**
 * Only when the person clicks: index.json, then this computer's .mcpb into downloads/
 * (size and SHA-256 checked), then server/ into program/<version>/ and program/current.json.
 * An app carrying the add-on copies its own .mcpb into downloads/ instead, with nothing downloaded.
 */
async function installAddon(options) {
    const key = platformKey(options.platform, options.arch, options.translated);
    if (!key)
        return { ok: false, error: exports.ERRORS.notForThisComputer };
    const home = addonHome(options);
    const { bundled } = options;
    if (bundled) {
        if (bundled.platform !== key)
            return { ok: false, error: exports.ERRORS.notForThisComputer };
        try {
            options.onProgress?.({ step: 'verify' });
            const mcpb = path.join(home, 'downloads', `openextract-ai-${bundled.version}-${key}.mcpb`);
            await copyBundled(bundled, mcpb);
            options.onProgress?.({ step: 'unpack' });
            const command = await unpackServer({ mcpb, programDir: programDir(home), version: bundled.version, platform: options.platform, env: options.env, run: options.run });
            const installed = { version: bundled.version, command };
            writeCurrent(home, installed);
            return { ok: true, installed, mcpb };
        }
        catch (err) {
            return { ok: false, error: err instanceof PlainError ? err.message : exports.ERRORS.cantSave(String(err?.message ?? err)) };
        }
    }
    if (!options.indexUrl)
        return { ok: false, error: exports.ERRORS.notForThisComputer };
    try {
        options.onProgress?.({ step: 'index' });
        const parsed = parseIndex(await fetchIndex(options.indexUrl, options.fetch), key);
        if (!parsed.ok)
            return parsed;
        const { version, url, sha256, size } = parsed.download;
        const mcpb = path.join(home, 'downloads', `openextract-ai-${version}-${key}.mcpb`);
        await downloadVerified({ url, size, sha256, dest: mcpb, fetch: options.fetch, onProgress: options.onProgress, stallMs: options.stallMs });
        options.onProgress?.({ step: 'unpack' });
        const command = await unpackServer({ mcpb, programDir: programDir(home), version, platform: options.platform, env: options.env, run: options.run });
        const installed = { version, command };
        writeCurrent(home, installed);
        return { ok: true, installed, mcpb };
    }
    catch (err) {
        return { ok: false, error: err instanceof PlainError ? err.message : exports.ERRORS.cantSave(String(err?.message ?? err)) };
    }
}
exports.STATUS_TIMEOUT_MS = 20000;
const realStatusRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
    (0, child_process_1.execFile)(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err)
            reject(err);
        else
            resolve(String(stdout));
    });
});
exports.realStatusRunner = realStatusRunner;
/** The add-on's one JSON line, checked field by field. */
function parseStatus(stdout) {
    for (const line of stdout.split(/\r?\n/)) {
        const text = line.trim();
        if (!text.startsWith('{'))
            continue;
        let data;
        try {
            data = JSON.parse(text);
        }
        catch {
            continue;
        }
        const count = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
        if (typeof data?.version !== 'string' || !count(data.free_questions) || !count(data.free_questions_left))
            return null;
        const keyFrom = (k) => {
            if (k === null || k === undefined)
                return null;
            if (typeof k !== 'object' || typeof k.name !== 'string' || !k.name.trim())
                return undefined;
            return {
                name: k.name.trim().slice(0, 80),
                kind: typeof k.kind === 'string' ? k.kind : '',
                until: typeof k.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k.until) ? k.until : null,
                phone: typeof k.phone === 'string' && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(k.phone) ? k.phone : null,
            };
        };
        const key = keyFrom(data.key);
        if (key === undefined)
            return null;
        let keys = key ? [key] : [];
        if (Array.isArray(data.keys)) {
            const listed = data.keys.slice(0, 50).map(keyFrom);
            if (listed.some((k) => !k))
                return null;
            keys = listed;
        }
        return {
            version: data.version,
            key,
            keys,
            freeQuestions: data.free_questions,
            freeQuestionsLeft: Math.min(data.free_questions_left, data.free_questions),
        };
    }
    return null;
}
async function addonStatus(command, { runner = exports.realStatusRunner, timeoutMs = exports.STATUS_TIMEOUT_MS } = {}) {
    let stdout;
    try {
        stdout = await runner(command, ['--status'], timeoutMs);
    }
    catch (err) {
        return {
            ok: false,
            error: err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT'
                ? "OpenExtract AI didn't answer in time. Try again."
                : "OpenExtract AI couldn't be started. Try installing it again.",
        };
    }
    const status = parseStatus(stdout);
    return status ? { ok: true, status } : { ok: false, error: "OpenExtract AI's answer couldn't be read. Try installing it again." };
}
// ── Claude Code ─────────────────────────────────────────────────────────────
/** The command a Claude Code user pastes into a terminal. */
function claudeCodeCommand(command, platform) {
    // Windows paths can't hold a double quote; on macOS and Linux, keep the shell from reading $ ` \ " in the path.
    const quoted = platform === 'win32' ? command : command.replace(/(["\\$`])/g, '\\$1');
    return `claude mcp add --scope user openextract -- "${quoted}"`;
}
// ── ChatGPT (desktop): ~/.codex/config.toml ─────────────────────────────────
exports.CODEX_COMMENT = '# Added by OpenExtract. Delete these lines to disconnect.';
exports.CODEX_BACKUP = 'config.toml.openextract-backup';
function codexConfigPath({ env, homedir }) {
    const codexHome = env.CODEX_HOME?.trim();
    return path.join(codexHome ? path.resolve(codexHome) : path.join(homedir, '.codex'), 'config.toml');
}
/** A TOML basic string. */
function tomlString(value) {
    let out = '"';
    for (const ch of value) {
        const code = ch.codePointAt(0);
        if (ch === '"')
            out += '\\"';
        else if (ch === '\\')
            out += '\\\\';
        else if (ch === '\n')
            out += '\\n';
        else if (ch === '\r')
            out += '\\r';
        else if (ch === '\t')
            out += '\\t';
        else if (code < 0x20 || code === 0x7f)
            out += `\\u${code.toString(16).padStart(4, '0')}`;
        else
            out += ch;
    }
    return `${out}"`;
}
function codexBlock(command, eol = '\n') {
    return [exports.CODEX_COMMENT, '[mcp_servers.openextract]', `command = ${tomlString(command)}`, 'args = []'].join(eol) + eol;
}
class TomlError extends Error {
}
const BARE_KEY = /[A-Za-z0-9_-]/;
/**
 * Splits a TOML file into lines and statements, enough to find tables and keys without
 * mistaking a "[" inside a string or a multi-line array for a table. It reads, never
 * rewrites: every byte of the file is in exactly one item. Throws TomlError on a file it
 * can't follow (an unterminated string, a broken table name).
 */
function scanToml(text) {
    const items = [];
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const n = text.length;
    const eolAt = (k) => (text[k] === '\n' ? 1 : text[k] === '\r' && text[k + 1] === '\n' ? 2 : 0);
    const skipSpaces = () => { while (i < n && (text[i] === ' ' || text[i] === '\t'))
        i++; };
    const toLineEnd = () => {
        while (i < n && !eolAt(i))
            i++;
        i += eolAt(i);
    };
    // After a value or table name: spaces, maybe a comment, then the line break (or the end).
    const finishLine = () => {
        skipSpaces();
        if (text[i] === '#') {
            toLineEnd();
            return;
        }
        if (i < n && !eolAt(i))
            throw new TomlError(`unexpected text at ${i}`);
        i += eolAt(i);
    };
    const basicString = () => {
        let out = '';
        i++; // "
        while (i < n) {
            const c = text[i];
            if (c === '"') {
                i++;
                return out;
            }
            if (eolAt(i))
                throw new TomlError('line break in a string');
            if (c === '\\') {
                const e = text[i + 1];
                const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
                if (e in simple) {
                    out += simple[e];
                    i += 2;
                }
                else if (e === 'u' || e === 'U') {
                    const len = e === 'u' ? 4 : 8;
                    const hex = text.slice(i + 2, i + 2 + len);
                    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len)
                        throw new TomlError('bad escape');
                    out += String.fromCodePoint(parseInt(hex, 16));
                    i += 2 + len;
                }
                else if (e === 'x') {
                    const hex = text.slice(i + 2, i + 4);
                    if (!/^[0-9a-fA-F]{2}$/.test(hex))
                        throw new TomlError('bad escape');
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 4;
                }
                else {
                    throw new TomlError('bad escape');
                }
                continue;
            }
            out += c;
            i++;
        }
        throw new TomlError('unterminated string');
    };
    const literalString = () => {
        const close = text.indexOf("'", i + 1);
        const line = text.slice(i + 1, close);
        if (close < 0 || /[\r\n]/.test(line))
            throw new TomlError('unterminated string');
        i = close + 1;
        return line;
    };
    const multiline = (quote) => {
        i += 3;
        while (i < n) {
            if (quote === '"' && text[i] === '\\') {
                i += 2;
                continue;
            }
            if (text.startsWith(quote.repeat(3), i)) {
                i += 3;
                // Up to two more quotes belong to the string ("""a"""" is a" plus the close).
                let extra = 0;
                while (extra < 2 && text[i] === quote) {
                    i++;
                    extra++;
                }
                return;
            }
            i++;
        }
        throw new TomlError('unterminated multi-line string');
    };
    const keyParts = () => {
        const parts = [];
        for (;;) {
            skipSpaces();
            if (text[i] === '"')
                parts.push(basicString());
            else if (text[i] === "'")
                parts.push(literalString());
            else {
                const from = i;
                while (i < n && BARE_KEY.test(text[i]))
                    i++;
                if (i === from)
                    throw new TomlError(`bad key at ${i}`);
                parts.push(text.slice(from, i));
            }
            skipSpaces();
            if (text[i] !== '.')
                return parts;
            i++;
        }
    };
    // A value: strings, arrays and inline tables can span lines; brackets inside strings and
    // comments don't count.
    const value = () => {
        let depth = 0;
        let plain;
        let first = true;
        for (;;) {
            if (i >= n) {
                if (depth > 0)
                    throw new TomlError('unterminated array or table');
                return plain;
            }
            const c = text[i];
            const eol = eolAt(i);
            if (eol) {
                if (depth === 0)
                    return plain;
                i += eol;
                continue;
            }
            if (c === '#') {
                if (depth === 0)
                    return plain;
                while (i < n && !eolAt(i))
                    i++;
                continue;
            }
            if (c === '"' || c === "'") {
                const triple = text.startsWith(c.repeat(3), i);
                if (triple)
                    multiline(c);
                else {
                    const s = c === '"' ? basicString() : literalString();
                    if (first && depth === 0)
                        plain = s;
                }
            }
            else if (c === '[' || c === '{') {
                depth++;
                i++;
            }
            else if (c === ']' || c === '}') {
                depth--;
                if (depth < 0)
                    throw new TomlError('unbalanced brackets');
                i++;
            }
            else if ((c === ' ' || c === '\t') && depth === 0) {
                let k = i;
                while (k < n && (text[k] === ' ' || text[k] === '\t'))
                    k++;
                if (k >= n || eolAt(k) || text[k] === '#')
                    return plain;
                i = k; // more of the value: a date and time with a space between them
                continue;
            }
            else {
                i++;
            }
            if (c !== ' ' && c !== '\t')
                first = false;
        }
    };
    while (i < n) {
        const start = items.length === 0 ? 0 : i;
        skipSpaces();
        const eol = eolAt(i);
        if (i >= n || eol) {
            i += eol;
            items.push({ kind: 'blank', start, end: i });
        }
        else if (text[i] === '#') {
            toLineEnd();
            items.push({ kind: 'comment', start, end: i });
        }
        else if (text[i] === '[') {
            i++;
            const arrayTable = text[i] === '[';
            if (arrayTable)
                i++;
            const key = keyParts();
            if (text[i] !== ']' || (arrayTable && text[i + 1] !== ']'))
                throw new TomlError(`bad table name at ${i}`);
            i += arrayTable ? 2 : 1;
            finishLine();
            items.push({ kind: 'header', start, end: i, key, arrayTable });
        }
        else {
            const key = keyParts();
            if (text[i] !== '=')
                throw new TomlError(`expected = at ${i}`);
            i++;
            skipSpaces();
            const plain = value();
            finishLine();
            items.push({ kind: 'value', start, end: i, key, text: plain });
        }
    }
    return items;
}
const OURS = ['mcp_servers', 'openextract'];
const startsWith = (parts, prefix) => prefix.every((p, k) => parts[k] === p);
const same = (a, b) => a.length === b.length && startsWith(a, b);
function find(text) {
    let items;
    try {
        items = scanToml(text);
    }
    catch (err) {
        if (err instanceof TomlError)
            return { entry: { state: 'unreadable' }, items: [] };
        throw err;
    }
    let table = [];
    let header;
    let other = false;
    let command = null;
    items.forEach((item, k) => {
        if (item.kind === 'header') {
            table = item.key;
            if (startsWith(table, OURS) && item.arrayTable)
                other = true;
            else if (same(table, OURS)) {
                if (header !== undefined)
                    other = true;
                header = k;
            }
        }
        else if (item.kind === 'value') {
            const full = [...table, ...item.key];
            // Our table's own keys are ours. A key that makes mcp_servers or mcp_servers.openextract a
            // value (an inline table), or sets openextract's keys from outside its table, is the other way.
            if (startsWith(table, OURS)) {
                if (same(table, OURS) && same(item.key, ['command']) && item.text !== undefined)
                    command = item.text;
            }
            else if (startsWith(full, OURS) || same(full, ['mcp_servers'])) {
                other = true;
            }
        }
    });
    if (other)
        return { entry: { state: 'other' }, items };
    if (header === undefined)
        return { entry: { state: 'absent' }, items };
    return { entry: { state: 'block', command }, items, header };
}
/** Whether ChatGPT's settings file has the openextract entry, and what it runs. */
function codexEntry(text) {
    return find(text).entry;
}
exports.CODEX_ERRORS = {
    unreadable: "ChatGPT's settings file has something OpenExtract can't read, so OpenExtract didn't change it.",
    other: "ChatGPT's settings file already has an openextract entry written another way, so OpenExtract didn't change it.",
    notText: "ChatGPT's settings file isn't plain text, so OpenExtract didn't change it.",
};
/**
 * `text` with the openextract block added at the end, or put in place of the one that's
 * there (with the comment line above it, and up to its last key: comments and blank lines
 * after it belong to what follows). Every other byte stays as it was, line breaks included;
 * the block uses the file's own (CRLF if it has any).
 */
function withCodexBlock(text, command) {
    const { entry, items, header } = find(text);
    if (entry.state === 'unreadable')
        return { ok: false, error: exports.CODEX_ERRORS.unreadable };
    if (entry.state === 'other')
        return { ok: false, error: exports.CODEX_ERRORS.other };
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = codexBlock(command, eol);
    if (header === undefined) {
        if (text === '' || text === '\ufeff')
            return { ok: true, text: text + block };
        let prefix = text;
        if (!prefix.endsWith('\n'))
            prefix += eol;
        if (!prefix.endsWith(eol + eol) && !/^\ufeff?(\r?\n)$/.test(prefix))
            prefix += eol;
        return { ok: true, text: prefix + block };
    }
    let first = header;
    const above = items[header - 1];
    if (above?.kind === 'comment' && text.slice(above.start, above.end).trim() === exports.CODEX_COMMENT)
        first = header - 1;
    let last = header;
    for (let k = header + 1; k < items.length && items[k].kind !== 'header'; k++) {
        if (items[k].kind === 'value')
            last = k;
    }
    // The first item starts at 0 even after a byte-order mark; keep the mark.
    const from = first === 0 && text.charCodeAt(0) === 0xfeff ? 1 : items[first].start;
    const to = items[last].end;
    const replaced = text.slice(from, to);
    const ending = replaced.endsWith('\n') ? block : block.slice(0, -eol.length);
    return { ok: true, text: text.slice(0, from) + ending + text.slice(to) };
}
/**
 * Connects ChatGPT (desktop): backs config.toml up to config.toml.openextract-backup, then
 * writes it with the openextract block added or replaced. A file that's a link is written
 * where it leads, so the link stays. A missing file or folder is created. Unchanged when the
 * block is already right (no backup then either).
 */
function connectCodex(configPath, command) {
    let target = configPath;
    let original = null;
    try {
        original = fs.readFileSync(configPath);
        target = fs.realpathSync(configPath);
    }
    catch (err) {
        if (err?.code !== 'ENOENT')
            return { ok: false, error: `OpenExtract couldn't read ChatGPT's settings file: ${err?.message ?? err}` };
    }
    const text = original ? original.toString('utf-8') : '';
    if (original && !Buffer.from(text, 'utf-8').equals(original))
        return { ok: false, error: exports.CODEX_ERRORS.notText };
    const result = withCodexBlock(text, command);
    if (!result.ok)
        return result;
    if (original && result.text === text)
        return { ok: true, changed: false };
    // Read back what would be written before writing it: it must hold exactly this block.
    const check = codexEntry(result.text);
    if (check.state !== 'block' || check.command !== command)
        return { ok: false, error: exports.CODEX_ERRORS.unreadable };
    const tmp = path.join(path.dirname(target), `.config.toml.openextract-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        let mode = 0o600;
        if (original) {
            fs.copyFileSync(configPath, path.join(path.dirname(configPath), exports.CODEX_BACKUP));
            mode = fs.statSync(target).mode & 0o777;
        }
        fs.writeFileSync(tmp, result.text, { encoding: 'utf-8', mode });
        try {
            fs.renameSync(tmp, target);
        }
        catch (err) {
            // Windows won't replace a file another program holds open; write it in place (the backup is made).
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(err?.code))
                throw err;
            fs.writeFileSync(target, result.text, 'utf-8');
            fs.rmSync(tmp, { force: true });
        }
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // nothing to tidy
        }
        return { ok: false, error: `OpenExtract couldn't change ChatGPT's settings file: ${err?.message ?? err}` };
    }
    return { ok: true, changed: true };
}
