import { useState, useMemo } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { formatRelative, formatDate } from '../../lib/dates';
import { SearchIcon, RecoverIcon, ExportIcon } from '../shared/Icons';
import ChatBubble from './ChatBubble';

type ExportFormat = 'csv' | 'html' | 'pdf';

type RecoverySource = 'recently_deleted' | 'orphaned';

interface RecoveredConversation {
  recovery_id: string;
  source: RecoverySource;
  chat_id: number | null;
  chat_identifier: string;
  display_name: string;
  service: string;
  is_group: boolean;
  message_count: number;
  last_message_date: string;
  last_message_preview: string;
}

interface RecoveredMessage {
  message_id: number;
  text: string | null;
  message_type: string;
  date: string;
  is_from_me: boolean;
  sender: string;
  sender_handle: string;
  has_attachments: boolean;
  is_reaction: boolean;
  source: RecoverySource;
  deleted_date: string | null;
}

interface RecoveryResult {
  conversations: RecoveredConversation[];
  messages_by_conversation: Record<string, RecoveredMessage[]>;
  scanned: { recently_deleted: number; orphaned: number };
  schema_support: { recently_deleted: boolean };
}

interface Props {
  udid: string;
}

function sourceLabel(source: RecoverySource): string {
  return source === 'recently_deleted' ? 'Recently Deleted' : 'Orphaned';
}

function sourceBadgeClass(source: RecoverySource): string {
  return source === 'recently_deleted'
    ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-sky-50 text-sky-700 border-sky-200';
}

