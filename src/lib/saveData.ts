/**
 * Shared pieces of "Save to this computer": writing text files the renderer builds,
 * and the file formats more than one screen produces.
 *
 * Every PDF is printed by Chromium (electron/pdfExport.ts): an engine save asks for its
 * print-ready page through exportMessagesPdf, a page built here goes through exportHtmlPdf.
 */
import { exportHtmlPdf, exportMessagesPdf, saveFolder, sidecarCall, type PdfExportMethod, type PdfSplit } from './ipc';
import { chatName } from './whatsapp';
import { voiceMemoSaveDetail } from './voiceMemos';
import { calendarSaveDetail } from './calendar';
import { CSV_BOM, formatTimeline, FORMAT_FILTERS, type ExportFormat } from './timelineExport';
import type { TimelineEntry } from '../types/timeline';
import type { PodcastExportResult, PodcastSaveFormat } from '../types/podcasts';
import type { VoiceMemoExportResult, VoiceMemoSaveFormat } from '../types/voiceMemos';
import type { CalendarExportResult, CalendarSaveFormat } from '../types/calendar';

/** What a finished save reports in its notice. */
export interface SaveResult {
  title: string;
  detail?: string;
  /** The file or folder written, for "Show in folder". */
  path?: string;
  /** Something the person should read, such as why a PDF became several; keeps the notice up until dismissed. */
  note?: string;
}

/**
 * Engine export methods report some failures in their result instead of throwing:
 * { success: false, error }, { status: 'error', message }, a bare { error }, or
 * { error, empty_reason } when there was nothing to save (WhatsApp not in the backup).
 */
export function checkEngineResult<T>(result: T): T {
  const r = result as any;
  const failed = r && (r.success === false || r.status === 'error'
    || (r.error && (Object.keys(r).length === 1 || r.empty_reason)));
  if (failed) throw new Error(r.error || r.message || 'The export did not finish.');
  return result;
}

/** Ask where to save, then write `content` there. Resolves to the path, or null if cancelled. */
export async function saveTextFile(options: {
  title: string;
  defaultName: string;
  filter: { name: string; extensions: string[] };
  content: string | (() => Promise<string> | string);
}): Promise<string | null> {
  const filePath = await window.openextract.saveFile({
    title: options.title,
    defaultPath: options.defaultName,
    filters: [options.filter],
  });
  if (!filePath) return null;
  const content = typeof options.content === 'function' ? await options.content() : options.content;
  await window.openextract.writeFile(filePath, content);
  return filePath;
}

export function csvEscape(value: string): string {
  const escaped = (value ?? '').replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
  return `"${escaped}"`;
}

/** "1 contact", "45 contacts" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ── Contacts ───────────────────────────────────────────────────────────────────

export interface ContactRecord {
  first_name: string;
  last_name: string;
  display_name: string;
  organization: string;
  phones: string[];
  emails: string[];
  note: string;
}

/** The address book as a spreadsheet, with a byte-order mark so Excel reads it as UTF-8 (as every CSV the app saves). */
export function contactsToCsv(contacts: ContactRecord[]): string {
  const rows = ['"First Name","Last Name","Display Name","Organization","Phone Numbers","Email Addresses","Notes"'];
  for (const c of contacts) {
    rows.push([
      c.first_name, c.last_name, c.display_name, c.organization,
      (c.phones || []).join('; '), (c.emails || []).join('; '), c.note,
    ].map(v => csvEscape(v || '')).join(','));
  }
  return CSV_BOM + rows.join('\n');
}

