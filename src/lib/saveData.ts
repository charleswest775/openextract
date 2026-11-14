/**
 * Shared pieces of "Save to this computer": writing text files the renderer builds,
 * and the file formats more than one screen produces.
 */
import { exportMessagesPdf, saveFolder, sidecarCall } from './ipc';
import { chatName } from './whatsapp';
import type { PodcastExportResult, PodcastSaveFormat } from '../types/podcasts';

/** What a finished save reports in its notice. */
export interface SaveResult {
  title: string;
  detail?: string;
  /** The file or folder written, for "Show in folder". */
  path?: string;
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

export function contactsToCsv(contacts: ContactRecord[]): string {
  const rows = ['"First Name","Last Name","Display Name","Organization","Phone Numbers","Email Addresses","Notes"'];
  for (const c of contacts) {
    rows.push([
      c.first_name, c.last_name, c.display_name, c.organization,
      (c.phones || []).join('; '), (c.emails || []).join('; '), c.note,
    ].map(v => csvEscape(v || '')).join(','));
  }
  return rows.join('\n');
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

// ── Notes ──────────────────────────────────────────────────────────────────────

export interface NoteRecord {
  title: string;
  body: string;
  created: string;
  modified: string;
}

export function notesToText(notes: NoteRecord[]): string {
  return notes.map(n =>
    `Title: ${n.title}\nCreated: ${n.created}\nModified: ${n.modified}\n${'='.repeat(40)}\n\n${n.body}`
  ).join('\n\n' + '-'.repeat(60) + '\n\n');
}

// ── Conversations ──────────────────────────────────────────────────────────────

export type ConversationFormat = 'html' | 'pdf' | 'csv' | 'txt';

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

async function exportMany(methods: ExportMethods, params: Record<string, unknown>, format: ConversationFormat): Promise<{ files: string[]; message_count: number }> {
  const result: any = format === 'pdf'
    ? await exportMessagesPdf(methods.many, params)
    : checkEngineResult(await sidecarCall<{ files: string[]; message_count: number }>(methods.many, { ...params, format }));
  // Every file written, however the engine named them
  const files: string[] = Array.isArray(result?.files) ? result.files : result?.file ? [result.file] : [];
  return { files, message_count: result?.message_count ?? 0 };
}

/** Save one conversation into a folder the person picks. */
export async function saveConversation(udid: string, convo: ConversationRef, format: ConversationFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params = { udid, chat_id: convo.chat_id, output_dir: outputDir, display_name: convo.display_name };
  const result = await exportOne(MESSAGES_EXPORT, params, format);
  const file: string | undefined = result?.file ?? result?.files?.[0];
  return {
    title: `Saved your conversation with ${convo.display_name || convo.chat_identifier}`,
    detail: result?.message_count != null ? plural(result.message_count, 'message') : undefined,
    path: file ?? outputDir,
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
  const file: string | undefined = result?.file ?? result?.files?.[0];
  return {
    title: `Saved your WhatsApp chat with ${chatName(chat)}`,
    detail: result?.message_count != null ? plural(result.message_count, 'message') : undefined,
    path: file ?? outputDir,
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
