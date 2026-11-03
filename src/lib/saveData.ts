/**
 * Shared pieces of "Save to this computer": writing text files the renderer builds,
 * and the file formats more than one screen produces.
 */
import { exportMessagesPdf, saveFolder, sidecarCall } from './ipc';

/** What a finished save reports in its notice. */
export interface SaveResult {
  title: string;
  detail?: string;
  /** The file or folder written, for "Show in folder". */
  path?: string;
}

/**
 * Engine export methods report some failures in their result instead of throwing:
 * { success: false, error }, { status: 'error', message } or a bare { error }.
 */
export function checkEngineResult<T>(result: T): T {
  const r = result as any;
  const failed = r && (r.success === false || r.status === 'error' || (r.error && Object.keys(r).length === 1));
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

/** Save one conversation into a folder the person picks. */
export async function saveConversation(udid: string, convo: ConversationRef, format: ConversationFormat): Promise<SaveResult | null> {
  const outputDir = await saveFolder();
  if (!outputDir) return null;
  const params = { udid, chat_id: convo.chat_id, output_dir: outputDir, display_name: convo.display_name };
  const result: any = format === 'pdf'
    ? await exportMessagesPdf('export_conversation', params)
    : checkEngineResult(await sidecarCall('export_conversation', { ...params, format }));
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
  const result = format === 'pdf'
    ? await exportMessagesPdf('export_conversations', params)
    : checkEngineResult(await sidecarCall<{ files: string[]; message_count: number }>(
      'export_conversations', { ...params, format },
    ));
  return {
    title: `Saved ${plural(result.message_count, 'message')}`,
    detail: `${plural(convos.length, 'conversation')} in ${plural(result.files.length, 'file')}`,
    path: result.files.length === 1 ? result.files[0] : outputDir,
  };
}
