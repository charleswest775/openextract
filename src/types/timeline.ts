export type TimelineEntryType = 'message' | 'call' | 'photo' | 'voicemail' | 'note' | 'browser' | 'voice_memo' | 'calendar';

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
    conversationName: string;
    service: string;
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
  voiceMemo?: {
    memoId: number;
    title: string;
    duration: number;
    folder: string | null;
    deleted: boolean;
    hasAudio: boolean;
  };
  calendar?: {
    eventId: number;
    title: string;
    allDay: boolean;
    when: string;                     // formatted, e.g. "3:00 PM – 4:00 PM" or "All day"
    location: string | null;
    calendarName: string | null;
    color: string | null;
    recurring: boolean;
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
  types: new Set(['message', 'call', 'photo', 'voicemail', 'note', 'browser', 'voice_memo', 'calendar']),
  contactIdentifier: '',
  dateFrom: '',
  dateTo: '',
  searchQuery: '',
};