// vCard 3.0 text values escape backslash, comma, semicolon and newline.
function vcardText(value: string): string {
  return (value || '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r?\n/g, '\\n');
}

/** One .vcf holding every contact; Contacts, Outlook and Google Contacts all import it. */
export function contactsToVcard(contacts: ContactRecord[]): string {
  return contacts.map(c => {
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:${vcardText(c.last_name)};${vcardText(c.first_name)};;;`,
      `FN:${vcardText(c.display_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.organization)}`,
    ];
    if (c.organization) lines.push(`ORG:${vcardText(c.organization)}`);
    for (const p of c.phones || []) lines.push(`TEL;TYPE=VOICE:${vcardText(p)}`);
    for (const e of c.emails || []) lines.push(`EMAIL;TYPE=INTERNET:${vcardText(e)}`);
    if (c.note) lines.push(`NOTE:${vcardText(c.note)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }).join('\r\n') + '\r\n';
}

// ── Records: notes, calls, web history, recovered messages ─────────────────────

/** The core formats, in the order every Save dialog lists them (RECORD_FORMATS in SaveDialog.tsx). */
export type RecordFormat = 'pdf' | 'html' | 'csv' | 'txt';
/** Notes have no spreadsheet. */
export type NotesFormat = 'pdf' | 'html' | 'txt';

/**
 * Run an engine save in `format`: a PDF through Chromium (the engine writes the
 * print-ready page), anything else straight from the engine. Failures the engine
 * reports in its result are thrown.
 */
async function exportRecords(method: PdfExportMethod, params: Record<string, unknown>, format: RecordFormat): Promise<any> {
  return format === 'pdf'
    ? exportMessagesPdf(method, params)
    : checkEngineResult(await sidecarCall(method, { ...params, format }));
}

/** The one file a save wrote, however the engine or the PDF exporter named it. */
function savedFile(result: any): string | undefined {
  return result?.file ?? result?.files?.[0] ?? result?.exported?.[0];
}

/** Save one note into a folder the person picks. */
export async function saveNote(udid: string, note: { note_id: number | string; title: string }, format: NotesFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = await exportRecords('export_notes', { udid, note_ids: [note.note_id], output_dir: outputDir }, format);
  return { title: `Saved "${note.title || 'Untitled'}"`, path: savedFile(result) ?? outputDir };
}

/** Save every note in one file (Notes.pdf, .html or .txt) into a folder the person picks. */
export async function saveAllNotes(udid: string, format: NotesFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = await exportRecords('export_notes', { udid, output_dir: outputDir, mode: 'merged' }, format);
  return { title: `Saved ${plural(result?.count ?? 0, 'note')}`, detail: 'In one file', path: savedFile(result) ?? outputDir };
}

/** Save every call into a folder the person picks. */
export async function saveCalls(udid: string, format: RecordFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = await exportRecords('export_calls', { udid, output_dir: outputDir }, format);
  return { title: `Saved ${plural(result?.count ?? 0, 'call')}`, path: savedFile(result) ?? outputDir };
}

/** Save every page visit, from every browser, into a folder the person picks. */
export async function saveBrowserHistory(udid: string, format: RecordFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = await exportRecords('export_browser_history', { udid, output_dir: outputDir }, format);
  return { title: `Saved ${plural(result?.count ?? 0, 'page visit')}`, path: savedFile(result) ?? outputDir };
}

/** Save every recovered message, in one file, into a folder the person picks. */
export async function saveRecoveredMessages(udid: string, format: RecordFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = await exportRecords('export_recovered_messages', { udid, output_dir: outputDir }, format);
  return { title: `Saved ${plural(result?.message_count ?? 0, 'recovered message')}`, path: savedFile(result) ?? outputDir };
}

// ── Pages built here: the Timeline ─────────────────────────────────────────────

/**
 * The most Timeline events one PDF holds. Chromium prints the whole page at once:
 * 50,000 events printed reliably, 100,000 took ~4 GB, 200,000 crashed after minutes
 * (electron/pdfExport.ts has the backstop). The web page and the spreadsheet have no limit.
 */
export const MAX_PDF_EVENTS = 25_000;

/**
 * Write Timeline entries into `folder` as `<baseName>.<ext>`, the PDF printed by
 * Chromium. Resolves to the file written. `title` heads the page and the text.
 * More events than a PDF holds are refused before the page is built.
 */
export async function writeTimeline(
  entries: TimelineEntry[],
  format: ExportFormat,
  folder: string,
  baseName: string,
  title?: string,
): Promise<string> {
  if (format === 'pdf') {
    if (entries.length > MAX_PDF_EVENTS) {
      throw new Error(`This is too much for one PDF: ${plural(entries.length, 'event')}, and one PDF holds up to ${MAX_PDF_EVENTS.toLocaleString()}. `
        + 'Narrow it down to a date range, a search or fewer kinds, or save it as a web page or spreadsheet, which have no limit.');
    }
    return (await exportHtmlPdf(formatTimeline(entries, 'pdf', { title }), folder, baseName)).file;
  }
  const path = `${folder}/${baseName}.${FORMAT_FILTERS[format].extensions[0]}`;
  await window.openextract.writeFile(path, formatTimeline(entries, format, { title }));
  return path;
}

// ── One person: everything with them, photos and files included ───────────────

/**
 * What export_person needs to save one person's history: their Messages
 * conversations and WhatsApp chats whole (a person's messages are whole chats,
 * as People matches them), and their calls and voicemails one by one. Messages
 * and WhatsApp chat ids are separate lists because the two databases' ids
 * collide. Call and voicemail ids stay text: they aren't always numbers
 * ("ft_3", "A-…7").
 */
export interface PersonExportSpec {
  display_name: string;
  chat_ids: number[];
  conversation_names: Record<number, string>;
  whatsapp_chat_ids: number[];
  whatsapp_names: Record<number, string>;
  call_ids: string[];
  voicemail_ids: string[];
  /** Shared notes, as list_notes gives their ids. */
  note_ids: string[];
  /** Only these sms.db messages from the chats, when given; else the whole chats. */
  message_ids?: number[];
  /** Only these ChatStorage messages from the WhatsApp chats, when given; else the whole chats. */
  whatsapp_message_ids?: number[];
}

/**
 * The save request for a person's stream, from the entries People shows for
 * them. A chat is saved whole (People may have read only its newest messages)
 * unless `onlyThese`: then only the messages shown, for when dates, a search
 * or Photos picked out some of them.
 */
export function personExportSpec(displayName: string, entries: TimelineEntry[], { onlyThese = false } = {}): PersonExportSpec {
  const spec: PersonExportSpec = {
    display_name: displayName, chat_ids: [], conversation_names: {},
    whatsapp_chat_ids: [], whatsapp_names: {}, call_ids: [], voicemail_ids: [], note_ids: [],
  };
  const calls = new Set<string>();
  const voicemails = new Set<string>();
  const notes = new Set<string>();
  const messages: number[] = [];
  const whatsapp: number[] = [];
  for (const e of entries) {
    const id = e.id.slice(e.id.indexOf(':') + 1);
    if (e.type === 'message' && e.message?.chatId != null) {
      const chat = e.message.chatId;
      if (!(chat in spec.conversation_names)) {
        spec.chat_ids.push(chat);
        spec.conversation_names[chat] = e.message.conversationName;
      }
      if (/^\d+$/.test(id)) messages.push(Number(id));
    } else if (e.type === 'whatsapp' && e.whatsapp) {
      const chat = e.whatsapp.chatId;
      if (!(chat in spec.whatsapp_names)) {
        spec.whatsapp_chat_ids.push(chat);
        spec.whatsapp_names[chat] = e.whatsapp.conversationName;
      }
      if (/^\d+$/.test(id)) whatsapp.push(Number(id));
    } else if (e.type === 'call' && id) {
      calls.add(id);
    } else if (e.type === 'voicemail' && id) {
      voicemails.add(id);
    } else if (e.type === 'note' && id) {
      notes.add(id);
    }
  }
  spec.call_ids = [...calls];
  spec.voicemail_ids = [...voicemails];
  spec.note_ids = [...notes];
  if (onlyThese) {
    spec.message_ids = messages;
    spec.whatsapp_message_ids = whatsapp;
  }
  return spec;
}

/** "214 photos and files", plus what couldn't be saved, for the notice. */
function personSaveDetail(result: any): string {
  const parts = [plural(result?.message_count ?? 0, 'event')];
  const media = result?.media;
  if (media?.copied) parts.push(plural(media.copied, 'photo or file', 'photos and files'));
  const notes: string[] = [];
  if (media?.not_in_backup) notes.push(`${plural(media.not_in_backup, 'file')} ${media.not_in_backup === 1 ? "wasn't" : "weren't"} in the backup`);
  if (media?.failed) notes.push(`${plural(media.failed, 'file')} couldn't be copied`);
  for (const why of Object.values(result?.errors ?? {})) if (typeof why === 'string') notes.push(why);
  return [parts.join(' and '), ...notes].join('. ');
}

/**
 * Save everything with one person into a folder the person picks: one file
 * (PDF, web page, spreadsheet or text) and a folder of every photo, video,
 * voice message, document and voicemail recording beside it.
 */
export async function savePerson(udid: string, spec: PersonExportSpec, format: RecordFormat, title: string): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params = { udid, output_dir: outputDir, ...spec };
  const result: any = format === 'pdf'
    // The page is printed from a temporary folder; the originals go beside the PDF
    ? await exportMessagesPdf('export_person', { ...params, media_dir: outputDir })
    : await sidecarCall('export_person', { ...params, format });
  // Nothing could be saved: { error, errors }
  if (result?.error) throw new Error(result.error);
  return { title, detail: personSaveDetail(result), path: savedFile(result) ?? outputDir };
}

// ── Conversations ──────────────────────────────────────────────────────────────

export type ConversationFormat = RecordFormat;

interface ConversationRef {
  chat_id: number;
  display_name: string;
  chat_identifier: string;
}

/** A WhatsApp chat as list_whatsapp_chats gives it; its address is never shown, so no chat_identifier. */
interface WhatsAppChatRef {
  chat_id: number;
  display_name: string;
  handle?: string;
}

/** The engine methods that save one chat or several, and the PDF exporter's name for them. */
type ExportMethods =
  | { one: 'export_conversation'; many: 'export_conversations' }
  | { one: 'export_whatsapp_chat'; many: 'export_whatsapp_chats' };

const MESSAGES_EXPORT: ExportMethods = { one: 'export_conversation', many: 'export_conversations' };
const WHATSAPP_EXPORT: ExportMethods = { one: 'export_whatsapp_chat', many: 'export_whatsapp_chats' };

async function exportOne(methods: ExportMethods, params: Record<string, unknown>, format: ConversationFormat): Promise<any> {
  return format === 'pdf'
    ? exportMessagesPdf(methods.one, params)
    : checkEngineResult(await sidecarCall(methods.one, { ...params, format }));
}

async function exportMany(methods: ExportMethods, params: Record<string, unknown>, format: ConversationFormat): Promise<{ files: string[]; message_count: number; splits?: PdfSplit[] }> {
  const result: any = format === 'pdf'
    ? await exportMessagesPdf(methods.many, params)
    : checkEngineResult(await sidecarCall<{ files: string[]; message_count: number }>(methods.many, { ...params, format }));
  // Every file written, however the engine named them
  const files: string[] = Array.isArray(result?.files) ? result.files : result?.file ? [result.file] : [];
  return { files, message_count: result?.message_count ?? 0, splits: result?.splits };
}

// ── Why a PDF save is several files ───────────────────────────────────────────

/** "2020, 2021 and 2022" */
function joinList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** An estimate to two figures: 6,321 -> "6,300". */
function roughly(n: number): string {
  if (n < 100) return Math.round(n).toLocaleString();
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return (Math.round(n / step) * step).toLocaleString();
}

/** "about 700 MB", "about 1.4 GB" */
function aboutSize(megabytes: number): string {
  if (megabytes >= 1000) return `about ${(Math.round(megabytes / 100) / 10).toLocaleString()} GB`;
  return `about ${roughly(Math.max(1, megabytes))} MB`;
}

/** "by year: 2020, 2021 and 2022", or "by date: Jan–Jun 2024 and Jul–Dec 2024" when a year was split by month. */
function byWhat(labels: string[]): string {
  const how = labels.every(l => /^\d{4}(–\d{4})?$/.test(l)) ? 'by year' : 'by date';
  if (labels.length > 6) return `${how} into ${labels.length} PDFs, ${labels[0]} to ${labels[labels.length - 1]}`;
  return `${how}: ${joinList(labels)}`;
}

const SMALLER_FILES = 'Smaller files are easier to open, share and print.';

/**
 * Why a PDF save came out as several files, for its notice (electron/pdfExport.ts
 * splits a conversation that would make too big a PDF). Undefined when nothing was split.
 */
export function pdfSplitNote(splits: PdfSplit[] | undefined, noun: 'conversation' | 'chat'): string | undefined {
  if (!splits?.length) return undefined;
  if (splits.length === 1) {
    const s = splits[0];
    const size = `${aboutSize(s.estimate.megabytes)} and ${roughly(s.estimate.pages)} pages`;
    const opening = s.name ? `Your ${noun} with ${s.name} would be one PDF of ${size}` : `One PDF of it all would be ${size}`;
    return `${opening}, so it's split ${byWhat(s.labels)}. ${SMALLER_FILES}`;
  }
  const each = splits.map(s => `${s.name ?? 'everything'} (${plural(s.labels.length, 'PDF')})`);
  const named = each.length > 4 ? [...each.slice(0, 3), `${each.length - 3} more`] : each;
  return `${splits.length} ${noun}s would each be too big as one PDF, so each is split by year: ${joinList(named)}. ${SMALLER_FILES}`;
}

/** { note } when there is one, so a notice without one has no note key at all. */
function noted(note: string | undefined): { note?: string } {
  return note ? { note } : {};
}

/** A one-conversation save's notice already says whose it is. */
function unnamed(splits: PdfSplit[] | undefined): PdfSplit[] | undefined {
  return splits?.map(s => ({ ...s, name: null }));
}

/** "1,204 messages", or "1,204 messages in 5 PDFs" when a save made several files. */
function messagesIn(count: number, files: string[], noun = 'message'): string {
  return files.length > 1 ? `${plural(count, noun)} in ${plural(files.length, 'PDF')}` : plural(count, noun);
}

/** Save one conversation into a folder the person picks. */
export async function saveConversation(udid: string, convo: ConversationRef, format: ConversationFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params = { udid, chat_id: convo.chat_id, output_dir: outputDir, display_name: convo.display_name };
  const result = await exportOne(MESSAGES_EXPORT, params, format);
  const files: string[] = result?.files ?? (result?.file ? [result.file] : []);
  return {
    title: `Saved your conversation with ${convo.display_name || convo.chat_identifier}`,
    detail: result?.message_count != null ? messagesIn(result.message_count, files) : undefined,
    path: files.length === 1 ? files[0] : outputDir,
    ...noted(pdfSplitNote(unnamed(result?.splits), 'conversation')),
  };
}

/** Save several conversations, one file each ('separate') or all in one ('merged'). */
export async function saveConversations(
  udid: string,
  convos: ConversationRef[],
  format: ConversationFormat,
  mode: 'separate' | 'merged',
): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const conversationNames: Record<number, string> = {};
  for (const c of convos) conversationNames[c.chat_id] = c.display_name || c.chat_identifier;
  const params = {
    udid, chat_ids: convos.map(c => c.chat_id), conversation_names: conversationNames,
    output_dir: outputDir, mode,
  };
  const result = await exportMany(MESSAGES_EXPORT, params, format);
  return {
    title: `Saved ${plural(result.message_count, 'message')}`,
    detail: `${plural(convos.length, 'conversation')} in ${plural(result.files.length, 'file')}`,
    path: result.files.length === 1 ? result.files[0] : outputDir,
    ...noted(pdfSplitNote(result.splits, 'conversation')),
  };
}

