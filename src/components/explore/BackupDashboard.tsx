import type { BackupStats } from '../../hooks/useBackupStats';
import PageHeader from '../shared/PageHeader';
import CountUp from '../shared/CountUp';
import OrganicLoader from '../shared/OrganicLoader';
import { allOnlyInIcloud, moreOnlyInIcloud } from '../../lib/photoCounts';
import { Info } from 'lucide-react';
import {
  LinesIcon, CameraIcon, ContactIcon, CallIcon, NoteIcon, VoicemailIcon, LockIcon, WhatsAppIcon,
} from '../shared/Icons';
import { ReportProblemButton } from '../shared/Feedback';

interface Props {
  // Loaded once by ExploreLayout, which also uses the counts to hide empty sections.
  stats: BackupStats | null;
  loading: boolean;
  error: string | null;
  onNavigate: (tab: string) => void;
  hasBrowserHistory: boolean;
}

// Chart colors from the Hearth palette (index.css --series-*)
const SERIES = {
  terracotta: 'var(--series-terracotta)',
  sage: 'var(--series-sage)',
  ochre: 'var(--series-ochre)',
  slate: 'var(--series-slate)',
  plum: 'var(--series-plum)',
  taupe: 'var(--series-taupe)',
  missed: 'var(--error)',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatHour(hour: number): string {
  if (hour < 0) return '--';
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '--';
  }
}

