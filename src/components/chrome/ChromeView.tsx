import { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, AlertTriangle, Globe, Bookmark, Download, ExternalLink, Inbox } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { format, parseISO } from 'date-fns';

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoryEntry {
    url_id: number;
    url: string;
    title: string;
    visit_count: number;
    last_visit_time: string | null;
    typed_count: number;
}

interface BookmarkEntry {
    id: string;
    name: string;
    url: string;
    folder: string;
    date_added: string | null;
}

interface Props {
    backup: BackupInfo;
}

type ActiveTab = 'history' | 'bookmarks';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    try {
        return format(parseISO(iso), 'MMM d, yyyy h:mm a');
    } catch {
        return iso;
    }
}

function truncateUrl(url: string, max = 80): string {
    return url.length > max ? url.slice(0, max) + '…' : url;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ChromeView({ backup }: Props) {
    const [activeTab, setActiveTab] = useState<ActiveTab>('history');

    // History state
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyTotal, setHistoryTotal] = useState(0);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [historySearch, setHistorySearch] = useState('');
    const [historyPage, setHistoryPage] = useState(0);
    const [historyExporting, setHistoryExporting] = useState(false);
    const historyPageSize = 100;

    // Bookmarks state
    const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
    const [bookmarksLoading, setBookmarksLoading] = useState(false);
    const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
    const [bookmarksError, setBookmarksError] = useState<string | null>(null);
    const [bookmarksSearch, setBookmarksSearch] = useState('');
    const [bookmarksPage, setBookmarksPage] = useState(0);
    const [bookmarksExporting, setBookmarksExporting] = useState(false);
    const bookmarksPageSize = 100;

    // Load history on mount
    useEffect(() => {
        loadHistory();
    }, [backup.udid]);

    // Load bookmarks lazily when tab is first opened
    useEffect(() => {
        if (activeTab === 'bookmarks' && !bookmarksLoaded) {
            loadBookmarks();
        }
    }, [activeTab]);

    async function loadHistory() {
        setHistoryLoading(true);
        setHistoryError(null);
        try {
            const res = await window.openextract.call('chrome.list_history', {
                udid: backup.udid,
                offset: 0,
                limit: 10000,
            });
            if (!res.success) throw new Error(res.error);
            if (res.data?.error && !res.data?.history?.length) throw new Error(res.data.error);
            setHistory(res.data?.history || []);
            setHistoryTotal(res.data?.total ?? res.data?.history?.length ?? 0);
        } catch (err: any) {
            setHistoryError(err.message || 'Failed to load Chrome history');
        } finally {
            setHistoryLoading(false);
        }
    }

    async function loadBookmarks() {
        setBookmarksLoading(true);
        setBookmarksError(null);
        try {
            const res = await window.openextract.call('chrome.list_bookmarks', {
                udid: backup.udid,
            });
            if (!res.success) throw new Error(res.error);
            if (res.data?.error && !res.data?.bookmarks?.length) throw new Error(res.data.error);
            setBookmarks(res.data?.bookmarks || []);
            setBookmarksLoaded(true);
        } catch (err: any) {
            setBookmarksError(err.message || 'Failed to load Chrome bookmarks');
        } finally {
            setBookmarksLoading(false);
        }
    }

    async function handleExportHistory() {
        setHistoryExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return;
            const res = await window.openextract.call('chrome.export_history', {
                udid: backup.udid,
                output_dir: folder,
            });
            if (!res.success || res.data?.error) throw new Error(res.error || res.data?.error);
            alert(`Exported ${res.data.count.toLocaleString()} history entries to ${res.data.path}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setHistoryExporting(false);
        }
    }

    async function handleExportBookmarks() {
        setBookmarksExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return;
            const res = await window.openextract.call('chrome.export_bookmarks', {
                udid: backup.udid,
                output_dir: folder,
            });
            if (!res.success || res.data?.error) throw new Error(res.error || res.data?.error);
            alert(`Exported ${res.data.count.toLocaleString()} bookmarks to ${res.data.path}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setBookmarksExporting(false);
        }
    }

    // Filtered/paginated history
    const filteredHistory = useMemo(() => {
        if (!historySearch) return history;
        const q = historySearch.toLowerCase();
        return history.filter(
            (h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)
        );
    }, [history, historySearch]);

    const paginatedHistory = filteredHistory.slice(
        historyPage * historyPageSize,
        (historyPage + 1) * historyPageSize
    );
    const historyTotalPages = Math.ceil(filteredHistory.length / historyPageSize);

    // Filtered/paginated bookmarks
    const filteredBookmarks = useMemo(() => {
        if (!bookmarksSearch) return bookmarks;
        const q = bookmarksSearch.toLowerCase();
        return bookmarks.filter(
            (b) => b.name.toLowerCase().includes(q) ||
                   b.url.toLowerCase().includes(q) ||
                   b.folder.toLowerCase().includes(q)
        );
    }, [bookmarks, bookmarksSearch]);

    const paginatedBookmarks = filteredBookmarks.slice(
        bookmarksPage * bookmarksPageSize,
        (bookmarksPage + 1) * bookmarksPageSize
    );
    const bookmarksTotalPages = Math.ceil(filteredBookmarks.length / bookmarksPageSize);

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full bg-base text-text-primary">
            {/* Header */}
            <div
                className="flex items-center justify-between px-6 py-4 flex-shrink-0"
                style={{ borderBottom: '0.5px solid var(--border-default)' }}
            >
                <div>
                    <h2 className="font-display text-title font-semibold text-text-primary">Chrome</h2>
                    <p className="text-caption text-text-tertiary mt-0.5">
                        Google Chrome browser data
                    </p>
                </div>

                {/* Tab switcher */}
                <div
                    className="flex items-center rounded-lg overflow-hidden"
                    style={{ border: '0.5px solid var(--border-strong)' }}
                >
                    <button
                        onClick={() => setActiveTab('history')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-body transition-colors ${
                            activeTab === 'history'
                                ? 'bg-accent text-white'
                                : 'text-text-secondary hover:bg-elevated'
                        }`}
                    >
                        <Globe size={13} strokeWidth={1.5} />
                        History
                    </button>
                    <button
                        onClick={() => setActiveTab('bookmarks')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-body transition-colors ${
                            activeTab === 'bookmarks'
                                ? 'bg-accent text-white'
                                : 'text-text-secondary hover:bg-elevated'
                        }`}
                        style={{ borderLeft: '0.5px solid var(--border-strong)' }}
                    >
                        <Bookmark size={13} strokeWidth={1.5} />
                        Bookmarks
                    </button>
                </div>
            </div>

            {/* ── History tab ──────────────────────────────────────────────── */}
            {activeTab === 'history' && (
                <div className="flex flex-col flex-1 overflow-hidden">
                    {/* Toolbar */}
                    <div
                        className="flex items-center justify-between px-6 py-3 flex-shrink-0"
                        style={{ borderBottom: '0.5px solid var(--border-subtle)' }}
                    >
                        <span className="text-caption text-text-tertiary">
                            {historyLoading
                                ? 'Loading…'
                                : `${filteredHistory.length.toLocaleString()}${historySearch ? ' matching' : ''} entries`}
                        </span>
                        <div className="flex items-center gap-3">
                            <div className="relative">
                                <Search
                                    size={13}
                                    strokeWidth={1.5}
                                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                                />
                                <input
                                    type="text"
                                    placeholder="Search history…"
                                    value={historySearch}
                                    onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(0); }}
                                    className="bg-base text-body text-text-primary rounded-lg w-52 pl-8 pr-3 py-1.5 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary transition-colors"
                                    style={{ border: '0.5px solid var(--border-strong)' }}
                                />
                            </div>
                            <button
                                onClick={handleExportHistory}
                                disabled={historyExporting || history.length === 0}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                            >
                                <Download size={13} strokeWidth={1.5} />
                                {historyExporting ? 'Exporting…' : 'Export CSV'}
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-auto p-6">
                        {historyLoading && (
                            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                                <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
                                <p className="text-body">Loading Chrome history…</p>
                            </div>
                        )}

                        {historyError && (
                            <div className="flex flex-col items-center justify-center h-full">
                                <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-warning mb-3" />
                                <p className="text-body text-text-secondary max-w-md text-center">{historyError}</p>
                            </div>
                        )}

                        {!historyLoading && !historyError && filteredHistory.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                                <Inbox size={24} strokeWidth={1.5} className="mb-3" />
                                <p className="text-body">No history entries found.</p>
                            </div>
                        )}

                        {!historyLoading && !historyError && filteredHistory.length > 0 && (
                            <div
                                className="rounded-xl overflow-hidden"
                                style={{ border: '0.5px solid var(--border-default)' }}
                            >
                                <table className="w-full text-body text-left">
                                    <thead>
                                        <tr
                                            className="bg-surface"
                                            style={{ borderBottom: '0.5px solid var(--border-default)' }}
                                        >
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Title / URL</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary whitespace-nowrap">Last Visit</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary text-right">Visits</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {paginatedHistory.map((entry) => (
                                            <tr
                                                key={entry.url_id}
                                                className="hover:bg-accent-subtle transition-colors duration-200"
                                                style={{ height: '48px', borderBottom: '0.5px solid var(--border-subtle)' }}
                                            >
                                                <td className="px-4 py-2 max-w-0" style={{ width: '60%' }}>
                                                    <div className="flex flex-col min-w-0">
                                                        <span className="text-text-primary font-medium truncate">
                                                            {entry.title || truncateUrl(entry.url)}
                                                        </span>
                                                        <span className="font-mono text-caption text-text-tertiary truncate flex items-center gap-1">
                                                            <ExternalLink size={10} strokeWidth={1.5} className="flex-shrink-0" />
                                                            {truncateUrl(entry.url)}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-text-secondary text-caption">
                                                    {formatDate(entry.last_visit_time)}
                                                </td>
                                                <td className="px-4 py-2 text-right font-mono text-caption text-text-tertiary">
                                                    {entry.visit_count.toLocaleString()}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>

                                {historyTotalPages > 1 && (
                                    <div
                                        className="flex items-center justify-between px-4 py-2.5 bg-surface"
                                        style={{ borderTop: '0.5px solid var(--border-default)' }}
                                    >
                                        <span className="text-caption text-text-tertiary">
                                            Showing{' '}
                                            <span className="font-medium text-text-primary">
                                                {historyPage * historyPageSize + 1}
                                            </span>
                                            –
                                            <span className="font-medium text-text-primary">
                                                {Math.min((historyPage + 1) * historyPageSize, filteredHistory.length)}
                                            </span>{' '}
                                            of{' '}
                                            <span className="font-medium text-text-primary">
                                                {filteredHistory.length.toLocaleString()}
                                            </span>
                                        </span>
                                        <div className="inline-flex gap-1">
                                            <button
                                                onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                                                disabled={historyPage === 0}
                                                className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors"
                                                style={{ border: '0.5px solid var(--border-strong)' }}
                                            >
                                                Prev
                                            </button>
                                            <button
                                                onClick={() => setHistoryPage((p) => Math.min(historyTotalPages - 1, p + 1))}
                                                disabled={historyPage === historyTotalPages - 1}
                                                className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors"
                                                style={{ border: '0.5px solid var(--border-strong)' }}
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Bookmarks tab ────────────────────────────────────────────── */}
            {activeTab === 'bookmarks' && (
                <div className="flex flex-col flex-1 overflow-hidden">
                    {/* Toolbar */}
                    <div
                        className="flex items-center justify-between px-6 py-3 flex-shrink-0"
                        style={{ borderBottom: '0.5px solid var(--border-subtle)' }}
                    >
                        <span className="text-caption text-text-tertiary">
                            {bookmarksLoading
                                ? 'Loading…'
                                : `${filteredBookmarks.length.toLocaleString()}${bookmarksSearch ? ' matching' : ''} bookmarks`}
                        </span>
                        <div className="flex items-center gap-3">
                            <div className="relative">
                                <Search
                                    size={13}
                                    strokeWidth={1.5}
                                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                                />
                                <input
                                    type="text"
                                    placeholder="Search bookmarks…"
                                    value={bookmarksSearch}
                                    onChange={(e) => { setBookmarksSearch(e.target.value); setBookmarksPage(0); }}
                                    className="bg-base text-body text-text-primary rounded-lg w-52 pl-8 pr-3 py-1.5 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary transition-colors"
                                    style={{ border: '0.5px solid var(--border-strong)' }}
                                />
                            </div>
                            <button
                                onClick={handleExportBookmarks}
                                disabled={bookmarksExporting || bookmarks.length === 0}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                            >
                                <Download size={13} strokeWidth={1.5} />
                                {bookmarksExporting ? 'Exporting…' : 'Export JSON'}
                            </button>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-auto p-6">
                        {bookmarksLoading && (
                            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                                <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
                                <p className="text-body">Loading bookmarks…</p>
                            </div>
                        )}

                        {bookmarksError && (
                            <div className="flex flex-col items-center justify-center h-full">
                                <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-warning mb-3" />
                                <p className="text-body text-text-secondary max-w-md text-center">{bookmarksError}</p>
                            </div>
                        )}

                        {!bookmarksLoading && !bookmarksError && filteredBookmarks.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                                <Inbox size={24} strokeWidth={1.5} className="mb-3" />
                                <p className="text-body">No bookmarks found.</p>
                            </div>
                        )}

                        {!bookmarksLoading && !bookmarksError && filteredBookmarks.length > 0 && (
                            <div
                                className="rounded-xl overflow-hidden"
                                style={{ border: '0.5px solid var(--border-default)' }}
                            >
                                <table className="w-full text-body text-left">
                                    <thead>
                                        <tr
                                            className="bg-surface"
                                            style={{ borderBottom: '0.5px solid var(--border-default)' }}
                                        >
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Name / URL</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Folder</th>
                                            <th className="px-4 py-2.5 text-caption font-medium text-text-secondary whitespace-nowrap">Date Added</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {paginatedBookmarks.map((bm, idx) => (
                                            <tr
                                                key={`${bm.id}-${idx}`}
                                                className="hover:bg-accent-subtle transition-colors duration-200"
                                                style={{ height: '48px', borderBottom: '0.5px solid var(--border-subtle)' }}
                                            >
                                                <td className="px-4 py-2 max-w-0" style={{ width: '55%' }}>
                                                    <div className="flex flex-col min-w-0">
                                                        <span className="text-text-primary font-medium truncate">
                                                            {bm.name || truncateUrl(bm.url)}
                                                        </span>
                                                        <span className="font-mono text-caption text-text-tertiary truncate flex items-center gap-1">
                                                            <ExternalLink size={10} strokeWidth={1.5} className="flex-shrink-0" />
                                                            {truncateUrl(bm.url)}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-2">
                                                    <span
                                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-caption text-text-secondary bg-surface"
                                                        style={{ border: '0.5px solid var(--border-default)' }}
                                                    >
                                                        <Bookmark size={10} strokeWidth={1.5} />
                                                        {bm.folder}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-text-secondary text-caption">
                                                    {formatDate(bm.date_added)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>

                                {bookmarksTotalPages > 1 && (
                                    <div
                                        className="flex items-center justify-between px-4 py-2.5 bg-surface"
                                        style={{ borderTop: '0.5px solid var(--border-default)' }}
                                    >
                                        <span className="text-caption text-text-tertiary">
                                            Showing{' '}
                                            <span className="font-medium text-text-primary">
                                                {bookmarksPage * bookmarksPageSize + 1}
                                            </span>
                                            –
                                            <span className="font-medium text-text-primary">
                                                {Math.min((bookmarksPage + 1) * bookmarksPageSize, filteredBookmarks.length)}
                                            </span>{' '}
                                            of{' '}
                                            <span className="font-medium text-text-primary">
                                                {filteredBookmarks.length.toLocaleString()}
                                            </span>
                                        </span>
                                        <div className="inline-flex gap-1">
                                            <button
                                                onClick={() => setBookmarksPage((p) => Math.max(0, p - 1))}
                                                disabled={bookmarksPage === 0}
                                                className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors"
                                                style={{ border: '0.5px solid var(--border-strong)' }}
                                            >
                                                Prev
                                            </button>
                                            <button
                                                onClick={() => setBookmarksPage((p) => Math.min(bookmarksTotalPages - 1, p + 1))}
                                                disabled={bookmarksPage === bookmarksTotalPages - 1}
                                                className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors"
                                                style={{ border: '0.5px solid var(--border-strong)' }}
                                            >
                                                Next
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