// WhatsApp chats save the same way through their own engine methods: a WhatsApp
// chat id is a different database's number, and the same number given to
// export_conversation would save somebody's text messages instead.

/** Save one WhatsApp chat into a folder the person picks. */
export async function saveWhatsAppChat(udid: string, chat: WhatsAppChatRef, format: ConversationFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params = { udid, chat_id: chat.chat_id, output_dir: outputDir, display_name: chat.display_name };
  const result = await exportOne(WHATSAPP_EXPORT, params, format);
  const files: string[] = result?.files ?? (result?.file ? [result.file] : []);
  return {
    title: `Saved your WhatsApp chat with ${chatName(chat)}`,
    detail: result?.message_count != null ? messagesIn(result.message_count, files) : undefined,
    path: files.length === 1 ? files[0] : outputDir,
    ...noted(pdfSplitNote(unnamed(result?.splits), 'chat')),
  };
}

/** Save several WhatsApp chats, one file each ('separate') or all in one ('merged'). */
export async function saveWhatsAppChats(
  udid: string,
  chats: WhatsAppChatRef[],
  format: ConversationFormat,
  mode: 'separate' | 'merged',
): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const conversationNames: Record<number, string> = {};
  for (const c of chats) conversationNames[c.chat_id] = chatName(c);
  const params = {
    udid, chat_ids: chats.map(c => c.chat_id), conversation_names: conversationNames,
    output_dir: outputDir, mode,
  };
  const result = await exportMany(WHATSAPP_EXPORT, params, format);
  return {
    title: `Saved ${plural(result.message_count, 'WhatsApp message')}`,
    detail: `${plural(chats.length, 'chat')} in ${plural(result.files.length, 'file')}`,
    path: result.files.length === 1 ? result.files[0] : outputDir,
    ...noted(pdfSplitNote(result.splits, 'chat')),
  };
}

