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
exports.FULL_DISK_ACCESS_URL = exports.WINDOWS_CLAUDE_STEPS = exports.ASK_AI_OFF = void 0;
exports.registerAskAi = registerAskAi;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const aiAddon_1 = require("./aiAddon");
/** What every call answers in a build without Ask AI. */
exports.ASK_AI_OFF = "Ask AI isn't part of this copy of OpenExtract.";
/** Claude for Windows doesn't open .mcpb files (its package declares no file types), so the file is
 * shown in its folder and the screen says where it goes in Claude. Checked on a real PC 2026-11-25. */
exports.WINDOWS_CLAUDE_STEPS = "In Claude, open Settings, then Extensions. Click Advanced settings, then "
    + "Install Extension, and choose the file that's selected in the folder that just opened.";
/** System Settings > Privacy & Security > Full Disk Access. The only address ask-ai:open-full-disk-access opens. */
exports.FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
/** A path as the person would recognise it: ~/.codex/config.toml on a Mac. */
function shown(file, homedir, platform) {
    if (platform === 'win32' || !file.startsWith(homedir + path.sep))
        return file;
    return `~${file.slice(homedir.length)}`;
}
function registerAskAi(o) {
    const { ipcMain } = o;
    const bundled = o.bundled ?? null;
    const on = o.indexUrl !== null || bundled !== null;
    const edition = bundled?.edition ?? null;
    const off = { ok: false, error: exports.ASK_AI_OFF };
    const look = o.look ?? aiAddon_1.realLook;
    const place = { platform: o.platform, env: o.env, homedir: o.homedir };
    const detect = () => (0, aiAddon_1.detectAiApps)({ ...place, look, systemApps: o.systemApps, macBinDirs: o.macBinDirs });
    // ── backups.json ──
    // The backup opened in this run, and the backups the engine listed in it. Earlier runs' backups
    // come from the recent list (the store's sessions), which holds each one's folder.
    let openedDir = null;
    const found = [];
    function recentDirs() {
        const sessions = o.store.get('sessions', []);
        if (!Array.isArray(sessions))
            return [];
        return sessions
            .filter((s) => s && typeof s.backupDir === 'string')
            .sort((a, b) => (Date.parse(b.lastOpened) || 0) - (Date.parse(a.lastOpened) || 0))
            .map((s) => s.backupDir);
    }
    /** The backup open now, or else the last one opened (the newest in the recent list). */
    function openOrLast() {
        return openedDir ?? recentDirs()[0] ?? null;
    }
    function writeBackups() {
        try {
            (0, aiAddon_1.writeBackupsFile)((0, aiAddon_1.addonHome)(place), (0, aiAddon_1.backupsFile)(openOrLast(), [...found, ...recentDirs()], o.platform));
        }
        catch (err) {
            // Opening a backup or installing never fails over it; the add-on still has the usual folders.
            console.error('[ask-ai] backups.json not written:', err);
        }
    }
    // One install at a time; a second click while one runs waits for the same one.
    let installing = null;
    function install(sender) {
        if (!installing) {
            installing = (0, aiAddon_1.installAddon)({
                ...place,
                indexUrl: o.indexUrl,
                bundled,
                arch: o.arch,
                translated: o.translated,
                fetch: o.fetch,
                run: o.run,
                stallMs: o.stallMs,
                onProgress: progress => {
                    try {
                        sender?.send('ask-ai:progress', progress);
                    }
                    catch {
                        // The window was closed; the install goes on.
                    }
                },
            }).then(result => {
                if (result.ok)
                    writeBackups();
                return result;
            }).finally(() => {
                installing = null;
            });
        }
        return installing;
    }
    function claudeState() {
        const connected = (0, aiAddon_1.claudeHasAddon)(place, look, edition);
        const version = connected ? (0, aiAddon_1.claudeAddonVersion)(place, look, edition) : null;
        return { connected, version, outdated: !!bundled && version !== null && (0, aiAddon_1.newerVersion)(bundled.version, version) };
    }
    function state() {
        const apps = detect();
        const installed = (0, aiAddon_1.readCurrent)((0, aiAddon_1.addonHome)(place), look);
        let chatgpt = null;
        if (apps.includes('chatgpt')) {
            const file = (0, aiAddon_1.codexConfigPath)(place);
            let entry = { state: 'absent' };
            try {
                entry = (0, aiAddon_1.codexEntry)(fs.readFileSync(file, 'utf-8'));
            }
            catch {
                // No settings file yet: not connected.
            }
            chatgpt = {
                connected: entry.state === 'block',
                current: entry.state === 'block' && !!installed && entry.command === installed.command,
                settingsFile: shown(file, o.homedir, o.platform),
            };
        }
        return {
            enabled: true,
            apps,
            available: bundled ? (0, aiAddon_1.platformKey)(o.platform, o.arch, o.translated) === bundled.platform
                : (0, aiAddon_1.platformKey)(o.platform, o.arch, o.translated) !== null,
            hidden: o.store.get('askAiHidden', false) === true,
            noteSeen: o.store.get('askAiNoteSeen', false) === true,
            installed: installed ? { version: installed.version } : null,
            update: bundled && installed && (0, aiAddon_1.newerVersion)(bundled.version, installed.version) ? { version: bundled.version } : null,
            claude: apps.includes('claude') ? claudeState() : null,
            chatgpt,
            claudeCode: apps.includes('claude-code')
                ? { command: installed ? (0, aiAddon_1.claudeCodeCommand)(installed.command, o.platform) : null }
                : null,
            fullDiskAccess: o.platform === 'darwin' && (0, aiAddon_1.inMobileSync)(openOrLast(), o.homedir),
            edition,
        };
    }
    ipcMain.handle('ask-ai:state', () => (on ? state() : { enabled: false }));
    // The add-on's own count: free questions left, or whose key it has. Run with a time limit.
    ipcMain.handle('ask-ai:status', async () => {
        if (!on)
            return off;
        const installed = (0, aiAddon_1.readCurrent)((0, aiAddon_1.addonHome)(place), look);
        if (!installed)
            return { ok: false, error: "OpenExtract AI isn't installed yet." };
        return (0, aiAddon_1.addonStatus)(installed.command, { runner: o.statusRunner });
    });
    ipcMain.handle('ask-ai:install', async (event) => {
        if (!on)
            return off;
        const result = await install(event?.sender);
        return result.ok ? { ok: true } : result;
    });
    // Claude (desktop): open the .mcpb, which shows Claude's own Install dialog.
    ipcMain.handle('ask-ai:connect-claude', async (event) => {
        if (!on)
            return off;
        if (!detect().includes('claude'))
            return { ok: false, error: "Claude isn't on this computer." };
        const result = await install(event?.sender);
        if (!result.ok)
            return result;
        if (o.platform === 'win32') {
            o.shell.showItemInFolder?.(result.mcpb);
            return { ok: true, message: exports.WINDOWS_CLAUDE_STEPS };
        }
        const failed = await o.shell.openPath(result.mcpb);
        if (failed) {
            return { ok: false, error: `Claude didn't open OpenExtract AI. In Claude, open Settings, then Extensions, and install this file: ${result.mcpb}` };
        }
        return { ok: true };
    });
    // ChatGPT (desktop): only with the person's OK, given on the screen.
    ipcMain.handle('ask-ai:connect-chatgpt', async (event, consent) => {
        if (!on)
            return off;
        if (consent !== true)
            return { ok: false, error: 'Nothing was changed.' };
        if (!detect().includes('chatgpt'))
            return { ok: false, error: "ChatGPT isn't on this computer." };
        const result = await install(event?.sender);
        if (!result.ok)
            return result;
        const connected = (0, aiAddon_1.connectCodex)((0, aiAddon_1.codexConfigPath)(place), result.installed.command);
        return connected.ok ? { ok: true } : connected;
    });
    ipcMain.handle('ask-ai:set-hidden', (_event, hidden) => {
        if (on && typeof hidden === 'boolean')
            o.store.set('askAiHidden', hidden);
    });
    ipcMain.handle('ask-ai:note-seen', () => {
        if (on)
            o.store.set('askAiNoteSeen', true);
    });
    // "Open Settings" on the Full Disk Access step: this one fixed address, on a Mac, never one from the window.
    ipcMain.handle('ask-ai:open-full-disk-access', async () => {
        if (!on)
            return off;
        if (o.platform !== 'darwin')
            return { ok: false, error: 'Full Disk Access is a Mac setting.' };
        await o.shell.openExternal(exports.FULL_DISK_ACCESS_URL);
        return { ok: true };
    });
    return {
        backupOpened(backupDir) {
            if (!on || typeof backupDir !== 'string' || !path.isAbsolute(backupDir))
                return;
            openedDir = backupDir;
            if ((0, aiAddon_1.addonInstalled)((0, aiAddon_1.addonHome)(place)))
                writeBackups();
        },
        backupsFound(backupDirs) {
            if (!on || !Array.isArray(backupDirs))
                return;
            for (const dir of backupDirs) {
                if (typeof dir === 'string' && path.isAbsolute(dir) && !found.includes(dir))
                    found.push(dir);
            }
        },
    };
}
