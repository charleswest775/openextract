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
  message_type: string;
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
  const [selectedChats, setSelectedChats] = useState<Set<number>>(new Set());

  const activeChatRef = useRef<number | null>(null);
  const activeDateFromRef = useRef<string | undefined>(undefined);
  const activeDateToRef = useRef<string | undefined>(undefined);
  const currentOffsetRef = useRef<number>(0);
  const inSearchModeRef = useRef<boolean>(false);
  const loadEpochRef = useRef<number>(0);
  const [hasMore, setHasMore] = useState(false);

  const loadConversations = useCallback(async () => {
    if (!udid) return;
    setLoading(true);
    try {
      const result = await sidecarCall<{ conversations: Conversation[] }>(
        'list_conversations', { udid }
      );
      setConversations(result.conversations);
    } finally {
      setLoading(false);
    }
  }, [udid]);

  const loadMessages = useCallback(async (
    chatId: number, offset = 0, limit = PAGE_SIZE,
    dateFrom?: string, dateTo?: string
  ) => {
    if (!udid) return;
    setLoading(true);
    inSearchModeRef.current = false;
    if (offset === 0) {
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
      if (loadEpochRef.current !== epoch) return;
      if (offset === 0) {
        setMessages(result.messages);
      } else {
        setMessages(prev => [...result.messages, ...prev]);
      }
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
      chatId, currentOffsetRef.current, LOAD_MORE_SIZE,
      activeDateFromRef.current, activeDateToRef.current
    );
  }, [udid, loadMessages]);

  const searchMessages = useCallback(async (
    query: string, chatId?: number, dateFrom?: string, dateTo?: string
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
    chatId: number, format: 'txt' | 'csv' | 'html',
    outputDir: string, dateFrom?: string, dateTo?: string, query?: string
  ) => {
    if (!udid) return null;
    return sidecarCall<{ file: string; message_count: number }>(
      'export_conversation',
      { udid, chat_id: chatId, format, output_dir: outputDir, date_from: dateFrom, date_to: dateTo, query }
    );
  }, [udid]);

  const toggleChatSelection = useCallback((chatId: number) => {
    setSelectedChats(prev => {
      const next = new Set(prev);
      if (next.has(chatId)) next.delete(chatId);
      else next.add(chatId);
      return next;
    });
  }, []);

  const selectAllChats = useCallback((chatIds: number[]) => {
    setSelectedChats(new Set(chatIds));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedChats(new Set());
  }, []);

  const exportConversations = useCallback(async (
    chatIds: number[], conversationNames: Record<number, string>,
    format: 'txt' | 'csv' | 'html', outputDir: string,
    mode: 'merged' | 'separate', dateFrom?: string, dateTo?: string, query?: string
  ) => {
    if (!udid) return null;
    return sidecarCall<{ files: string[]; message_count: number }>(
      'export_conversations',
      { udid, chat_ids: chatIds, conversation_names: conversationNames, format, output_dir: outputDir, mode, date_from: dateFrom, date_to: dateTo, query }
    );
  }, [udid]);

  return {
    conversations, messages, activeChat, totalMessages, hasMore, loading, selectedChats,
    loadConversations, loadMessages, loadMore, searchMessages,
    exportConversation, exportConversations,
    toggleChatSelection, selectAllChats, clearSelection, setActiveChat,
  };
}
