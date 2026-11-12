import { useState, useEffect, useCallback, useRef, useMemo, type ComponentType, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { sidecarCall } from '../../lib/ipc';
import { formatRelative } from '../../lib/dates';
import { groupByDay, isOffDay } from '../../lib/dayGroups';
import { LinesIcon } from '../shared/Icons';
import ChatBubble, { type AttachmentProps, type BubbleMessage, type MapPreviewProps } from './ChatBubble';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import Highlight from '../shared/Highlight';
import { ReportProblemButton } from '../shared/Feedback';
import SaveDialog, { ConversationModeChoice, FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import type { BackupIndex } from '../../hooks/useTimeline';
import type { TimelineEntry, TimelineEntryType } from '../../types/timeline';
import { plural, saveConversation, saveConversations, type ConversationFormat, type SaveResult } from '../../lib/saveData';
import { matches, matchesTerms, parseQuery, haystack, type Term } from '../../lib/search';
import type { Icon } from './sections';
import type { WhatsAppSearchHit } from '../../types/whatsapp';

/** A message the engine's whole-store search found (search_whatsapp_messages). */
export type FoundMessage = WhatsAppSearchHit;

/** A conversation as the list shows it: Messages' shape; WhatsApp's chats add the optional fields. */
export interface ChatListItem {
  chat_id: number;
  chat_identifier: string;
  display_name: string;
  service: string;
  message_count: number;
  last_message_date: string | null;
  last_message_preview: string;
  is_group: boolean;
  /** WhatsApp: the other person's number in a one-to-one chat. */
  handle?: string;
  chat_type?: string;
  archived?: boolean;
}

/**
 * Where a two-pane chat screen reads from: Messages (sms.db) or WhatsApp
 * (ChatStorage.sqlite). Both page the same way (offsets count back from the
 * newest message, each page oldest first), but their ids collide, so every
 * call, index entry and saved file goes through the source's own names and
 * never the other's.
 */
export interface ChatSource {
  /** The feedback area and the area a save is counted under. */
  area: 'messages' | 'whatsapp';
  title: string;
  icon: Icon;
  rpc: { list: string; page: string; offset: string };
  /** This source's entries in the shared index, for the "still reading" note. */
  entryType: TimelineEntryType;
  stillReading: string;
  /** Message ids the search matches, per chat, in the order the chat reads. */
  hitsByChat: (entries: TimelineEntry[], terms: Term[]) => Map<number, number[]>;
  /**
   * When the shared index couldn't hold every message: the engine searches
   * the whole store instead, and the hits it finds are added to the index's.
   * Without it (Messages) the screen searches the index only.
   */
  fullSearch?: {
    /** The index stopped short of this source's messages. */
    capped: (index: BackupIndex) => boolean;
    /** Every message in the store the query finds; rejects with why it couldn't search. */
    search: (udid: string, query: string) => Promise<FoundMessage[]>;
    /** The index's hits plus what the engine found, per chat, in reading order. */
    merge: (indexHits: Map<number, number[]>, found: FoundMessage[], terms: Term[]) => Map<number, number[]>;
    /** The line over the list while it searches, and once it has. */
    searching: string;
    searched: string;
  };
  /** What one item in the list is called: "conversation", "chat". */
  noun: string;
  name: (c: ChatListItem) => string;
  /** What the list's search matches a chat on besides its messages: what its row shows. */
  listMatchFields: (c: ChatListItem) => (string | null | undefined)[];
  /** What a row says after its message count, each after a " · ". */
  rowDetails: (c: ChatListItem) => string[];
  /** What the open chat's header says after its message count. */
  headerDetails: (c: ChatListItem) => string[];
  saveOneLabel: string;
  saveOneTitle: (name: string) => string;
  saveOne: (udid: string, c: ChatListItem, format: ConversationFormat) => Promise<SaveResult | null>;
  saveMany: (udid: string, cs: ChatListItem[], format: ConversationFormat, mode: 'separate' | 'merged') => Promise<SaveResult | null>;
  /**
   * The whole screen when there are no chats at all: why, calmly, or the
   * error with a Report button. Without it (Messages) the list says so in a line.
   */
  emptyScreen?: (emptyReason: string | null, error: string | null) => ReactNode;
  bubble: {
    variant: 'messages' | 'whatsapp';
    Attachment?: ComponentType<AttachmentProps>;
    MapPreview?: ComponentType<MapPreviewProps>;
  };
}

// sms.db messages the search matches, per conversation, oldest first
function messageHits(entries: TimelineEntry[], terms: Term[]): Map<number, number[]> {
  const by = new Map<number, number[]>();
  if (terms.length === 0) return by;
  for (const e of entries) {
    if (e.type !== 'message' || e.message?.chatId == null || !e.message.text) continue;
    if (!matchesTerms(haystack([e.message.text]), terms)) continue;
    const list = by.get(e.message.chatId) ?? [];
    list.push(Number(e.id.slice('message:'.length)));
    by.set(e.message.chatId, list);
  }
  // The index is newest first; step through a conversation oldest first, like reading it
  for (const list of by.values()) list.reverse();
  return by;
}

export const MESSAGES_SOURCE: ChatSource = {
  area: 'messages',
  title: 'Messages',
  icon: LinesIcon,
  rpc: { list: 'list_conversations', page: 'get_messages', offset: 'get_message_offset' },
  entryType: 'message',
  stillReading: 'Still reading messages, more may match…',
  hitsByChat: messageHits,
  noun: 'conversation',
  name: c => c.display_name || c.chat_identifier,
  // A conversation's identifier is its number or email, which its row shows when it has no name
  listMatchFields: c => [c.display_name, c.chat_identifier],
  rowDetails: c => (c.service !== 'iMessage' ? [c.service] : []),
  headerDetails: c => (c.is_group ? ['Group'] : []),
  saveOneLabel: 'Save conversation',
  saveOneTitle: name => `Save your conversation with ${name}`,
  saveOne: saveConversation,
  saveMany: saveConversations,
  bubble: { variant: 'messages' },
};

interface PageResult {
  messages: BubbleMessage[];
  total: number;
  next_offset: number;
  error?: string;
}

/** What the list call answers, for either source. */
export interface ChatListResult {
  conversations?: ChatListItem[];
  error?: string;
  empty_reason?: string;
}

/**
 * The engine's answer for the list, read the voicemail way: a reason
 * (not_in_backup, no_records) is a calm empty, unsupported_format says why in
 * place of the list, and only an error with no reason is a store that
 * couldn't be read (shown with a Report button).
 */
export function readChatList(result: ChatListResult | null | undefined): {
  conversations: ChatListItem[];
  emptyReason: string | null;
  unreadableNote: string | null;
  listError: string | null;
} {
  return {
    conversations: Array.isArray(result?.conversations) ? result.conversations : [],
    emptyReason: result?.empty_reason ?? null,
    unreadableNote: result?.empty_reason === 'unsupported_format' ? result.error ?? null : null,
    listError: result?.error && !result.empty_reason ? result.error : null,
  };
}

/** What the list says when it shows no chats and hasn't failed. */
export function emptyListText(o: {
  nouns: string; total: number; query: string; unreadableNote: string | null;
}): string {
  if (o.total === 0) return o.unreadableNote ?? `No ${o.nouns} in this backup`;
  return o.query ? `No messages match "${o.query}"` : `No ${o.nouns} match`;
}

/**
 * The chats the list shows. While searching: those with a match, those whose
 * row matches, and the chat opened from elsewhere (a search result, People)
 * for as long as the search it was opened with stays, so the screen doesn't
 * move away from the message it was asked to show while the index is still
 * being read. The filters apply to every chat.
 */
export function visibleChats(conversations: ChatListItem[], o: {
  query: string;
  hitsByChat: Map<number, number[]>;
  listMatchFields: (c: ChatListItem) => (string | null | undefined)[];
  keptChat: number | null;
  minMessageCount: number;
  activeSince: string;
}): ChatListItem[] {
  const since = o.activeSince ? new Date(o.activeSince + 'T00:00:00') : null;
  return conversations.filter((c) => {
    if (o.query && c.chat_id !== o.keptChat && !o.hitsByChat.has(c.chat_id)
      && !matches(o.query, ...o.listMatchFields(c))) return false;
    if (o.minMessageCount > 0 && c.message_count < o.minMessageCount) return false;
    if (since) {
      if (!c.last_message_date) return false;
      if (new Date(c.last_message_date) < since) return false;
    }
    return true;
  });
}

/**
 * A search that hides the open chat opens the first chat that matches: the
 * chat to open, or null to stay.
 */
export function chatAfterSearch(visible: ChatListItem[], activeChat: number | null, query: string): number | null {
  if (!query || activeChat === null || visible.length === 0) return null;
  return visible.some(c => c.chat_id === activeChat) ? null : visible[0].chat_id;
}

const CONVERSATION_FORMATS = [FORMATS.html, FORMATS.pdf, FORMATS.csv, FORMATS.txt];

const PAGE_SIZE = 200;
const LOAD_MORE_SIZE = 200;

export interface MessageExplorerProps {
  udid: string;
  /** Every message in the backup, read once: what the search box matches against. */
  index: BackupIndex;
  /** What the top search box holds: conversations without a match are hidden, matches are marked. */
  query: string;
  /** Open this conversation instead of the most recent one. */
  openChatId?: number | null;
  /** Open the conversation at this message (a search result) instead of at its newest. */
  openMessageId?: number | null;
}

interface Props extends MessageExplorerProps {
  /** Messages unless told otherwise. */
  source?: ChatSource;
}

export default function MessageExplorer({ udid, index, query, openChatId, openMessageId, source = MESSAGES_SOURCE }: Props) {
  const [conversations, setConversations] = useState<ChatListItem[]>([]);
  const [messages, setMessages] = useState<BubbleMessage[]>([]);
  const [activeChat, setActiveChat] = useState<number | null>(null);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Opened partway down a long conversation: there are newer messages below
  const [hasNewer, setHasNewer] = useState(false);
  const [loading, setLoading] = useState(false);
  // Why there are no conversations, when the engine can't read this sms.db (iOS 5 and earlier)
  const [unreadableNote, setUnreadableNote] = useState<string | null>(null);
  // The list has been asked for once: until then, nothing says it's empty
  const [listLoaded, setListLoaded] = useState(false);
  // The list couldn't be read (as opposed to being empty), and the engine's reason for an empty one
  const [listError, setListError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  // A page of the open conversation couldn't be read
  const [pageError, setPageError] = useState<string | null>(null);
  const [minMessageCount, setMinMessageCount] = useState(0);
  const [convDateFilter, setConvDateFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<number>>(new Set());
  // Which Save dialog is open: the conversation on screen, or the ones ticked in Select mode
  const [choosing, setChoosing] = useState<'one' | 'selected' | null>(null);
  const [bulkExportMode, setBulkExportMode] = useState<'merged' | 'separate'>('separate');
  // The match being shown, as a message id
  const [currentHit, setCurrentHit] = useState<number | null>(openMessageId ?? null);
  // The chat opened from elsewhere (a search result, People): kept in the list until the search changes
  const [keptChat, setKeptChat] = useState<number | null>(openChatId ?? null);
  const { busy: exporting, run } = useSaveAction(source.area);

  // Offsets count from the newest message: [newest, oldest) is what's loaded
  const offsetRef = useRef(0);
  const newestRef = useRef(0);
  const epochRef = useRef(0);
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef(false);
  const scrollToMessageRef = useRef<number | null>(null);
  const [slowLoading, setSlowLoading] = useState(false);
  const slowLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── What the search box matches ──────────────────────────────────────────
  const terms = useMemo(() => parseQuery(query), [query]);
  // Message ids that match, per conversation, in reading order
  const indexHits = useMemo(
    () => source.hitsByChat(index.entries, terms),
    [index.entries, terms, source],
  );

  // Too many messages for the index to hold: the engine searches every chat as well
  const fullSearch = source.fullSearch;
  const capped = !!fullSearch && fullSearch.capped(index);
  const [found, setFound] = useState<{ query: string; results: FoundMessage[] | null; error?: string } | null>(null);
  useEffect(() => {
    if (!fullSearch || !capped || terms.length === 0) {
      setFound(null);
      return;
    }
    let live = true;
    // Wait for typing to pause: each search reads the whole store
    const timer = setTimeout(() => {
      fullSearch.search(udid, query).then(
        results => { if (live) setFound({ query, results }); },
        e => { if (live) setFound({ query, results: null, error: String((e as Error)?.message ?? e) }); },
      );
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [udid, query, terms, capped, fullSearch]);
  const searchedAll = capped && found !== null && found.query === query ? found : null;
  const hitsByChat = useMemo(
    () => (fullSearch && searchedAll?.results ? fullSearch.merge(indexHits, searchedAll.results, terms) : indexHits),
    [fullSearch, searchedAll, indexHits, terms],
  );

  const hits = activeChat !== null ? hitsByChat.get(activeChat) ?? [] : [];
  const hitAt = currentHit !== null ? hits.indexOf(currentHit) : -1;

  useEffect(() => {
    loadConversations();
  }, [udid]);

  async function loadConversations() {
    setLoading(true);
    setListError(null);
    try {
      const result = await sidecarCall<ChatListResult>(source.rpc.list, { udid });
      const read = readChatList(result);
      const list = read.conversations;
      setConversations(list);
      setEmptyReason(read.emptyReason);
      setUnreadableNote(read.unreadableNote);
      // An error with no reason is a store that couldn't be read, not an empty one
      if (read.listError) setListError(read.listError);
      // Open on the asked-for conversation, else the most recent one rather than an empty pane
      const first = list.find(c => c.chat_id === openChatId) ?? list[0];
      if (first) openChat(first.chat_id, first.chat_id === openChatId ? openMessageId ?? undefined : undefined);
    } catch (e) {
      setConversations([]);
      setListError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
      setListLoaded(true);
    }
  }

  // After messages change: scroll to the message asked for, or to the bottom when switching conversations
  useEffect(() => {
    const box = messageContainerRef.current;
    if (!box) return;
    if (scrollToMessageRef.current !== null) {
      const el = box.querySelector(`[data-message-id="${scrollToMessageRef.current}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        scrollToMessageRef.current = null;
        return;
      }
    }
    if (scrollToBottomRef.current) {
      scrollToBottomRef.current = false;
      box.scrollTop = box.scrollHeight;
    }
  }, [messages]);

  function startLoading() {
    setLoading(true);
    if (slowLoadingTimerRef.current) clearTimeout(slowLoadingTimerRef.current);
    slowLoadingTimerRef.current = setTimeout(() => setSlowLoading(true), 500);
  }

  function stopLoading() {
    setLoading(false);
    if (slowLoadingTimerRef.current) clearTimeout(slowLoadingTimerRef.current);
    setSlowLoading(false);
  }

  /** Open a conversation at its newest message, or around one message. */
  async function openChat(chatId: number, atMessage?: number) {
    epochRef.current += 1;
    const epoch = epochRef.current;
    setActiveChat(chatId);
    setMessages([]);
    setTotalMessages(0);
    setHasMore(false);
    setHasNewer(false);
    setPageError(null);
    startLoading();
    try {
      let start = 0;
      if (atMessage != null) {
        try {
          const pos = await sidecarCall<{ offset: number; found: boolean }>(
            source.rpc.offset, { udid, chat_id: chatId, message_id: atMessage },
          );
          if (pos?.found) start = Math.max(0, pos.offset - PAGE_SIZE / 2);
        } catch {
          // Open at the newest instead
        }
        if (epochRef.current !== epoch) return;
      }
      const result = await readPage(chatId, start, PAGE_SIZE);
      if (epochRef.current !== epoch) return;
      newestRef.current = start;
      offsetRef.current = result.next_offset ?? start + result.messages.length;
      setTotalMessages(result.total);
      setHasMore(offsetRef.current < result.total);
      setHasNewer(start > 0);
      if (atMessage != null) scrollToMessageRef.current = atMessage;
      else scrollToBottomRef.current = true;
      setMessages(result.messages);
    } catch (e) {
      if (epochRef.current === epoch) setPageError(String((e as Error)?.message ?? e));
    } finally {
      if (epochRef.current === epoch) stopLoading();
    }
  }

  /** One page, or an error saying why it couldn't be read (the engine reports some in the result). */
  async function readPage(chatId: number, offset: number, limit: number): Promise<PageResult> {
    const result = await sidecarCall<PageResult>(source.rpc.page, { udid, chat_id: chatId, offset, limit });
    const page = Array.isArray(result?.messages) ? result.messages : [];
    if (result?.error && page.length === 0) throw new Error(result.error);
    return { ...result, messages: page, total: result?.total ?? page.length };
  }

  async function loadOlder() {
    if (activeChat === null) return;
    const epoch = epochRef.current;
    setPageError(null);
    startLoading();
    try {
      const offset = offsetRef.current;
      const result = await readPage(activeChat, offset, LOAD_MORE_SIZE);
      if (epochRef.current !== epoch) return;
      setMessages(prev => [...result.messages, ...prev]);
      offsetRef.current = result.next_offset ?? offset + result.messages.length;
      setTotalMessages(result.total);
      setHasMore(offsetRef.current < result.total);
    } catch (e) {
      if (epochRef.current === epoch) setPageError(String((e as Error)?.message ?? e));
    } finally {
      if (epochRef.current === epoch) stopLoading();
    }
  }

  async function loadNewer() {
    if (activeChat === null || newestRef.current === 0) return;
    const epoch = epochRef.current;
    setPageError(null);
    startLoading();
    try {
      const start = Math.max(0, newestRef.current - LOAD_MORE_SIZE);
      const result = await readPage(activeChat, start, newestRef.current - start);
      if (epochRef.current !== epoch) return;
      setMessages(prev => [...prev, ...result.messages]);
      newestRef.current = start;
      setHasNewer(start > 0);
    } catch (e) {
      if (epochRef.current === epoch) setPageError(String((e as Error)?.message ?? e));
    } finally {
      if (epochRef.current === epoch) stopLoading();
    }
  }

  /** Show one message: scroll to it if it's loaded, else load the messages around it. */
  function showMessage(messageId: number) {
    setCurrentHit(messageId);
    const box = messageContainerRef.current;
    const el = box?.querySelector(`[data-message-id="${messageId}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (activeChat !== null) openChat(activeChat, messageId);
  }

  // A new search, or a conversation picked while searching: once it's loaded, go to its newest match.
  // Opened on a message a search found, stay on that message.
  const jumpPending = useRef(openMessageId == null);
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setCurrentHit(null);
    // A new search: the chat opened from elsewhere is just another chat now
    setKeptChat(null);
    jumpPending.current = true;
  }, [query]);
  useEffect(() => {
    if (!jumpPending.current || loading || hits.length === 0 || messages.length === 0) return;
    jumpPending.current = false;
    showMessage(hits[hits.length - 1]);
  }, [query, activeChat, hits, messages.length, loading]);

  function saveOne(format: ConversationFormat) {
    setChoosing(null);
    const convo = activeConvo;
    if (convo) run(() => source.saveOne(udid, convo, format));
  }

  const filteredConversations = useMemo(() => visibleChats(conversations, {
    query, hitsByChat, listMatchFields: source.listMatchFields, keptChat, minMessageCount, activeSince: convDateFilter,
  }), [conversations, query, hitsByChat, source, keptChat, minMessageCount, convDateFilter]);

  // A search that hides the open conversation opens the first one that matches
  useEffect(() => {
    const next = chatAfterSearch(filteredConversations, activeChat, query);
    if (next !== null) openChat(next);
  }, [filteredConversations]);

  function toggleChatSelection(chatId: number) {
    setSelectedChats(prev => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedChats(new Set(filteredConversations.map(c => c.chat_id)));
  }

  function clearSelection() {
    setSelectedChats(new Set());
  }

  function saveSelected(format: ConversationFormat) {
    setChoosing(null);
    const convos = conversations.filter(c => selectedChats.has(c.chat_id));
    if (convos.length > 0) run(() => source.saveMany(udid, convos, format, bulkExportMode));
  }

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // After a failed page, wait for "Load older messages" rather than asking again on every scroll
    if (el.scrollTop < 100 && hasMore && !loading && !pageError) loadOlder();
  }, [hasMore, loading, activeChat, pageError]);

  const activeConvo = conversations.find(c => c.chat_id === activeChat);

  // Group messages by day (memoized to avoid recalculating on every render)
  const groupedMessages = useMemo(() => groupByDay(messages), [messages]);
  const noun = source.noun;
  const nouns = `${noun}s`;

  const activeFilters = (minMessageCount > 0 ? 1 : 0) + (convDateFilter ? 1 : 0);
  const allSelected = filteredConversations.length > 0 && filteredConversations.every(c => selectedChats.has(c.chat_id));

  // A source with its own empty screen (WhatsApp) uses the whole page to say why there's nothing
  if (source.emptyScreen && listLoaded && !loading && conversations.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title={source.title} />
        <div className="flex-1 overflow-y-auto">{source.emptyScreen(emptyReason, listError)}</div>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col${slowLoading ? ' cursor-wait' : ''}`}>
      <PageHeader
        title={source.title}
        count={conversations.length > 0
          ? (query
            ? `${filteredConversations.length} of ${plural(conversations.length, noun)}`
            : plural(conversations.length, noun))
          : undefined}
        actions={
          selectMode ? (
            <SaveButton
              primary
              onClick={() => setChoosing('selected')}
              busy={exporting}
              disabled={selectedChats.size === 0}
              label={selectedChats.size > 0 ? `Save ${plural(selectedChats.size, noun)}` : 'Save selected'}
            />
          ) : (
            <SaveButton onClick={() => setChoosing('one')} busy={exporting} disabled={!activeConvo} label={source.saveOneLabel} />
          )
        }
      />
      <div className="flex-1 flex min-h-0">
      {/* Conversation list */}
      <div className="w-[300px] flex-shrink-0 border-r border-rule flex flex-col">
        <div className="px-3 py-2.5 border-b border-rule flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFiltersOpen(o => !o)}
              aria-expanded={filtersOpen}
              className={`hearth-ghost-btn !px-3 !py-1.5 ${activeFilters > 0 ? '!border-accent text-accent' : ''}`}
            >
              <SlidersHorizontal size={16} />
              Filter{activeFilters > 0 ? ` (${activeFilters})` : ''}
            </button>
            <div className="flex-1" />
            {selectMode && (
              <button
                onClick={() => (allSelected ? clearSelection() : selectAllFiltered())}
                className="text-sm text-accent hover:underline"
              >
                {allSelected ? 'Select none' : 'Select all'}
              </button>
            )}
            <button
              onClick={() => {
                if (selectMode) { clearSelection(); setSelectMode(false); }
                else setSelectMode(true);
              }}
              className="hearth-ghost-btn !px-3 !py-1.5"
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          </div>
          {filtersOpen && (
            <div className="flex flex-col gap-2 pt-1">
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="w-28 flex-shrink-0">At least</span>
                <input
                  type="number"
                  min={0}
                  value={minMessageCount || ''}
                  placeholder="0"
                  onChange={(e) => setMinMessageCount(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-20 px-2 py-1 text-sm bg-surface rounded-md border border-rule focus:outline-none focus:border-accent"
                />
                <span>messages</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="w-28 flex-shrink-0">Active since</span>
                <input
                  type="date"
                  value={convDateFilter}
                  onChange={(e) => setConvDateFilter(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1 text-sm bg-surface rounded-md border border-rule focus:outline-none focus:border-accent"
                />
                {convDateFilter && (
                  <button
                    onClick={() => setConvDateFilter('')}
                    className="text-text-tertiary hover:text-text-primary text-lg leading-none"
                    aria-label="Clear date"
                  >
                    &times;
                  </button>
                )}
              </label>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          {query && fullSearch && capped ? (
            // The index couldn't hold every message, so the engine searched the whole store
            searchedAll?.error ? (
              <div className="px-3 py-2 text-xs text-text-secondary border-b border-rule" role="alert">
                Couldn't search every {noun}: {searchedAll.error}
                <div><ReportProblemButton error={searchedAll.error} area={source.area} className="mt-1" /></div>
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-text-tertiary border-b border-rule" role="status">
                {searchedAll ? fullSearch.searched : fullSearch.searching}
              </div>
            )
          ) : query && index.loadingTypes.has(source.entryType) && (
            <div className="px-3 py-2 text-xs text-text-tertiary border-b border-rule">{source.stillReading}</div>
          )}
          {filteredConversations.map((c) => {
            const name = source.name(c);
            const isOn = selectMode ? selectedChats.has(c.chat_id) : activeChat === c.chat_id;
            const matched = hitsByChat.get(c.chat_id)?.length ?? 0;
            return (
              <button
                key={c.chat_id}
                onClick={() => {
                  if (selectMode) toggleChatSelection(c.chat_id);
                  else {
                    setCurrentHit(null);
                    jumpPending.current = true;
                    openChat(c.chat_id);
                  }
                }}
                aria-current={!selectMode && activeChat === c.chat_id ? 'true' : undefined}
                aria-pressed={selectMode ? selectedChats.has(c.chat_id) : undefined}
                className={`w-full px-3 py-2.5 text-left border-b border-rule transition-colors flex items-center gap-3 ${
                  isOn ? 'bg-accent-wash' : 'hover:bg-surface'
                }`}
              >
                {selectMode ? (
                  <span className={`flex-shrink-0 w-6 h-6 rounded-md border-2 flex items-center justify-center ${
                    selectedChats.has(c.chat_id) ? 'bg-accent border-accent text-white' : 'border-border-strong bg-surface'
                  }`}>
                    {selectedChats.has(c.chat_id) && (
                      <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2 6 5 9 10 3" />
                      </svg>
                    )}
                  </span>
                ) : (
                  // Drawn from data-initials so the row's text starts with the name (scripts click rows by name)
                  <span
                    aria-hidden="true"
                    data-initials={initials(name)}
                    className="flex-shrink-0 w-10 h-10 rounded-full bg-sand flex items-center justify-center text-sm font-medium text-text-secondary before:content-[attr(data-initials)]"
                  />
                )}
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary truncate"><Highlight text={name} query={query} /></span>
                    <span className="text-xs text-text-tertiary flex-shrink-0">{formatRelative(c.last_message_date)}</span>
                  </span>
                  {query ? (
                    <span className="block text-xs text-accent font-medium mt-0.5">
                      {matched > 0 ? plural(matched, 'match', 'matches')
                        : matches(query, ...source.listMatchFields(c)) ? 'Name matches' : 'Opened from search'}
                    </span>
                  ) : (
                    <span className="block text-xs text-text-secondary truncate mt-0.5">{c.last_message_preview}</span>
                  )}
                  <span className="block text-xs text-text-tertiary mt-0.5">
                    {plural(c.message_count, 'message')}
                    {source.rowDetails(c).map(d => ` · ${d}`).join('')}
                  </span>
                </span>
              </button>
            );
          })}
          {filteredConversations.length === 0 && !loading && listLoaded && (
            listError && conversations.length === 0 ? (
              <div className="p-4 text-sm text-text-secondary text-center" role="alert">
                Couldn't read the {nouns}
                <div className="text-xs mt-1 break-words">{listError}</div>
                <ReportProblemButton error={listError} area={source.area} className="mt-2" />
              </div>
            ) : (
              <div className="p-4 text-sm text-text-secondary text-center">
                {emptyListText({ nouns, total: conversations.length, query, unreadableNote })}
              </div>
            )
          )}
          {!query && filteredConversations.length > 0 && filteredConversations.length !== conversations.length && (
            <div className="px-3 py-2 text-xs text-text-tertiary text-center">
              {filteredConversations.length} of {conversations.length} {nouns}
            </div>
          )}
        </div>
      </div>

      {/* Message view */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeConvo ? (
          <>
            {/* Chat header */}
            <div className="px-5 py-3 border-b border-rule flex items-center gap-3 bg-base">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-serif text-lg flex-shrink-0"
                style={{ background: `radial-gradient(circle at 35% 30%, oklch(78% 0.09 14), oklch(58% 0.10 14))` }}
              >
                {(source.name(activeConvo) || '?')[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="text-base font-semibold text-text-primary truncate">
                  {source.name(activeConvo)}
                </div>
                <div className="text-xs text-text-secondary truncate">
                  {plural(totalMessages, 'message')}
                  {source.headerDetails(activeConvo).map(d => ` · ${d}`).join('')}
                </div>
              </div>
              {/* Step through this conversation's matches */}
              {query && hits.length > 0 && (
                <div className="flex items-center gap-1 flex-shrink-0" role="group" aria-label="Matches in this conversation">
                  <span className="text-sm text-text-secondary tabular-nums mr-1">
                    {hitAt >= 0 ? `${hitAt + 1} of ${hits.length}` : plural(hits.length, 'match', 'matches')}
                  </span>
                  <button
                    onClick={() => showMessage(hits[hitAt > 0 ? hitAt - 1 : hits.length - 1])}
                    title="Earlier match"
                    aria-label="Earlier match"
                    className="w-9 h-9 rounded-full border border-rule flex items-center justify-center hover:bg-surface"
                  >
                    <ChevronUp size={18} />
                  </button>
                  <button
                    onClick={() => showMessage(hits[hitAt >= 0 && hitAt < hits.length - 1 ? hitAt + 1 : 0])}
                    title="Later match"
                    aria-label="Later match"
                    className="w-9 h-9 rounded-full border border-rule flex items-center justify-center hover:bg-surface"
                  >
                    <ChevronDown size={18} />
                  </button>
                </div>
              )}
            </div>

            {/* Messages */}
            <div
              ref={messageContainerRef}
              data-thread-scroll=""
              className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4"
              onScroll={handleScroll}
            >
              {pageError && messages.length === 0 && !loading ? (
                <EmptyState
                  icon={source.icon}
                  title={`Couldn't read this ${noun}`}
                  detail={<>{pageError}<div><ReportProblemButton error={pageError} area={source.area} className="mt-2" /></div></>}
                />
              ) : pageError && (
                <div role="alert" className="text-center text-sm text-text-secondary mb-2">
                  Couldn't read more of this {noun}: {pageError}
                  <div><ReportProblemButton error={pageError} area={source.area} className="mt-1" /></div>
                </div>
              )}
              {hasMore && (
                <button onClick={loadOlder} className="w-full text-center text-sm text-accent py-2 hover:underline mb-2">
                  Load older messages
                </button>
              )}
              {groupedMessages.map((group) => (
                <div key={group.key}>
                  <div className="text-center my-3">
                    <span className="text-xs text-text-secondary bg-sand px-3 py-0.5 rounded-full">{group.label}</span>
                  </div>
                  {group.messages.map((msg) => (
                    <ChatBubble
                      key={msg.message_id}
                      message={msg}
                      showSender={activeConvo.is_group}
                      udid={udid}
                      query={query}
                      current={msg.message_id === currentHit}
                      showDate={isOffDay(msg.date, group)}
                      variant={source.bubble.variant}
                      Attachment={source.bubble.Attachment}
                      MapPreview={source.bubble.MapPreview}
                      onQuoteClick={showMessage}
                    />
                  ))}
                </div>
              ))}
              {hasNewer && (
                <button onClick={loadNewer} className="w-full text-center text-sm text-accent py-2 hover:underline mt-2">
                  Load newer messages
                </button>
              )}
            </div>
          </>
        ) : (
          !loading && <EmptyState icon={source.icon} title={`Pick a ${noun} to read it`} />
        )}
      </div>
      </div>

      {choosing === 'one' && activeConvo && (
        <SaveDialog
          title={source.saveOneTitle(source.name(activeConvo))}
          formats={CONVERSATION_FORMATS}
          onSave={saveOne}
          onCancel={() => setChoosing(null)}
        />
      )}
      {choosing === 'selected' && (
        <SaveDialog
          title={`Save ${plural(selectedChats.size, noun)}`}
          formats={CONVERSATION_FORMATS}
          onSave={saveSelected}
          onCancel={() => setChoosing(null)}
        >
          {selectedChats.size > 1 && <ConversationModeChoice mode={bulkExportMode} onChange={setBulkExportMode} noun={noun} />}
        </SaveDialog>
      )}
    </div>
  );
}

// "Karin Lindqvist" → "KL", "Switchbacks & Snacks" → "SS", "+15035550190" → "#"
function initials(name: string): string {
  const words = name.split(/\s+/).filter(w => /^[\p{L}]/u.test(w));
  if (words.length === 0) return '#';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}