function formatFullDate(iso: string | null): string {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch {
    return '--';
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SkeletonPulse({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

function LoadingSkeleton() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 bg-base">
      <div className="text-accent">
        <OrganicLoader size={120} />
      </div>
      <div className="hearth-eyebrow">Reading your backup</div>
    </div>
  );
}

function ProportionBar({ items }: { items: { label: string; value: number; color: string }[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-sand">
        {items.map((item, i) => (
          <div
            key={i}
            className="h-full transition-all duration-700"
            style={{
              width: `${(item.value / total) * 100}%`,
              backgroundColor: item.color,
              minWidth: item.value > 0 ? '2px' : '0',
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
            <span className="font-medium text-text-primary">{item.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
  onClick,
}: {
  icon: typeof LinesIcon;
  value: number;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="hearth-card p-4 text-left hover:border-[var(--border-strong)] transition-all duration-200 group flex items-center gap-3.5"
    >
      <span className="w-12 h-12 rounded-xl bg-accent-wash flex items-center justify-center flex-shrink-0">
        <Icon className="text-accent" size={26} />
      </span>
      <span className="flex flex-col min-w-0">
        <span className="text-2xl text-text-primary tabular-nums" style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, letterSpacing: '-0.02em' }}>
          <CountUp end={value} />
        </span>
        <span className="text-sm text-text-secondary">{label}</span>
      </span>
    </button>
  );
}

function InsightCard({
  title,
  icon: Icon,
  onViewAll,
  children,
}: {
  title: string;
  icon: typeof LinesIcon;
  onViewAll?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="hearth-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <Icon className="text-text-secondary" size={20} />
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
        </div>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="text-sm text-accent hover:text-accent-hover font-medium"
          >
            Open {title}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────────

function DashboardContent({ stats, onNavigate, hasBrowserHistory }: {
  stats: BackupStats;
  onNavigate: (tab: string) => void;
  hasBrowserHistory: boolean;
}) {
  const { overview, messages, photos, calls, notes, voicemails } = stats;
  // Library rows the backup has no file for (#106), as the Photos screen counts them.
  const photosOnlyInIcloud = Math.max(overview.total_photos + overview.total_videos - overview.photos_in_backup, 0);

  const dateRange = (from: string | null, to: string | null) => {
    if (!from && !to) return '';
    return `${formatDate(from)} — ${formatDate(to)}`;
  };

  const whatsappMessages = overview.total_whatsapp_messages ?? 0;
  const whatsappUnreadable = overview.whatsapp_status === 'error' || overview.whatsapp_status === 'unsupported_format';
  const tiles = [
    { tab: 'messages', icon: LinesIcon, value: overview.total_messages, label: 'Messages' },
    { tab: 'whatsapp', icon: WhatsAppIcon, value: whatsappMessages, label: 'WhatsApp' },
    { tab: 'photos', icon: CameraIcon, value: overview.photos_in_backup, label: 'Photos & Videos' },
    { tab: 'contacts', icon: ContactIcon, value: overview.total_contacts, label: 'Address book' },
    { tab: 'calls', icon: CallIcon, value: overview.total_calls, label: 'Calls' },
    { tab: 'notes', icon: NoteIcon, value: overview.total_notes, label: 'Notes' },
    { tab: 'voicemail', icon: VoicemailIcon, value: overview.total_voicemails, label: 'Voicemails' },
  ];
  const present = tiles.filter(t => t.value > 0);
  // WhatsApp isn't listed as missing: most iPhones don't have it
  const missing = [
    ...tiles.filter(t => t.value === 0 && t.tab !== 'whatsapp').map(t => t.label === 'Photos & Videos' ? 'photos' : t.label.toLowerCase()),
    ...(hasBrowserHistory ? [] : ['web history']),
  ];

  const facts = [
    overview.device_name,
    overview.ios_version && `iOS ${overview.ios_version}`,
    overview.last_backup && `Backed up ${formatFullDate(overview.last_backup)}`,
    overview.size_gb > 0 && `${overview.size_gb.toFixed(1)} GB`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Backup details"
        count={
          <span className="inline-flex items-center gap-2">
            {facts}
            {overview.encrypted && (
              <span className="inline-flex items-center gap-1 text-accent">
                <LockIcon size={16} />
                Encrypted
              </span>
            )}
          </span>
        }
      />
      <div className="p-7 space-y-6 overflow-y-auto flex-1">
        {/* What's in the backup; kinds with nothing in them are listed underneath instead */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          {present.map(t => (
            <StatCard key={t.tab} icon={t.icon} value={t.value} label={t.label} onClick={() => onNavigate(t.tab)} />
          ))}
        </div>
        {missing.length > 0 && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-dashed border-rule text-sm text-text-secondary">
            <Info className="text-text-tertiary mt-0.5" size={20} />
            <div>
              <span className="font-medium text-text-primary">Not in this backup: </span>
              {listOf(missing)}.
              {!overview.encrypted && overview.total_calls === 0 && (
                <> Apple only includes call history when a backup is encrypted.</>
              )}
            </div>
          </div>
        )}

        {/* Insights Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Messages Insight */}
          {overview.total_messages > 0 && (
            <InsightCard title="Messages" icon={LinesIcon} onViewAll={() => onNavigate('messages')}>
              <div className="space-y-4">
                <ProportionBar items={[
                  { label: 'Sent', value: messages.sent, color: SERIES.terracotta },
                  { label: 'Received', value: messages.received, color: SERIES.slate },
                ]} />

                <ProportionBar items={[
                  { label: 'iMessage', value: messages.imessage_count, color: SERIES.slate },
                  { label: 'SMS', value: messages.sms_count, color: SERIES.sage },
                ]} />

                {messages.top_conversations.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 mb-2">Top conversations</div>
                    <div className="space-y-1.5">
                      {messages.top_conversations.map((conv, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary w-4">{i + 1}.</span>
                            <span className="text-xs text-gray-700 truncate max-w-[160px]">{conv.display_name}</span>
                          </div>
                          <span className="text-xs font-medium text-gray-500 tabular-nums">
                            {conv.message_count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t border-gray-100 pt-3 space-y-0.5">
                  {messages.busiest_day && <MiniStat label="Busiest day" value={messages.busiest_day} />}
                  {messages.busiest_hour >= 0 && <MiniStat label="Peak hour" value={formatHour(messages.busiest_hour)} />}
                  {messages.avg_messages_per_day > 0 && (
                    <MiniStat label="Average per day" value={`~${messages.avg_messages_per_day}`} />
                  )}
                  {messages.total_attachments > 0 && (
                    <MiniStat label="Attachments" value={messages.total_attachments.toLocaleString()} />
                  )}
                  {(messages.first_message_date || messages.last_message_date) && (
                    <MiniStat label="Date range" value={dateRange(messages.first_message_date, messages.last_message_date)} />
                  )}
                </div>
              </div>
            </InsightCard>
          )}

          {/* WhatsApp: how much there is, or that it's there but couldn't be read */}
          {(whatsappMessages > 0 || whatsappUnreadable) && (
            <InsightCard title="WhatsApp" icon={WhatsAppIcon} onViewAll={() => onNavigate('whatsapp')}>
              {whatsappUnreadable ? (
                <p className="text-sm text-text-secondary">
                  {overview.whatsapp_status === 'unsupported_format'
                    ? "WhatsApp is in this backup, but this version of it can't be read yet."
                    : "WhatsApp is in this backup, but its chats couldn't be read."}
                </p>
              ) : (
                <div className="space-y-0.5">
                  <MiniStat label="Chats" value={(overview.total_whatsapp_chats ?? 0).toLocaleString()} />
                  <MiniStat label="Messages" value={whatsappMessages.toLocaleString()} />
                </div>
              )}
            </InsightCard>
          )}

          {/* Photos Insight: the photos in the backup, as the tile counts them */}
          {(overview.total_photos + overview.total_videos) > 0 && (
            <InsightCard title="Photos & Videos" icon={CameraIcon} onViewAll={() => onNavigate('photos')}>
              {overview.photos_in_backup === 0 ? (
                <p className="text-xs text-gray-500">{allOnlyInIcloud(photosOnlyInIcloud)}</p>
              ) : (
                <div className="space-y-4">
                  {Object.keys(photos.by_kind).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-gray-500 mb-2">Breakdown</div>
                      {(() => {
                        const kindColors: Record<string, string> = {
                          photo: SERIES.terracotta,
                          video: SERIES.ochre,
                          live_photo: SERIES.plum,
                          other: SERIES.taupe,
                        };
                        const items = Object.entries(photos.by_kind).map(([kind, count]) => ({
                          label: kind.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
                          value: count,
                          color: kindColors[kind] || SERIES.taupe,
                        }));
                        return <ProportionBar items={items} />;
                      })()}
                    </div>
                  )}

                  {photosOnlyInIcloud > 0 && (
                    <p className="text-xs text-gray-500">{moreOnlyInIcloud(photosOnlyInIcloud)}</p>
                  )}

                  <div className="border-t border-gray-100 pt-3 space-y-0.5">
                    {photos.total_favorites > 0 && (
                      <MiniStat label="Favorites" value={photos.total_favorites.toLocaleString()} />
                    )}
                    {photos.with_location > 0 && (
                      <MiniStat label="With location" value={photos.with_location.toLocaleString()} />
                    )}
                    {photos.total_video_duration_seconds > 0 && (
                      <MiniStat label="Video duration" value={formatDuration(photos.total_video_duration_seconds)} />
                    )}
                    {(photos.earliest_date || photos.latest_date) && (
                      <MiniStat label="Date range" value={dateRange(photos.earliest_date, photos.latest_date)} />
                    )}
                  </div>
                </div>
              )}
            </InsightCard>
          )}

          {/* Calls Insight */}
          {overview.total_calls > 0 && (
            <InsightCard title="Calls" icon={CallIcon} onViewAll={() => onNavigate('calls')}>
              <div className="space-y-4">
                <ProportionBar items={[
                  { label: 'Incoming', value: calls.incoming, color: SERIES.slate },
                  { label: 'Outgoing', value: calls.outgoing, color: SERIES.terracotta },
                ]} />

                <ProportionBar items={[
                  { label: 'Answered', value: calls.answered, color: SERIES.sage },
                  { label: 'Missed', value: calls.missed, color: SERIES.missed },
                ]} />

                {calls.top_contacts.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-gray-500 mb-2">Top contacts</div>
                    <div className="space-y-1.5">
                      {calls.top_contacts.map((contact, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-text-tertiary w-4">{i + 1}.</span>
                            <span className="text-xs text-gray-700 truncate max-w-[160px]">{contact.name}</span>
                          </div>
                          <span className="text-xs font-medium text-gray-500 tabular-nums">
                            {contact.count.toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="border-t border-gray-100 pt-3 space-y-0.5">
                  {calls.total_duration_seconds > 0 && (
                    <MiniStat label="Total talk time" value={formatDuration(calls.total_duration_seconds)} />
                  )}
                  {calls.avg_duration_seconds > 0 && (
                    <MiniStat label="Avg call" value={formatDuration(calls.avg_duration_seconds)} />
                  )}
                  {calls.longest_call_seconds > 0 && (
                    <MiniStat label="Longest call" value={formatDuration(calls.longest_call_seconds)} />
                  )}
                  {calls.facetime_count > 0 && (
                    <MiniStat label="FaceTime calls" value={calls.facetime_count.toLocaleString()} />
                  )}
                </div>
              </div>
            </InsightCard>
          )}

          {/* Notes Insight */}
          {overview.total_notes > 0 && (
            <InsightCard title="Notes" icon={NoteIcon} onViewAll={() => onNavigate('notes')}>
              <div className="space-y-0.5">
                <MiniStat label="Total notes" value={notes.total.toLocaleString()} />
                {notes.avg_length_chars > 0 && (
                  <MiniStat label="Average length" value={`~${notes.avg_length_chars.toLocaleString()} chars`} />
                )}
                {notes.longest_chars > 0 && (
                  <MiniStat label="Longest note" value={`${notes.longest_chars.toLocaleString()} chars`} />
                )}
              </div>
            </InsightCard>
          )}

          {/* Voicemail Insight */}
          {overview.total_voicemails > 0 && (
            <InsightCard title="Voicemail" icon={VoicemailIcon} onViewAll={() => onNavigate('voicemail')}>
              <div className="space-y-4">
                <ProportionBar items={[
                  { label: 'Read', value: voicemails.read, color: SERIES.sage },
                  { label: 'Unread', value: voicemails.unread, color: SERIES.ochre },
                ]} />
                <div className="border-t border-gray-100 pt-3 space-y-0.5">
                  <MiniStat label="Total" value={voicemails.total.toLocaleString()} />
                  {voicemails.total_duration_seconds > 0 && (
                    <MiniStat label="Total duration" value={formatDuration(voicemails.total_duration_seconds)} />
                  )}
                </div>
              </div>
            </InsightCard>
          )}
        </div>
      </div>
    </div>
  );
}

// "photos, calls and notes"
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export default function BackupDashboard({ stats, loading, error, onNavigate, hasBrowserHistory }: Props) {
  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-sm text-text-secondary mb-1">Couldn't read this backup's overview</div>
          <div className="text-xs text-apple-error">{error}</div>
          <ReportProblemButton error={error} area="dashboard" className="mt-2" />
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return <DashboardContent stats={stats} onNavigate={onNavigate} hasBrowserHistory={hasBrowserHistory} />;
}
