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
  rowsForPerson,
} from '../lib/people';
import type { Conversation, Message } from './useMessages';
import type { PhotoAsset } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "T84QZS65DQ.com.facebook.Facebook" → "Facebook"
function appDisplayName(bundleId: string): string {
  const withoutTeam = bundleId.replace(/^[A-Z0-9]{10}\./, '');
  const parts = withoutTeam.split('.');
  return parts[parts.length - 1] || bundleId;
}

// Per-conversation cap ensures every contact is represented in the timeline.
// Global cap prevents extremely large backups from overwhelming the UI.
const MESSAGES_PER_CONV = 500;
const MAX_MESSAGES = 200000;
const PAGE_SIZE = 100;

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
      conversationName: conv.display_name || conv.chat_identifier,
      service: conv.service,
      chatId: conv.chat_id,
      isGroup: conv.is_group,
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
      bodyPreview: (note.body || '').slice(0, 120),
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

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface UseTimelineReturn {
  /** Everything loaded, before any filter, in no particular order. */
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
  filters: TimelineFilters;
  setFilters: (patch: Partial<TimelineFilters>) => void;
  page: number;
  setPage: (p: number) => void;
  pageSize: number;
  loadAllMessages: () => Promise<void>;
  refresh: () => void;
}

// `startingFilters` opens the Timeline on a filter, such as a day from the Year view.
export function useTimeline(udid: string, startingFilters?: Partial<TimelineFilters>): UseTimelineReturn {
  const [rawEntries, setRawEntries] = useState<TimelineEntry[]>([]);
  const [loadingTypes, setLoadingTypes] = useState<Set<TimelineEntryType>>(
    new Set(['message', 'call', 'photo', 'voicemail', 'note'])
  );
  const [errors, setErrors] = useState<Partial<Record<TimelineEntryType, string>>>({});
  const [messageCap, setMessageCap] = useState<{ loaded: number; total: number } | null>(null);
  const [filters, setFiltersState] = useState<TimelineFilters>({ ...DEFAULT_FILTERS, ...startingFilters });
  const [page, setPage] = useState(0);
  const loadEpochRef = useRef(0);
  const [identifierGroupMap, setIdentifierGroupMap] = useState<IdentifierGroupMap>(new Map());
  // The day to load in full first, when opening on one with messages showing.
  const openDay = startingFilters?.dateFrom
    && startingFilters.dateFrom === startingFilters.dateTo
    && (startingFilters.types?.has('message') ?? true)
    ? startingFilters.dateFrom
    : null;

  const addEntries = useCallback((incoming: TimelineEntry[], type: TimelineEntryType) => {
    setRawEntries(prev => {
      // Replaces this type's entries. A message can be in two chats: show it once.
      const seen = new Set<string>();
      const fresh = incoming.filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
      return [...prev.filter(e => e.type !== type), ...fresh];
    });
    setLoadingTypes(prev => {
      const next = new Set(prev);
      next.delete(type);
      return next;
    });
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

      // Opening on a day: show all of it now, even if the cap below would leave it out.
      const dayEntries: TimelineEntry[] = [];
      if (openDay) {
        try {
          const byId = new Map(conversations.map(c => [c.chat_id, c]));
          const day = await sidecarCall<{ conversations: { chat_id: number; messages: Message[] }[] }>(
            'get_messages_on_day',
            { udid, day: openDay }
          );
          if (loadEpochRef.current !== epoch) return;
          for (const { chat_id, messages } of day.conversations) {
            const conv = byId.get(chat_id);
            if (!conv) continue;
            dayEntries.push(...messages.filter(m => !m.is_reaction).map(m => normalizeMessage(m, conv)));
          }
          setRawEntries(prev => [...prev.filter(e => e.type !== 'message'), ...dayEntries]);
        } catch {
          // The full load below still shows what it reaches
        }
      }

      // Sort by most recent, then cap total messages fetched
      const sorted = [...conversations].sort((a, b) =>
        (b.last_message_date || '').localeCompare(a.last_message_date || '')
      );

      let loaded = 0;
      const totalAcross = sorted.reduce((s, c) => s + c.message_count, 0);
      const entries: TimelineEntry[] = [...dayEntries];

      for (const conv of sorted) {
        if (loaded >= MAX_MESSAGES) break;
        try {
          // Paginate through all messages in this conversation
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
      }

      addEntries(entries, 'message');
      if (loaded < totalAcross) {
        setMessageCap({ loaded, total: totalAcross });
      } else {
        setMessageCap(null);
      }
    } catch (e: any) {
      markError('message', e.message || 'Failed to load messages');
    }
  }, [udid, openDay, addEntries, markError]);

  const fetchCalls = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ calls: RawCall[] }>(
        'list_calls',
        { udid, limit: 999999 }
      );
      if (loadEpochRef.current !== epoch) return;
      // Calls may return an error field instead of crashing (e.g. unencrypted backup)
      if ((res as any).error) throw new Error((res as any).error);
      addEntries(res.calls.map(normalizeCall), 'call');
    } catch (e: any) {
      markError('call', e.message || 'Failed to load calls');
    }
  }, [udid, addEntries, markError]);

  const fetchPhotos = useCallback(async (epoch: number) => {
    try {
      // Load all photos for the timeline
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

  const fetchContactGroups = useCallback(async () => {
    try {
      const res = await sidecarCall<{ contacts: { phones: string[]; emails: string[] }[] }>(
        'list_contacts',
        { udid }
      );
      setIdentifierGroupMap(buildIdentifierGroupMap(res.contacts));
    } catch {
      // Non-critical — contact grouping is best-effort
    }
  }, [udid]);

  const load = useCallback(() => {
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
    setRawEntries([]);
    setErrors({});
    setMessageCap(null);
    setLoadingTypes(new Set(['message', 'call', 'photo', 'voicemail', 'note', 'browser']));
    setPage(0);

    // Fire all fetches in parallel; each one updates state independently
    fetchMessages(epoch);
    fetchCalls(epoch);
    fetchPhotos(epoch);
    fetchVoicemail(epoch);
    fetchNotes(epoch);
    fetchBrowser(epoch);
    fetchContactGroups();
  }, [fetchMessages, fetchCalls, fetchPhotos, fetchVoicemail, fetchNotes, fetchBrowser, fetchContactGroups]);

  useEffect(() => {
    load();
    // Leaving stops the load, so hopping between Year and Timeline doesn't stack them up.
    return () => {
      loadEpochRef.current += 1;
    };
  }, [load]);

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

  // ── Derived contact list ──────────────────────────────────────────────────
  const allContacts = useMemo((): ContactOption[] => buildContactOptions(rawEntries), [rawEntries]);

  // ── Counts per type (unfiltered) ──────────────────────────────────────────
  const counts = useMemo((): Record<TimelineEntryType, number> => {
    const c: Record<TimelineEntryType, number> = {
      message: 0, call: 0, photo: 0, voicemail: 0, note: 0, browser: 0,
    };
    for (const e of rawEntries) c[e.type]++;
    // When messages are capped, show the real total rather than the loaded subset
    if (messageCap) c.message = messageCap.total;
    return c;
  }, [rawEntries, messageCap]);

  // ── Filtered + sorted entries ─────────────────────────────────────────────
  const filteredEntries = useMemo((): TimelineEntry[] => {
    const { types, contactIdentifier, dateFrom, dateTo, searchQuery } = filters;
    const q = searchQuery.trim().toLowerCase();
    // Use local midnight for both bounds so the user's chosen calendar day is
    // respected regardless of their UTC offset.  Appending 'T00:00:00' (no Z)
    // makes the Date constructor treat it as local time, matching 'T23:59:59'.
    const fromMs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const toMs = dateTo ? new Date(dateTo + 'T23:59:59.999').getTime() : null;

    // ── Contact matching ───────────────────────────────────────────────────
    // When a contact is selected we match entries three ways:
    //  1. Identifier match (exact, normalised phone, or address-book group)
    //  2. Name match (same resolved display name)
    //  3. Unattributed entries (photos, notes, browser) shown within the
    //     communication window of matched entries.
    let matchesContact: ((e: TimelineEntry) => boolean) | null = null;

    if (contactIdentifier) {
      const selectedContact = allContacts.find(c => identifiersMatch(contactIdentifier, c.identifier));
      const selectedName = selectedContact?.name?.toLowerCase() ?? '';

      // Collect every raw identifier seen in rawEntries that belongs to
      // this contact, plus track the communication-window timestamps.
      const contactIds = new Set<string>();
      let minTs = Infinity;
      let maxTs = -Infinity;

      for (const e of rowsForPerson(contactIdentifier, rawEntries, allContacts, identifierGroupMap)) {
        contactIds.add(e.contactIdentifier!);
        if (e.timestamp) {
          const ts = new Date(e.timestamp).getTime();
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
      }

      matchesContact = (e: TimelineEntry): boolean => {
        // Entries with an identifier: check against collected set
        if (e.contactIdentifier) {
          if (contactIds.has(e.contactIdentifier)) return true;
          // Normalised phone fallback for slight formatting differences
          for (const cid of contactIds) {
            if (identifiersMatch(cid, e.contactIdentifier)) return true;
          }
          if (selectedName && e.contactName?.toLowerCase() === selectedName) return true;
          return false;
        }
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

    return rawEntries
      .filter(e => {
        if (!types.has(e.type)) return false;

        if (matchesContact && !matchesContact(e)) return false;

        if (fromMs || toMs) {
          if (!e.timestamp) return false; // undated entries can't be placed in a date range
          const ts = new Date(e.timestamp).getTime();
          if (fromMs && ts < fromMs) return false;
          if (toMs && ts > toMs) return false;
        }

        if (q) {
          const haystack = [
            e.contactName,
            e.message?.text,
            e.message?.conversationName,
            e.call?.app,
            e.photo?.filename,
            e.voicemail?.transcript,
            e.note?.title,
            e.note?.bodyPreview,
            e.browser?.title,
            e.browser?.domain,
            e.browser?.url,
          ].filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      })
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  }, [rawEntries, filters, allContacts, identifierGroupMap]);

  // ── Paginated slice ───────────────────────────────────────────────────────
  const entries = useMemo(() => {
    const start = page * PAGE_SIZE;
    return filteredEntries.slice(start, start + PAGE_SIZE);
  }, [filteredEntries, page]);

  const setFilters = useCallback((patch: Partial<TimelineFilters>) => {
    setFiltersState(prev => ({ ...prev, ...patch }));
    setPage(0);
  }, []);

  const loading = loadingTypes.size > 0;

  return {
    allEntries: rawEntries,
    entries,
    filteredEntries,
    allContacts,
    counts,
    totalFiltered: filteredEntries.length,
    loading,
    loadingTypes,
    errors,
    messageCap,
    filters,
    setFilters,
    page,
    setPage,
    pageSize: PAGE_SIZE,
    loadAllMessages,
    refresh: load,
  };
}
