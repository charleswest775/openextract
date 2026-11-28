/**
 * Ask AI: lets an AI app on this computer (Claude, ChatGPT, Claude Code) read the person's
 * backups through OpenExtract AI, an add-on. This file holds what the screen
 * (components/ai/AskAiScreen.tsx), the "New" note on Home and the header entry share:
 * the words, when they show, and the state the main process reports.
 *
 * Mac and Windows releases carry the add-on (ai-addon.json, scripts/ai-addon-pin.mjs), so Install needs
 * no download; a build made with OPENEXTRACT_AI_INDEX_URL downloads it instead (electron/askAi.ts).
 * Everywhere else (Linux, a developer's build) the main process says { enabled: false } and none of it shows.
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
    /** This copy of OpenExtract carries a newer add-on than the one installed. */
    update: { version: string } | null;
    /** `outdated`: Claude has an older version than this copy of OpenExtract carries. */
    claude: { connected: boolean; version: string | null; outdated: boolean } | null;
    chatgpt: { connected: boolean; current: boolean; settingsFile: string } | null;
    claudeCode: { command: string | null } | null;
    /** macOS, and the open (or last opened) backup is in Finder's backup folder. */
    fullDiskAccess: boolean;
    /** 'unrestricted': this app carries the friends-and-family edition (no limit, no keys). */
    edition: 'unrestricted' | null;
  };

export type OnState = Extract<AskAiState, { enabled: true }>;

/** The add-on's `--status` (electron/aiAddon.ts parseStatus). */
export interface AddonKey {
  name: string;
  kind: string;
  until: string | null;
  phone: string | null;
}

