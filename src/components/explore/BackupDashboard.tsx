import { useBackupStats, type BackupStats } from '../../hooks/useBackupStats';
import CountUp from '../shared/CountUp';
import OrganicLoader from '../shared/OrganicLoader';
import {
  LinesIcon, CameraIcon, ContactIcon, CallIcon, NoteIcon, VoicemailIcon,
  LockIcon, ClockIcon,
} from '../shared/Icons';

interface Props {
  udid: string;
  onNavigate: (tab: string) => void;
}

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
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-100">
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
      <div className="flex gap-4 text-xs text-gray-500">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
            <span className="font-medium text-gray-700">{item.value.toLocaleString()}</span>
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
      className="hearth-card p-4 text-left hover:border-[var(--border-strong)] transition-all duration-200 group"
    >
      <Icon className="text-text-tertiary group-hover:text-accent transition-colors" size={18} />
      <div className="mt-2 text-2xl text-text-primary tabular-nums" style={{ fontFamily: 'Fraunces, serif', fontWeight: 500, letterSpacing: '-0.02em' }}>
        <CountUp end={value} />
      </div>
      <div className="text-xs text-text-secondary mt-0.5">{label}</div>
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
    <div className="rounded-xl bg-white border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon className="text-gray-400" size={16} />
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        </div>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
          >
            View all
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
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-xs font-medium text-gray-800">{value}</span>
    </div>
  );
}

// ── Main Dashboard ───────────────────────────────────────────────────────────

function DashboardContent({ stats, onNavigate }: { stats: BackupStats; onNavigate: (tab: string) => void }) {
  const { overview, messages, photos, calls, notes, voicemails } = stats;

  const dateRange = (from: string | null, to: string | null) => {
    if (!from && !to) return '';
    return `${formatDate(from)} — ${formatDate(to)}`;
  };

  return (
    <div className="p-7 space-y-6 overflow-y-auto h-full">
      {/* Hero */}
      <div>
        <div className="hearth-eyebrow mb-2">Overview</div>
        <h1 className="text-4xl text-text-primary">
          {overview.device_name}
        </h1>
        <div className="flex items-center gap-3 mt-3 text-sm text-text-secondary flex-wrap">
          {overview.ios_version && (
            <span className="hearth-pill">iOS {overview.ios_version}</span>
          )}
          {overview.last_backup && (
            <span className="flex items-center gap-1.5 font-mono text-xs">
              <ClockIcon size={12} className="text-text-tertiary" />
              {formatFullDate(overview.last_backup)}
            </span>
          )}
          {overview.size_gb > 0 && (
            <span className="font-mono text-xs">{overview.size_gb.toFixed(1)} GB</span>
          )}
          {overview.encrypted && (
            <span className="flex items-center gap-1 text-accent">
              <LockIcon size={12} />
              Encrypted
            </span>
          )}
        </div>
      </div>

      {/* Big Numbers */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          icon={LinesIcon}
          value={overview.total_messages}
          label="Messages"
          onClick={() => onNavigate('messages')}
        />
        <StatCard
          icon={CameraIcon}
          value={overview.total_photos + overview.total_videos}
          label="Photos & Videos"
          onClick={() => onNavigate('photos')}
        />
        <StatCard
          icon={ContactIcon}
          value={overview.total_contacts}
          label="Contacts"
          onClick={() => onNavigate('contacts')}
        />
        <StatCard
          icon={CallIcon}
          value={overview.total_calls}
          label="Calls"
          onClick={() => onNavigate('calls')}
        />
        <StatCard
          icon={NoteIcon}
          value={overview.total_notes}
          label="Notes"
          onClick={() => onNavigate('notes')}
        />
        <StatCard
          icon={VoicemailIcon}
          value={overview.total_voicemails}
          label="Voicemails"
          onClick={() => onNavigate('voicemail')}
        />
      </div>

      {/* Insights Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Messages Insight */}
        {overview.total_messages > 0 && (
          <InsightCard title="Messages" icon={LinesIcon} onViewAll={() => onNavigate('messages')}>
            <div className="space-y-4">
              <ProportionBar items={[
                { label: 'Sent', value: messages.sent, color: '#34d399' },
                { label: 'Received', value: messages.received, color: '#60a5fa' },
              ]} />

              <ProportionBar items={[
                { label: 'iMessage', value: messages.imessage_count, color: '#3b82f6' },
                { label: 'SMS', value: messages.sms_count, color: '#a3e635' },
              ]} />

              {messages.top_conversations.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-2">Top conversations</div>
                  <div className="space-y-1.5">
                    {messages.top_conversations.map((conv, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
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

        {/* Photos Insight */}
        {(overview.total_photos + overview.total_videos) > 0 && (
          <InsightCard title="Photos & Videos" icon={CameraIcon} onViewAll={() => onNavigate('photos')}>
            <div className="space-y-4">
              {Object.keys(photos.by_kind).length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-2">Breakdown</div>
                  {(() => {
                    const kindColors: Record<string, string> = {
                      photo: '#3b82f6',
                      video: '#f97316',
                      live_photo: '#8b5cf6',
                      other: '#6b7280',
                    };
                    const items = Object.entries(photos.by_kind).map(([kind, count]) => ({
                      label: kind.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
                      value: count,
                      color: kindColors[kind] || '#9ca3af',
                    }));
                    return <ProportionBar items={items} />;
                  })()}
                </div>
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
          </InsightCard>
        )}

        {/* Calls Insight */}
        {overview.total_calls > 0 && (
          <InsightCard title="Calls" icon={CallIcon} onViewAll={() => onNavigate('calls')}>
            <div className="space-y-4">
              <ProportionBar items={[
                { label: 'Incoming', value: calls.incoming, color: '#60a5fa' },
                { label: 'Outgoing', value: calls.outgoing, color: '#34d399' },
              ]} />

              <ProportionBar items={[
                { label: 'Answered', value: calls.answered, color: '#34d399' },
                { label: 'Missed', value: calls.missed, color: '#f87171' },
              ]} />

              {calls.top_contacts.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-2">Top contacts</div>
                  <div className="space-y-1.5">
                    {calls.top_contacts.map((contact, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
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
                { label: 'Read', value: voicemails.read, color: '#34d399' },
                { label: 'Unread', value: voicemails.unread, color: '#fbbf24' },
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
  );
}

export default function BackupDashboard({ udid, onNavigate }: Props) {
  const { stats, loading, error } = useBackupStats(udid);

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-sm text-gray-500 mb-1">Failed to load dashboard</div>
          <div className="text-xs text-red-500">{error}</div>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return <DashboardContent stats={stats} onNavigate={onNavigate} />;
}
