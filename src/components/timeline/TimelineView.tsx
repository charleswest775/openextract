import { useMemo, useState, useCallback } from 'react';
import { Clock, Loader2, CheckCircle2, AlertTriangle, Download } from 'lucide-react';
import { useTimeline } from '../../hooks/useTimeline';
import { TimelineEntry, TimelineEntryType } from '../../types/timeline';
import TimelineFilterBar from './TimelineFilterBar';
import TimelineEntryCard from './TimelineEntryCard';
import { formatDate } from '../../lib/dates';
import { formatTimeline, FORMAT_FILTERS, ExportFormat } from '../../lib/timelineExport';

interface Props {
  udid: string;
}

const LOADING_LABELS: Record<TimelineEntryType, string> = {
  message:   'Messages',
  call:      'Calls',
  photo:     'Photos',
  voicemail: 'Voicemail',
  note:      'Notes',
  browser:   'Browser History',
};

const ALL_TYPES: TimelineEntryType[] = ['message', 'call', 'photo', 'voicemail', 'note', 'browser'];

// Group entries by calendar day
function groupByDay(entries: TimelineEntry[]): { date: string; entries: TimelineEntry[] }[] {
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

export default function TimelineView({ udid }: Props) {
  const {
    entries,
    filteredEntries,
    allContacts,
    counts,
    totalFiltered,
    loading,
    loadingTypes,
    errors,
    messageCap,
    filters,
    setFilters,
    page,
    setPage,
    pageSize,
    loadAllMessages,
  } = useTimeline(udid);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async (format: ExportFormat) => {
    setExportMenuOpen(false);
    if (!window.openextract || filteredEntries.length === 0) return;

    const filePath = await window.openextract.saveFile({
      title: 'Export Timeline',
      defaultPath: `timeline-export.${FORMAT_FILTERS[format].extensions[0]}`,
      filters: [FORMAT_FILTERS[format]],
    });
    if (!filePath) return;

    setExporting(true);
    try {
      const content = formatTimeline(filteredEntries, format);
      await window.openextract.writeFile(filePath, content);
      await window.openextract.incrementExportCount();
    } catch (e: any) {
      console.error('Timeline export failed:', e);
    } finally {
      setExporting(false);
    }
  }, [filteredEntries]);

  const groups = useMemo(() => groupByDay(entries), [entries]);

  const start = page * pageSize + 1;
  const end = Math.min(page * pageSize + pageSize, totalFiltered);
  const totalPages = Math.ceil(totalFiltered / pageSize);

  const anyError = Object.keys(errors).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px 12px',
        borderBottom: '0.5px solid var(--border-default)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span className="text-title font-semibold">Timeline</span>
          {!loading && (
            <span className="text-body text-text-secondary">
              {totalFiltered.toLocaleString()} event{totalFiltered !== 1 ? 's' : ''}
            </span>
          )}
          {loading && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>
              <Loader2 size={11} className="animate-spin" />
              Loading…
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {messageCap && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
              Messages: {messageCap.loaded.toLocaleString()} of {messageCap.total.toLocaleString()} loaded
              <button
                onClick={loadAllMessages}
                style={{
                  fontSize: 11, color: 'var(--text-accent)',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >
                Load all
              </button>
            </div>
          )}

          {/* Export dropdown */}
          {totalFiltered > 0 && !loading && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setExportMenuOpen(o => !o)}
                disabled={exporting}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 6,
                  border: '0.5px solid var(--border-strong)',
                  background: 'var(--bg-base)',
                  color: 'var(--text-secondary)',
                  fontSize: 12, fontFamily: 'inherit',
                  cursor: exporting ? 'not-allowed' : 'pointer',
                  opacity: exporting ? 0.5 : 1,
                }}
              >
                {exporting
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Download size={12} />}
                Export
              </button>
              {exportMenuOpen && (
                <div style={{
                  position: 'absolute', top: 32, right: 0, zIndex: 50,
                  background: 'var(--bg-elevated)',
                  border: '0.5px solid var(--border-strong)',
                  borderRadius: 8,
                  boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
                  overflow: 'hidden', minWidth: 160,
                }}>
                  {(['html', 'md', 'csv'] as ExportFormat[]).map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => handleExport(fmt)}
                      style={{
                        display: 'block', width: '100%',
                        padding: '8px 14px', textAlign: 'left',
                        background: 'transparent', border: 'none',
                        fontSize: 12, fontFamily: 'inherit',
                        color: 'var(--text-primary)', cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {FORMAT_FILTERS[fmt].name} (.{FORMAT_FILTERS[fmt].extensions[0]})
                    </button>
                  ))}
                  <div style={{ padding: '4px 14px 6px', fontSize: 11, color: 'var(--text-tertiary)', borderTop: '0.5px solid var(--border-default)' }}>
                    {totalFiltered.toLocaleString()} entries (all filtered)
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

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
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              <AlertTriangle size={13} style={{ color: 'var(--error)', flexShrink: 0 }} />
              {LOADING_LABELS[type]}: {msg}
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
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Loading Timeline…</div>
            {ALL_TYPES.map(type => {
              const isLoading = loadingTypes.has(type);
              const hasError = !!errors[type];
              return (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                  {hasError
                    ? <AlertTriangle size={14} style={{ color: 'var(--error)' }} />
                    : isLoading
                      ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent)' }} />
                      : <CheckCircle2 size={14} style={{ color: 'var(--success)' }} />
                  }
                  <span>{LOADING_LABELS[type]}</span>
                  {!isLoading && !hasError && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>({counts[type].toLocaleString()})</span>
                  )}
                  {hasError && (
                    <span style={{ color: 'var(--error)', fontSize: 12 }}>failed</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state (filters returned nothing) */}
      {!loading && entries.length === 0 && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 8,
          color: 'var(--text-tertiary)',
        }}>
          <Clock size={40} strokeWidth={1} style={{ marginBottom: 4 }} />
          <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--text-secondary)' }}>No timeline entries found</div>
          <div style={{ fontSize: 13 }}>Try adjusting your filters or date range</div>
        </div>
      )}

      {/* Timeline body — shown even while loading if we have partial entries */}
      {entries.length > 0 && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px' }}>
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
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>
                  {group.date}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {group.entries.length} event{group.entries.length !== 1 ? 's' : ''}
                </span>
                <div style={{ flex: 1, height: '0.5px', background: 'var(--border-default)' }} />
              </div>

              {/* Entry cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {group.entries.map(entry => (
                  <TimelineEntryCard key={entry.id} entry={entry} udid={udid} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalFiltered > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 20px',
          borderTop: '0.5px solid var(--border-default)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {totalFiltered === 0 ? 'No results' : `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${totalFiltered.toLocaleString()}`}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              disabled={page === 0}
              onClick={() => { setPage(page - 1); }}
              style={paginationBtn(page === 0)}
            >
              ← Prev
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => { setPage(page + 1); }}
              style={paginationBtn(page >= totalPages - 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function paginationBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '5px 14px',
    borderRadius: 6,
    border: '0.5px solid var(--border-strong)',
    background: 'var(--bg-base)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.35 : 1,
    transition: 'background 0.12s',
  };
}
