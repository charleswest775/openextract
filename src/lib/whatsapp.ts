/**
 * The WhatsApp screen's wording and small decisions, kept apart from the
 * components so they can be tested: what a chat is called and how its row
 * describes it, what a call or a reaction says, what kind of file an
 * attachment is and what to say when it isn't in the backup, how a file
 * copied out of the backup is handed to the computer, and which messages a
 * search finds, in the order the chat reads.
 *
 * Words match the engine's (ios-backup-core whatsapp.py) where both say the
 * same thing, so the screen and a saved chat agree.
 */
import type {
  WhatsAppAttachment, WhatsAppAttachmentResult, WhatsAppCall, WhatsAppEmptyReason, WhatsAppQuote, WhatsAppReaction,
  WhatsAppSearchHit,
} from '../types/whatsapp';
import type { TimelineEntry } from '../types/timeline';
import { haystack, matchesTerms, searchText, type Term } from './search';

// ── Chats ──────────────────────────────────────────────────────────────────

/** "Group", "Broadcast list" or "Channel"; '' for a chat with one person. */
export function chatTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'group': return 'Group';
    case 'broadcast': return 'Broadcast list';
    case 'channel': return 'Channel';
    default: return '';
  }
}

/** What a chat's row says after its message count: ["Group", "Archived"]. */
export function chatDetails(c: { chat_type?: string | null; archived?: boolean | null }): string[] {
  return [chatTypeLabel(c.chat_type), c.archived ? 'Archived' : ''].filter(Boolean);
}

/** A chat's name as people see it; never its WhatsApp address. */
export function chatName(c: { display_name?: string | null; handle?: string | null }): string {
  return c.display_name || c.handle || 'WhatsApp chat';
}

/**
 * What the chat list's search looks at: what the row shows (the name) and the
 * other person's number. Not the chat's address ("…@s.whatsapp.net", "…@g.us"),
 * which nobody sees: "what" or "us" would otherwise keep every chat.
 */
export function chatMatchFields(c: { display_name?: string | null; handle?: string | null }): (string | null | undefined)[] {
  return [c.display_name, c.handle];
}

// ── Calls ──────────────────────────────────────────────────────────────────

