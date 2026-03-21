import { useEffect, useState } from 'react';
import { MessageSquare, Image, Phone, PhoneCall, Users, FileText, Globe, Youtube, MapPin, Loader2, Database } from 'lucide-react';
import { sidecarCall, DataSource, DataSourceId, DetectedApp, ScanResult } from '../lib/ipc';
import { BackupInfo } from '../hooks/useBackup';

interface Props {
  backup: BackupInfo;
  onConfirm: (selected: DataSource[]) => void;
}

const SOURCE_ICONS: Record<DataSourceId, typeof MessageSquare> = {
  messages: MessageSquare,
  photos: Image,
  voicemail: Phone,
  calls: PhoneCall,
  contacts: Users,
  notes: FileText,
  chrome: Globe,
  youtube: Youtube,
  location: MapPin,
};

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export default function DataSourcePicker({ backup, onConfirm }: Props) {
  const [sources, setSources] = useState<DataSource[]>([]);
  const [detected, setDetected] = useState<DetectedApp[]>([]);
  const [selected, setSelected] = useState<Set<DataSourceId>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detectedExpanded, setDetectedExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    sidecarCall<ScanResult>('scan_data_sources', { udid: backup.udid })
      .then(({ sources: scanned, detected: apps }) => {
        setSources(scanned);
        setDetected(apps ?? []);
        setSelected(new Set(scanned.filter(s => s.available).map(s => s.id)));
      })
      .catch(err => setError(err.message ?? 'Scan failed'))
      .finally(() => setLoading(false));
  }, [backup.udid]);

  const availableSources = sources.filter(s => s.available);
  const allSelected = availableSources.length > 0 && availableSources.every(s => selected.has(s.id));

  function toggleSource(id: DataSourceId) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(availableSources.map(s => s.id)));
    }
  }

  function handleConfirm() {
    onConfirm(sources.filter(s => selected.has(s.id)));
  }

  return (
    <div className="flex flex-col items-center justify-start h-full px-6 py-8 overflow-y-auto">
      <div className="w-full max-w-lg">
        <h2 className="font-display text-lg font-semibold text-text-primary mb-1">
          Choose Data Sources
        </h2>
        <p className="text-body text-text-secondary mb-6">
          Select which data to load from{' '}
          <span className="text-text-primary font-medium">{backup.device_name}</span>.
        </p>

        {loading && (
          <div className="flex items-center justify-center gap-2.5 py-16 text-text-secondary">
            <Loader2 size={18} strokeWidth={1.5} className="animate-spin" />
            <span className="text-body">Scanning backup…</span>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-body text-red-700 mb-4">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── Supported sources ─────────────────────────────────── */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-caption text-text-tertiary uppercase tracking-wide font-semibold">
                Supported sources
              </span>
              {availableSources.length > 0 && (
                <button
                  onClick={toggleAll}
                  className="text-caption text-text-accent hover:underline"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2 mb-6">
              {sources.map(source => {
                const Icon = SOURCE_ICONS[source.id];
                const isChecked = selected.has(source.id);
                return (
                  <button
                    key={source.id}
                    disabled={!source.available}
                    onClick={() => source.available && toggleSource(source.id)}
                    className={`flex items-center gap-3 rounded-lg px-4 py-3 border text-left transition-colors duration-150 ${
                      !source.available
                        ? 'opacity-40 cursor-not-allowed border-border-default bg-surface'
                        : isChecked
                        ? 'border-text-accent bg-accent-subtle'
                        : 'border-border-default bg-surface hover:bg-sidebar-active/40'
                    }`}
                  >
                    {/* Checkbox */}
                    <div
                      className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border transition-colors duration-150 ${
                        isChecked && source.available
                          ? 'bg-text-accent border-text-accent'
                          : 'border-border-default bg-transparent'
                      }`}
                    >
                      {isChecked && source.available && (
                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                          <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>

                    <Icon
                      size={16}
                      strokeWidth={1.5}
                      className={source.available ? 'text-text-accent flex-shrink-0' : 'text-text-tertiary flex-shrink-0'}
                    />

                    <span className="flex-1 text-body text-text-primary">{source.label}</span>

                    {source.available ? (
                      <span className="text-caption text-text-secondary tabular-nums">
                        {formatCount(source.record_count)}
                      </span>
                    ) : (
                      <span className="text-caption text-text-tertiary">Not found</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* ── Detected app data (no adapter) ────────────────────── */}
            {detected.length > 0 && (
              <div className="mb-6">
                <button
                  onClick={() => setDetectedExpanded(x => !x)}
                  className="flex items-center justify-between w-full mb-3 group"
                >
                  <span className="text-caption text-text-tertiary uppercase tracking-wide font-semibold">
                    App data detected — no adapter
                    <span className="ml-1.5 normal-case font-normal text-text-tertiary">
                      ({detected.length})
                    </span>
                  </span>
                  <span className="text-caption text-text-accent group-hover:underline">
                    {detectedExpanded ? 'Hide' : 'Show'}
                  </span>
                </button>

                {detectedExpanded && (
                  <>
                    <p className="text-caption text-text-secondary mb-3 leading-relaxed">
                      These apps have data in the backup but no extraction adapter is available yet.
                      The raw database files are present — adapter contributions are welcome.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {detected.map(app => (
                        <div
                          key={app.bundle_id}
                          className="flex items-start gap-3 rounded-lg px-4 py-3 border border-border-default bg-surface opacity-60"
                        >
                          <Database size={15} strokeWidth={1.5} className="text-text-tertiary flex-shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-body text-text-primary font-medium">
                                {app.display_name}
                              </span>
                              <span
                                className="text-caption text-text-tertiary bg-sidebar-active px-1.5 py-0.5 rounded"
                                title={app.bundle_id}
                              >
                                no adapter
                              </span>
                            </div>
                            <span className="text-caption text-text-tertiary truncate block" title={app.bundle_id}>
                              {app.bundle_id}
                            </span>
                            <span className="text-caption text-text-tertiary">
                              {app.db_files.length} database file{app.db_files.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            <button
              onClick={handleConfirm}
              disabled={selected.size === 0}
              className="w-full rounded-md bg-text-accent text-white text-body font-medium py-2.5 transition-opacity duration-150 disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
            >
              Open Selected{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
