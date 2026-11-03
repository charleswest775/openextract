import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { sidecarCall } from '../../lib/ipc';
import { formatRelative, formatDate } from '../../lib/dates';
import { LinesIcon, SearchIcon } from '../shared/Icons';
import ChatBubble from './ChatBubble';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { ConversationModeChoice, FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { plural, saveConversation, saveConversations, type ConversationFormat } from '../../lib/saveData';

interface Conversation {
  chat_id: number;
  chat_identifier: string;
  display_name: string;
  service: string;
  message_count: number;
  last_message_date: string;
  last_message_preview: string;
  is_group: boolean;
}

interface Message {
  message_id: number;
  text: string | null;
  message_type: string;
  link_preview?: { url?: string; title?: string; summary?: string; sitename?: string };
  date: string;
  is_from_me: boolean;
  sender: string;
  sender_handle: string;
  has_attachments: boolean;
  is_reaction: boolean;
  attachments?: { attachment_id: number; filename: string; mime_type: string; transfer_name: string; total_bytes: number }[];
}

const CONVERSATION_FORMATS = [FORMATS.html, FORMATS.pdf, FORMATS.csv, FORMATS.txt];

const PAGE_SIZE = 200;
const LOAD_MORE_SIZE = 200;

interface Props {
  udid: string;
  /** Open this conversation instead of the most recent one. */
  openChatId?: number | null;
}

export default function MessageExplorer({ udid, openChatId }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeChat, setActiveChat] = useState<number | null>(null);
  const [totalMessages, setTotalMessages] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [convoSearch, setConvoSearch] = useState('');
  const [minMessageCount, setMinMessageCount] = useState(0);
  const [convDateFilter, setConvDateFilter] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<number>>(new Set());
  // Which Save dialog is open: the conversation on screen, or the ones ticked in Select mode
  const [choosing, setChoosing] = useState<'one' | 'selected' | null>(null);
  const [bulkExportMode, setBulkExportMode] = useState<'merged' | 'separate'>('separate');
  const { busy: exporting, run } = useSaveAction('messages');

  const offsetRef = useRef(0);
  const epochRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef(false);
  const [slowLoading, setSlowLoading] = useState(false);
  const slowLoadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadConversations();
  }, [udid]);

  async function loadConversations() {
    setLoading(true);
    try {
      const result = await sidecarCall<{ conversations: Conversation[] }>('list_conversations', { udid });
      setConversations(result.conversations);
      // Open on the asked-for conversation, else the most recent one rather than an empty pane
      const first = result.conversations.find(c => c.chat_id === openChatId) ?? result.conversations[0];
      if (first) loadMessages(first.chat_id);
    } finally {
      setLoading(false);
    }
  }

  // Scroll to bottom after messages update when switching conversations
  useEffect(() => {
    if (scrollToBottomRef.current && messageContainerRef.current) {
      scrollToBottomRef.current = false;
      messageContainerRef.current.scrollTop = messageContainerRef.current.scrollHeight;
    }
  }, [messages]);

  async function loadMessages(chatId: number, offset = 0) {
    setLoading(true);
    if (offset === 0) {
      setMessages([]);
      setTotalMessages(0);
      setHasMore(false);
      setActiveChat(chatId);
      setSearch('');
      offsetRef.current = 0;
      epochRef.current += 1;
      scrollToBottomRef.current = true;
      if (slowLoadingTimerRef.current) clearTimeout(slowLoadingTimerRef.current);
      slowLoadingTimerRef.current = setTimeout(() => setSlowLoading(true), 500);
    }
    const epoch = epochRef.current;
    try {
      const result = await sidecarCall<{ messages: Message[]; total: number; next_offset: number }>(
        'get_messages', { udid, chat_id: chatId, offset, limit: offset === 0 ? PAGE_SIZE : LOAD_MORE_SIZE }
      );
      if (epochRef.current !== epoch) return;
      if (offset === 0) {
        setMessages(result.messages);
      } else {
        setMessages(prev => [...result.messages, ...prev]);
      }
      const newOffset = result.next_offset ?? offset + result.messages.length;
      offsetRef.current = newOffset;
      setTotalMessages(result.total);
      setHasMore(newOffset < result.total);
    } finally {
      setLoading(false);
      if (slowLoadingTimerRef.current) clearTimeout(slowLoadingTimerRef.current);
      setSlowLoading(false);
    }
  }

  async function handleSearch() {
    if (!search.trim()) return;
    setLoading(true);
    epochRef.current += 1;
    try {
      const result = await sidecarCall<{ results: Message[] }>(
        'search_messages', { udid, query: search, chat_id: activeChat ?? undefined, limit: 500 }
      );
      setMessages(result.results);
      setTotalMessages(result.results.length);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  function saveOne(format: ConversationFormat) {
    setChoosing(null);
    const convo = activeConvo;
    if (convo) run(() => saveConversation(udid, convo, format));
  }

  const filteredConversations = conversations.filter((c) => {
    if (convoSearch) {
      const q = convoSearch.toLowerCase();
      if (
        !c.display_name.toLowerCase().includes(q) &&
        !c.chat_identifier.toLowerCase().includes(q) &&
        !c.last_message_preview.toLowerCase().includes(q)
      ) return false;
    }
    if (minMessageCount > 0 && c.message_count < minMessageCount) return false;
    if (convDateFilter) {
      if (!c.last_message_date) return false;
      const convDate = new Date(c.last_message_date);
      const filterDate = new Date(convDateFilter + 'T00:00:00');
      if (convDate < filterDate) return false;
    }
    return true;
  });

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
    if (convos.length > 0) run(() => saveConversations(udid, convos, format, bulkExportMode));
  }

  const loadMore = useCallback(() => {
    if (activeChat !== null && hasMore && !loading) {
      loadMessages(activeChat, offsetRef.current);
    }
  }, [activeChat, hasMore, loading]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop < 100 && hasMore && !loading) {
      loadMore();
    }
  }, [hasMore, loading, loadMore]);

  const activeConvo = conversations.find(c => c.chat_id === activeChat);

  // Group messages by date (memoized to avoid recalculating on every render)
  const groupedMessages = useMemo(() => {
    const groups: { date: string; messages: Message[] }[] = [];
    let currentDate = '';
    for (const msg of messages) {
      const d = formatDate(msg.date);
      if (d !== currentDate) {
        currentDate = d;
        groups.push({ date: d, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [messages]);

  const activeFilters = (minMessageCount > 0 ? 1 : 0) + (convDateFilter ? 1 : 0);
  const allSelected = filteredConversations.length > 0 && filteredConversations.every(c => selectedChats.has(c.chat_id));

  return (
    <div className={`h-full flex flex-col${slowLoading ? ' cursor-wait' : ''}`}>
      <PageHeader
        title="Messages"
        count={conversations.length > 0 ? plural(conversations.length, 'conversation') : undefined}
        search={{ value: convoSearch, onChange: setConvoSearch, placeholder: 'Search conversations' }}
        actions={
          selectMode ? (
            <SaveButton
              primary
              onClick={() => setChoosing('selected')}
              busy={exporting}
              disabled={selectedChats.size === 0}
              label={selectedChats.size > 0 ? `Save ${plural(selectedChats.size, 'conversation')}` : 'Save selected'}
            />
          ) : (
            <SaveButton onClick={() => setChoosing('one')} busy={exporting} disabled={!activeConvo} label="Save conversation" />
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
          {filteredConversations.map((c) => {
            const name = c.display_name || c.chat_identifier;
            const isOn = selectMode ? selectedChats.has(c.chat_id) : activeChat === c.chat_id;
            return (
              <button
                key={c.chat_id}
                onClick={() => {
                  if (selectMode) toggleChatSelection(c.chat_id);
                  else loadMessages(c.chat_id);
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
                    <span className="text-sm font-medium text-text-primary truncate">{name}</span>
                    <span className="text-xs text-text-tertiary flex-shrink-0">{formatRelative(c.last_message_date)}</span>
                  </span>
                  <span className="block text-xs text-text-secondary truncate mt-0.5">{c.last_message_preview}</span>
                  <span className="block text-xs text-text-tertiary mt-0.5">
                    {plural(c.message_count, 'message')}
                    {c.service !== 'iMessage' && ` · ${c.service}`}
                  </span>
                </span>
              </button>
            );
          })}
          {filteredConversations.length === 0 && !loading && (
            <div className="p-4 text-sm text-text-secondary text-center">
              {conversations.length > 0 ? 'No conversations match' : 'No conversations in this backup'}
            </div>
          )}
          {filteredConversations.length > 0 && filteredConversations.length !== conversations.length && (
            <div className="px-3 py-2 text-xs text-text-tertiary text-center">
              {filteredConversations.length} of {conversations.length} conversations
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
                {(activeConvo.display_name || activeConvo.chat_identifier || '?')[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="text-base font-semibold text-text-primary truncate">
                  {activeConvo.display_name || activeConvo.chat_identifier}
                </div>
                <div className="text-xs text-text-secondary truncate">
                  {plural(totalMessages, 'message')}
                  {activeConvo.is_group && ' · Group'}
                </div>
              </div>
              <div className="relative flex-shrink-0">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" size={18} />
                <input
                  type="search"
                  aria-label="Search this conversation"
                  placeholder="Search messages"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className="h-10 pl-10 pr-3 text-sm bg-surface rounded-full border border-rule focus:outline-none focus:border-accent w-40 lg:w-56"
                />
              </div>
            </div>

            {/* Messages */}
            <div ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4" onScroll={handleScroll}>
              {hasMore && (
                <button onClick={loadMore} className="w-full text-center text-sm text-accent py-2 hover:underline mb-2">
                  Load older messages
                </button>
              )}
              {groupedMessages.map((group) => (
                <div key={group.date}>
                  <div className="text-center my-3">
                    <span className="text-xs text-text-secondary bg-sand px-3 py-0.5 rounded-full">{group.date}</span>
                  </div>
                  {group.messages.map((msg) => (
                    <ChatBubble
                      key={msg.message_id}
                      message={msg}
                      showSender={activeConvo.is_group}
                      udid={udid}
                    />
                  ))}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </>
        ) : (
          !loading && <EmptyState icon={LinesIcon} title="Pick a conversation to read it" />
        )}
      </div>
      </div>

      {choosing === 'one' && activeConvo && (
        <SaveDialog
          title={`Save your conversation with ${activeConvo.display_name || activeConvo.chat_identifier}`}
          formats={CONVERSATION_FORMATS}
          onSave={saveOne}
          onCancel={() => setChoosing(null)}
        />
      )}
      {choosing === 'selected' && (
        <SaveDialog
          title={`Save ${plural(selectedChats.size, 'conversation')}`}
          formats={CONVERSATION_FORMATS}
          onSave={saveSelected}
          onCancel={() => setChoosing(null)}
        >
          {selectedChats.size > 1 && <ConversationModeChoice mode={bulkExportMode} onChange={setBulkExportMode} />}
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
