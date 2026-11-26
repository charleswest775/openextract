/**
 * Ask AI: lets an AI app on this computer (Claude, ChatGPT, Claude Code) read the person's
 * backups through OpenExtract AI, an add-on. This file holds what the screen
 * (components/ai/AskAiScreen.tsx), the "New" note on Home and the header entry share:
 * the words, when they show, and the state the main process reports.
 *
 * Only builds made with OPENEXTRACT_AI_INDEX_URL have it (electron/askAi.ts). Everywhere
 * else the main process says { enabled: false } and none of it shows.
 *
 * The app holds no counting or key checks: the add-on does all of that, and the screen
 * only shows what the add-on says about itself (its --status).
 */

export type AiAppId = 'claude' | 'chatgpt' | 'claude-code';

/** The same shape as AskAiState in electron/askAi.ts. */
export type AskAiState =
  | { enabled: false }
  | {
    enabled: true;
    apps: AiAppId[];
    available: boolean;
    hidden: boolean;
    noteSeen: boolean;
    installed: { version: string } | null;
    claude: { connected: boolean } | null;
    chatgpt: { connected: boolean; current: boolean; settingsFile: string } | null;
    claudeCode: { command: string | null } | null;
  };

export type OnState = Extract<AskAiState, { enabled: true }>;

/** The add-on's `--status` (electron/aiAddon.ts parseStatus). */
export interface AddonStatus {
  version: string;
  key: { name: string; kind: string; until: string | null } | null;
  freeQuestions: number;
  freeQuestionsLeft: number;
}

export type AskAiResult = { ok: true; message?: string } | { ok: false; error: string };

export interface InstallProgress {
  step: 'index' | 'download' | 'verify' | 'unpack';
  received?: number;
  total?: number;
}

export const APP_NAMES: Record<AiAppId, string> = { claude: 'Claude', chatgpt: 'ChatGPT', 'claude-code': 'Claude Code' };
/** Who each app sends what it reads to. */
export const COMPANIES: Record<AiAppId, string> = { claude: 'Anthropic', chatgpt: 'OpenAI', 'claude-code': 'Anthropic' };

// The price and where keys come from, for this build. Each is one constant, so a later build
// ("3 questions free, then $29 once") changes them in one place.
export const PRICE_LINE = "3 questions free, then you'll need an access key.";
export const KEYS_LINE = 'OpenExtract AI is being tested with a few people right now, so keys come from Charles West, who makes OpenExtract.';
export const EXAMPLE_QUESTION = 'When did Sam and I first talk about moving to Denver?';

/** "Claude", "Claude and ChatGPT", "Claude, ChatGPT and Claude Code". */
export function listOf(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function appNames(apps: AiAppId[]): string {
  return listOf(apps.map(id => APP_NAMES[id]));
}

/** "Anthropic for Claude and Claude Code, OpenAI for ChatGPT": who gets what each app found reads. */
export function companiesLine(apps: AiAppId[]): string {
  const byCompany = new Map<string, string[]>();
  for (const id of apps) byCompany.set(COMPANIES[id], [...(byCompany.get(COMPANIES[id]) ?? []), APP_NAMES[id]]);
  return [...byCompany].map(([company, names]) => `${company} for ${listOf(names)}`).join(', ');
}

/** The header entry and the screen: only with an AI app found, a download for this computer, and not hidden. */
export function askAiShown(state: AskAiState | null | undefined): state is OnState {
  return !!state && state.enabled && state.available && state.apps.length > 0 && !state.hidden;
}

/** The one-time "New" note on Home: as the entry, until it's closed or Ask AI is opened. */
export function newNoteShown(state: AskAiState | null | undefined): boolean {
  return askAiShown(state) && !state.noteSeen;
}

/** Settings' "Show Ask AI" switch: wherever Ask AI could show, hidden or not. */
export function settingShown(state: AskAiState | null | undefined): state is OnState {
  return !!state && state.enabled && state.available && state.apps.length > 0;
}

/** "Sarah's key". */
export function keyLabel(name: string): string {
  return `Unlimited: ${name}'s key`;
}

/** What the add-on says about itself, in a line. */
export function statusLine(status: AddonStatus): string {
  if (status.key) return keyLabel(status.key.name);
  const { freeQuestions: total, freeQuestionsLeft: left } = status;
  if (left > 0) return `${left} of ${total} free ${total === 1 ? 'question' : 'questions'} left`;
  return `The ${total} free ${total === 1 ? 'question has' : 'questions have'} been used. To keep asking, you'll need an access key.`;
}

/** What an install is doing. */
export function progressLine(progress: InstallProgress | null | undefined): string {
  switch (progress?.step) {
    case 'download': {
      const { received = 0, total = 0 } = progress;
      if (!total) return 'Downloading OpenExtract AI…';
      const percent = Math.min(100, Math.floor((received / total) * 100));
      return `Downloading OpenExtract AI… ${percent}% of ${Math.max(1, Math.round(total / 1e6))} MB`;
    }
    case 'verify': return 'Checking the download…';
    case 'unpack': return 'Unpacking…';
    default: return 'Getting ready…';
  }
}

/** Each app's state, in a few words. */
export function appStateLine(id: AiAppId, state: OnState): string {
  switch (id) {
    case 'claude': return state.claude?.connected ? 'Connected' : 'Not installed';
    case 'chatgpt': return state.chatgpt?.connected ? 'Connected' : 'Not connected';
    case 'claude-code': return state.claudeCode?.command ? 'Paste this command into a terminal to connect it.' : 'Not installed';
  }
}

// ── Shared state: the header entry, the note, Settings and the screen see the same ─────────

type Listener = (state: AskAiState | null) => void;
let current: AskAiState | null = null;
let loading: Promise<AskAiState | null> | null = null;
const listeners = new Set<Listener>();

function publish(state: AskAiState | null) {
  current = state;
  for (const listener of listeners) listener(state);
}

export function askAiState(): AskAiState | null {
  return current;
}

/** Asks the main process again (it looks for AI apps only in builds that have Ask AI). */
export function refreshAskAi(): Promise<AskAiState | null> {
  const bridge = typeof window !== 'undefined' ? window.openextract?.askAi : undefined;
  if (!bridge?.state) return Promise.resolve(current);
  loading = bridge.state()
    .then(state => {
      publish(state);
      return state;
    })
    .catch(() => current)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The state now, asking for it the first time. Returns a function that stops listening. */
export function watchAskAi(listener: Listener): () => void {
  listeners.add(listener);
  if (!current && !loading) refreshAskAi();
  return () => {
    listeners.delete(listener);
  };
}

/** "Don't show this again" (true) or Settings' switch (false). */
export async function setAskAiHidden(hidden: boolean): Promise<void> {
  if (current?.enabled) publish({ ...current, hidden });
  await window.openextract?.askAi?.setHidden?.(hidden);
}

/** The note has done its job: closed, or Ask AI opened. */
export async function markNoteSeen(): Promise<void> {
  if (current?.enabled && !current.noteSeen) {
    publish({ ...current, noteSeen: true });
    await window.openextract?.askAi?.noteSeen?.();
  }
}

/** Forget what's known (tests). */
export function resetAskAi(): void {
  current = null;
  loading = null;
  listeners.clear();
}

// ── Opening the screen from the header or the note ──────────────────────────

const OPEN_EVENT = 'openextract:ask-ai';

export function openAskAi(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenAskAi(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}
