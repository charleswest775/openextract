import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { Search, MessageSquare, Loader2, CheckSquare, Square } from 'lucide-react';
import { useMessages } from '../hooks/useMessages';
import { formatRelative } from '../lib/dates';
import { saveFolder } from '../lib/ipc';
import ChatBubble from './ChatBubble';

interface Props {
  udid: string;
}

function datePreset(months: number | null): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (months !== null) from.setMonth(from.getMonth() - months);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: months === null ? '' : fmt(from), to: fmt(to) };
}

function thisYearPreset(): { from: string; to: string } {
  const year = new Date().getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function localDateToISO(dateStr: string, endOfDay = false): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59)
    : new Date(year, month - 1, day, 0, 0, 0);
  return d.toISOString();
}

export default function MessageView({ udid }: Props) {
  const {
    conversations,
    messages,
    activeChat,
    totalMessages,
    hasMore,
    loading,
    selectedChats,
    loadConversations,
    loadMessages,
    loadMore,
    searchMessages,
    exportConversation,
    exportConversations,
    toggleChatSelection,
    selectAllChats,
    clearSelection,
  } = useMessages(udid);

  const [convSearch, setConvSearch] = useState('');
  const [minMessageCount, setMinMessageCount] = useState(0);
  const [convDateFilter, setConvDateFilter] = useState('');
  const [msgSearch, setMsgSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filtersActive, setFiltersActive] = useState(false);
  const [exportFormat, setExportFormat] = useState<'txt' | 'csv' | 'html'>('txt');
  const [exporting, setExporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [showBulkExportDialog, setShowBulkExportDialog] = useState(false);
  const [bulkExportMode, setBulkExportMode] = useState<'merged' | 'separate'>('separate');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Snapshot of scrollHeight taken just before a loadMore prepend, used to restore position.
  const prevScrollHeightRef = useRef<number>(0);
  // Prevents concurrent loadMore calls while one is in-flight.
  const loadingMoreRef = useRef(false);
  // Refs so the IntersectionObserver callback always sees current values without re-subscribing.
  const hasMoreRef = useRef(hasMore);
  const loadingRef = useRef(loading);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  // Only auto-scroll to bottom on initial load, not when prepending older messages
  const suppressAutoScroll = useRef(false);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Auto-select the first conversation so messages are visible without a manual click.
  useEffect(() => {
    if (conversations.length > 0 && activeChat === null) {
      loadMessages(conversations[0].chat_id);
    }
  }, [conversations, activeChat, loadMessages]);

  useEffect(() => {
    if (suppressAutoScroll.current) {
      suppressAutoScroll.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // After messages are prepended (loadMore), restore the scroll position so the viewport
  // stays anchored to the same message instead of jumping to the top.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || prevScrollHeightRef.current === 0) return;
    const diff = container.scrollHeight - prevScrollHeightRef.current;
    if (diff > 0) container.scrollTop += diff;
    prevScrollHeightRef.current = 0;
  }, [messages]);

  // Infinite scroll: watch the top sentinel and load more when it enters the viewport.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          hasMoreRef.current &&
          !loadingRef.current &&
          !loadingMoreRef.current
        ) {
          loadingMoreRef.current = true;
          suppressAutoScroll.current = true;
          prevScrollHeightRef.current = container.scrollHeight;
          loadMore().finally(() => { loadingMoreRef.current = false; });
        }
      },
      { root: container, threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const applyFilters = useCallback((query: string, from: string, to: string) => {
    if (!activeChat) return;
    const hasQuery = query.trim().length > 0;
    const hasDate = from || to;
    const utcFrom = from ? localDateToISO(from, false) : undefined;
    const utcTo = to ? localDateToISO(to, true) : undefined;
    if (hasQuery || hasDate) {
      setFiltersActive(true);
      if (hasQuery) {
        searchMessages(query.trim(), activeChat, utcFrom, utcTo);
      } else {
        loadMessages(activeChat, 0, 1000, utcFrom, utcTo);
      }
    } else {
      setFiltersActive(false);
      loadMessages(activeChat);
    }
  }, [activeChat, searchMessages, loadMessages]);

  function handleClearFilters(reload = true) {
    setMsgSearch('');
    setDateFrom('');
    setDateTo('');
    setFiltersActive(false);
    if (reload && activeChat) loadMessages(activeChat);
  }

  function applyPreset(from: string, to: string) {
    setDateFrom(from);
    setDateTo(to);
    applyFilters(msgSearch, from, to);
  }

  async function handleExport() {
    if (!activeChat) return;
    const dir = await saveFolder();
    if (!dir) return;
    setExporting(true);
    try {
      const result = await exportConversation(
        activeChat, exportFormat, dir,
        dateFrom ? localDateToISO(dateFrom, false) : undefined,
        dateTo ? localDateToISO(dateTo, true) : undefined,
        msgSearch.trim() || undefined
      );
      if (result) {
        alert(`Exported ${result.message_count} messages to:\n${result.file}`);
      }
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleBulkExport() {
    if (selectedChats.size === 0) return;
    const dir = await saveFolder();
    if (!dir) return;
    setExporting(true);
    setShowBulkExportDialog(false);
    try {
      const chatIds = Array.from(selectedChats);
      const conversationNames: Record<number, string> = {};
      for (const conv of conversations) {
        if (selectedChats.has(conv.chat_id)) {
          conversationNames[conv.chat_id] = conv.display_name;
        }
      }
      const result = await exportConversations(
        chatIds, conversationNames, exportFormat, dir, bulkExportMode,
        dateFrom ? localDateToISO(dateFrom, false) : undefined,
        dateTo ? localDateToISO(dateTo, true) : undefined,
        msgSearch.trim() || undefined
      );
      if (result) {
        const fileList = result.files.join('\n');
        alert(`Exported ${result.message_count} messages across ${result.files.length} file(s):\n${fileList}`);
      }
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  const filteredConversations = conversations.filter((c) => {
    if (convSearch) {
      const q = convSearch.toLowerCase();
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

  const activeConversation = conversations.find((c) => c.chat_id === activeChat);

  return (
    <div className="flex h-full bg-base">
      {/* Conversation list */}
      <div className="w-80 flex flex-col bg-surface flex-shrink-0" style={{ borderRight: '0.5px solid var(--border-default)' }}>
        <div className="p-3" style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
          <div className="relative">
            <Search size={14} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={convSearch}
              onChange={(e) => setConvSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-elevated text-body text-text-primary rounded-md focus:outline-none focus:ring-2 focus:shadow-focus placeholder:text-text-tertiary"
              style={{ border: '0.5px solid var(--border-default)' }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <button
              onClick={() => {
                if (selectMode) { clearSelection(); setSelectMode(false); }
                else setSelectMode(true);
              }}
              className={`text-caption px-2 py-1 rounded-md transition-colors ${
                selectMode
                  ? 'bg-accent text-white'
                  : 'bg-base text-text-secondary hover:bg-elevated'
              }`}
              style={{ border: '0.5px solid var(--border-default)' }}
            >
              {selectMode ? 'Cancel select' : 'Select'}
            </button>
            {selectMode && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const allIds = filteredConversations.map(c => c.chat_id);
                    if (selectedChats.size === allIds.length && allIds.every(id => selectedChats.has(id))) {
                      clearSelection();
                    } else {
                      selectAllChats(allIds);
                    }
                  }}
                  className="text-caption px-2 py-1 rounded-md bg-base text-text-secondary hover:bg-elevated transition-colors"
                  style={{ border: '0.5px solid var(--border-default)' }}
                >
                  {filteredConversations.length > 0 && filteredConversations.every(c => selectedChats.has(c.chat_id))
                    ? 'Deselect all'
                    : 'Select all'}
                </button>
                {selectedChats.size > 0 && (
                  <button
                    onClick={() => setShowBulkExportDialog(true)}
                    disabled={exporting}
                    className="text-caption px-2 py-1 rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                  >
                    {exporting ? 'Exporting...' : `Export ${selectedChats.size}`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="px-3 py-2 space-y-1.5" style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2">
            <label className="text-caption text-text-tertiary whitespace-nowrap">Min messages</label>
            <input
              type="number"
              min={0}
              value={minMessageCount || ''}
              placeholder="0"
              onChange={(e) => setMinMessageCount(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-2 py-1 text-caption bg-elevated text-text-primary rounded-md focus:outline-none focus:ring-2 focus:shadow-focus placeholder:text-text-tertiary"
              style={{ border: '0.5px solid var(--border-default)' }}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-caption text-text-tertiary whitespace-nowrap">After</label>
            <input
              type="date"
              value={convDateFilter}
              onChange={(e) => setConvDateFilter(e.target.value)}
              className="w-full px-2 py-1 text-caption bg-elevated text-text-primary rounded-md focus:outline-none focus:ring-2 focus:shadow-focus"
              style={{ border: '0.5px solid var(--border-default)' }}
            />
            {convDateFilter && (
              <button
                onClick={() => setConvDateFilter('')}
                className="text-caption text-text-tertiary hover:text-text-primary transition-colors flex-shrink-0"
                title="Clear date filter"
              >
                &times;
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && conversations.length === 0 && (
            <div className="flex items-center justify-center py-8 text-text-tertiary">
              <Loader2 size={16} strokeWidth={1.5} className="animate-spin mr-2" />
              <span className="text-body">Loading...</span>
            </div>
          )}
          {filteredConversations.map((conv) => (
            <button
              key={conv.chat_id}
              onClick={() => {
                if (selectMode) {
                  toggleChatSelection(conv.chat_id);
                } else {
                  handleClearFilters(false);
                  loadMessages(conv.chat_id);
                }
              }}
              className={`w-full text-left px-4 py-2.5 transition-colors duration-200 ${
                activeChat === conv.chat_id && !selectMode
                  ? 'bg-accent-subtle'
                  : selectMode && selectedChats.has(conv.chat_id)
                    ? 'bg-accent-subtle'
                    : 'hover:bg-sidebar-active'
              }`}
              style={{
                borderBottom: '0.5px solid var(--border-subtle)',
                borderLeft: (selectMode ? selectedChats.has(conv.chat_id) : activeChat === conv.chat_id)
                  ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {selectMode && (
                    selectedChats.has(conv.chat_id)
                      ? <CheckSquare size={16} strokeWidth={1.5} className="text-accent flex-shrink-0" />
                      : <Square size={16} strokeWidth={1.5} className="text-text-tertiary flex-shrink-0" />
                  )}
                  <div className="text-body font-medium text-text-primary truncate">
                    {conv.display_name}
                    {conv.is_group && (
                      <span className="ml-1 text-caption text-text-tertiary">Group</span>
                    )}
                  </div>
                </div>
                <span className="text-caption text-text-tertiary ml-2 flex-shrink-0">
                  {formatRelative(conv.last_message_date)}
                </span>
              </div>
              <div className={`text-caption text-text-secondary truncate mt-0.5 ${selectMode ? 'ml-6' : ''}`}>
                {conv.last_message_preview || 'No messages'}
              </div>
              <div className={`text-caption text-text-tertiary mt-0.5 ${selectMode ? 'ml-6' : ''}`}>
                {conv.message_count} messages
              </div>
            </button>
          ))}
        </div>
        <div className="p-2 text-caption text-text-tertiary text-center" style={{ borderTop: '0.5px solid var(--border-subtle)' }}>
          {filteredConversations.length !== conversations.length
            ? `${filteredConversations.length} of ${conversations.length} conversations`
            : `${conversations.length} conversations`}
        </div>
      </div>

      {/* Message display */}
      <div className="flex-1 flex flex-col bg-base min-w-0">
        {activeConversation ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 flex items-center justify-between gap-3 flex-shrink-0" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
              <div className="min-w-0 overflow-hidden">
                <div className="text-body font-medium text-text-primary truncate">{activeConversation.display_name}</div>
                <div className="text-caption text-text-secondary truncate">
                  {activeConversation.service} &middot; {totalMessages} {filtersActive ? 'matching' : ''} messages
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as 'txt' | 'csv' | 'html')}
                  className="text-body bg-surface text-text-primary rounded-md px-2 py-1 focus:outline-none focus:shadow-focus"
                  style={{ border: '0.5px solid var(--border-default)' }}
                >
                  <option value="txt">TXT</option>
                  <option value="csv">CSV</option>
                  <option value="html">HTML</option>
                </select>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="text-body text-text-accent hover:underline disabled:opacity-50"
                >
                  {exporting ? 'Exporting...' : filtersActive ? 'Export filtered' : 'Export'}
                </button>
              </div>
            </div>

            {/* Filter bar */}
            <div className="px-4 py-2 bg-surface flex-shrink-0 space-y-2" style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search in conversation..."
                  value={msgSearch}
                  onChange={(e) => setMsgSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyFilters(msgSearch, dateFrom, dateTo);
                  }}
                  className="flex-1 px-3 py-1.5 text-body bg-base text-text-primary rounded-md focus:outline-none focus:shadow-focus placeholder:text-text-tertiary"
                  style={{ border: '0.5px solid var(--border-default)' }}
                />
                <button
                  onClick={() => applyFilters(msgSearch, dateFrom, dateTo)}
                  className="px-3 py-1.5 text-body bg-accent text-white rounded-md hover:bg-accent-hover transition-colors"
                >
                  Search
                </button>
                {filtersActive && (
                  <button
                    onClick={() => handleClearFilters()}
                    className="px-3 py-1.5 text-body text-text-secondary bg-base rounded-md hover:bg-elevated transition-colors"
                    style={{ border: '0.5px solid var(--border-default)' }}
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-caption text-text-tertiary">Date:</span>
                {[
                  { label: '3 months', months: 3 },
                  { label: '6 months', months: 6 },
                  { label: '1 year', months: 12 },
                  { label: 'This year', months: null },
                  { label: 'All time', months: -1 },
                ].map(({ label, months }) => (
                  <button
                    key={label}
                    onClick={() => {
                      if (months === -1) {
                        // Load the full message set with no date filter
                        setDateFrom('');
                        setDateTo('');
                        setFiltersActive(false);
                        if (activeChat) {
                          const total = activeConversation?.message_count ?? 1_000_000;
                          loadMessages(activeChat, 0, total);
                        }
                      } else if (months === null) {
                        const p = thisYearPreset();
                        applyPreset(p.from, p.to);
                      } else {
                        const p = datePreset(months);
                        applyPreset(p.from, p.to);
                      }
                    }}
                    className="text-caption px-2 py-1 rounded-md bg-base text-text-secondary hover:bg-elevated transition-colors"
                    style={{ border: '0.5px solid var(--border-default)' }}
                  >
                    {label}
                  </button>
                ))}

                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    applyFilters(msgSearch, e.target.value, dateTo);
                  }}
                  className="text-caption px-2 py-1 rounded-md bg-base text-text-primary focus:outline-none focus:shadow-focus"
                  style={{ border: '0.5px solid var(--border-default)' }}
                />
                <span className="text-caption text-text-tertiary">to</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    applyFilters(msgSearch, dateFrom, e.target.value);
                  }}
                  className="text-caption px-2 py-1 rounded-md bg-base text-text-primary focus:outline-none focus:shadow-focus"
                  style={{ border: '0.5px solid var(--border-default)' }}
                />
              </div>
            </div>

            {/* Messages area */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 bg-surface">
              {/* Top sentinel — IntersectionObserver triggers loadMore when this is visible */}
              <div ref={topSentinelRef} />
              {/* Spinner shown while loading older messages (not the initial load) */}
              {loading && messages.length > 0 && (
                <div className="flex items-center justify-center py-3 text-text-tertiary">
                  <Loader2 size={14} strokeWidth={1.5} className="animate-spin mr-2" />
                  <span className="text-caption">Loading older messages…</span>
                </div>
              )}
              {loading && messages.length === 0 && (
                <div className="flex items-center justify-center py-8 text-text-tertiary">
                  <Loader2 size={16} strokeWidth={1.5} className="animate-spin mr-2" />
                  <span className="text-body">Loading...</span>
                </div>
              )}
              {!loading && messages.length === 0 && filtersActive && (
                <div className="text-center text-text-tertiary text-body py-8">No messages match the current filters.</div>
              )}
              <div className="space-y-1">
                {messages.map((msg) => (
                  <ChatBubble key={msg.message_id} message={msg} udid={udid} />
                ))}
              </div>
              <div ref={messagesEndRef} />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-text-tertiary">
            <div className="text-center">
              <MessageSquare size={32} strokeWidth={1.5} className="mx-auto mb-3 text-text-tertiary" />
              <p className="text-body">Select a conversation to view messages</p>
            </div>
          </div>
        )}
      </div>

      {/* Bulk export dialog */}
      {showBulkExportDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowBulkExportDialog(false)}>
          <div className="bg-surface rounded-lg p-6 w-96 shadow-xl" style={{ border: '0.5px solid var(--border-default)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-body font-medium text-text-primary mb-4">
              Export {selectedChats.size} conversation{selectedChats.size > 1 ? 's' : ''}
            </h3>

            <div className="space-y-3 mb-4">
              <label className="text-caption text-text-secondary">Export mode</label>
              <div className="space-y-2">
                <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-elevated transition-colors">
                  <input
                    type="radio"
                    name="bulkExportMode"
                    value="separate"
                    checked={bulkExportMode === 'separate'}
                    onChange={() => setBulkExportMode('separate')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-body text-text-primary">Separate files</div>
                    <div className="text-caption text-text-tertiary">Each conversation exported to its own file</div>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-elevated transition-colors">
                  <input
                    type="radio"
                    name="bulkExportMode"
                    value="merged"
                    checked={bulkExportMode === 'merged'}
                    onChange={() => setBulkExportMode('merged')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-body text-text-primary">Merged into one file</div>
                    <div className="text-caption text-text-tertiary">All messages sorted by timestamp with sender/recipient labels</div>
                  </div>
                </label>
              </div>

              <div>
                <label className="text-caption text-text-secondary">Format</label>
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as 'txt' | 'csv' | 'html')}
                  className="w-full mt-1 text-body bg-base text-text-primary rounded-md px-2 py-1.5 focus:outline-none focus:shadow-focus"
                  style={{ border: '0.5px solid var(--border-default)' }}
                >
                  <option value="txt">TXT</option>
                  <option value="csv">CSV</option>
                  <option value="html">HTML</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkExportDialog(false)}
                className="px-4 py-1.5 text-body text-text-secondary rounded-md hover:bg-elevated transition-colors"
                style={{ border: '0.5px solid var(--border-default)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkExport}
                className="px-4 py-1.5 text-body bg-accent text-white rounded-md hover:bg-accent-hover transition-colors"
              >
                Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
