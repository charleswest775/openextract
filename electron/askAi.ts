import * as fs from 'fs';
import * as path from 'path';
import {
  type AiAppId, type Fetch, type InstallResult, type Look, type Run, type StatusRunner,
  addonHome, addonStatus, claudeCodeCommand, claudeHasAddon, codexConfigPath, codexEntry, connectCodex,
  detectAiApps, installAddon, platformKey, readCurrent, realLook,
} from './aiAddon';

/**
 * The Ask AI screen's side of the main process: what the window may ask for, and nothing
 * more. The window never names a path, a URL or a program; it can only say "install",
 * "connect Claude", "connect ChatGPT" (with the person's OK) and "hide this".
 *
 * Ask AI is off unless the build was made with OPENEXTRACT_AI_INDEX_URL (aiIndexUrl in
 * aiAddon.ts). Off, the handlers are still registered, so the window's bridge is the same
 * in every build, but each answers that it's off and touches nothing: no folder is
 * looked at, nothing is downloaded or run, and nothing is saved.
 */

interface Store {
  get(key: string, fallback?: any): any;
  set(key: string, value: any): void;
}

export interface AskAiOptions {
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => any): void };
  shell: { openPath(file: string): Promise<string> };
  store: Store;
  /** index.json, or null when Ask AI is off. */
  indexUrl: string | null;
  platform: string;
  arch: string;
  translated?: boolean;
  env: Record<string, string | undefined>;
  homedir: string;
  fetch: Fetch;
  // For tests: where to look and what to run instead of the real thing.
  look?: Look;
  systemApps?: string;
  run?: Run;
  statusRunner?: StatusRunner;
  stallMs?: number;
}

/** What every call answers in a build without Ask AI. */
export const ASK_AI_OFF = "Ask AI isn't part of this copy of OpenExtract.";

export type AskAiState =
  | { enabled: false }
  | {
    enabled: true;
    /** The AI apps found, in a fixed order. */
    apps: AiAppId[];
    /** There's a download for this computer. */
    available: boolean;
    /** "Don't show this again" (undone in Settings). */
    hidden: boolean;
    /** The "New" note on Home has been seen (closed, or Ask AI opened). */
    noteSeen: boolean;
    installed: { version: string } | null;
    claude: { connected: boolean } | null;
    /** `current`: the entry runs the installed program (not an older one). */
    chatgpt: { connected: boolean; current: boolean; settingsFile: string } | null;
    /** The command to paste, once the add-on is installed. */
    claudeCode: { command: string | null } | null;
  };

export type AskAiResult = { ok: true } | { ok: false; error: string };

/** A path as the person would recognise it: ~/.codex/config.toml on a Mac. */
function shown(file: string, homedir: string, platform: string): string {
  if (platform === 'win32' || !file.startsWith(homedir + path.sep)) return file;
  return `~${file.slice(homedir.length)}`;
}

export function registerAskAi(o: AskAiOptions): void {
  const { ipcMain } = o;
  const on = o.indexUrl !== null;
  const off: AskAiResult = { ok: false, error: ASK_AI_OFF };
  const look = o.look ?? realLook;
  const place = { platform: o.platform, env: o.env, homedir: o.homedir };
  const detect = () => detectAiApps({ ...place, look, systemApps: o.systemApps });

  // One install at a time; a second click while one runs waits for the same one.
  let installing: Promise<InstallResult> | null = null;
  function install(sender: any): Promise<InstallResult> {
    if (!installing) {
      installing = installAddon({
        ...place,
        indexUrl: o.indexUrl!,
        arch: o.arch,
        translated: o.translated,
        fetch: o.fetch,
        run: o.run,
        stallMs: o.stallMs,
        onProgress: progress => {
          try {
            sender?.send('ask-ai:progress', progress);
          } catch {
            // The window was closed; the install goes on.
          }
        },
      }).finally(() => {
        installing = null;
      });
    }
    return installing;
  }

  function state(): AskAiState {
    const apps = detect();
    const installed = readCurrent(addonHome(place), look);
    let chatgpt: Extract<AskAiState, { enabled: true }>['chatgpt'] = null;
    if (apps.includes('chatgpt')) {
      const file = codexConfigPath(place);
      let entry: ReturnType<typeof codexEntry> = { state: 'absent' };
      try {
        entry = codexEntry(fs.readFileSync(file, 'utf-8'));
      } catch {
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
      available: platformKey(o.platform, o.arch, o.translated) !== null,
      hidden: o.store.get('askAiHidden', false) === true,
      noteSeen: o.store.get('askAiNoteSeen', false) === true,
      installed: installed ? { version: installed.version } : null,
      claude: apps.includes('claude') ? { connected: claudeHasAddon(place, look) } : null,
      chatgpt,
      claudeCode: apps.includes('claude-code')
        ? { command: installed ? claudeCodeCommand(installed.command, o.platform) : null }
        : null,
    };
  }

  ipcMain.handle('ask-ai:state', (): AskAiState => (on ? state() : { enabled: false }));

  // The add-on's own count: free questions left, or whose key it has. Run with a time limit.
  ipcMain.handle('ask-ai:status', async () => {
    if (!on) return off;
    const installed = readCurrent(addonHome(place), look);
    if (!installed) return { ok: false, error: "OpenExtract AI isn't installed yet." };
    return addonStatus(installed.command, { runner: o.statusRunner });
  });

  ipcMain.handle('ask-ai:install', async (event: any): Promise<AskAiResult> => {
    if (!on) return off;
    const result = await install(event?.sender);
    return result.ok ? { ok: true } : result;
  });

  // Claude (desktop): open the .mcpb, which shows Claude's own Install dialog.
  ipcMain.handle('ask-ai:connect-claude', async (event: any): Promise<AskAiResult> => {
    if (!on) return off;
    if (!detect().includes('claude')) return { ok: false, error: "Claude isn't on this computer." };
    const result = await install(event?.sender);
    if (!result.ok) return result;
    const failed = await o.shell.openPath(result.mcpb);
    if (failed) {
      return { ok: false, error: `Claude didn't open OpenExtract AI. In Claude, open Settings, then Extensions, and install this file: ${result.mcpb}` };
    }
    return { ok: true };
  });

  // ChatGPT (desktop): only with the person's OK, given on the screen.
  ipcMain.handle('ask-ai:connect-chatgpt', async (event: any, consent: unknown): Promise<AskAiResult> => {
    if (!on) return off;
    if (consent !== true) return { ok: false, error: 'Nothing was changed.' };
    if (!detect().includes('chatgpt')) return { ok: false, error: "ChatGPT isn't on this computer." };
    const result = await install(event?.sender);
    if (!result.ok) return result;
    const connected = connectCodex(codexConfigPath(place), result.installed.command);
    return connected.ok ? { ok: true } : connected;
  });

  ipcMain.handle('ask-ai:set-hidden', (_event: any, hidden: unknown) => {
    if (on && typeof hidden === 'boolean') o.store.set('askAiHidden', hidden);
  });

  ipcMain.handle('ask-ai:note-seen', () => {
    if (on) o.store.set('askAiNoteSeen', true);
  });
}