/** "45 s", "1:23", "1:02:03": how long a call or voice message lasted. */
export function durationText(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return `${m}:${String(rest).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** A call that didn't connect: shown in the error colour. */
export function isMissedCall(call: Pick<WhatsAppCall, 'outcome'>): boolean {
  return ['missed', 'declined', 'failed', 'no_answer'].includes(call.outcome);
}

/** "Missed video call", "Outgoing voice call", or "WhatsApp call" when the record doesn't say. */
export function callTitle(call: WhatsAppCall): string {
  const medium = call.is_video ? 'video' : 'voice';
  if (call.is_video == null && call.outcome === 'unknown') return 'WhatsApp call';
  switch (call.outcome) {
    case 'missed': return `Missed ${medium} call`;
    case 'declined': return `Declined ${medium} call`;
    case 'failed': return `Failed ${medium} call`;
    case 'no_answer': return `Unanswered ${medium} call`;
    case 'answered_elsewhere': return `${capital(medium)} call answered on another device`;
    case 'ongoing': return `${capital(medium)} call in progress when backed up`;
    default: return `${call.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} ${medium} call`;
  }
}

/** How long a connected call lasted, or '' when it didn't connect or nobody knows. */
export function callLength(call: WhatsAppCall): string {
  return !isMissedCall(call) && call.duration ? durationText(call.duration) : '';
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Reactions ──────────────────────────────────────────────────────────────

export interface ReactionGroup {
  emoji: string;
  /** Who reacted with it, "You" for the phone's owner, in the order they did. */
  names: string[];
  mine: boolean;
}

/** Reactions as chips: one per emoji, in the order each was first used. */
export function groupReactions(reactions: WhatsAppReaction[] | null | undefined): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    if (!r?.emoji) continue;
    const g = groups.get(r.emoji) ?? { emoji: r.emoji, names: [], mine: false };
    const name = r.is_from_me ? 'You' : r.sender || r.sender_handle || 'Someone';
    if (!g.names.includes(name)) g.names.push(name);
    g.mine ||= r.is_from_me;
    groups.set(r.emoji, g);
  }
  return [...groups.values()];
}

// ── Attachments ────────────────────────────────────────────────────────────

export type AttachmentKind = 'image' | 'sticker' | 'gif' | 'video' | 'voice' | 'audio' | 'document';

const EXT = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff'];
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', '3gp', 'avi', 'mkv', 'webm'];
const AUDIO_EXTS = ['opus', 'ogg', 'oga', 'm4a', 'mp3', 'aac', 'wav', 'amr', 'caf'];

type AttachmentLike = Pick<WhatsAppAttachment, 'mime_type' | 'transfer_name' | 'filename'>;

/** What kind of file an attachment is, from its type and name, and the message it came with. */
export function attachmentKind(a: AttachmentLike, messageType?: string | null): AttachmentKind {
  const mime = (a.mime_type || '').toLowerCase();
  const ext = EXT(a.filename || '') || EXT(a.transfer_name || '');
  if (messageType === 'sticker') return 'sticker';
  if (messageType === 'gif') return 'gif';
  if (messageType === 'document') return 'document';
  const major = mime.split('/')[0];
  if (major === 'image' || (!mime && IMAGE_EXTS.includes(ext))) return 'image';
  if (major === 'video' || (!mime && VIDEO_EXTS.includes(ext))) return 'video';
  if (major === 'audio' || (!mime && AUDIO_EXTS.includes(ext))) {
    // WhatsApp records voice messages as Opus in Ogg; other sound files are just audio
    return ext === 'opus' || mime === 'audio/ogg' ? 'voice' : 'audio';
  }
  if (!mime && !ext) {
    if (messageType === 'image') return 'image';
    if (messageType === 'video') return 'video';
    if (messageType === 'audio') return 'audio';
  }
  return 'document';
}

const KIND_LABELS: Record<AttachmentKind, string> = {
  image: 'Photo', sticker: 'Sticker', gif: 'GIF', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document',
};

/** "Photo", "Voice message", ... */
export function kindLabel(kind: AttachmentKind): string {
  return KIND_LABELS[kind];
}

// The labels the engine gives a file it has no name for (ios-backup-core _MEDIA_LABELS)
const ENGINE_LABELS = [
  'Photo', 'Video', 'Audio', 'Document', 'GIF', 'Sticker', 'Attachment',
  'View-once photo', 'View-once video', 'View-once voice message', 'Video message',
];

/**
 * What a bubble says for a file that isn't in the backup: "Photo not in this
 * backup", or the engine's own label for it ("Video message not in this backup").
 */
export function missingText(kind: AttachmentKind, transferName?: string | null): string {
  const label = transferName && ENGINE_LABELS.includes(transferName) && transferName !== 'Attachment'
    ? transferName : KIND_LABELS[kind];
  return `${label} not in this backup`;
}

// Characters that don't show but change how a name reads: direction overrides and
// isolates (U+202A-U+202E, U+2066-U+2069), direction marks, zero-width spaces and
// joiners. "Invoice<U+202E>fdp.exe" displays as "Invoiceexe.pdf" and would pose as a PDF.
const INVISIBLE = /[؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** A file name as it should be shown: without the invisible characters that can disguise it. */
export function cleanFileName(name: string | null | undefined): string {
  return (name ?? '').replace(INVISIBLE, '').trim();
}

/** A file's own name, when it has one (not just a label like "Document"), cleaned for showing. */
export function documentName(a: Pick<WhatsAppAttachment, 'transfer_name' | 'filename'>): string {
  const name = cleanFileName(a.transfer_name || (a.filename ? a.filename.split('/').pop() ?? '' : ''));
  return ENGINE_LABELS.includes(name) ? '' : name;
}

/**
 * A shown name split so its extension can stay in view when the rest is cut
 * short: "Quarterly report.pdf" → { stem: "Quarterly report", ext: ".pdf" }.
 */
export function splitExtension(name: string): { stem: string; ext: string } {
  const m = /^(.+?)(\.[A-Za-z0-9]{1,10})$/.exec(name);
  return m ? { stem: m[1], ext: m[2] } : { stem: name, ext: '' };
}

/** What kind of file a name says it is, by its real extension: "PDF file", "EXE file", or "File". */
export function fileTypeLabel(name: string): string {
  const { ext } = splitExtension(cleanFileName(name));
  return ext ? `${ext.slice(1).toUpperCase()} file` : 'File';
}

/** What happened when a file was handed to the computer. */
export const SHOWN_IN_FOLDER = "OpenExtract doesn't open this kind of file itself, so it's shown in its folder.";

/** The two things the app can do with a copied file (window.openextract's openPath and showInFolder). */
export interface FileHandler {
  openPath: (path: string) => Promise<string>;
  showInFolder: (path: string) => Promise<void>;
}

/**
 * Hand a file copied out of the backup (get_whatsapp_attachment with as_file)
 * to the computer. Only a file the engine says is safe to open (a photo,
 * video, sound or document) is opened; anything else, a program or a script
 * whatever the sender named it, is shown in its folder instead, because
 * opening a program runs it. Resolves to what to tell the person, or null.
 */
export async function handOver(r: WhatsAppAttachmentResult | null | undefined, files: FileHandler): Promise<string | null> {
  if (r?.empty_reason === 'not_in_backup') return "This file isn't in the backup";
  if (r?.error) return r.error;
  if (!r?.path) return "Couldn't copy the file out of the backup";
  if (r.openable !== true) {
    await files.showInFolder(r.path);
    return SHOWN_IN_FOLDER;
  }
  const problem = await files.openPath(r.path);
  return problem ? `Couldn't open it: ${problem}` : null;
}

