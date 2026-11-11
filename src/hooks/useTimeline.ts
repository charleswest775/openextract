import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sidecarCall } from '../lib/ipc';
import {
  TimelineEntry,
  TimelineEntryType,
  TimelineFilters,
  ContactOption,
  DEFAULT_FILTERS,
} from '../types/timeline';
import {
  identifiersMatch,
  IdentifierGroupMap,
  buildIdentifierGroupMap,
  buildContactOptions,
  getContactGroup,
  matchPerson,
  normPhone,
} from '../lib/people';
import { matchesTerms, parseQuery, searchText } from '../lib/search';
import type { Conversation, Message } from './useMessages';
import type { PhotoAsset } from '../types';
import type { WhatsAppChatsResult, WhatsAppConversation, WhatsAppMessage, WhatsAppMessagesResult } from '../types/whatsapp';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "T84QZS65DQ.com.facebook.Facebook" → "Facebook"
function appDisplayName(bundleId: string): string {
  const withoutTeam = bundleId.replace(/^[A-Z0-9]{10}\./, '');
  const parts = withoutTeam.split('.');
  return parts[parts.length - 1] || bundleId;
}

// Stops reading messages past this many, so a very large backup can't overwhelm the app.
const MAX_MESSAGES = 200000;
// WhatsApp has its own allowance on top, so a big WhatsApp history can't crowd out Messages (or the other way round).
const MAX_WHATSAPP = 200000;
// Messages per request while reading a whole chat into the index.
const CHAT_PAGE = 500;
const PAGE_SIZE = 100;

// Every kind of record the index reads, each one "still loading" until its read ends, however it ends.
const ALL_KINDS: TimelineEntryType[] = ['message', 'whatsapp', 'call', 'photo', 'voicemail', 'note', 'browser'];

// ── Normalizers ────────────────────────────────────────────────────────────────

export function normalizeMessage(msg: Message, conv: Conversation): TimelineEntry {
  return {
    id: `message:${msg.message_id}`,
    type: 'message',
    timestamp: msg.date,
    contactName: conv.display_name || conv.chat_identifier,
    contactIdentifier: conv.chat_identifier,
    message: {
      text: msg.text,
      isFromMe: msg.is_from_me,
      sender: msg.sender,
      messageType: msg.message_type,
      eventText: msg.event_text ?? null,
      conversationName: conv.display_name || conv.chat_identifier,
      service: conv.service,
      chatId: conv.chat_id,
      isGroup: conv.is_group,
    },
  };
}

/**
 * A WhatsApp message as a Timeline entry, or null when WhatsApp kept no usable
 * date for it (it can't be placed on the Timeline).
 *
 * Its id is "whatsapp:<id>", never "message:": WhatsApp's ids overlap sms.db's,
 * so the same number is a different message in each.
 *
 * Who it's with: a one-to-one chat is the other person's number ("+digits"),
 * so it joins their texts and calls; a group, broadcast list or channel is the
 * chat itself, like a group text; a one-to-one chat with no number WhatsApp
 * could tie it to is with no one (it isn't anyone's, so it's left out of People).
 */
export function normalizeWhatsApp(msg: WhatsAppMessage, conv: WhatsAppConversation): TimelineEntry | null {
  if (!msg.date) return null;
  const chatType = conv.chat_type ?? (conv.is_group ? 'group' : 'individual');
  const name = conv.display_name || conv.handle || 'WhatsApp chat';
  const contactIdentifier = chatType === 'individual'
    ? conv.handle || null
    : conv.chat_identifier || conv.chat_jid || null;
  const call = msg.call
    ? { outcome: msg.call.outcome, direction: msg.call.direction, isVideo: msg.call.is_video, duration: msg.call.duration }
    : null;
  return {
    id: `whatsapp:${msg.message_id}`,
    type: 'whatsapp',
    timestamp: msg.date,
    contactName: name,
    contactIdentifier,
    whatsapp: {
      text: msg.text || null,
      isFromMe: msg.is_from_me,
      sender: msg.sender ?? '',
      messageType: msg.message_type || 'unknown',
      eventText: msg.event_text || null,
      attachmentLabel: msg.attachments?.[0]?.transfer_name || null,
      conversationName: name,
      chatId: conv.chat_id,
      chatType,
      isGroup: chatType === 'group',
      sort: msg.sort ?? null,
      call,
    },
  };
}

