/**
 * OpenExtract API client.
 * Wraps all HTTP calls to the openextract-api server.
 */

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? res.statusText);
  }
  return res.json();
}

// ── Backup sessions ───────────────────────────────────────────────────────────

export const api = {
  backups: {
    discover: (searchPath?: string) =>
      request<BackupInfo[]>(`/backups/discover${searchPath ? `?search_path=${encodeURIComponent(searchPath)}` : ""}`),

    open: (path: string, password?: string) =>
      request<{ session_key: string }>("/backups/open", {
        method: "POST",
        body: JSON.stringify({ path, password }),
      }),

    sessions: () => request<{ sessions: string[] }>("/backups/sessions"),

    close: (sessionKey: string) =>
      request(`/backups/sessions/${encodeURIComponent(sessionKey)}`, { method: "DELETE" }),
  },

  // ── Messages ────────────────────────────────────────────────────────────────

  messages: {
    conversations: (session: string) =>
      request<Conversation[]>(`/messages/conversations?session=${encodeURIComponent(session)}`),

    get: (session: string, chatId: number, opts?: { offset?: number; limit?: number }) =>
      request<Message[]>(
        `/messages/conversations/${chatId}?session=${encodeURIComponent(session)}`
        + `&offset=${opts?.offset ?? 0}&limit=${opts?.limit ?? 100}`
      ),

    search: (session: string, q: string, chatId?: number) =>
      request<Message[]>(
        `/messages/search?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`
        + (chatId != null ? `&chat_id=${chatId}` : "")
      ),
  },

  // ── Data domains ─────────────────────────────────────────────────────────────

  contacts: {
    list: (session: string) =>
      request<Contact[]>(`/contacts?session=${encodeURIComponent(session)}`),
  },

  calls: {
    list: (session: string, offset = 0, limit = 200) =>
      request<Call[]>(`/calls?session=${encodeURIComponent(session)}&offset=${offset}&limit=${limit}`),
  },

  voicemail: {
    list: (session: string) =>
      request<Voicemail[]>(`/voicemail?session=${encodeURIComponent(session)}`),
    audioUrl: (id: number, session: string) =>
      `${BASE}/voicemail/${id}/audio?session=${encodeURIComponent(session)}`,
  },

  notes: {
    list: (session: string) =>
      request<Note[]>(`/notes?session=${encodeURIComponent(session)}`),
  },

  photos: {
    albums: (session: string) =>
      request<Album[]>(`/photos/albums?session=${encodeURIComponent(session)}`),
    assets: (session: string, opts?: { offset?: number; limit?: number; albumId?: number }) =>
      request<Asset[]>(
        `/photos/assets?session=${encodeURIComponent(session)}`
        + `&offset=${opts?.offset ?? 0}&limit=${opts?.limit ?? 100}`
        + (opts?.albumId != null ? `&album_id=${opts.albumId}` : "")
      ),
    thumbnailUrl: (hash: string, session: string, size = 256) =>
      `${BASE}/photos/assets/${hash}/thumbnail?session=${encodeURIComponent(session)}&size=${size}`,
  },

  // ── Analysis ─────────────────────────────────────────────────────────────────

  analysis: {
    /**
     * Start analysis and stream SSE events.
     * Returns an EventSource — the caller subscribes to 'message' events.
     */
    runStream: (session: string, tokenBudget = 100_000): EventSource => {
      return new EventSource(
        `${BASE}/analysis/${encodeURIComponent(session)}/run?token_budget=${tokenBudget}`
      );
    },

    get: (session: string) =>
      request<AnalysisResult>(`/analysis/${encodeURIComponent(session)}`),

    aiChunks: (session: string, budget = 100_000) =>
      request<{ total_tokens: number; chunks: AIChunk[] }>(
        `/analysis/${encodeURIComponent(session)}/ai-chunks?budget=${budget}`
      ),

    reportHtmlUrl: (session: string) =>
      `${BASE}/analysis/${encodeURIComponent(session)}/report.html`,

    reportPdfUrl: (session: string) =>
      `${BASE}/analysis/${encodeURIComponent(session)}/report.pdf`,
  },

  // ── Anonymize ─────────────────────────────────────────────────────────────────

  anonymize: {
    process: (
      session: string,
      domain: "messages" | "contacts" | "notes" | "conversations",
      strategy: "redact" | "pseudonymize" = "pseudonymize",
      chatId?: number,
      limit = 500
    ) =>
      request<{ store_key: string; summary: object; diff: DiffEntry[] }>(
        `/anonymize/${encodeURIComponent(session)}/process`,
        {
          method: "POST",
          body: JSON.stringify({ strategy, domain, chat_id: chatId, limit }),
        }
      ),

    diff: (session: string, domain: string, chatId?: number) =>
      request<{ summary: object; diff: DiffEntry[] }>(
        `/anonymize/${encodeURIComponent(session)}/diff?domain=${domain}`
        + (chatId != null ? `&chat_id=${chatId}` : "")
      ),

    approve: (session: string, domain: string, chatId?: number, fieldPath?: string) =>
      request(
        `/anonymize/${encodeURIComponent(session)}/approve?domain=${domain}`
        + (chatId != null ? `&chat_id=${chatId}` : "")
        + (fieldPath ? `&field_path=${encodeURIComponent(fieldPath)}` : ""),
        { method: "POST" }
      ),

    compare: (session: string, domain: string, chatId?: number) =>
      request<{ pairs: Array<{ original: unknown; anonymized: unknown }>; summary: object }>(
        `/anonymize/${encodeURIComponent(session)}/compare?domain=${domain}`
        + (chatId != null ? `&chat_id=${chatId}` : "")
      ),
  },
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackupInfo {
  udid: string;
  path: string;
  device_name: string | null;
  ios_version: string | null;
  is_encrypted: boolean;
  size_bytes: number;
}

export interface Conversation {
  id: number;
  display_name: string | null;
  participants: string[];
  participant_names: string[];
  message_count: number;
  last_message_at: string | null;
  last_message_text: string | null;
  is_group: boolean;
}

export interface Message {
  id: number;
  chat_id: number;
  text: string | null;
  sender: string;
  sender_name: string | null;
  timestamp: string;
  is_from_me: boolean;
  type: string;
  attachments: Attachment[];
}

export interface Attachment {
  id: number;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface Contact {
  id: number;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  phones: { number: string; label: string | null }[];
  emails: { address: string; label: string | null }[];
}

export interface Call {
  id: number;
  address: string;
  contact_name: string | null;
  direction: "incoming" | "outgoing" | "missed" | "blocked";
  duration_seconds: number;
  timestamp: string;
  service: string | null;
}

export interface Voicemail {
  id: number;
  sender: string;
  sender_name: string | null;
  duration_seconds: number;
  timestamp: string;
  is_read: boolean;
  transcript: string | null;
}

export interface Note {
  id: number;
  title: string | null;
  body: string | null;
  created_at: string | null;
  modified_at: string | null;
  folder: string | null;
  word_count: number;
}

export interface Album {
  id: number;
  title: string;
  asset_count: number;
}

export interface Asset {
  uuid: string;
  filename: string;
  file_hash: string | null;
  asset_type: string;
  width: number | null;
  height: number | null;
  created_at: string | null;
  is_favorite: boolean;
}

export interface AnalysisResult {
  backup_path: string;
  completed_at: string;
  relationship_graph: RelationshipGraph;
  activity_patterns: ActivityPattern;
  topic_analysis: TopicAnalysis;
  synthesis: SynthesisResult | null;
}

export interface RelationshipGraph {
  contacts: ContactSummary[];
  total_conversations: number;
  total_messages: number;
  date_range_start: string | null;
  date_range_end: string | null;
}

export interface ContactSummary {
  identifier: string;
  display_name: string | null;
  total_messages: number;
  messages_sent: number;
  messages_received: number;
  first_contact: string | null;
  last_contact: string | null;
  avg_response_seconds: number | null;
}

export interface ActivityPattern {
  hour_of_day: Record<string, number>;
  day_of_week: Record<string, number>;
  daily_counts: Record<string, number>;
}

export interface TopicAnalysis {
  topics: Topic[];
  timeline_events: TimelineEvent[];
}

export interface Topic {
  label: string;
  keywords: string[];
  message_count: number;
  representative_phrases: string[];
}

export interface TimelineEvent {
  date: string;
  event_type: string;
  description: string;
  magnitude: number;
}

export interface SynthesisResult {
  total_token_estimate: number;
  chunks: AIChunk[];
  summary_json: object;
}

export interface AIChunk {
  index: number;
  source: string;
  token_estimate: number;
  content: string;
}

export interface DiffEntry {
  field_path: string;
  entity_type: string;
  original_value: string;
  anonymized_value: string;
  approved: boolean;
}
