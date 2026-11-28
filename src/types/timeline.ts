import type { WhatsAppAttachment, WhatsAppCallOutcome } from './whatsapp';

/** A photo sent in a Messages conversation: an sms.db attachment, read with get_attachment. */
export interface MessagePhoto {
  attachment_id: number;
  filename: string;
  mime_type: string;
  transfer_name: string;
}

/**
 * A file sent with a message, as the engine lists it: Messages' fields, and
 * WhatsApp's extras (its own thumbnail, size, length, whether the file is in
 * the backup) when it has them. The ids are each database's own and collide
 * between Messages and WhatsApp, so always fetch through the message's source.
 */
export interface TimelineAttachment {
  attachment_id: number;
  filename: string;
  mime_type: string | null;
  transfer_name: string;
  total_bytes?: number | null;
  thumbnail_path?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /** Whether the file is in the backup; when false, don't ask for it. */
  available?: boolean;
  uti?: string | null;
  is_sticker?: boolean;
}

export type TimelineEntryType = 'message' | 'whatsapp' | 'call' | 'photo' | 'voicemail' | 'note' | 'browser';

export interface TimelineEntry {
  id: string;                         // "{type}:{original_id}"
  type: TimelineEntryType;
  timestamp: string;                  // ISO 8601 — the sort key
  contactName: string | null;
  contactIdentifier: string | null;   // phone number or email

  message?: {
    text: string | null;
    isFromMe: boolean;
    sender: string;
    messageType: string;
    eventText?: string | null;          // e.g. "Karin added Theo to the conversation"
    conversationName: string;
    service: string;
    chatId?: number;
    isGroup?: boolean;
    /** The message's files (photos, videos, voice messages, documents); absent when it has none. */
    attachments?: TimelineAttachment[];
    /** The photos among them, when there are any: what it adds to Photos in someone's stream. */
    photos?: MessagePhoto[];
  };
  /**
   * A WhatsApp message. Its id is "whatsapp:<ChatStorage Z_PK>" and its chatId is a
   * ChatStorage chat, never an sms.db one: open it with openTab('whatsapp', { waChatId }).
   */
  whatsapp?: {
    text: string | null;
    isFromMe: boolean;
    /** "me" when from me, "" on system rows, else a name or "+digits". */
    sender: string;
    /** text, image, video, audio, document, sticker, gif, contact, shared_location, live_location, call, system, deleted, poll, view_once, link, unknown */
    messageType: string;
    /** What happened, for calls, locations, system rows and media without text. */
    eventText: string | null;
    /** The first attachment's name or label ("Photo", "IMG_0001.jpg"), for describing and searching. */
    attachmentLabel: string | null;
    conversationName: string;
    chatId: number;
    chatType: 'individual' | 'group' | 'broadcast' | 'channel';
    isGroup: boolean;
    /** Arrival order in the chat (ZSORT), for stepping through matches in thread order. */
    sort: number | null;
    /** On a call row: how it went, so search can find "missed" calls and the Timeline can mark them. */
    call?: {
      outcome: WhatsAppCallOutcome;
      direction: 'incoming' | 'outgoing';
      isVideo: boolean | null;
      duration: number | null;
    } | null;
    /** The message's media; absent when it has none. */
    attachments?: TimelineAttachment[];
    /** The photo sent with it, on a photo message whose file is in the backup. */
    photos?: WhatsAppAttachment[];
  };
  call?: {
    direction: string;
    status: string;
    duration: number;
    app: string;
  };
  photo?: {
    filename: string;
    fileHash: string;
    kind: string;
    width: number;
    height: number;
    duration: number;
  };
  voicemail?: {
    /** list_voicemails' id: a ROWID in the main store, or "<account folder>.<ROWID>" for a per-line store's copy. */
    voicemailId: number | string;
    duration: number;
    transcript: string;
    phoneNumber: string;
  };
  note?: {
    noteId: number | string;
    title: string;
    bodyPreview: string;
    body: string;
    modified: string;
    /**
     * The numbers and email addresses of the people it's shared with (not the
     * phone's owner), so it's in their stream. Absent when it isn't shared.
     */
    sharedWith?: string[];
    /**
     * In the iPhone's Recently Deleted folder. Only a person's stream shows
     * it (People, and what a person save writes); the Timeline and search leave it out.
     */
    deleted?: boolean;
  };
  browser?: {
    url: string;
    title: string;
    domain: string;
    browserName: 'safari' | 'firefox';
  };
}

export interface TimelineFilters {
  types: Set<TimelineEntryType>;
  contactIdentifier: string;          // empty string = all
  dateFrom: string;                   // YYYY-MM-DD or empty
  dateTo: string;                     // YYYY-MM-DD or empty
  searchQuery: string;
}

export interface ContactOption {
  identifier: string;                 // phone number or email
  name: string;                       // display name
}

export const DEFAULT_FILTERS: TimelineFilters = {
  types: new Set(['message', 'whatsapp', 'call', 'photo', 'voicemail', 'note', 'browser']),
  contactIdentifier: '',
  dateFrom: '',
  dateTo: '',
  searchQuery: '',
};