export interface RawCall {
  call_id: number;
  address: string;
  contact_name: string;
  date: string;
  duration: number;
  direction: string;
  status: string;
  app: string;
}

export function normalizeCall(call: RawCall): TimelineEntry {
  const isUuid = UUID_RE.test(call.address ?? '');
  // contact_name sometimes echoes back the UUID address when no real contact is found
  const realName = call.contact_name && !UUID_RE.test(call.contact_name) ? call.contact_name : null;
  const name = realName
    || (isUuid && call.app ? appDisplayName(call.app) : null)
    || (!isUuid ? call.address : null)
    || null;
  return {
    id: `call:${call.call_id}`,
    type: 'call',
    timestamp: call.date,
    contactName: name,
    // UUID addresses aren't useful identifiers for contact filtering
    contactIdentifier: isUuid ? null : call.address,
    call: {
      direction: call.direction,
      status: call.status,
      duration: call.duration,
      app: call.app,
    },
  };
}

function normalizePhoto(photo: PhotoAsset): TimelineEntry | null {
  if (!photo.date_created) return null;
  return {
    id: `photo:${photo.uuid}`,
    type: 'photo',
    timestamp: photo.date_created,
    contactName: null,
    contactIdentifier: null,
    photo: {
      filename: photo.filename,
      fileHash: photo.file_hash,
      kind: photo.kind,
      width: photo.width,
      height: photo.height,
      duration: photo.duration,
    },
  };
}

export interface RawVoicemail {
  id: number;
  phone_number: string;
  contact_name: string;
  date_received: string;
  duration: number;
  is_read: boolean;
  transcript?: string;
}

export function normalizeVoicemail(vm: RawVoicemail): TimelineEntry {
  const name = vm.contact_name || vm.phone_number;
  return {
    id: `voicemail:${vm.id}`,
    type: 'voicemail',
    timestamp: vm.date_received,
    contactName: name,
    contactIdentifier: vm.phone_number,
    voicemail: {
      duration: vm.duration,
      transcript: vm.transcript || '',
      phoneNumber: vm.phone_number,
    },
  };
}

interface RawNote {
  note_id: number | string;
  title: string;
  body: string;
  created: string;
  modified: string;
}

// The first `n` characters, counted by code point so an emoji isn't cut in half.
function firstCodePoints(s: string, n: number): string {
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count++ === n) break;
    out += ch;
  }
  return out;
}

function normalizeNote(note: RawNote): TimelineEntry {
  return {
    id: `note:${note.note_id}`,
    type: 'note',
    timestamp: note.created || note.modified,
    contactName: null,
    contactIdentifier: null,
    note: {
      noteId: note.note_id,
      title: note.title || 'Untitled',
      bodyPreview: firstCodePoints(note.body || '', 120),
      body: note.body || '',
      modified: note.modified,
    },
  };
}

interface RawBrowserVisit {
  visit_id: string;
  url: string;
  title: string;
  domain: string;
  visit_date: string | null;
  browser: 'safari' | 'firefox';
  visit_count: number | null;
}

function normalizeBrowserVisit(v: RawBrowserVisit): TimelineEntry {
  return {
    id: `browser:${v.visit_id}`,
    type: 'browser',
    timestamp: v.visit_date ?? '',
    contactName: null,
    contactIdentifier: null,
    browser: {
      url: v.url,
      title: v.title || v.domain || v.url,
      domain: v.domain,
      browserName: v.browser,
    },
  };
}

