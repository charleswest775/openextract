import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { formatRelative, formatDate } from '../../lib/dates';
import { SearchIcon, ExportIcon } from '../shared/Icons';
import ChatBubble from './ChatBubble';

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

const PAGE_SIZE = 200;
const LOAD_MORE_SIZE = 200;

interface Props {
  udid: string;
}

export default function MessageExplorer({ udid }: Props) {
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
  const [exporting, setExporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<number>>(new Set());
  const [showBulkExportDialog, setShowBulkExportDialog] = useState(false);
  const [bulkExportMode, setBulkExportMode] = useState<'merged' | 'separate'>('separate');
  const [bulkExportFormat, setBulkExportFormat] = useState<'txt' | 'csv' | 'html'>('html');

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

  async function handleExport(format: 'txt' | 'csv' | 'html') {
    if (activeChat === null) return;
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    try {
      await sidecarCall('export_conversation', {
        udid, chat_id: activeChat, format, output_dir: outputDir,
      });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
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

  async function handleBulkExport() {
    if (selectedChats.size === 0) return;
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    setShowBulkExportDialog(false);
    try {
      const chatIds = Array.from(selectedChats);
      const conversationNames: Record<number, string> = {};
      for (const c of conversations) {
        if (selectedChats.has(c.chat_id)) {
          conversationNames[c.chat_id] = c.display_name || c.chat_identifier;
        }
      }
      const result = await sidecarCall<{ files: string[]; message_count: number }>(
        'export_conversations', {
          udid, chat_ids: chatIds, conversation_names: conversationNames,
          format: bulkExportFormat, output_dir: outputDir, mode: bulkExportMode,
        }
      );
      window.openextract.incrementExportCount();
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

  return (
    <div className={`h-full flex${slowLoading ? ' cursor-wait' : ''}`}>
      {/* Conversation list */}
      <div className="w-[280px] flex-shrink-0 border-r border-gray-200 flex flex-col">
        <div className="p-3 border-b border-gray-200 space-y-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search conversations..."
              value={convoSearch}
              onChange={(e) => setConvoSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 whitespace-nowrap">Min messages</label>
            <input
              type="number"
              min={0}
              value={minMessageCount || ''}
              placeholder="0"
              onChange={(e) => setMinMessageCount(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-full px-2 py-1 text-xs bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 placeholder:text-gray-300"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 whitespace-nowrap">After</label>
            <input
              type="date"
              value={convDateFilter}
              onChange={(e) => setConvDateFilter(e.target.value)}
              className="w-full px-2 py-1 text-xs bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400"
            />
            {convDateFilter && (
              <button
                onClick={() => setConvDateFilter('')}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                title="Clear date filter"
              >
                &times;
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-2">
            <button
              onClick={() => {
                if (selectMode) { clearSelection(); setSelectMode(false); }
                else setSelectMode(true);
              }}
              className={`text-xs px-2 py-1 rounded-md border transition-colors ${
                selectMode
                  ? 'bg-emerald-500 text-white border-emerald-500'
                  : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {selectMode ? 'Cancel select' : 'Select'}
            </button>
            {selectMode && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    const allSelected = filteredConversations.length > 0 &&
                      filteredConversations.every(c => selectedChats.has(c.chat_id));
                    if (allSelected) clearSelection();
                    else selectAllFiltered();
                  }}
                  className="text-xs px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  {filteredConversations.length > 0 && filteredConversations.every(c => selectedChats.has(c.chat_id))
                    ? 'Deselect all' : 'Select all'}
                </button>
                {selectedChats.size > 0 && (
                  <button
                    onClick={() => setShowBulkExportDialog(true)}
                    disabled={exporting}
                    className="text-xs px-2 py-1 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
                  >
                    {exporting ? 'Exporting...' : `Export ${selectedChats.size}`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map((c) => (
            <button
              key={c.chat_id}
              onClick={() => {
                if (selectMode) toggleChatSelection(c.chat_id);
                else loadMessages(c.chat_id);
              }}
              className={`w-full px-3 py-2.5 text-left border-b border-gray-100 transition-colors ${
                selectMode && selectedChats.has(c.chat_id)
                  ? 'bg-emerald-50'
                  : activeChat === c.chat_id && !selectMode
                    ? 'bg-gray-100'
                    : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {selectMode && (
                    <span className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${
                      selectedChats.has(c.chat_id)
                        ? 'bg-emerald-500 border-emerald-500 text-white'
                        : 'border-gray-300 bg-white'
                    }`}>
                      {selectedChats.has(c.chat_id) && (
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="2 6 5 9 10 3" />
                        </svg>
                      )}
                    </span>
                  )}
                  <span className="text-sm font-medium text-gray-900 truncate">
                    {c.display_name || c.chat_identifier}
                  </span>
                </div>
                <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">
                  {formatRelative(c.last_message_date)}
                </span>
              </div>
              <div className={`text-xs text-gray-400 truncate mt-0.5 ${selectMode ? 'ml-6' : ''}`}>
                {c.last_message_preview}
              </div>
              <div className={`text-[10px] text-gray-300 mt-0.5 ${selectMode ? 'ml-6' : ''}`}>
                {c.message_count.toLocaleString()} messages
                {c.service !== 'iMessage' && ` · ${c.service}`}
              </div>
            </button>
          ))}
          {filteredConversations.length === 0 && !loading && (
            <div className="p-4 text-sm text-gray-400 text-center">No conversations found</div>
          )}
          {filteredConversations.length > 0 && (
            <div className="px-3 py-2 text-[10px] text-gray-300 text-center">
              {filteredConversations.length !== conversations.length
                ? `${filteredConversations.length} of ${conversations.length} conversations`
                : `${conversations.length} conversations`}
            </div>
          )}
        </div>
      </div>

      {/* Message view */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeConvo ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {activeConvo.display_name || activeConvo.chat_identifier}
                </div>
                <div className="text-xs text-gray-400 truncate">
                  {totalMessages.toLocaleString()} messages
                  {activeConvo.is_group && ' · Group'}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="relative">
                  <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                  <input
                    type="text"
                    placeholder="Search messages..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-40"
                  />
                </div>
                <div className="relative group">
                  <button
                    className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                    disabled={exporting}
                  >
                    <ExportIcon className="text-gray-500" size={16} />
                  </button>
                  <div className="hidden group-hover:block absolute right-0 top-full pt-1 z-10">
                  <div className="bg-white border border-gray-200 rounded-md shadow-lg py-1">
                    <button onClick={() => handleExport('html')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">HTML</button>
                    <button onClick={() => handleExport('csv')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">CSV</button>
                    <button onClick={() => handleExport('txt')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">Text</button>
                  </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div ref={messageContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4" onScroll={handleScroll}>
              {hasMore && (
                <button onClick={loadMore} className="w-full text-center text-xs text-gray-400 py-2 hover:text-gray-600 mb-2">
                  Load older messages...
                </button>
              )}
              {groupedMessages.map((group) => (
                <div key={group.date}>
                  <div className="text-center my-3">
                    <span className="text-[11px] text-gray-400 bg-gray-50 px-2.5 py-0.5 rounded-full">{group.date}</span>
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
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <LinesIconPlaceholder />
              <p className="text-sm mt-2">Select a conversation to view messages</p>
            </div>
          </div>
        )}
      </div>

      {/* Bulk export dialog */}
      {showBulkExportDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowBulkExportDialog(false)}>
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl border border-gray-200" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-gray-900 mb-4">
              Export {selectedChats.size} conversation{selectedChats.size > 1 ? 's' : ''}
            </h3>

            <div className="space-y-3 mb-4">
              <label className="text-xs text-gray-500">Export mode</label>
              <div className="space-y-2">
                <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-gray-50 transition-colors">
                  <input
                    type="radio"
                    name="bulkMode"
                    value="separate"
                    checked={bulkExportMode === 'separate'}
                    onChange={() => setBulkExportMode('separate')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm text-gray-900">Separate files</div>
                    <div className="text-xs text-gray-400">Each conversation exported to its own file, named by contact</div>
                  </div>
                </label>
                <label className="flex items-start gap-3 cursor-pointer p-2 rounded-md hover:bg-gray-50 transition-colors">
                  <input
                    type="radio"
                    name="bulkMode"
                    value="merged"
                    checked={bulkExportMode === 'merged'}
                    onChange={() => setBulkExportMode('merged')}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="text-sm text-gray-900">Single file sorted by time</div>
                    <div className="text-xs text-gray-400">All messages merged into one file, sorted by timestamp</div>
                  </div>
                </label>
              </div>

              <div>
                <label className="text-xs text-gray-500">Format</label>
                <select
                  value={bulkExportFormat}
                  onChange={(e) => setBulkExportFormat(e.target.value as 'txt' | 'csv' | 'html')}
                  className="w-full mt-1 text-sm bg-gray-50 text-gray-900 rounded-md px-2 py-1.5 border border-gray-200 focus:outline-none focus:border-emerald-400"
                >
                  <option value="html">HTML</option>
                  <option value="csv">CSV</option>
                  <option value="txt">Text</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowBulkExportDialog(false)}
                className="px-4 py-1.5 text-sm text-gray-500 rounded-md border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkExport}
                className="px-4 py-1.5 text-sm bg-emerald-500 text-white rounded-md hover:bg-emerald-600 transition-colors"
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

function LinesIconPlaceholder() {
  return (
    <svg className="mx-auto text-gray-300" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