export interface AddonStatus {
  version: string;
  key: AddonKey | null;
  keys: AddonKey[];
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

// The price and where keys come from (the add-on counts and checks keys; the store is
// openextract.app/ai/buy). Each is one constant, so a price change is one place here and the
// site's /ai and /ai/buy pages.
export const PRICE_LINE = '3 questions free. After that, a key for each iPhone: $29 for good, or $9 for a week.';
export const KEYS_LINE = 'When the free questions run out, the AI gives you a link to buy a key for the iPhone you asked about. '
  + 'OpenExtract itself stays free, with no limits.';
export const EXAMPLE_QUESTION = 'When did Sam and I first talk about moving to Denver?';

/** "What you can ask": one line each, in the person's own words. */
export const EXAMPLES: { what: string; ask: string }[] = [
  { what: 'Find something someone sent you', ask: 'What was the gate code Dana texted me last summer?' },
  { what: 'Look back on a friendship', ask: 'How have Theo and I kept in touch since 2024?' },
  { what: 'Hear from someone again', ask: 'Find the voicemails Mom left me, and what she said in them.' },
  { what: 'See a day again', ask: 'Show me the photos from the day Leo learned to ride his bike.' },
  { what: 'Keep track of what was said', ask: 'What did I tell people I would do in March?' },
  { what: 'Sum up a year', ask: 'Make me a year in review for 2025, from my messages, calls and photos.' },
];

/** What it reads, for the screen's first paragraph. */
export const READS_LINE = 'messages, WhatsApp, calls, voicemail, contacts, notes, calendar and photos';

/** After connecting: how to ask, said the same way on the screen and the site's guide. */
export function howToSteps(apps: AiAppId[]): string[] {
  const chats = apps.filter(id => id !== 'claude-code').map(id => APP_NAMES[id]);
  const open = chats.length
    ? `Open ${chats.length > 1 ? `${chats.slice(0, -1).join(', ')} or ${chats[chats.length - 1]}` : chats[0]} and start a new chat`
      + (apps.includes('claude-code') ? ' (or a new Claude Code session).' : '.')
    : 'Start a new Claude Code session.';
  return [
    open,
    'Ask in your own words. The AI looks things up in your backup and says what it found, '
      + 'pointing to the messages, calls and notes it used, so you can check them.',
    'It reads the backup you last opened in OpenExtract. To ask about another one, open it here first, '
      + 'or ask the AI which backups it can see.',
    'Answers come from what the backup holds. If the AI can\'t find something, ask it to look again with other words.',
  ];
}

/** Pages on openextract.app the screen links to (the browser opens them). */
export const AI_PAGE_URL = 'https://www.openextract.app/ai';
export const AI_GUIDE_URL = 'https://www.openextract.app/use-cases/ask-claude-about-your-iphone-backup';
export const AI_BUY_URL = 'https://www.openextract.app/ai/buy';

// Said after PRICE_LINE and KEYS_LINE by a copy carrying the unrestricted edition: the person sees how
// OpenExtract AI will be sold, and that theirs needs none of it.
export const UNRESTRICTED_LINE = "Your copy is the friends-and-family edition: your questions are unlimited and you won't need a key.";
export const UNRESTRICTED_STATUS = 'Unlimited questions: the friends-and-family edition';
/** The same, shorter, after PRICE_LINE in the "New" note on Home. */
export const UNRESTRICTED_NOTE = 'Your copy is the friends-and-family edition, with no limit and no key.';

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

/** "December 4" (a key's last day, a local date as the add-on writes it). */
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/** One key, in a line: which iPhone it's for, and until when. */
export function keyLine(key: AddonKey): string {
  if (key.kind === 'unrestricted') return UNRESTRICTED_STATUS;
  if (!key.phone) return keyLabel(key.name);
  const which = `the iPhone with phone code ${key.phone}`;
  return key.until ? `Unlimited questions about ${which}, through ${dayLabel(key.until)}` : `Unlimited questions about ${which}`;
}

function freeLine(total: number, left: number): string {
  if (left > 0) return `${left} of ${total} free ${total === 1 ? 'question' : 'questions'} left`;
  return `The ${total} free ${total === 1 ? 'question has' : 'questions have'} been used. To keep asking about an iPhone, you'll need a key for it.`;
}

/** What the add-on says about itself, a line each: its keys, then the free questions other iPhones have. */
export function statusLines(status: AddonStatus): string[] {
  const keys = status.keys.length ? status.keys : status.key ? [status.key] : [];
  const lines = keys.map(keyLine);
  // A key for any iPhone (friends', the unrestricted edition) leaves nothing counted.
  if (keys.some(k => !k.phone)) return lines;
  const free = freeLine(status.freeQuestions, status.freeQuestionsLeft);
  return keys.length ? [...lines, `Other iPhones: ${free.charAt(0).toLowerCase()}${free.slice(1)}`] : [free];
}

/** The first of statusLines (the Home note and tests). */
export function statusLine(status: AddonStatus): string {
  return statusLines(status)[0];
}

/** No key for any iPhone and no free questions left: the screen offers to buy one. */
export function needsKey(status: AddonStatus | null): boolean {
  return !!status && status.freeQuestionsLeft === 0 && !(status.keys.length ? status.keys : status.key ? [status.key] : []).some(k => !k.phone);
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

/**
 * The Full Disk Access step on Claude's and ChatGPT's cards, on a Mac when the backup is in Finder's
 * backup folder (FRIENDS-BUILD.md section 3). macOS asks it of the app the add-on runs inside.
 */
export function fullDiskAccessStep(id: AiAppId, state: OnState): { title: string; text: string } | null {
  if (!state.fullDiskAccess || (id !== 'claude' && id !== 'chatgpt')) return null;
  const app = APP_NAMES[id];
  return {
    title: `${app} needs Full Disk Access to read backups in Finder's backup folder.`,
    text: `This lets ${app} read any file on this Mac. In Settings, turn on ${app} under Full Disk Access, `
      + `then quit ${app} and open it again. If it's already on, there's nothing to do.`,
  };
}

/** Each app's state, in a few words. */
export function appStateLine(id: AiAppId, state: OnState): string {
  switch (id) {
    case 'claude':
      if (!state.claude?.connected) return 'Not installed';
      return state.claude.outdated && state.claude.version ? `Connected, with an older version (${state.claude.version})` : 'Connected';
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
