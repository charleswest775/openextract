import { useEffect, useState, useRef, useCallback } from 'react';
import { useMessages } from '../hooks/useMessages';
import { formatRelative } from '../lib/dates';
import { saveFolder } from '../lib/ipc';
import ChatBubble from './ChatBubble';

interface Props {
  udid: string;
}

// Returns today / N-months-ago as YYYY-MM-DD strings (in local time)
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

/**
 * Convert a YYYY-MM-DD date string to a UTC ISO string using local midnight.
 * This ensures "March 1" means March 1 in the user's timezone, not UTC midnight.
 */
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
    loading,
    loadConversations,
    loadMessages,
    searchMessages,
    exportConversation,
  } = useMessages(udid);

  // Conversation list search
  const [convSearch, setConvSearch] = useState('');

  // In-conversation filters
  const [msgSearch, setMsgSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filtersActive, setFiltersActive] = useState(false);

  // Export
  const [exportFormat, setExportFormat] = useState<'txt' | 'csv' | 'html'>('txt');
  const [exporting, setExporting] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  // Auto-select the first conversation so messages are visible without a manual click.
  useEffect(() => {
    if (conversations.length > 0 && activeChat === null) {
      loadMessages(conversations[0].chat_id);
    }
  }, [conversations, activeChat, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Apply filters (debounced via a button or on Enter; date fields apply immediately)
  const applyFilters = useCallback((query: string, from: string, to: string) => {
    if (!activeChat) return;
    const hasQuery = query.trim().length > 0;
    const hasDate = from || to;
    // Convert local date strings to UTC ISO so the backend compares in the user's timezone
    const utcFrom = from ? localDateToISO(from, false) : undefined;
    const utcTo = to ? localDateToISO(to, true) : undefined;
    if (hasQuery || hasDate) {
      setFiltersActive(true);
      if (hasQuery) {
        searchMessages(query.trim(), activeChat, utcFrom, utcTo);
      } else {
        // Date-only filter: use loadMessages with date params
        loadMessages(activeChat, 0, 500, utcFrom, utcTo);
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

  const filteredConversations = convSearch
    ? conversations.filter(
        (c) =>
          c.display_name.toLowerCase().includes(convSearch.toLowerCase()) ||
          c.chat_identifier.toLowerCase().includes(convSearch.toLowerCase()) ||
          c.last_message_preview.toLowerCase().includes(convSearch.toLowerCase())
      )
    : conversations;

  const activeConversation = conversations.find((c) => c.chat_id === activeChat);

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div className="w-80 border-r border-gray-200 flex flex-col bg-white flex-shrink-0">
        <div className="p-3 border-b border-gray-100">
          <input
            type="text"
            placeholder="Search conversations..."
            value={convSearch}
            onChange={(e) => setConvSearch(e.target.value)}
            className="w-full px-3 py-2 bg-gray-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && conversations.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-sm">Loading conversations...</div>
          )}
          {filteredConversations.map((conv) => (
            <button
              key={conv.chat_id}
              onClick={() => {
                handleClearFilters(false);
                loadMessages(conv.chat_id);
              }}
              className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                activeChat === conv.chat_id ? 'bg-blue-50' : ''
              }`}
            >
              <div className="flex justify-between items-start">
                <div className="font-medium text-sm text-gray-900 truncate flex-1">
                  {conv.display_name}
                  {conv.is_group && (
                    <span className="ml-1 text-xs text-gray-400">👥</span>
                  )}
                </div>
                <span className="text-xs text-gray-400 ml-2 flex-shrink-0">
                  {formatRelative(conv.last_message_date)}
                </span>
              </div>
              <div className="text-xs text-gray-500 truncate mt-0.5">
                {conv.last_message_preview || 'No messages'}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                {conv.message_count} messages · {conv.service}
              </div>
            </button>
          ))}
        </div>
        <div className="p-2 border-t border-gray-100 text-xs text-gray-400 text-center">
          {conversations.length} conversations
        </div>
      </div>

      {/* Message display */}
      <div className="flex-1 flex flex-col bg-white min-w-0">
        {activeConversation ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
              <div>
                <div className="font-medium text-gray-900">{activeConversation.display_name}</div>
                <div className="text-xs text-gray-500">
                  {activeConversation.chat_identifier} · {totalMessages} {filtersActive ? 'matching' : ''} messages
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as 'txt' | 'csv' | 'html')}
                  className="text-sm border border-gray-200 rounded px-2 py-1 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="txt">TXT</option>
                  <option value="csv">CSV</option>
                  <option value="html">HTML</option>
                </select>
                <button
                  onClick={handleExport}
                  disabled={exporting}
                  className="text-sm text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  {exporting ? 'Exporting...' : filtersActive ? 'Export filtered' : 'Export'}
                </button>
              </div>
            </div>

            {/* Filter bar */}
            <div className="px-4 py-2 border-b border-gray-100 bg-gray-50 flex-shrink-0 space-y-2">
              {/* Search row */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Search in conversation..."
                  value={msgSearch}
                  onChange={(e) => setMsgSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyFilters(msgSearch, dateFrom, dateTo);
                  }}
                  className="flex-1 px-3 py-1.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => applyFilters(msgSearch, dateFrom, dateTo)}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Search
                </button>
                {filtersActive && (
                  <button
                    onClick={handleClearFilters}
                    className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded bg-white"
                  >
                    Clear
                  </button>
                )}
              </div>

              {/* Date filter row */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Preset buttons */}
                <span className="text-xs text-gray-400">Date:</span>
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
                        applyPreset('', '');
                      } else if (months === null) {
                        const p = thisYearPreset();
                        applyPreset(p.from, p.to);
                      } else {
                        const p = datePreset(months);
                        applyPreset(p.from, p.to);
                      }
                    }}
                    className="text-xs px-2 py-1 rounded border border-gray-200 bg-white hover:bg-gray-100 text-gray-600"
                  >
                    {label}
                  </button>
                ))}

                {/* Custom date inputs */}
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    applyFilters(msgSearch, e.target.value, dateTo);
                  }}
                  className="text-xs px-2 py-1 border border-gray-200 rounded bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-400">to</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    applyFilters(msgSearch, dateFrom, e.target.value);
                  }}
                  className="text-xs px-2 py-1 border border-gray-200 rounded bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-4 bg-gray-50">
              {loading && (
                <div className="text-center text-gray-500 text-sm py-8">Loading...</div>
              )}
              {!loading && messages.length === 0 && filtersActive && (
                <div className="text-center text-gray-400 text-sm py-8">No messages match the current filters.</div>
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
          <div className="flex items-center justify-center h-full text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-3">💬</div>
              <p>Select a conversation to view messages</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