// ── The backup, read once ─────────────────────────────────────────────────────

/** A card from the phone's address book. */
export interface AddressCard {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  organization: string;
  phones: string[];
  emails: string[];
  note: string;
}

export interface BackupIndex {
  /** Every record read so far, newest first. */
  entries: TimelineEntry[];
  /** Everyone the records mention, for picking a person. */
  contacts: ContactOption[];
  /** The address book; null until it's read. */
  addressBook: AddressCard[] | null;
  identifierGroupMap: IdentifierGroupMap;
  counts: Record<TimelineEntryType, number>;
  loading: boolean;
  loadingTypes: Set<TimelineEntryType>;
  errors: Partial<Record<TimelineEntryType, string>>;
  messageCap: { loaded: number; total: number } | null;
  /**
   * Set when WhatsApp has more messages than the index reads: only the newest
   * `loaded` of `total` are in the Timeline, search and People.
   */
  whatsappCap: { loaded: number; total: number } | null;
  loadAllMessages: () => Promise<void>;
  /** Reads one day's messages ahead of the rest, for opening the Timeline on a day. */
  loadDay: (day: string) => void;
  refresh: () => void;
}

// While messages load, hand over what's read at most this often, so search fills in as it goes.
const FLUSH_MS = 1500;

function dedupe(entries: TimelineEntry[]): TimelineEntry[] {
  // A message can be in two chats: keep it once.
  const seen = new Set<string>();
  return entries.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/**
 * Reads every kind of record in the backup once, for search, People and the
 * Timeline to share. Each kind arrives on its own; messages arrive in batches.
 */
export function useBackupIndex(udid: string): BackupIndex {
  const [rawEntries, setRawEntries] = useState<TimelineEntry[]>([]);
  const [loadingTypes, setLoadingTypes] = useState<Set<TimelineEntryType>>(() => new Set(ALL_KINDS));
  const [errors, setErrors] = useState<Partial<Record<TimelineEntryType, string>>>({});
  const [messageCap, setMessageCap] = useState<{ loaded: number; total: number } | null>(null);
  // How many WhatsApp messages were read and how many there are, when there were too many to read every one
  const [whatsappCap, setWhatsappCap] = useState<{ loaded: number; total: number } | null>(null);
  const [addressBook, setAddressBook] = useState<AddressCard[] | null>(null);
  const [identifierGroupMap, setIdentifierGroupMap] = useState<IdentifierGroupMap>(new Map());
  const loadEpochRef = useRef(0);
  const conversationsRef = useRef<Conversation[] | null>(null);
  const messagesDoneRef = useRef(false);
  // Days read ahead of the full load, kept through its batches
  const dayEntriesRef = useRef<TimelineEntry[]>([]);
  const daysAskedRef = useRef(new Set<string>());

  const addEntries = useCallback((incoming: TimelineEntry[], type: TimelineEntryType) => {
    const fresh = dedupe(incoming);
    setRawEntries(prev => [...prev.filter(e => e.type !== type), ...fresh]);
    setLoadingTypes(prev => {
      const next = new Set(prev);
      next.delete(type);
      return next;
    });
  }, []);

  const putMessages = useCallback((loaded: TimelineEntry[]) => {
    const all = dedupe([...loaded, ...dayEntriesRef.current]);
    setRawEntries(prev => [...prev.filter(e => e.type !== 'message'), ...all]);
  }, []);

  // WhatsApp's own: replacing only WhatsApp entries, so it never touches sms.db's (and Messages' never touch these)
  const putWhatsApp = useCallback((loaded: TimelineEntry[]) => {
    const fresh = dedupe(loaded);
    setRawEntries(prev => [...prev.filter(e => e.type !== 'whatsapp'), ...fresh]);
  }, []);

  const markError = useCallback((type: TimelineEntryType, msg: string) => {
    setErrors(prev => ({ ...prev, [type]: msg }));
    setLoadingTypes(prev => {
      const next = new Set(prev);
      next.delete(type);
      return next;
    });
  }, []);

  const fetchMessages = useCallback(async (epoch: number) => {
    try {
      const { conversations } = await sidecarCall<{ conversations: Conversation[] }>(
        'list_conversations',
        { udid }
      );
      if (loadEpochRef.current !== epoch) return;
      conversationsRef.current = conversations;

      // Newest conversations first, so recent messages are searchable soonest
      const sorted = [...conversations].sort((a, b) =>
        (b.last_message_date || '').localeCompare(a.last_message_date || '')
      );

      let loaded = 0;
      const totalAcross = sorted.reduce((s, c) => s + c.message_count, 0);
      const entries: TimelineEntry[] = [];
      let flushedAt = Date.now();

      for (const conv of sorted) {
        if (loaded >= MAX_MESSAGES) break;
        try {
          // Every message in this conversation, a page at a time
          let offset = 0;
          const batchSize = 500;
          while (true) {
            const { messages, total } = await sidecarCall<{ messages: Message[]; total: number; next_offset: number }>(
              'get_messages',
              { udid, chat_id: conv.chat_id, offset, limit: batchSize }
            );
            if (loadEpochRef.current !== epoch) return;
            entries.push(...messages.filter(m => !m.is_reaction).map(m => normalizeMessage(m, conv)));
            loaded += messages.length;
            offset += batchSize;
            if (offset >= total || messages.length === 0) break;
          }
        } catch {
          // Skip one failed conversation, continue with others
        }
        if (Date.now() - flushedAt > FLUSH_MS) {
          putMessages(entries);
          flushedAt = Date.now();
        }
      }

      messagesDoneRef.current = true;
      putMessages(entries);
      setLoadingTypes(prev => {
        const next = new Set(prev);
        next.delete('message');
        return next;
      });
      setMessageCap(loaded < totalAcross ? { loaded, total: totalAcross } : null);
    } catch (e: any) {
      markError('message', e.message || 'Failed to load messages');
    }
  }, [udid, putMessages, markError]);

  const fetchCalls = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ calls: RawCall[]; error?: string; empty_reason?: string }>(
        'list_calls',
        { udid, limit: 999999 }
      );
      if (loadEpochRef.current !== epoch) return;
      // No calls with an empty_reason is a normal state, even with an error
      // explaining it (call history is only in encrypted backups). Only an
      // error on its own, like a database that couldn't be read, is a failure.
      if (res.error && !res.empty_reason) throw new Error(res.error);
      addEntries((res.calls ?? []).map(normalizeCall), 'call');
    } catch (e: any) {
      markError('call', e.message || 'Failed to load calls');
    }
  }, [udid, addEntries, markError]);

  const fetchPhotos = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ photos: PhotoAsset[]; total: number }>(
        'list_photos',
        { udid, offset: 0, limit: 999999 }
      );
      if (loadEpochRef.current !== epoch) return;
      const normalized = res.photos.map(normalizePhoto).filter((e): e is TimelineEntry => e !== null);
      addEntries(normalized, 'photo');
    } catch (e: any) {
      markError('photo', e.message || 'Failed to load photos');
    }
  }, [udid, addEntries, markError]);

  const fetchVoicemail = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ voicemails: RawVoicemail[] }>(
        'list_voicemails',
        { udid }
      );
      if (loadEpochRef.current !== epoch) return;
      addEntries(res.voicemails.map(normalizeVoicemail), 'voicemail');
    } catch (e: any) {
      markError('voicemail', e.message || 'Failed to load voicemail');
    }
  }, [udid, addEntries, markError]);

  const fetchNotes = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ notes: RawNote[] }>(
        'list_notes',
        { udid }
      );
      if (loadEpochRef.current !== epoch) return;
      addEntries(res.notes.map(normalizeNote), 'note');
    } catch (e: any) {
      markError('note', e.message || 'Failed to load notes');
    }
  }, [udid, addEntries, markError]);

  const fetchBrowser = useCallback(async (epoch: number) => {
    try {
      // Check first — not every backup has browser history
      const hasRes = await sidecarCall<{ has_any: boolean }>('has_browser_history', { udid });
      if (loadEpochRef.current !== epoch) return;
      if (!hasRes.has_any) {
        // No history — remove from loading set without adding entries
        addEntries([], 'browser');
        return;
      }
      const res = await sidecarCall<{ visits: RawBrowserVisit[] }>(
        'list_browser_history',
        { udid }
      );
      if (loadEpochRef.current !== epoch) return;
      addEntries((res.visits ?? []).map(normalizeBrowserVisit), 'browser');
    } catch (e: any) {
      markError('browser', e.message || 'Failed to load browser history');
    }
  }, [udid, addEntries, markError]);

  // WhatsApp, read like Messages a chat at a time, newest chats first. A backup
  // without it, with none in it, or from a WhatsApp version this app can't read
  // yet is simply empty here (the WhatsApp screen explains which); only a store
  // that's there but unreadable is an error.
  const fetchWhatsApp = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<WhatsAppChatsResult>('list_whatsapp_chats', { udid });
      if (loadEpochRef.current !== epoch) return;
      if (res?.empty_reason) {
        addEntries([], 'whatsapp');
        return;
      }
      if (res?.error) {
        markError('whatsapp', res.error);
        return;
      }

      const sorted = [...(res?.conversations ?? [])].sort((a, b) =>
        (b.last_message_date || '').localeCompare(a.last_message_date || '')
      );
      const total = sorted.reduce((s, c) => s + (c.message_count || 0), 0);
      const entries: TimelineEntry[] = [];
      let loaded = 0;
      let capped = false;
      let failure: string | null = null;
      let flushedAt = Date.now();

      for (const conv of sorted) {
        if (loaded >= MAX_WHATSAPP) {
          capped = true;
          break;
        }
        try {
          let offset = 0;
          while (true) {
            const page = await sidecarCall<WhatsAppMessagesResult>(
              'get_whatsapp_messages',
              { udid, chat_id: conv.chat_id, offset, limit: CHAT_PAGE }
            );
            if (loadEpochRef.current !== epoch) return;
            // A chat that can't be read is skipped; the rest still load
            if (page?.error) {
              if (!page.empty_reason) failure ??= page.error;
              break;
            }
            const messages = page?.messages ?? [];
            for (const m of messages) {
              const entry = normalizeWhatsApp(m, conv);
              if (entry) entries.push(entry);
            }
            loaded += messages.length;
            offset += CHAT_PAGE;
            if (messages.length === 0 || offset >= (page?.total ?? 0)) break;
            // One chat can be bigger than the allowance: keep its newest messages and stop
            if (loaded >= MAX_WHATSAPP) {
              capped = true;
              break;
            }
          }
        } catch (e: any) {
          if (loadEpochRef.current !== epoch) return;
          failure ??= e?.message || "Couldn't read a WhatsApp chat";
        }
        if (Date.now() - flushedAt > FLUSH_MS) {
          putWhatsApp(entries);
          flushedAt = Date.now();
        }
      }

      putWhatsApp(entries);
      setWhatsappCap(capped ? { loaded, total } : null);
      // Every chat failed: say so. Some did: show what could be read.
      if (entries.length === 0 && failure) {
        markError('whatsapp', failure);
        return;
      }
      setLoadingTypes(prev => {
        const next = new Set(prev);
        next.delete('whatsapp');
        return next;
      });
    } catch (e: any) {
      if (loadEpochRef.current !== epoch) return;
      markError('whatsapp', e?.message || "Couldn't read WhatsApp");
    }
  }, [udid, addEntries, putWhatsApp, markError]);

  const fetchAddressBook = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ contacts: AddressCard[] }>('list_contacts', { udid });
      if (loadEpochRef.current !== epoch) return;
      setAddressBook(res.contacts ?? []);
      setIdentifierGroupMap(buildIdentifierGroupMap(res.contacts ?? []));
    } catch {
      // Non-critical: people are grouped by number alone, and the card links are left out
      setAddressBook([]);
    }
  }, [udid]);

  const load = useCallback(() => {
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
    setRawEntries([]);
    setErrors({});
    setMessageCap(null);
    setWhatsappCap(null);
    setAddressBook(null);
    setLoadingTypes(new Set(ALL_KINDS));
    conversationsRef.current = null;
    messagesDoneRef.current = false;
    dayEntriesRef.current = [];
    daysAskedRef.current = new Set();

    // Fire all fetches in parallel; each one updates state independently
    fetchMessages(epoch);
    fetchWhatsApp(epoch);
    fetchCalls(epoch);
    fetchPhotos(epoch);
    fetchVoicemail(epoch);
    fetchNotes(epoch);
    fetchBrowser(epoch);
    fetchAddressBook(epoch);
  }, [fetchMessages, fetchWhatsApp, fetchCalls, fetchPhotos, fetchVoicemail, fetchNotes, fetchBrowser, fetchAddressBook]);

  useEffect(() => {
    load();
    // Closing the backup stops the load
    return () => {
      loadEpochRef.current += 1;
    };
  }, [load]);

  const loadDay = useCallback(async (day: string) => {
    if (messagesDoneRef.current || daysAskedRef.current.has(day)) return;
    daysAskedRef.current.add(day);
    const epoch = loadEpochRef.current;
    try {
      const conversations = conversationsRef.current
        ?? (await sidecarCall<{ conversations: Conversation[] }>('list_conversations', { udid })).conversations;
      const byId = new Map(conversations.map(c => [c.chat_id, c]));
      const res = await sidecarCall<{ conversations: { chat_id: number; messages: Message[] }[] }>(
        'get_messages_on_day',
        { udid, day }
      );
      if (loadEpochRef.current !== epoch || messagesDoneRef.current) return;
      const dayEntries: TimelineEntry[] = [];
      for (const { chat_id, messages } of res.conversations) {
        const conv = byId.get(chat_id);
        if (conv) dayEntries.push(...messages.filter(m => !m.is_reaction).map(m => normalizeMessage(m, conv)));
      }
      dayEntriesRef.current = [...dayEntriesRef.current, ...dayEntries];
      setRawEntries(prev => {
        const have = new Set(prev.map(e => e.id));
        return [...prev, ...dedupe(dayEntries).filter(e => !have.has(e.id))];
      });
    } catch {
      // The full load still reaches that day
    }
  }, [udid]);

  // Load all messages (user-triggered, removes the cap)
  const loadAllMessages = useCallback(async () => {
    if (!messageCap) return;
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
    setLoadingTypes(prev => new Set([...prev, 'message']));
    try {
      const { conversations } = await sidecarCall<{ conversations: Conversation[] }>(
        'list_conversations',
        { udid }
      );
      if (loadEpochRef.current !== epoch) return;
      const entries: TimelineEntry[] = [];
      for (const conv of conversations) {
        try {
          const { messages } = await sidecarCall<{ messages: Message[]; total: number; next_offset: number }>(
            'get_messages',
            { udid, chat_id: conv.chat_id, offset: 0, limit: conv.message_count }
          );
          if (loadEpochRef.current !== epoch) return;
          entries.push(...messages.filter(m => !m.is_reaction).map(m => normalizeMessage(m, conv)));
        } catch {
          // Skip
        }
      }
      addEntries(entries, 'message');
      setMessageCap(null);
    } catch (e: any) {
      markError('message', e.message || 'Failed to load all messages');
    }
  }, [udid, messageCap, addEntries, markError]);

  // Sorted once here, so every filter downstream keeps the order for free
  const entries = useMemo(
    () => [...rawEntries].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? '')),
    [rawEntries],
  );

  const contacts = useMemo((): ContactOption[] => buildContactOptions(rawEntries), [rawEntries]);

  const counts = useMemo((): Record<TimelineEntryType, number> => {
    const c: Record<TimelineEntryType, number> = {
      message: 0, whatsapp: 0, call: 0, photo: 0, voicemail: 0, note: 0, browser: 0,
    };
    for (const e of rawEntries) c[e.type]++;
    // When messages are capped, show the real total rather than the loaded subset
    if (messageCap) c.message = messageCap.total;
    if (whatsappCap) c.whatsapp = whatsappCap.total;
    return c;
  }, [rawEntries, messageCap, whatsappCap]);

  return useMemo(() => ({
    entries,
    contacts,
    addressBook,
    identifierGroupMap,
    counts,
    loading: loadingTypes.size > 0,
    loadingTypes,
    errors,
    messageCap,
    whatsappCap,
    loadAllMessages,
    loadDay,
    refresh: load,
  }), [entries, contacts, addressBook, identifierGroupMap, counts, loadingTypes, errors, messageCap, whatsappCap, loadAllMessages, loadDay, load]);
}

