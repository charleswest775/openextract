import { useState, useCallback } from 'react';
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

export function useMessages(udid: string | undefined) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeChat, setActiveChat] = useState<number | null>(null);
  const [totalMessages, setTotalMessages] = useState(0);
  const [loading, setLoading] = useState(false);

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
    limit = 50,
    dateFrom?: string,
    dateTo?: string
  ) => {
    if (!udid) return;
    setLoading(true);
    setActiveChat(chatId);
    try {
      const result = await sidecarCall<{ messages: Message[]; total: number }>(
        'get_messages',
        { udid, chat_id: chatId, offset, limit, date_from: dateFrom, date_to: dateTo }
      );
      if (offset === 0) {
        setMessages(result.messages);
      } else {
        setMessages(prev => [...prev, ...result.messages]);
      }
      setTotalMessages(result.total);
    } finally {
      setLoading(false);
    }
  }, [udid]);

  const searchMessages = useCallback(async (
    query: string,
    chatId?: number,
    dateFrom?: string,
    dateTo?: string
  ) => {
    if (!udid) return [];
    setLoading(true);
    try {
      const result = await sidecarCall<{ results: Message[] }>(
        'search_messages',
        { udid, query, chat_id: chatId, date_from: dateFrom, date_to: dateTo }
      );
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
    loading,
    loadConversations,
    loadMessages,
    searchMessages,
    exportConversation,
    setActiveChat,
  };
}