export default function RecordRecoveryView({ udid }: Props) {
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [activeRecoveryId, setActiveRecoveryId] = useState<string | null>(null);
  const [convoSearch, setConvoSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function runScan() {
    setScanning(true);
    setError(null);
    try {
      const r = await sidecarCall<RecoveryResult>('recover_messages', { udid });
      setResult(r);
      setScanned(true);
      setActiveRecoveryId(r.conversations[0]?.recovery_id ?? null);
    } catch (e: any) {
      setError(e?.message || 'Recovery scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function handleExport(format: ExportFormat) {
    if (!result || result.conversations.length === 0) return;
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    setExportError(null);
    try {
      await sidecarCall<{ file: string; message_count: number }>(
        'export_recovered_messages',
        { udid, format, output_dir: outputDir },
      );
      window.openextract?.incrementExportCount?.();
    } catch (e: any) {
      setExportError(e?.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  const conversations = result?.conversations ?? [];
  const filteredConversations = useMemo(() => {
    const q = convoSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(c =>
      c.display_name.toLowerCase().includes(q) ||
      c.chat_identifier.toLowerCase().includes(q) ||
      c.last_message_preview.toLowerCase().includes(q)
    );
  }, [conversations, convoSearch]);

  const activeConvo = conversations.find(c => c.recovery_id === activeRecoveryId) ?? null;
  const activeMessages = activeRecoveryId
    ? result?.messages_by_conversation[activeRecoveryId] ?? []
    : [];

  const groupedMessages = useMemo(() => {
    const groups: { date: string; messages: RecoveredMessage[] }[] = [];
    let currentDate = '';
    for (const msg of activeMessages) {
      const d = formatDate(msg.date);
      if (d !== currentDate) {
        currentDate = d;
        groups.push({ date: d, messages: [msg] });
      } else {
        groups[groups.length - 1].messages.push(msg);
      }
    }
    return groups;
  }, [activeMessages]);

  // ── Pre-scan / scanning / error states ────────────────────────────────────

  if (!scanned || scanning) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <h2 className="text-sm font-medium text-gray-900">Record Recovery</h2>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <RecoverIcon size={36} className="text-gray-300 mb-3" />
          {scanning ? (
            <div className="text-sm text-gray-400">Scanning backup for recoverable messages…</div>
          ) : (
            <>
              <div className="text-sm text-gray-600 mb-1">
                Attempt to recover deleted records from this backup.
              </div>
              <div className="text-xs text-gray-400 max-w-md mb-4">
                Currently recovers messages from the iOS &quot;Recently Deleted&quot; bucket
                (iOS 16+, up to 30 days) and orphaned messages whose chats were deleted.
                Recovered messages are shown in their original conversations where possible.
              </div>
              <button
                onClick={runScan}
                className="px-4 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 flex items-center gap-2"
              >
                <RecoverIcon size={14} />
                Scan for deleted messages
              </button>
              {error && (
                <div className="mt-4 p-3 rounded-md border border-red-200 bg-red-50 text-sm text-red-700 max-w-md">
                  {error}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Results: conversation-thread layout ───────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* Top summary bar */}
      <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between flex-shrink-0 bg-gray-50">
        <div className="flex items-center gap-4 text-xs text-gray-600">
          <div>
            <span className="text-gray-400">Recently Deleted: </span>
            <span className="text-gray-900 font-medium">
              {result!.scanned.recently_deleted.toLocaleString()}
            </span>
            {!result!.schema_support.recently_deleted && (
              <span className="text-gray-400 ml-1">(unsupported on this iOS version)</span>
            )}
          </div>
          <div>
            <span className="text-gray-400">Orphaned: </span>
            <span className="text-gray-900 font-medium">
              {result!.scanned.orphaned.toLocaleString()}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {exportError && (
            <span className="text-xs text-red-600" title={exportError}>Export failed</span>
          )}
          <div className="relative group">
            <button
              disabled={exporting || conversations.length === 0}
              className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={conversations.length === 0 ? 'Nothing to export' : 'Export'}
            >
              <ExportIcon size={12} />
              {exporting ? 'Exporting…' : 'Export'}
            </button>
            {!exporting && conversations.length > 0 && (
              <div className="hidden group-hover:block absolute right-0 top-full pt-1 z-10">
                <div className="bg-white border border-gray-200 rounded-md shadow-lg py-1 min-w-[90px]">
                  <button onClick={() => handleExport('csv')} className="block w-full px-3 py-1.5 text-xs text-left hover:bg-gray-50">CSV</button>
                  <button onClick={() => handleExport('html')} className="block w-full px-3 py-1.5 text-xs text-left hover:bg-gray-50">HTML</button>
                  <button onClick={() => handleExport('pdf')} className="block w-full px-3 py-1.5 text-xs text-left hover:bg-gray-50">PDF</button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={runScan}
            className="text-xs px-2.5 py-1 rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 flex items-center gap-1.5"
          >
            <RecoverIcon size={12} />
            Rescan
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Conversation list */}
        <div className="w-[280px] flex-shrink-0 border-r border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-200">
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
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.map((c) => (
              <button
                key={c.recovery_id}
                onClick={() => setActiveRecoveryId(c.recovery_id)}
                className={`w-full px-3 py-2.5 text-left border-b border-gray-100 transition-colors ${
                  activeRecoveryId === c.recovery_id ? 'bg-gray-100' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 truncate flex-1 min-w-0">
                    {c.display_name || c.chat_identifier || 'Unknown'}
                  </span>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">
                    {formatRelative(c.last_message_date)}
                  </span>
                </div>
                <div className="text-xs text-gray-400 truncate mt-0.5">
                  {c.last_message_preview || <span className="italic">[no preview]</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`inline-block text-[9px] px-1.5 py-0.5 rounded border ${sourceBadgeClass(c.source)}`}>
                    {sourceLabel(c.source)}
                  </span>
                  <span className="text-[10px] text-gray-300">
                    {c.message_count.toLocaleString()} message{c.message_count === 1 ? '' : 's'}
                    {c.service && c.service !== 'iMessage' && ` · ${c.service}`}
                  </span>
                </div>
              </button>
            ))}
            {filteredConversations.length === 0 && (
              <div className="p-4 text-sm text-gray-400 text-center">
                {conversations.length === 0
                  ? 'No recoverable messages found.'
                  : 'No conversations match your search.'}
              </div>
            )}
            {conversations.length > 0 && (
              <div className="px-3 py-2 text-[10px] text-gray-300 text-center">
                {filteredConversations.length !== conversations.length
                  ? `${filteredConversations.length} of ${conversations.length} conversations`
                  : `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`}
              </div>
            )}
          </div>
        </div>

        {/* Message thread */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeConvo ? (
            <>
              <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {activeConvo.display_name || activeConvo.chat_identifier || 'Unknown'}
                    </div>
                    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${sourceBadgeClass(activeConvo.source)}`}>
                      {sourceLabel(activeConvo.source)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 truncate">
                    {activeConvo.message_count.toLocaleString()} recovered message{activeConvo.message_count === 1 ? '' : 's'}
                    {activeConvo.is_group && ' · Group'}
                    {activeConvo.source === 'orphaned' && ' · original chat deleted'}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
                {groupedMessages.map((group) => (
                  <div key={group.date}>
                    <div className="text-center my-3">
                      <span className="text-[11px] text-gray-400 bg-gray-50 px-2.5 py-0.5 rounded-full">
                        {group.date}
                      </span>
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
                {activeMessages.length === 0 && (
                  <div className="text-center py-12 text-sm text-gray-400">
                    No messages in this conversation.
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-400">
                <RecoverIcon size={40} className="mx-auto text-gray-300" />
                <p className="text-sm mt-2">Select a conversation to view recovered messages</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