/**
 * Whether the app can play this sound itself. Chromium plays Ogg, MP3, AAC and
 * WAV, but not Apple's CAF or AMR; those open in another app.
 */
export function playsInApp(a: AttachmentLike): boolean {
  const ext = EXT(a.filename || '') || EXT(a.transfer_name || '');
  const mime = (a.mime_type || '').toLowerCase();
  return !['caf', 'amr'].includes(ext) && !['audio/x-caf', 'audio/amr'].includes(mime);
}

/** The size to draw a picture at, no bigger than maxW × maxH, keeping its shape; null when its size isn't known. */
export function fitBox(
  width: number | null | undefined, height: number | null | undefined, maxW: number, maxH: number,
): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0 || !isFinite(width) || !isFinite(height)) return null;
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "820 KB", "2.4 MB"; '' when unknown. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0 || !isFinite(n)) return '';
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ── Locations and contact cards ────────────────────────────────────────────

/** "45.52310° N, 122.67650° W"; '' when there are no coordinates. */
export function formatCoordinates(lat: number | null | undefined, lon: number | null | undefined): string {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return '';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lon).toFixed(5)}° ${ew}`;
}

/** The name and phone numbers on a vCard, as far as it can be read. */
export function readVcard(vcard: string | null | undefined): { name: string; phones: string[] } {
  if (!vcard) return { name: '', phones: [] };
  // Folded lines continue with a space or tab (RFC 6350 3.2)
  const lines = vcard.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const value = (line: string) => line.slice(line.indexOf(':') + 1)
    .replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  let name = '', fromN = '';
  const phones: string[] = [];
  for (const line of lines) {
    const key = line.slice(0, line.indexOf(':')).split(';')[0].toUpperCase().replace(/^ITEM\d+\./, '');
    if (key === 'FN' && !name) name = value(line);
    else if (key === 'N' && !fromN) {
      const [last, first] = value(line).split(';');
      fromN = [first, last].filter(Boolean).join(' ').trim();
    } else if (key === 'TEL') {
      const tel = value(line);
      if (tel && !phones.includes(tel)) phones.push(tel);
    }
  }
  return { name: name || fromN, phones };
}

// ── Replies ────────────────────────────────────────────────────────────────

const QUOTE_LABELS: Record<string, string> = {
  image: 'Photo', video: 'Video', audio: 'Voice message', document: 'Document', contact: 'Contact card',
  shared_location: 'Location', live_location: 'Live location', link: 'Link', sticker: 'Sticker', gif: 'GIF',
};

/** What a reply quotes: its text, or what it was ("Photo") when it had none. */
export function quoteText(q: Pick<WhatsAppQuote, 'text' | 'message_type'>): string {
  return q.text?.trim() || QUOTE_LABELS[q.message_type] || 'Message';
}

/** Who wrote the quoted message. */
export function quoteSender(q: Pick<WhatsAppQuote, 'is_from_me' | 'sender'>): string {
  return q.is_from_me ? 'You' : q.sender || 'Someone';
}

// ── Empty states ───────────────────────────────────────────────────────────

export interface EmptyCopy {
  /** 'error' and 'unsupported' get a Report button; 'empty' is calm. */
  kind: 'error' | 'unsupported' | 'empty';
  title: string;
  detail?: string;
}

/**
 * What the WhatsApp screen says when it has no chats, from the engine's answer.
 * Not having WhatsApp is normal and calm; a store that can't be read says so.
 */
export function emptyCopy(emptyReason: WhatsAppEmptyReason | string | null | undefined, error: string | null | undefined): EmptyCopy {
  if (emptyReason === 'unsupported_format') {
    return {
      kind: 'unsupported',
      title: "This version of WhatsApp can't be read yet",
      detail: error || "Its chats are in the backup, but stored in a way OpenExtract doesn't know yet.",
    };
  }
  if (error && emptyReason !== 'not_in_backup' && emptyReason !== 'no_records') {
    return { kind: 'error', title: "Couldn't read the WhatsApp chats", detail: error };
  }
  if (emptyReason === 'no_records') {
    return { kind: 'empty', title: 'No WhatsApp chats in this backup', detail: 'WhatsApp is on this iPhone, but it has no chats with messages.' };
  }
  return {
    kind: 'empty',
    title: 'No WhatsApp chats in this backup',
    detail: emptyReason === 'not_in_backup' ? "WhatsApp wasn't on this iPhone, or its chats weren't in the backup." : undefined,
  };
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * WhatsApp messages the search matches, per chat, in the order the chat reads,
 * so Earlier and Later step through them as they appear on screen even when
 * the dates disagree.
 *
 * A message matches on everything the whole-backup search matches it on (the
 * same searchText: its text, what happened, its file's name, the chat's name,
 * who sent it in a group, and what kind of message it was), so a result opened
 * from there is a match here too, in the chat it came from.
 */
export function whatsappHits(entries: TimelineEntry[], terms: Term[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (terms.length === 0) return out;
  const by = new Map<number, ReadingPlace[]>();
  for (const e of entries) {
    const w = e.whatsapp;
    if (e.type !== 'whatsapp' || !w || w.chatId == null) continue;
    if (!matchesTerms(searchText(e), terms)) continue;
    const id = Number(e.id.slice('whatsapp:'.length));
    if (!Number.isFinite(id)) continue;
    const list = by.get(w.chatId) ?? [];
    list.push({ id, sort: typeof w.sort === 'number' ? w.sort : null });
    by.set(w.chatId, list);
  }
  for (const [chat, list] of by) out.set(chat, list.sort(byReadingOrder).map(h => h.id));
  return out;
}

interface ReadingPlace { id: number; sort: number | null }

/**
 * The order a chat reads in, as the engine pages it (sort, then id): messages
 * with no arrival order sit at the very top, so they come first, then by sort,
 * and messages that arrived together by id.
 */
function byReadingOrder(a: ReadingPlace, b: ReadingPlace): number {
  if (a.sort === null || b.sort === null) {
    if (a.sort !== b.sort) return a.sort === null ? -1 : 1;
    return a.id - b.id;
  }
  return a.sort - b.sort || a.id - b.id;
}

/**
 * What to ask the engine's search_whatsapp_messages for: it finds one piece
 * of text as written, so send the longest word (or phrase in quotes) and check
 * the rest here. '' when there's nothing to look for.
 */
export function engineSearchText(query: string): string {
  let best = '';
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const piece = (m[2] ?? m[1] ?? '').trim();
    if (piece.length > best.length) best = piece;
  }
  return best;
}

/**
 * The search's hits per chat when the shared index couldn't hold every
 * WhatsApp message: the index's (in reading order) plus what the engine found
 * in the messages the index doesn't have. The engine only matches text, so its
 * results are checked against every word of the search, on their text, the
 * chat's name and who sent them.
 *
 * The engine doesn't say where a message sits in its chat, only its date. The
 * index reads each chat newest first and stopped partway, so what it lacks is
 * older than what it has: those hits go first, oldest first by date.
 */
export function mergeSearchHits(
  indexHits: Map<number, number[]>, results: WhatsAppSearchHit[] | null | undefined, terms: Term[],
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [chat, ids] of indexHits) out.set(chat, [...ids]);
  if (terms.length === 0) return out;
  const extra = new Map<number, { id: number; date: string }[]>();
  for (const r of results ?? []) {
    if (r == null || !Number.isFinite(r.message_id) || !Number.isFinite(r.chat_id)) continue;
    if (out.get(r.chat_id)?.includes(r.message_id)) continue;
    if (!matchesTerms(haystack([r.text, r.chat_name, r.is_from_me ? null : r.sender]), terms)) continue;
    const list = extra.get(r.chat_id) ?? [];
    if (list.some(x => x.id === r.message_id)) continue;
    list.push({ id: r.message_id, date: r.date ?? '' });
    extra.set(r.chat_id, list);
  }
  for (const [chat, list] of extra) {
    // ISO dates compare as text; no date first, as the engine lists them
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    out.set(chat, [...list.map(x => x.id), ...(out.get(chat) ?? [])]);
  }
  return out;
}