// ── Podcasts ───────────────────────────────────────────────────────────────────

/**
 * Save the podcasts into a folder the person picks: the followed shows as a
 * subscription list another podcast app imports (OPML), or every show and
 * episode as spreadsheets. The engine writes the files and never overwrites
 * one; nothing to save comes back as { error, empty_reason } and is reported.
 */
export async function savePodcasts(udid: string, format: PodcastSaveFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const result = checkEngineResult(await sidecarCall<PodcastExportResult>('export_podcasts', { udid, output_dir: outputDir, format }));
  return {
    title: `Saved ${plural(result.count ?? 0, 'podcast')}`,
    detail: format === 'opml' ? 'Subscription list for another podcast app' : 'Spreadsheets of the shows and their episodes',
    path: result.path ?? result.files?.[0] ?? outputDir,
  };
}

// ── Voice Memos ────────────────────────────────────────────────────────────────

/**
 * Save voice memos into a folder the person picks: the recordings as audio
 * files (with their transcripts and a spreadsheet, in a "Voice Memos" folder),
 * or only the spreadsheet. With `memoIds`, just those recordings, straight
 * into the folder (a screen's Save on one recording; `name` is what it's
 * called). The engine copies the files and never overwrites one; nothing to
 * save comes back as { error, empty_reason } and is reported.
 */
