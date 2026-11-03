import type { ReactNode } from 'react';
import {
  ClockIcon, CalendarIcon, ExportIcon, FolderIcon, NoteIcon, RecoverIcon, VoicemailIcon,
} from '../shared/Icons';
import { DATA_SECTIONS, type ExploreContext, type Icon, type Tab } from './sections';

function monthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function range(from: string | null | undefined, to: string | null | undefined): string {
  const a = monthYear(from), b = monthYear(to);
  return a && b ? (a === b ? a : `${a} – ${b}`) : a || b;
}

// "About 4 min", "45 s"
function spoken(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 1 ? `About ${m} min` : `${Math.round(seconds)} s`;
}

interface Tile {
  tab: Tab;
  icon: Icon;
  label: string;
  value?: number;
  line: string;
}

/**
 * Direction 2's way in: one large tile per kind of data with what's in it, quiet
 * tiles for what the backup lacks, and the jobs people come to do.
 */
export default function LaunchpadHome({ ctx, intro }: { ctx: ExploreContext; intro?: ReactNode }) {
  const { overview, stats, hasBrowserHistory } = ctx;
  const has = (tab: Tab) => ctx.data.some(s => s.id === tab);

  const lines: Partial<Record<Tab, string>> = stats ? {
    messages: range(stats.messages.first_message_date, stats.messages.last_message_date),
    photos: range(stats.photos.earliest_date, stats.photos.latest_date),
    contacts: 'People and places',
    calls: stats.calls.total_duration_seconds > 0 ? `${spoken(stats.calls.total_duration_seconds)} of talking` : 'Who called, and when',
    notes: stats.notes.avg_length_chars > 0 ? `About ${Math.max(1, Math.round(stats.notes.avg_length_chars / 6))} words each` : 'Lists, plans and ideas',
    voicemail: stats.voicemails.total_duration_seconds > 0 ? `${spoken(stats.voicemails.total_duration_seconds)} of audio` : 'Messages people left',
    browser_history: 'Pages visited in Safari and Firefox',
  } : {};

  const tiles: Tile[] = [
    ...ctx.data.map(s => ({
      tab: s.id, icon: s.icon, label: s.id === 'browser_history' ? 'Web history' : s.label,
      value: s.count && overview ? s.count(overview) : undefined,
      line: lines[s.id] ?? '',
    })),
    { tab: 'timeline', icon: ClockIcon, label: 'Timeline', line: 'Every event, newest first' },
    { tab: 'year', icon: CalendarIcon, label: 'Year', line: 'A year at a glance, day by day' },
  ];

  const why = (tab: Tab): string => {
    switch (tab) {
      case 'photos': return 'They may be only in iCloud';
      case 'calls': return overview && !overview.encrypted ? 'Only in encrypted backups' : 'None in this backup';
      case 'voicemail': return 'Needs Visual Voicemail from the carrier';
      case 'browser_history': return 'No Safari or Firefox history found';
      default: return 'None in this backup';
    }
  };
  const missing = overview
    ? DATA_SECTIONS.filter(s => !has(s.id) && (s.id !== 'browser_history' || !hasBrowserHistory))
    : [];

  const tasks: { icon: Icon; label: string; tab: Tab }[] = [
    ...(has('messages') ? [{ icon: ExportIcon, label: 'Save a conversation as a PDF', tab: 'messages' as Tab }] : []),
    ...(has('voicemail') ? [{ icon: VoicemailIcon, label: 'Save every voicemail', tab: 'voicemail' as Tab }] : []),
    ...(has('photos') ? [{ icon: FolderIcon, label: 'Copy all photos to this computer', tab: 'photos' as Tab }] : []),
    ...(has('messages') ? [{ icon: RecoverIcon, label: 'Look for deleted messages', tab: 'record_recovery' as Tab }] : []),
    ...(has('notes') ? [{ icon: NoteIcon, label: 'Read and save your notes', tab: 'notes' as Tab }] : []),
  ].slice(0, 4);

  const backedUp = overview?.last_backup
    ? new Date(overview.last_backup).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
    : null;
  const history = stats ? range(stats.messages.first_message_date, stats.messages.last_message_date) : '';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-8 flex flex-col gap-6">
        {intro}
        <div>
          <h1 className="text-4xl text-text-primary">{overview?.device_name ?? ctx.session?.name}</h1>
          <p className="text-base text-text-secondary mt-2">
            {[backedUp && `Backed up ${backedUp}`, overview?.ios_version && `iOS ${overview.ios_version}`, history && `history from ${history}`]
              .filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {tiles.map(t => {
            const I = t.icon;
            return (
              <button
                key={t.tab}
                onClick={() => ctx.openTab(t.tab)}
                className="hearth-card p-5 flex items-center gap-4 text-left hover:border-[var(--border-strong)] hover:bg-[var(--bg-elevated)] transition-colors min-h-[124px]"
              >
                <span className="w-14 h-14 rounded-2xl bg-accent-wash flex items-center justify-center flex-shrink-0">
                  <I size={30} className="text-accent" />
                </span>
                <span className="flex flex-col min-w-0">
                  {t.value != null && (
                    <span className="text-3xl text-text-primary tabular-nums leading-none mb-1" style={{ fontFamily: 'Fraunces, serif', fontWeight: 500 }}>
                      {t.value.toLocaleString()}
                    </span>
                  )}
                  <span className="text-base font-semibold text-text-primary">{t.label}</span>
                  {t.line && <span className="text-sm text-text-secondary line-clamp-2">{t.line}</span>}
                </span>
              </button>
            );
          })}
          {missing.map(s => {
            const I = s.icon;
            return (
              <div
                key={s.id}
                className="rounded-xl border border-dashed border-border-strong p-5 flex items-center gap-4 min-h-[124px]"
              >
                <span className="w-14 h-14 rounded-2xl bg-sand flex items-center justify-center flex-shrink-0">
                  <I size={30} className="text-text-tertiary" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-base font-semibold text-text-secondary">{s.id === 'browser_history' ? 'Web history' : s.label}</span>
                  <span className="text-sm text-text-tertiary">Not in this backup</span>
                  <span className="text-sm text-text-secondary">{why(s.id)}</span>
                </span>
              </div>
            );
          })}
        </div>

        {tasks.length > 0 && (
          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-text-primary">Common tasks</h2>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {tasks.map(task => {
                const I = task.icon;
                return (
                  <button
                    key={task.label}
                    onClick={() => ctx.openTab(task.tab)}
                    className="hearth-card px-4 py-4 flex items-center gap-3 text-left text-[15px] font-medium text-text-primary hover:bg-[var(--bg-elevated)] transition-colors"
                  >
                    <I size={24} className="text-accent" />
                    {task.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
