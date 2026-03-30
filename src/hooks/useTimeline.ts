import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { sidecarCall } from '../lib/ipc';
import {
  TimelineEntry,
  TimelineEntryType,
  TimelineFilters,
  ContactOption,
  DEFAULT_FILTERS,
} from '../types/timeline';
import type { Conversation, Message } from './useMessages';
import type { PhotoAsset } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "T84QZS65DQ.com.facebook.Facebook" → "Facebook"
function appDisplayName(bundleId: string): string {
  const withoutTeam = bundleId.replace(/^[A-Z0-9]{10}\./, '');
  const parts = withoutTeam.split('.');
  return parts[parts.length - 1] || bundleId;
}

// Maximum messages loaded on initial timeline fetch (across all conversations)
const MAX_MESSAGES = 2000;
const PAGE_SIZE = 100;

// ── Phone-number normalizer ────────────────────────────────────────────────────
// Strips all non-digits and returns the last 10 digits so that "+1 (555) 123-4567",
// "15551234567", "+15551234567", and "5551234567" all compare equal.
function normPhone(s: string): string {
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Returns true when two contact identifiers refer to the same entity.
// Falls back to normalised phone comparison when exact strings differ.
function identifiersMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normPhone(a);
  const nb = normPhone(b);
  return na.length >= 7 && nb.length >= 7 && na === nb;
}

// ── Normalizers ────────────────────────────────────────────────────────────────

function normalizeMessage(msg: Message, conv: Conversation): TimelineEntry {
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
    },
  };
}

interface RawCall {
  call_id: number;
  address: string;
  contact_name: string;
  date: string;
  duration: number;
  direction: string;
  status: string;
  app: string;
}

function normalizeCall(call: RawCall): TimelineEntry {
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

interface RawVoicemail {
  id: number;
  phone_number: string;
  contact_name: string;
  date_received: string;
  duration: number;
  is_read: boolean;
  transcript?: string;
}

function normalizeVoicemail(vm: RawVoicemail): TimelineEntry {
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
    timestamp: note.created,
    contactName: null,
    contactIdentifier: null,
    note: {
      title: note.title || 'Untitled',
      bodyPreview: (note.body || '').slice(0, 120),
      modified: note.modified,
    },
  };
}

// ── Hook ───────────────────────────────────────────────────────────────────────

export interface UseTimelineReturn {
  entries: TimelineEntry[];
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

export function useTimeline(udid: string): UseTimelineReturn {
  const [rawEntries, setRawEntries] = useState<TimelineEntry[]>([]);
  const [loadingTypes, setLoadingTypes] = useState<Set<TimelineEntryType>>(
    new Set(['message', 'call', 'photo', 'voicemail', 'note'])
  );
  const [errors, setErrors] = useState<Partial<Record<TimelineEntryType, string>>>({});
  const [messageCap, setMessageCap] = useState<{ loaded: number; total: number } | null>(null);
  const [filters, setFiltersState] = useState<TimelineFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const loadEpochRef = useRef(0);

  const addEntries = useCallback((incoming: TimelineEntry[], type: TimelineEntryType) => {
    setRawEntries(prev => {
      // Deduplicate by id in case of re-fetch
      const existingIds = new Set(prev.filter(e => e.type === type).map(e => e.id));
      const fresh = incoming.filter(e => !existingIds.has(e.id));
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

      // Sort by most recent, then cap total messages fetched
      const sorted = [...conversations].sort((a, b) =>
        (b.last_message_date || '').localeCompare(a.last_message_date || '')
      );

      let loaded = 0;
      const totalAcross = sorted.reduce((s, c) => s + c.message_count, 0);
      const entries: TimelineEntry[] = [];

      for (const conv of sorted) {
        if (loaded >= MAX_MESSAGES) break;
        const remaining = MAX_MESSAGES - loaded;
        try {
          const { messages } = await sidecarCall<{ messages: Message[]; total: number; next_offset: number }>(
            'get_messages',
            { udid, chat_id: conv.chat_id, offset: 0, limit: Math.min(remaining, conv.message_count) }
          );
          if (loadEpochRef.current !== epoch) return;
          entries.push(...messages.filter(m => !m.is_reaction).map(m => normalizeMessage(m, conv)));
          loaded += messages.length;
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
  }, [udid, addEntries, markError]);

  const fetchCalls = useCallback(async (epoch: number) => {
    try {
      const res = await sidecarCall<{ calls: RawCall[] }>(
        'list_calls',
        { udid, limit: 10000 }
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
      // Load up to 2000 photos for the timeline (same cap as messages)
      const res = await sidecarCall<{ photos: PhotoAsset[]; total: number }>(
        'list_photos',
        { udid, offset: 0, limit: 2000 }
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

  const load = useCallback(() => {
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
    setRawEntries([]);
    setErrors({});
    setMessageCap(null);
    setLoadingTypes(new Set(['message', 'call', 'photo', 'voicemail', 'note']));
    setPage(0);

    // Fire all fetches in parallel; each one updates state independently
    fetchMessages(epoch);
    fetchCalls(epoch);
    fetchPhotos(epoch);
    fetchVoicemail(epoch);
    fetchNotes(epoch);
  }, [fetchMessages, fetchCalls, fetchPhotos, fetchVoicemail, fetchNotes]);

  useEffect(() => {
    load();
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
  const allContacts = useMemo((): ContactOption[] => {
    // Keyed by normalised phone / raw identifier so the same person isn't
    // listed twice when calls use "+15551234567" and messages use "5551234567".
    const seen = new Map<string, ContactOption>();
    for (const e of rawEntries) {
      if (e.contactIdentifier && e.contactName) {
        const np = normPhone(e.contactIdentifier);
        const key = np.length >= 7 ? np : e.contactIdentifier.toLowerCase();
        if (!seen.has(key)) {
          seen.set(key, { identifier: e.contactIdentifier, name: e.contactName });
        }
      }
    }
    return Array.from(seen.values())
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rawEntries]);

  // ── Counts per type (unfiltered) ──────────────────────────────────────────
  const counts = useMemo((): Record<TimelineEntryType, number> => {
    const c: Record<TimelineEntryType, number> = {
      message: 0, call: 0, photo: 0, voicemail: 0, note: 0,
    };
    for (const e of rawEntries) c[e.type]++;
    return c;
  }, [rawEntries]);

  // ── Filtered + sorted entries ─────────────────────────────────────────────
  const filteredEntries = useMemo((): TimelineEntry[] => {
    const { types, contactIdentifier, dateFrom, dateTo, searchQuery } = filters;
    const q = searchQuery.trim().toLowerCase();
    // Use local midnight for both bounds so the user's chosen calendar day is
    // respected regardless of their UTC offset.  Appending 'T00:00:00' (no Z)
    // makes the Date constructor treat it as local time, matching 'T23:59:59'.
    const fromMs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const toMs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : null;

    return rawEntries
      .filter(e => {
        if (!types.has(e.type)) return false;

        if (contactIdentifier && !identifiersMatch(contactIdentifier, e.contactIdentifier ?? '')) return false;

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
          ].filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }

        return true;
      })
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  }, [rawEntries, filters]);

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
    entries,
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