// ── One filtered view of it ───────────────────────────────────────────────────

export interface UseTimelineReturn {
  /** Everything loaded, before any filter, newest first. */
  allEntries: TimelineEntry[];
  entries: TimelineEntry[];
  filteredEntries: TimelineEntry[];
  allContacts: ContactOption[];
  counts: Record<TimelineEntryType, number>;
  totalFiltered: number;
  loading: boolean;
  loadingTypes: Set<TimelineEntryType>;
  errors: Partial<Record<TimelineEntryType, string>>;
  messageCap: { loaded: number; total: number } | null;
  whatsappCap: { loaded: number; total: number } | null;
  filters: TimelineFilters;
  setFilters: (patch: Partial<TimelineFilters>) => void;
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  loadAllMessages: () => Promise<void>;
  refresh: () => void;
}

// `startingFilters` opens the view on a filter, such as a day from the Year view.
export function useTimeline(index: BackupIndex, startingFilters?: Partial<TimelineFilters>): UseTimelineReturn {
  const [filters, setFiltersState] = useState<TimelineFilters>({ ...DEFAULT_FILTERS, ...startingFilters });
  const [page, setPage] = useState(0);
  const { entries: allEntries, contacts: allContacts, identifierGroupMap, loadDay } = index;

  // Opening on one day with messages showing: read that day ahead of the rest
  const openDay = filters.dateFrom && filters.dateFrom === filters.dateTo && filters.types.has('message')
    ? filters.dateFrom
    : null;
  useEffect(() => {
    if (openDay) loadDay(openDay);
  }, [openDay, loadDay]);

  // ── Filtered entries, newest first ────────────────────────────────────────
  const filteredEntries = useMemo((): TimelineEntry[] => {
    const { types, contactIdentifier, dateFrom, dateTo, searchQuery } = filters;
    const terms = parseQuery(searchQuery);
    // Use local midnight for both bounds so the user's chosen calendar day is
    // respected regardless of their UTC offset.  Appending 'T00:00:00' (no Z)
    // makes the Date constructor treat it as local time, matching 'T23:59:59'.
    const fromMs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const toMs = dateTo ? new Date(dateTo + 'T23:59:59.999').getTime() : null;

    // ── Contact matching ───────────────────────────────────────────────────
    // When a contact is selected we match entries three ways:
    //  1. Identifier match (exact, normalised phone, or address-book group)
    //  2. Name match (same resolved display name), for texts, calls and voicemail
    //  3. Unattributed entries (photos, notes, browser) shown within the
    //     communication window of matched entries.
    // A WhatsApp message is theirs by its number (or a number on their card)
    // only, never by name: People counts it the same way (gather.ts).
    let matchesContact: ((e: TimelineEntry) => boolean) | null = null;

    if (contactIdentifier) {
      const { rows: theirs, name: selectedName } = matchPerson(contactIdentifier, allEntries, allContacts, identifierGroupMap);

      // Collect every raw identifier seen in the entries that belongs to
      // this contact, plus track the communication-window timestamps.
      const contactIds = new Set<string>();
      let minTs = Infinity;
      let maxTs = -Infinity;

      for (const e of theirs) {
        contactIds.add(e.contactIdentifier!);
        if (e.timestamp) {
          const ts = new Date(e.timestamp).getTime();
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
      }

      // Every number and address on the cards of the identifiers above, worked
      // out the first time a WhatsApp message needs it: their WhatsApp number
      // can be on their card without being on any of their texts or calls.
      let cardIds: Set<string> | null = null;
      const onTheirCards = (id: string): boolean => {
        if (cardIds === null) {
          cardIds = new Set();
          for (const cid of contactIds) for (const x of getContactGroup(cid, identifierGroupMap) ?? []) cardIds.add(x);
        }
        return cardIds.has(id) || cardIds.has(id.toLowerCase()) || cardIds.has(normPhone(id));
      };

      matchesContact = (e: TimelineEntry): boolean => {
        // Entries with an identifier: check against collected set
        if (e.contactIdentifier) {
          if (contactIds.has(e.contactIdentifier)) return true;
          // Normalised phone fallback for slight formatting differences
          for (const cid of contactIds) {
            if (identifiersMatch(cid, e.contactIdentifier)) return true;
          }
          if (e.type === 'whatsapp') return onTheirCards(e.contactIdentifier);
          if (selectedName && e.contactName?.toLowerCase() === selectedName) return true;
          return false;
        }
        // A WhatsApp chat with no number WhatsApp could tie it to isn't anyone's
        if (e.type === 'whatsapp') return false;
        // Entries with a name but no identifier
        if (e.contactName) {
          return selectedName ? e.contactName.toLowerCase() === selectedName : false;
        }
        // Unattributed entries (photos, notes, browser): show within communication window
        if (e.timestamp && minTs !== Infinity) {
          const ts = new Date(e.timestamp).getTime();
          return ts >= minTs && ts <= maxTs;
        }
        return false;
      };
    }

    return allEntries.filter(e => {
      if (!types.has(e.type)) return false;

      if (matchesContact && !matchesContact(e)) return false;

      if (fromMs || toMs) {
        if (!e.timestamp) return false; // undated entries can't be placed in a date range
        const ts = new Date(e.timestamp).getTime();
        if (fromMs && ts < fromMs) return false;
        if (toMs && ts > toMs) return false;
      }

      return terms.length === 0 || matchesTerms(searchText(e), terms);
    });
  }, [allEntries, filters, allContacts, identifierGroupMap]);

  // ── Paginated slice ───────────────────────────────────────────────────────
  const entries = useMemo(() => {
    const start = page * PAGE_SIZE;
    return filteredEntries.slice(start, start + PAGE_SIZE);
  }, [filteredEntries, page]);

  const setFilters = useCallback((patch: Partial<TimelineFilters>) => {
    setFiltersState(prev => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

  return {
    allEntries,
    entries,
    filteredEntries,
    allContacts,
    counts: index.counts,
    totalFiltered: filteredEntries.length,
    loading: index.loading,
    loadingTypes: index.loadingTypes,
    errors: index.errors,
    messageCap: index.messageCap,
    whatsappCap: index.whatsappCap,
    filters,
    setFilters,
    page,
    setPage,
    pageSize: PAGE_SIZE,
    loadAllMessages: index.loadAllMessages,
    refresh: index.refresh,
  };
}
