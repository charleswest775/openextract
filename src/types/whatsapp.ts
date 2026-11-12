/**
 * What the engine's WhatsApp calls return (python/whatsapp.py, over
 * ios-backup-core's WhatsAppExtractor).
 *
 * The shapes extend Messages' (src/hooks/useMessages.ts) with what WhatsApp
 * has and Messages doesn't: replies, reactions, calls and locations sit on the
 * message they belong to, never as rows of their own.
 *
 * Ids are ChatStorage.sqlite primary keys. chat_id, message_id and
 * attachment_id overlap with sms.db's, so a WhatsApp id must only ever go to a
 * WhatsApp call (list_whatsapp_chats, get_whatsapp_messages, ...), never to a
 * Messages one.
 *
 * Pages come in arrival order (`sort`, WhatsApp's ZSORT). `date` is the
 * sender's clock and `message_id` is insertion order; neither is the order
 * the chat reads in.
 */

export type WhatsAppChatType = 'individual' | 'group' | 'broadcast' | 'channel';

/** Why a list came back empty, as the engine says it. */
export type WhatsAppEmptyReason = 'not_in_backup' | 'no_records' | 'unsupported_format';

export interface WhatsAppConversation {
  chat_id: number;
  /** The chat's JID, e.g. "12025550101@s.whatsapp.net" or "1203...@g.us". Not shown to people. */
  chat_identifier: string;
  display_name: string;
  service: 'WhatsApp';
  message_count: number;
  /** null when no message in the chat has a usable date. */
  last_message_date: string | null;
  last_message_preview: string;
  is_group: boolean;
  chat_jid: string;
  /** The other person's number as "+digits" in a one-to-one chat; "" for groups, lists, channels and unmapped LIDs. */
  handle: string;
  chat_type: WhatsAppChatType;
  archived: boolean;
}

export interface WhatsAppChatsResult {
  conversations: WhatsAppConversation[];
  error?: string;
  empty_reason?: WhatsAppEmptyReason;
}

export interface WhatsAppAttachment {
  attachment_id: number;
  /**
   * Backup-relative path ("Message/Media/..."), "" when WhatsApp recorded none. It can name a
   * file the backup doesn't have: only `available` says whether the file is there.
   */
  filename: string;
  mime_type: string | null;
  /** The file's name, or a label such as "Photo" or "Video message" when there is no file. */
  transfer_name: string;
  total_bytes: number | null;
  thumbnail_path: string | null;
  width: number | null;
  height: number | null;
  /** Seconds, for audio and video. */
  duration: number | null;
  /** The file is in the backup. When false, don't ask for it. */
  available: boolean;
}

export interface WhatsAppQuote {
  /** The quoted message, when it's in this chat; null when it isn't (deleted, or before the backup). */
  message_id: number | null;
  text: string;
  message_type: string;
  is_from_me: boolean;
  sender: string;
}

export interface WhatsAppReaction {
  emoji: string;
  sender: string;
  sender_handle: string;
  is_from_me: boolean;
  date: string | null;
}

export type WhatsAppCallOutcome =
  | 'answered' | 'missed' | 'declined' | 'failed' | 'no_answer' | 'answered_elsewhere' | 'ongoing' | 'unknown';

export interface WhatsAppCall {
  /** null when the call record doesn't say. */
  is_video: boolean | null;
  /** Seconds; null when unknown. */
  duration: number | null;
  outcome: WhatsAppCallOutcome;
  direction: 'incoming' | 'outgoing';
}

export interface WhatsAppLocation {
  /** null when WhatsApp stored no position (or 0,0). */
  latitude: number | null;
  longitude: number | null;
  live: boolean;
  place_name: string | null;
  thumbnail_path: string | null;
  /** get_whatsapp_attachment(attachment_id, thumbnail: true) gives the map preview. */
  attachment_id: number | null;
}

export interface WhatsAppLinkPreview {
  url?: string;
  title?: string;
  summary?: string;
  sitename?: string;
}

/**
 * message_type is one of: text, image, video, audio, contact, shared_location,
 * live_location, link, document, gif, deleted, sticker, view_once, poll, call,
 * system, unknown. A row that would otherwise be an empty bubble always has
 * event_text ("Missed voice call", "Location", "Contact card", ...).
 */
export interface WhatsAppMessage {
  message_id: number;
  text: string | null;
  message_type: string;
  event_text: string | null;
  link_preview: WhatsAppLinkPreview | null;
  /** UTC ISO 8601; null when WhatsApp stored no usable date. */
  date: string | null;
  is_from_me: boolean;
  /** "me" when from me; "" on system rows; else a name, "+digits" or "Unknown member". */
  sender: string;
  sender_handle: string;
  has_attachments: boolean;
  attachments: WhatsAppAttachment[];
  /** Always false: reactions are on the message they react to. */
  is_reaction: false;
  /** Arrival order in the chat (ZSORT). The order to show and step through. */
  sort: number | null;
  sender_jid: string;
  quoted: WhatsAppQuote | null;
  reactions: WhatsAppReaction[];
  call: WhatsAppCall | null;
  location: WhatsAppLocation | null;
  received_date: string | null;
  /** "6/12" style code on system rows. */
  event_code: string | null;
  starred: boolean;
  vcard: string | null;
}

export interface WhatsAppMessagesResult {
  messages: WhatsAppMessage[];
  total: number;
  next_offset: number;
  offset: number;
  limit: number;
  error?: string;
  empty_reason?: WhatsAppEmptyReason;
}

export interface WhatsAppSearchHit {
  message_id: number;
  text: string;
  date: string | null;
  is_from_me: boolean;
  sender: string;
  chat_id: number;
  chat_name: string;
}

export interface WhatsAppSearchResult {
  results: WhatsAppSearchHit[];
  query: string;
  error?: string;
  empty_reason?: WhatsAppEmptyReason;
}

/**
 * get_whatsapp_attachment. Default: the file as base64 `data`. With
 * `as_file: true`: a copy on disk named with its real extension (`path`), to
 * open in another app. A file too big to send inline comes back with
 * `too_large: true` and no data: ask again with `as_file: true`.
 * A file that isn't in the backup is `{error, empty_reason: 'not_in_backup'}`.
 */
export interface WhatsAppAttachmentResult {
  data?: string;
  path?: string;
  mime_type?: string;
  filename?: string;
  size?: number;
  too_large?: boolean;
  /**
   * With `as_file`: the copy is a photo, video, audio file or document another app
   * can safely open. When false (a program, script, shortcut, archive or anything
   * unrecognised, whatever the sender named it), don't open it: show it in its folder.
   */
  openable?: boolean;
  error?: string;
  empty_reason?: 'not_in_backup';
}

/** What get_backup_stats says about WhatsApp, in its overview. */
export type WhatsAppStatus = 'ok' | 'not_in_backup' | 'no_records' | 'unsupported_format' | 'error';
