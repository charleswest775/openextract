import { useMemo, useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTimeline } from '../../hooks/useTimeline';
import { TimelineEntry, TimelineEntryType, TimelineFilters } from '../../types/timeline';
import TimelineFilterBar from './TimelineFilterBar';
import TimelineEntryCard from './TimelineEntryCard';
import { formatDate } from '../../lib/dates';
import { saveFolder } from '../../lib/ipc';
import { formatTimeline, FORMAT_FILTERS, ExportFormat } from '../../lib/timelineExport';
import OrganicLoader from '../shared/OrganicLoader';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { ClockIcon } from '../shared/Icons';
import { useSaveAction } from '../../hooks/useSaveAction';
import { plural } from '../../lib/saveData';

const TIMELINE_FORMATS = [
  FORMATS.html,
  FORMATS.csv,
  { id: 'md', label: 'Markdown', detail: 'MD, for notes apps and text editors' },
];

interface Props {
  udid: string;
  startingFilters?: Partial<TimelineFilters>;
}

const LOADING_LABELS: Record<TimelineEntryType, string> = {
  message:   'Messages',
  call:      'Calls',
  photo:     'Photos',
  voicemail: 'Voicemail',
  note:      'Notes',
  browser:   'Web history',
};

const ALL_TYPES: TimelineEntryType[] = ['message', 'call', 'photo', 'voicemail', 'note', 'browser'];

// Group entries by calendar day
export function groupByDay(entries: TimelineEntry[]): { date: string; entries: TimelineEntry[] }[] {
  const groups: { date: string; entries: TimelineEntry[] }[] = [];
  let lastDate: string | null = null;
  for (const e of entries) {
    const d = formatDate(e.timestamp) || 'Unknown date';
    if (d !== lastDate) {
      lastDate = d;
      groups.push({ date: d, entries: [] });
    }
    groups[groups.length - 1].entries.push(e);
  }
  return groups;
}

export default function TimelineView({ udid, startingFilters }: Props) {
  const {
    entries,
    filteredEntries,
    allContacts,
    counts,
    totalFiltered,
    loading,
    loadingTypes,
    errors,
    filters,
    setFilters,
    page,
    setPage,
    pageSize,
  } = useTimeline(udid, startingFilters);

  const [choosing, setChoosing] = useState(false);
  const { busy: exporting, run } = useSaveAction('timeline');

  // The search field lives in the page header; typing waits a moment before filtering.
  const [searchText, setSearchText] = useState(filters.searchQuery);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSearchChange(val: string) {
    setSearchText(val);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => setFilters({ searchQuery: val }), 300);
  }
  useEffect(() => () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); }, []);

  function handleExport(format: ExportFormat) {
    setChoosing(false);
    if (filteredEntries.length === 0) return;
    run(async () => {
      const folder = await saveFolder();
      if (!folder) return null;
      const ext = FORMAT_FILTERS[format].extensions[0];
      const path = `${folder}/timeline-export.${ext}`;
      await window.openextract.writeFile(path, formatTimeline(filteredEntries, format));
      return { title: `Saved ${plural(filteredEntries.length, 'event')} from the Timeline`, path };
    });
  }

  const groups = useMemo(() => groupByDay(entries), [entries]);

  const start = page * pageSize + 1;
  const end = Math.min(page * pageSize + pageSize, totalFiltered);
  const totalPages = Math.ceil(totalFiltered / pageSize);

  const anyError = Object.keys(errors).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      <PageHeader
        title="Timeline"
        count={loading
          ? <span className="inline-flex items-center gap-1.5"><Loader2 size={16} className="animate-spin" />Loading…</span>
          : plural(totalFiltered, 'event')}
        search={{ value: searchText, onChange: handleSearchChange, placeholder: 'Search the timeline' }}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={exporting} disabled={loading || totalFiltered === 0} />}
      />

      {/* Filter bar */}
      <TimelineFilterBar
        filters={filters}
        counts={counts}
        allContacts={allContacts}
        onFiltersChange={setFilters}
      />

      {/* Error banners */}
      {anyError && (
        <div style={{ flexShrink: 0, padding: '6px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(Object.entries(errors) as [TimelineEntryType, string][]).map(([type, msg]) => (
            <div key={type} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 10px', borderRadius: 6,
              background: 'rgba(255,59,48,0.08)', border: '0.5px solid rgba(255,59,48,0.2)',
              fontSize: 14, color: 'var(--text-secondary)',
            }}>
              <AlertTriangle size={16} style={{ color: 'var(--error)', flexShrink: 0 }} />
              {LOADING_LABELS[type]}: {msg}
              <ReportProblemButton error={`${LOADING_LABELS[type]}: ${msg}`} area="timeline" className="ml-1" />
            </div>
          ))}
        </div>
      )}

      {/* Loading progress (shown while any type is still loading AND no entries yet) */}
      {loading && entries.length === 0 && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: 'var(--bg-surface)',
            border: '0.5px solid var(--border-default)',
            borderRadius: 12,
            padding: '24px 32px',
            minWidth: 280,
          }}>
            <div className="flex justify-center mb-3 text-accent">
              <OrganicLoader size={72} />
            </div>
            <div className="hearth-eyebrow text-center mb-4">Loading timeline</div>
            {ALL_TYPES.map(type => {
              const isLoading = loadingTypes.has(type);
              const hasError = !!errors[type];
              return (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                  {hasError
                    ? <AlertTriangle size={18} style={{ color: 'var(--error)' }} />
                    : isLoading
                      ? <Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent)' }} />
                      : <CheckCircle2 size={18} style={{ color: 'var(--success)' }} />
                  }
                  <span>{LOADING_LABELS[type]}</span>
                  {!isLoading && !hasError && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>({counts[type].toLocaleString()})</span>
                  )}
                  {hasError && (
                    <span style={{ color: 'var(--error)', fontSize: 14 }}>failed</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state (filters returned nothing) */}
      {!loading && entries.length === 0 && (
        <div style={{ flex: 1 }}>
          <EmptyState
            icon={ClockIcon}
            title="Nothing matches these filters"
            detail="Try more kinds of events, someone else, or a wider date range."
          />
        </div>
      )}

      {/* Timeline body — shown even while loading if we have partial entries */}
      {entries.length > 0 && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 16px' }}>
          {groups.map(group => (
            <div key={group.date}>
              {/* Date group header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '14px 0 8px',
                position: 'sticky', top: 0,
                background: 'var(--bg-base)',
                zIndex: 10,
              }}>
                <div style={{ flex: 1, height: '0.5px', background: 'var(--border-default)' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>
                  {group.date}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {group.entries.length} event{group.entries.length !== 1 ? 's' : ''}
                </span>
                <div style={{ flex: 1, height: '0.5px', background: 'var(--border-default)' }} />
              </div>

              {/* Entry cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {group.entries.map(entry => (
                  <TimelineEntryCard key={entry.id} entry={entry} udid={udid} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination: newest first, a page at a time */}
      {totalFiltered > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 24px',
          borderTop: '1px solid var(--border-default)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {`${start.toLocaleString()}–${end.toLocaleString()} of ${plural(totalFiltered, 'event')}`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="hearth-ghost-btn">
              ← Newer
            </button>
            <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} className="hearth-ghost-btn">
              Older →
            </button>
          </div>
        </div>
      )}
      {choosing && (
        <SaveDialog
          title={`Save ${plural(totalFiltered, 'event')} from the Timeline`}
          formats={TIMELINE_FORMATS}
          onSave={id => handleExport(id as ExportFormat)}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
