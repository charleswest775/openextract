import { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, AlertTriangle, Inbox, Download, Youtube, Clock, History } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { format, parseISO } from 'date-fns';

interface WatchEntry {
    video_id: string;
    title: string;
    channel: string;
    channel_id: string;
    watched_at: string | null;
    duration: number | null;
    progress: number | null;
    url: string;
}

interface SearchEntry {
    query: string;
    searched_at: string | null;
}

interface DownloadEntry {
    video_id: string;
    title: string;
    channel: string;
    downloaded_at: string | null;
    file_size: number | null;
    quality: string;
    duration: number | null;
    status: string;
    url: string;
}

interface Props {
    backup: BackupInfo;
}

type ActiveTab = 'watch' | 'search' | 'downloads';

function formatDuration(seconds: number | null): string {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatBytes(bytes: number | null): string {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
        return format(parseISO(iso), 'MMM d, yyyy h:mm a');
    } catch {
        return iso;
    }
}

function NoteBox({ note }: { note: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full text-text-tertiary px-8">
            <Youtube size={32} strokeWidth={1.5} className="mb-3 text-text-tertiary opacity-50" />
            <p className="text-body text-center text-text-secondary max-w-md">{note}</p>
        </div>
    );
}

export default function YouTubeView({ backup }: Props) {
    const [activeTab, setActiveTab] = useState<ActiveTab>('watch');

    const [watchEntries, setWatchEntries] = useState<WatchEntry[]>([]);
    const [watchNote, setWatchNote] = useState<string | null>(null);
    const [watchLoading, setWatchLoading] = useState(false);
    const [watchError, setWatchError] = useState<string | null>(null);

    const [searchEntries, setSearchEntries] = useState<SearchEntry[]>([]);
    const [searchNote, setSearchNote] = useState<string | null>(null);
    const [searchLoading, setSearchLoading] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
    const [downloadsNote, setDownloadsNote] = useState<string | null>(null);
    const [downloadsLoading, setDownloadsLoading] = useState(false);
    const [downloadsError, setDownloadsError] = useState<string | null>(null);

    const [filterQuery, setFilterQuery] = useState('');
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        loadWatchHistory();
        loadSearchHistory();
        loadDownloads();
    }, [backup.udid]);

    async function loadWatchHistory() {
        setWatchLoading(true);
        setWatchError(null);
        try {
            const res = await window.openextract.call('youtube.list_watch_history', {
                udid: backup.udid, limit: 10000,
            });
            if (!res.success) throw new Error(res.error);
            setWatchEntries(res.data?.entries || []);
            setWatchNote(res.data?.note || null);
        } catch (err: any) {
            setWatchError(err.message || 'Failed to load watch history');
        } finally {
            setWatchLoading(false);
        }
    }

    async function loadSearchHistory() {
        setSearchLoading(true);
        setSearchError(null);
        try {
            const res = await window.openextract.call('youtube.list_search_history', {
                udid: backup.udid, limit: 10000,
            });
            if (!res.success) throw new Error(res.error);
            setSearchEntries(res.data?.entries || []);
            setSearchNote(res.data?.note || null);
        } catch (err: any) {
            setSearchError(err.message || 'Failed to load search history');
        } finally {
            setSearchLoading(false);
        }
    }

    async function loadDownloads() {
        setDownloadsLoading(true);
        setDownloadsError(null);
        try {
            const res = await window.openextract.call('youtube.list_downloads', {
                udid: backup.udid, limit: 10000,
            });
            if (!res.success) throw new Error(res.error);
            setDownloads(res.data?.entries || []);
            setDownloadsNote(res.data?.note || null);
        } catch (err: any) {
            setDownloadsError(err.message || 'Failed to load downloads');
        } finally {
            setDownloadsLoading(false);
        }
    }

    async function handleExport() {
        setExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return;
            const res = await window.openextract.call('youtube.export', {
                udid: backup.udid,
                output_dir: folder,
                format: 'csv',
            });
            if (!res.success || res.data?.errors?.length) {
                const errs = res.data?.errors?.join('; ') || res.error;
                throw new Error(errs);
            }
            const count = (res.data?.exported || []).length;
            alert(`Exported ${count} file(s) to ${folder}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setExporting(false);
        }
    }

    const filteredWatch = useMemo(() => {
        if (!filterQuery) return watchEntries;
        const q = filterQuery.toLowerCase();
        return watchEntries.filter(e =>
            e.title?.toLowerCase().includes(q) ||
            e.channel?.toLowerCase().includes(q) ||
            e.video_id?.toLowerCase().includes(q)
        );
    }, [watchEntries, filterQuery]);

    const filteredSearch = useMemo(() => {
        if (!filterQuery) return searchEntries;
        const q = filterQuery.toLowerCase();
        return searchEntries.filter(e => e.query?.toLowerCase().includes(q));
    }, [searchEntries, filterQuery]);

    const filteredDownloads = useMemo(() => {
        if (!filterQuery) return downloads;
        const q = filterQuery.toLowerCase();
        return downloads.filter(e =>
            e.title?.toLowerCase().includes(q) ||
            e.channel?.toLowerCase().includes(q) ||
            e.video_id?.toLowerCase().includes(q)
        );
    }, [downloads, filterQuery]);

    const isLoading = watchLoading || searchLoading || downloadsLoading;
    const totalItems = watchEntries.length + searchEntries.length + downloads.length;

    const tabConfig: { id: ActiveTab; label: string; count: number; icon: typeof Clock }[] = [
        { id: 'watch',     label: 'Watch History',  count: watchEntries.length,  icon: Clock },
        { id: 'search',    label: 'Search History', count: searchEntries.length, icon: History },
        { id: 'downloads', label: 'Downloads',      count: downloads.length,     icon: Download },
    ];

    return (
        <div className="flex flex-col h-full bg-base text-text-primary">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                <div>
                    <h2 className="font-display text-title font-semibold text-text-primary">YouTube</h2>
                    <p className="text-caption text-text-tertiary mt-0.5">
                        {isLoading
                            ? 'Loading...'
                            : totalItems > 0
                                ? `${totalItems.toLocaleString()} items found`
                                : 'YouTube app data'}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search size={14} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                        <input
                            type="text"
                            placeholder="Filter..."
                            className="bg-base text-body text-text-primary rounded-lg w-56 pl-8 pr-3 py-1.5 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary transition-colors"
                            style={{ border: '0.5px solid var(--border-strong)' }}
                            value={filterQuery}
                            onChange={(e) => setFilterQuery(e.target.value)}
                        />
                    </div>
                    <button
                        onClick={handleExport}
                        disabled={exporting || totalItems === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                    >
                        <Download size={14} strokeWidth={1.5} />
                        {exporting ? 'Exporting...' : 'Export'}
                    </button>
                </div>
            </div>

            {/* Sub-tabs */}
            <div className="flex gap-0 px-6 pt-3" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                {tabConfig.map((tab) => {
                    const Icon = tab.icon;
                    const active = activeTab === tab.id;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`inline-flex items-center gap-1.5 px-4 py-2 text-body font-medium transition-colors border-b-2 -mb-px ${
                                active
                                    ? 'border-accent text-text-accent'
                                    : 'border-transparent text-text-secondary hover:text-text-primary'
                            }`}
                        >
                            <Icon size={13} strokeWidth={1.5} />
                            {tab.label}
                            {tab.count > 0 && (
                                <span className="ml-1 px-1.5 py-0.5 rounded-full text-caption bg-surface text-text-tertiary" style={{ border: '0.5px solid var(--border-default)' }}>
                                    {tab.count.toLocaleString()}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 bg-base">

                {/* Watch History */}
                {activeTab === 'watch' && (
                    <>
                        {watchLoading && <LoadingState label="Loading watch history..." />}
                        {watchError && <ErrorState message={watchError} />}
                        {!watchLoading && !watchError && watchNote && filteredWatch.length === 0 && (
                            <NoteBox note={watchNote} />
                        )}
                        {!watchLoading && !watchError && filteredWatch.length === 0 && !watchNote && (
                            <EmptyState label="No watch history found." />
                        )}
                        {!watchLoading && !watchError && filteredWatch.length > 0 && (
                            <div className="bg-base rounded-xl overflow-hidden" style={{ border: '0.5px solid var(--border-default)' }}>
                                <table className="w-full text-body text-left">
                                    <thead>
                                        <tr className="bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Title</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Channel</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Watched</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Duration</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Progress</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredWatch.map((entry, i) => (
                                            <tr key={`${entry.video_id}-${i}`} className="hover:bg-accent-subtle transition-colors duration-200" style={{ height: '44px', borderBottom: '0.5px solid var(--border-subtle)' }}>
                                                <td className="px-4 py-2 max-w-xs">
                                                    {entry.url ? (
                                                        <a
                                                            href={entry.url}
                                                            onClick={(e) => { e.preventDefault(); window.openextract.openExternal(entry.url); }}
                                                            className="text-text-accent hover:underline truncate block font-medium"
                                                            title={entry.title}
                                                        >
                                                            {entry.title || entry.video_id || '—'}
                                                        </a>
                                                    ) : (
                                                        <span className="truncate block font-medium text-text-primary">{entry.title || entry.video_id || '—'}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2 text-text-secondary truncate max-w-[160px]">{entry.channel || '—'}</td>
                                                <td className="px-4 py-2 whitespace-nowrap text-text-secondary text-caption">{formatDate(entry.watched_at)}</td>
                                                <td className="px-4 py-2 font-mono text-caption text-text-tertiary">{formatDuration(entry.duration)}</td>
                                                <td className="px-4 py-2 font-mono text-caption text-text-tertiary">{formatDuration(entry.progress)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}

                {/* Search History */}
                {activeTab === 'search' && (
                    <>
                        {searchLoading && <LoadingState label="Loading search history..." />}
                        {searchError && <ErrorState message={searchError} />}
                        {!searchLoading && !searchError && searchNote && filteredSearch.length === 0 && (
                            <NoteBox note={searchNote} />
                        )}
                        {!searchLoading && !searchError && filteredSearch.length === 0 && !searchNote && (
                            <EmptyState label="No search history found." />
                        )}
                        {!searchLoading && !searchError && filteredSearch.length > 0 && (
                            <div className="bg-base rounded-xl overflow-hidden" style={{ border: '0.5px solid var(--border-default)' }}>
                                <table className="w-full text-body text-left">
                                    <thead>
                                        <tr className="bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Search Query</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredSearch.map((entry, i) => (
                                            <tr key={`${entry.query}-${i}`} className="hover:bg-accent-subtle transition-colors duration-200" style={{ height: '44px', borderBottom: '0.5px solid var(--border-subtle)' }}>
                                                <td className="px-4 py-2 font-medium text-text-primary">{entry.query || '—'}</td>
                                                <td className="px-4 py-2 text-caption text-text-secondary whitespace-nowrap">{formatDate(entry.searched_at)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}

                {/* Downloads */}
                {activeTab === 'downloads' && (
                    <>
                        {downloadsLoading && <LoadingState label="Loading downloaded videos..." />}
                        {downloadsError && <ErrorState message={downloadsError} />}
                        {!downloadsLoading && !downloadsError && downloadsNote && filteredDownloads.length === 0 && (
                            <NoteBox note={downloadsNote} />
                        )}
                        {!downloadsLoading && !downloadsError && filteredDownloads.length === 0 && !downloadsNote && (
                            <EmptyState label="No downloaded videos found." />
                        )}
                        {!downloadsLoading && !downloadsError && filteredDownloads.length > 0 && (
                            <div className="bg-base rounded-xl overflow-hidden" style={{ border: '0.5px solid var(--border-default)' }}>
                                <table className="w-full text-body text-left">
                                    <thead>
                                        <tr className="bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Title</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Channel</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Downloaded</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Duration</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Size</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Quality</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredDownloads.map((entry, i) => (
                                            <tr key={`${entry.video_id}-${i}`} className="hover:bg-accent-subtle transition-colors duration-200" style={{ height: '44px', borderBottom: '0.5px solid var(--border-subtle)' }}>
                                                <td className="px-4 py-2 max-w-xs">
                                                    {entry.url ? (
                                                        <a
                                                            href={entry.url}
                                                            onClick={(e) => { e.preventDefault(); window.openextract.openExternal(entry.url); }}
                                                            className="text-text-accent hover:underline truncate block font-medium"
                                                            title={entry.title}
                                                        >
                                                            {entry.title || entry.video_id || '—'}
                                                        </a>
                                                    ) : (
                                                        <span className="truncate block font-medium text-text-primary">{entry.title || entry.video_id || '—'}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2 text-text-secondary truncate max-w-[140px]">{entry.channel || '—'}</td>
                                                <td className="px-4 py-2 text-caption text-text-secondary whitespace-nowrap">{formatDate(entry.downloaded_at)}</td>
                                                <td className="px-4 py-2 font-mono text-caption text-text-tertiary">{formatDuration(entry.duration)}</td>
                                                <td className="px-4 py-2 font-mono text-caption text-text-tertiary">{formatBytes(entry.file_size)}</td>
                                                <td className="px-4 py-2 text-caption text-text-secondary">{entry.quality || '—'}</td>
                                                <td className="px-4 py-2">
                                                    {entry.status && (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-caption text-text-secondary bg-surface" style={{ border: '0.5px solid var(--border-default)' }}>
                                                            {entry.status}
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function LoadingState({ label }: { label: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
            <p className="text-body">{label}</p>
        </div>
    );
}

function ErrorState({ message }: { message: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full">
            <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-error mb-3" />
            <p className="text-body text-apple-error">{message}</p>
        </div>
    );
}

function EmptyState({ label }: { label: string }) {
    return (
        <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <Inbox size={24} strokeWidth={1.5} className="mb-3" />
            <p className="text-body">{label}</p>
        </div>
    );
}
