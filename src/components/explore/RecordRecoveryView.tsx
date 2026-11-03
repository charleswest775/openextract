import { useState, useMemo } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { formatRelative, formatDate } from '../../lib/dates';
import { RecoverIcon } from '../shared/Icons';
import ChatBubble from './ChatBubble';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader, { SearchField } from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { checkEngineResult, plural } from '../../lib/saveData';

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
  return source === 'recently_deleted' ? 'Recently Deleted' : 'Left behind';
}

function sourceBadgeClass(source: RecoverySource): string {
  return source === 'recently_deleted'
    ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-sand text-text-secondary border-rule';
}

export default function RecordRecoveryView({ udid }: Props) {
  const [scanned, setScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [activeRecoveryId, setActiveRecoveryId] = useState<string | null>(null);
  const [convoSearch, setConvoSearch] = useState('');
  const [choosing, setChoosing] = useState(false);
  const { busy: exporting, run } = useSaveAction('record_recovery');

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

  function handleExport(format: ExportFormat) {
    setChoosing(false);
    run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const r = checkEngineResult(await sidecarCall<{ file: string; message_count: number }>(
        'export_recovered_messages',
        { udid, format, output_dir: outputDir },
      ));
      return { title: `Saved ${plural(r.message_count, 'recovered message')}`, path: r.file ?? outputDir };
    });
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
        <PageHeader title="Recover deleted messages" />
        <EmptyState
          icon={RecoverIcon}
          title={scanning ? 'Looking for deleted messages…' : 'Look for deleted messages'}
          detail={scanning ? undefined : (
            <>
              OpenExtract checks two places: the iPhone's Recently Deleted folder (iOS 16 and later,
              kept for up to 30 days), and messages left behind after their conversation was deleted.
              Whatever it finds is shown in its original conversation where possible.
            </>
          )}
          action={scanning ? undefined : (
            <>
              <button onClick={runScan} className="hearth-primary-btn">
                <RecoverIcon size={18} />
                Look for deleted messages
              </button>
              {error && (
                <div role="alert" className="mt-4 p-3 rounded-xl border border-border-strong bg-surface text-sm text-apple-error max-w-md">
                  {error}
                  <div><ReportProblemButton error={error} area="record_recovery" className="mt-1.5" /></div>
                </div>
              )}
            </>
          )}
        />
      </div>
    );
  }

  // ── Results: conversation-thread layout ───────────────────────────────────

  const found = result!.scanned;
  const summary = [
    result!.schema_support.recently_deleted
      ? `${found.recently_deleted.toLocaleString()} from Recently Deleted`
      : 'Recently Deleted isn\'t readable on this iOS version',
    `${found.orphaned.toLocaleString()} left behind`,
  ].join(' · ');

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Recover deleted messages"
        count={summary}
        actions={
          <>
            <button onClick={runScan} className="hearth-ghost-btn">
              <RecoverIcon size={18} />
              Look again
            </button>
            <SaveButton onClick={() => setChoosing(true)} busy={exporting} disabled={conversations.length === 0} label="Save all" />
          </>
        }
      />

      <div className="flex-1 flex min-h-0">
        {/* Conversation list */}
        <div className="w-[300px] flex-shrink-0 border-r border-rule flex flex-col">
          <div className="p-3 border-b border-rule">
            <SearchField value={convoSearch} onChange={setConvoSearch} placeholder="Search conversations" />
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.map((c) => (
              <button
                key={c.recovery_id}
                onClick={() => setActiveRecoveryId(c.recovery_id)}
                aria-current={activeRecoveryId === c.recovery_id ? 'true' : undefined}
                className={`w-full px-3 py-2.5 text-left border-b border-rule transition-colors ${
                  activeRecoveryId === c.recovery_id ? 'bg-accent-wash' : 'hover:bg-surface'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-text-primary truncate flex-1 min-w-0">
                    {c.display_name || c.chat_identifier || 'Unknown'}
                  </span>
                  <span className="text-xs text-text-tertiary flex-shrink-0">
                    {formatRelative(c.last_message_date)}
                  </span>
                </div>
                <div className="text-xs text-text-secondary truncate mt-0.5">
                  {c.last_message_preview || <span className="italic">[no preview]</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full border ${sourceBadgeClass(c.source)}`}>
                    {sourceLabel(c.source)}
                  </span>
                  <span className="text-xs text-text-tertiary">
                    {plural(c.message_count, 'message')}
                    {c.service && c.service !== 'iMessage' && ` · ${c.service}`}
                  </span>
                </div>
              </button>
            ))}
            {filteredConversations.length === 0 && (
              <div className="p-4 text-sm text-text-secondary text-center">
                {conversations.length === 0
                  ? 'No deleted messages were found in this backup.'
                  : 'No conversations match your search.'}
              </div>
            )}
          </div>
        </div>

        {/* Message thread */}
        <div className="flex-1 flex flex-col min-w-0">
          {activeConvo ? (
            <>
              <div className="px-5 py-3 border-b border-rule flex items-center gap-3">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="flex items-center gap-2">
                    <div className="text-base font-semibold text-text-primary truncate">
                      {activeConvo.display_name || activeConvo.chat_identifier || 'Unknown'}
                    </div>
                    <span className={`inline-block text-xs px-2 py-0.5 rounded-full border flex-shrink-0 ${sourceBadgeClass(activeConvo.source)}`}>
                      {sourceLabel(activeConvo.source)}
                    </span>
                  </div>
                  <div className="text-xs text-text-secondary truncate">
                    {plural(activeConvo.message_count, 'recovered message')}
                    {activeConvo.is_group && ' · Group'}
                    {activeConvo.source === 'orphaned' && ' · its conversation was deleted'}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
                {groupedMessages.map((group) => (
                  <div key={group.date}>
                    <div className="text-center my-3">
                      <span className="text-xs text-text-secondary bg-sand px-3 py-0.5 rounded-full">
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
                  <div className="text-center py-12 text-sm text-text-secondary">
                    No messages in this conversation.
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={RecoverIcon}
              title={conversations.length === 0 ? 'Nothing to recover' : 'Pick a conversation to read it'}
              detail={conversations.length === 0
                ? 'No deleted messages were found in this backup. Recently Deleted only keeps messages for 30 days, so a backup made at another time may hold different ones.'
                : undefined}
            />
          )}
        </div>
      </div>
      {choosing && (
        <SaveDialog
          title="Save recovered messages"
          formats={[FORMATS.html, FORMATS.pdf, FORMATS.csv]}
          onSave={id => handleExport(id as ExportFormat)}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
