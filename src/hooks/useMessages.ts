import { useState, useCallback, useRef } from 'react';
import { sidecarCall } from '../lib/ipc';

export interface Conversation {
  chat_id: number;
  chat_identifier: string;
  display_name: string;
  service: string;
  message_count: number;
  last_message_date: string;
  last_message_preview: string;
  is_group: boolean;
}

export interface LinkPreview {
  url?: string;
  title?: string;
  summary?: string;
  sitename?: string;
}

export interface Message {
  message_id: number;
  text: string | null;
  message_type: string; // 'text' | 'link' | 'location' | 'payment' | 'audio' | 'fitness' | 'game' | 'digital_touch' | 'handwriting' | 'attachment' | 'system'
  link_preview?: LinkPreview;
  date: string;
  is_from_me: boolean;
  sender: string;
  sender_handle: string;
  has_attachments: boolean;
  is_reaction: boolean;
  attachments?: Attachment[];
}

export interface Attachment {
  attachment_id: number;
  filename: string;
  mime_type: string;
  transfer_name: string;
  total_bytes: number;
}

const PAGE_SIZE = 1000;
const LOAD_MORE_SIZE = 500;

export function useMessages(udid: string | undefined) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeChat, setActiveChat] = useState<number | null>(null);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(false);

  // Track active load context so loadMore can continue with same filters
  const activeChatRef = useRef<number | null>(null);
  const activeDateFromRef = useRef<string | undefined>(undefined);
  const activeDateToRef = useRef<string | undefined>(undefined);
  const currentOffsetRef = useRef<number>(0);
  const inSearchModeRef = useRef<boolean>(false);
  // Incremented on every new conversation/filter load so stale responses are discarded
  const loadEpochRef = useRef<number>(0);

  // True when there are more messages to load (not in search mode)
  const [hasMore, setHasMore] = useState(false);

  const loadConversations = useCallback(async () => {
    if (!udid) return;
    setLoading(true);
    try {
      const result = await sidecarCall<{ conversations: Conversation[] }>(
        'list_conversations',
        { udid }
      );
      setConversations(result.conversations);
    } finally {
      setLoading(false);
    }
  }, [udid]);

  const loadMessages = useCallback(async (
    chatId: number,
    offset = 0,
    limit = PAGE_SIZE,
    dateFrom?: string,
    dateTo?: string
  ) => {
    if (!udid) return;
    setLoading(true);
    inSearchModeRef.current = false;

    if (offset === 0) {
      // Clear stale messages immediately so the old conversation never bleeds through
      setMessages([]);
      setTotalMessages(0);
      setHasMore(false);
      setActiveChat(chatId);
      activeChatRef.current = chatId;
      activeDateFromRef.current = dateFrom;
      activeDateToRef.current = dateTo;
      currentOffsetRef.current = 0;
      loadEpochRef.current += 1;
    }

    const epoch = loadEpochRef.current;

    try {
      const result = await sidecarCall<{ messages: Message[]; total: number; next_offset: number }>(
        'get_messages',
        { udid, chat_id: chatId, offset, limit, date_from: dateFrom, date_to: dateTo }
      );

      // Discard response if a newer load has started (conversation switched mid-flight)
      if (loadEpochRef.current !== epoch) return;

      // Backend returns chronological order (it reverses the DESC query internally).
      // For load-more (offset > 0), result.messages are older and must be prepended.
      if (offset === 0) {
        setMessages(result.messages);
      } else {
        setMessages(prev => [...result.messages, ...prev]);
      }

      // Use next_offset (raw DB rows fetched) not result.messages.length (filtered count).
      // Filtered rows (hidden/system) are dropped after the SQL LIMIT/OFFSET, so using
      // the filtered count would shift subsequent page windows and cause conversation bleed.
      const newOffset = result.next_offset ?? offset + result.messages.length;
      currentOffsetRef.current = newOffset;
      setTotalMessages(result.total);
      setHasMore(newOffset < result.total);
    } finally {
      setLoading(false);
    }
  }, [udid]);

  const loadMore = useCallback(async () => {
    const chatId = activeChatRef.current;
    if (!udid || chatId === null || inSearchModeRef.current) return;
    await loadMessages(
      chatId,
      currentOffsetRef.current,
      LOAD_MORE_SIZE,
      activeDateFromRef.current,
      activeDateToRef.current
    );
  }, [udid, loadMessages]);

  const searchMessages = useCallback(async (
    query: string,
    chatId?: number,
    dateFrom?: string,
    dateTo?: string
  ) => {
    if (!udid) return [];
    setLoading(true);
    inSearchModeRef.current = true;
    setMessages([]);
    setHasMore(false);
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
    try {
      const result = await sidecarCall<{ results: Message[] }>(
        'search_messages',
        { udid, query, chat_id: chatId, date_from: dateFrom, date_to: dateTo, limit: 5000 }
      );
      if (loadEpochRef.current !== epoch) return [];
      setMessages(result.results);
      setTotalMessages(result.results.length);
      return result.results;
    } finally {
      setLoading(false);
    }
  }, [udid]);

  const exportConversation = useCallback(async (
    chatId: number,
    format: 'txt' | 'csv' | 'html',
    outputDir: string,
    dateFrom?: string,
    dateTo?: string,
    query?: string
  ) => {
    if (!udid) return null;
    return sidecarCall<{ file: string; message_count: number }>(
      'export_conversation',
      { udid, chat_id: chatId, format, output_dir: outputDir, date_from: dateFrom, date_to: dateTo, query }
    );
  }, [udid]);

  return {
    conversations,
    messages,
    activeChat,
    totalMessages,
    hasMore,
    loading,
    loadConversations,
    loadMessages,
    loadMore,
    searchMessages,
    exportConversation,
    setActiveChat,
  };
}
