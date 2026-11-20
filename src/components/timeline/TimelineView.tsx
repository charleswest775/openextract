import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { useTimeline, type BackupIndex } from '../../hooks/useTimeline';
import { TimelineEntry, TimelineEntryType, TimelineFilters } from '../../types/timeline';
import TimelineFilterBar from './TimelineFilterBar';
import EventStream from './EventStream';
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
  /** The records, read once for the whole backup. */
  index: BackupIndex;
  startingFilters?: Partial<TimelineFilters>;
  /** What the top search box holds; the Timeline shows only events that match. */
  query: string;
  /** Opens a WhatsApp message in its chat on the WhatsApp screen. */
  onOpenWhatsApp?: (entry: TimelineEntry) => void;
  /** Opens a text message in its conversation on the Messages screen. */
  onOpenMessage?: (entry: TimelineEntry) => void;
}

const LOADING_LABELS: Record<TimelineEntryType, string> = {
  message:   'Messages',
  whatsapp:  'WhatsApp',
  call:      'Calls',
  photo:     'Photos',
  voicemail: 'Voicemail',
  note:      'Notes',
  browser:   'Web history',
};

const ALL_TYPES: TimelineEntryType[] = ['message', 'whatsapp', 'call', 'photo', 'voicemail', 'note', 'browser'];

export default function TimelineView({ udid, index, startingFilters, query, onOpenWhatsApp, onOpenMessage }: Props) {
  const {
    filteredEntries,
    allContacts,
    counts,
    totalFiltered,
    loading,
    loadingTypes,
    errors,
    whatsappCap,
    filters,
    setFilters,
  } = useTimeline(index, startingFilters);

  const [choosing, setChoosing] = useState(false);
  const { busy: exporting, run } = useSaveAction('timeline');

  // The top search box filters the Timeline
  useEffect(() => {
    setFilters({ searchQuery: query });
  }, [query, setFilters]);

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

  const anyError = Object.keys(errors).length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      <PageHeader
        title="Timeline"
        count={loading
          ? <span className="inline-flex items-center gap-1.5"><Loader2 size={16} className="animate-spin" />Loading…</span>
          : plural(totalFiltered, 'event')}
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

      {/* More WhatsApp than the index reads: say the oldest chats aren't here */}
      {whatsappCap && (
        <div style={{ flexShrink: 0, padding: '6px 20px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', borderRadius: 6,
            background: 'var(--bg-surface)', border: '0.5px solid var(--border-default)',
            fontSize: 14, color: 'var(--text-secondary)',
          }}>
            <Info size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            WhatsApp: the newest {whatsappCap.loaded.toLocaleString()} of {whatsappCap.total.toLocaleString()} messages are in the Timeline and search. Older chats open in full in the WhatsApp section.
          </div>
        </div>
      )}

      {/* Loading progress (shown while any type is still loading AND no entries yet) */}
      {loading && filteredEntries.length === 0 && (
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
      {!loading && filteredEntries.length === 0 && (
        <div style={{ flex: 1 }}>
          <EmptyState
            icon={ClockIcon}
            title="Nothing matches these filters"
            detail="Try more kinds of events, someone else, or a wider date range."
          />
        </div>
      )}

      {/* Timeline body: one stream, newest first, growing as you scroll. Shown while loading once there's something to show. */}
      {filteredEntries.length > 0 && (
        <EventStream
          entries={filteredEntries}
          resetKey={filters}
          udid={udid}
          variant="timeline"
          loading={loading}
          className="px-6 pb-4"
          onOpenWhatsApp={onOpenWhatsApp}
          onOpenMessage={onOpenMessage}
        />
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