export async function saveVoiceMemos(
  udid: string,
  format: VoiceMemoSaveFormat,
  opts: { memoIds?: number[]; name?: string } = {},
): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params: Record<string, unknown> = { udid, output_dir: outputDir, format };
  if (opts.memoIds) params.memo_ids = opts.memoIds;
  const result = checkEngineResult(await sidecarCall<VoiceMemoExportResult>('export_voice_memos', params));
  const one = opts.memoIds?.length === 1 && opts.name;
  return {
    title: one ? `Saved "${opts.name}"` : `Saved ${plural(result.count ?? 0, 'voice memo')}`,
    detail: voiceMemoSaveDetail(result, format),
    path: result.path ?? result.files?.[0] ?? outputDir,
  };
}

// ── Calendar ───────────────────────────────────────────────────────────────────

/**
 * Save calendar events into a folder the person picks: calendar files (.ics,
 * one per calendar, in a folder) that Calendar, Outlook or Google import, or a
 * spreadsheet. With `calendarId`, only that calendar, as one file. The engine
 * writes the files and never overwrites one; nothing to save comes back as
 * { error, empty_reason } and is reported.
 */
export async function saveCalendar(
  udid: string,
  format: CalendarSaveFormat,
  opts: { calendarId?: number } = {},
): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params: Record<string, unknown> = { udid, output_dir: outputDir, format };
  if (opts.calendarId != null) params.calendar_id = opts.calendarId;
  const result = checkEngineResult(await sidecarCall<CalendarExportResult>('export_calendar', params));
  return {
    title: `Saved ${plural(result.count ?? 0, 'event')}`,
    detail: calendarSaveDetail(result, format, opts.calendarId != null),
    path: result.path ?? result.files?.[0] ?? outputDir,
  };
}
