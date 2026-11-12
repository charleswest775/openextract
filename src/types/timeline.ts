import type { WhatsAppCallOutcome } from './whatsapp';

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
