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

  const offsetRef = useRef(0);
  const epochRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  async function loadMessages(chatId: number, offset = 0) {
    setLoading(true);
    if (offset === 0) {
      setMessages([]);
      setTotalMessages(0);
      setHasMore(false);
      setActiveChat(chatId);
      offsetRef.current = 0;
      epochRef.current += 1;
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
    <div className="h-full flex">
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
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.map((c) => (
            <button
              key={c.chat_id}
              onClick={() => loadMessages(c.chat_id)}
              className={`w-full px-3 py-2.5 text-left border-b border-gray-100 transition-colors ${
                activeChat === c.chat_id ? 'bg-gray-100' : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900 truncate flex-1">
                  {c.display_name || c.chat_identifier}
                </span>
                <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">
                  {formatRelative(c.last_message_date)}
                </span>
              </div>
              <div className="text-xs text-gray-400 truncate mt-0.5">
                {c.last_message_preview}
              </div>
              <div className="text-[10px] text-gray-300 mt-0.5">
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
      <div className="flex-1 flex flex-col">
        {activeConvo ? (
          <>
            {/* Chat header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-900">
                  {activeConvo.display_name || activeConvo.chat_identifier}
                </div>
                <div className="text-xs text-gray-400">
                  {totalMessages.toLocaleString()} messages
                  {activeConvo.is_group && ' · Group'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                  <input
                    type="text"
                    placeholder="Search messages..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-48"
                  />
                </div>
                <div className="relative group">
                  <button
                    className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
                    disabled={exporting}
                  >
                    <ExportIcon className="text-gray-500" size={16} />
                  </button>
                  <div className="hidden group-hover:block absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg py-1 z-10">
                    <button onClick={() => handleExport('html')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">HTML</button>
                    <button onClick={() => handleExport('csv')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">CSV</button>
                    <button onClick={() => handleExport('txt')} className="block w-full px-3 py-1.5 text-sm text-left hover:bg-gray-50">Text</button>
                  </div>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4" onScroll={handleScroll}>
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
