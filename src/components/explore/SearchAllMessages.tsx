import { useState, useRef } from 'react';
import { sidecarCall } from '../../lib/ipc';
import { formatDateTime } from '../../lib/dates';
import { SearchIcon } from '../shared/Icons';

/** Most matches one search returns; the results say so when they hit it. */
export const SEARCH_LIMIT = 500;

/** A message to open in the Messages view, picked from search results. */
export interface MessageTarget {
  chatId: number;
  messageId: number;
}

interface SearchResult {
  message_id: number;
  text: string | null;
  date: string;
  is_from_me: boolean;
  sender: string;
  chat_id: number;
  chat_name?: string;
}

interface Props {
  udid: string;
  onOpen: (target: MessageTarget) => void;
  /** Fill the parent's height and scroll the results inside it. */
  fill?: boolean;
  /** Shown under the box until the first search. */
  placeholder?: React.ReactNode;
}

const SNIPPET_LENGTH = 220;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Long messages: show the part around the first match, not just the start.
function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET_LENGTH) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - 60, text.length - SNIPPET_LENGTH));
  const end = start + SNIPPET_LENGTH;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  // split() with a capture group puts each match at an odd index
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => i % 2 === 1
        ? <mark key={i} className="bg-accent-wash text-text-primary rounded-sm px-0.5">{part}</mark>
        : part)}
    </>
  );
}

export default function SearchAllMessages({ udid, onOpen, fill, placeholder }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epochRef = useRef(0);

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    epochRef.current += 1;
    const epoch = epochRef.current;
    setLoading(true);
    setError(null);
    try {
      // No chat_id: the sidecar searches every conversation.
      const result = await sidecarCall<{ results: SearchResult[] }>(
        'search_messages', { udid, query: q, limit: SEARCH_LIMIT }
      );
      if (epochRef.current !== epoch) return;
      setResults(result.results);
      setSearchedFor(q);
    } catch (err: any) {
      if (epochRef.current !== epoch) return;
      setResults([]);
      setSearchedFor(null);
      setError(err.message);
    } finally {
      if (epochRef.current === epoch) setLoading(false);
    }
  }

  return (
    <div className={fill ? 'h-full flex flex-col min-h-0' : ''}>
      <div className="relative flex-shrink-0">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="text"
          placeholder="Search all messages"
          aria-label="Search all messages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="w-full pl-9 pr-3 py-2.5 text-sm bg-white rounded-lg border border-gray-200 focus:outline-none focus:border-emerald-400"
        />
      </div>

      {loading && <div className="mt-3 text-xs text-gray-400">Searching…</div>}
      {error && <div className="mt-3 text-xs text-red-500">Search failed: {error}</div>}

      {!loading && searchedFor !== null && (
        <div className={`mt-3 ${fill ? 'flex-1 flex flex-col min-h-0' : ''}`}>
          <div className="text-xs text-gray-500 mb-2 flex-shrink-0">
            {results.length === 0
              ? `No messages contain "${searchedFor}"`
              : results.length >= SEARCH_LIMIT
                ? `Showing the first ${SEARCH_LIMIT} matches`
                : `${results.length.toLocaleString()} ${results.length === 1 ? 'match' : 'matches'}`}
          </div>
          {results.length > 0 && (
            <div className={`rounded-lg border border-gray-200 bg-white overflow-y-auto ${fill ? 'flex-1 min-h-0' : 'max-h-[420px]'}`}>
              {results.map((r) => (
                <button
                  key={`${r.chat_id}-${r.message_id}`}
                  onClick={() => onOpen({ chatId: r.chat_id, messageId: r.message_id })}
                  className="w-full px-3 py-2.5 text-left border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900 truncate">
                      {r.chat_name || 'Conversation'}
                    </span>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDateTime(r.date)}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5 break-words">
                    <span className="text-gray-400">{r.is_from_me ? 'You' : r.sender}: </span>
                    <HighlightedText text={snippet(r.text ?? '', searchedFor)} query={searchedFor} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && searchedFor === null && !error && placeholder}
    </div>
  );
}
