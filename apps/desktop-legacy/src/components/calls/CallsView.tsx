import { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, AlertTriangle, Inbox, Lock, Download, Video, Phone, MessageSquare, Smartphone } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { format, parseISO } from 'date-fns';

interface Call {
    call_id: number;
    address: string;
    contact_name: string;
    date: string;
    duration: number;
    direction: 'incoming' | 'outgoing' | 'unknown';
    status: 'answered' | 'missed' | 'unknown';
    app: string;
}

interface Props {
    backup: BackupInfo;
}

function formatDuration(seconds: number): string {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = parseFloat((seconds % 60).toFixed(2));
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

type SortField = 'date' | 'contact_name' | 'duration' | 'type';
type SortOrder = 'asc' | 'desc';

export default function CallsView({ backup }: Props) {
    const [calls, setCalls] = useState<Call[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<SortField>('date');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const [page, setPage] = useState(0);
    const pageSize = 100;

    useEffect(() => {
        loadCalls();
    }, [backup.udid]);

    async function loadCalls() {
        setLoading(true);
        setError(null);
        try {
            const res = await window.openextract.call('list_calls', { udid: backup.udid, limit: 10000 });
            if (!res.success) throw new Error(res.error);
            if (res.data?.error) throw new Error(res.data.error);
            setCalls(res.data?.calls || []);
        } catch (err: any) {
            setError(err.message || 'Failed to load calls');
        } finally {
            setLoading(false);
        }
    }

    async function handleExport() {
        setExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return;
            const res = await window.openextract.call('export_calls', { udid: backup.udid, output_dir: folder });
            if (!res.success || res.data.error) throw new Error(res.error || res.data.error);
            alert(`Successfully exported calls to ${folder}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setExporting(false);
        }
    }

    const filteredAndSortedCalls = useMemo(() => {
        let result = calls;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter(c =>
                c.contact_name?.toLowerCase().includes(q) ||
                c.address?.toLowerCase().includes(q) ||
                c.app?.toLowerCase().includes(q)
            );
        }
        result = [...result].sort((a, b) => {
            let configA, configB;
            switch (sortBy) {
                case 'date': configA = new Date(a.date).getTime(); configB = new Date(b.date).getTime(); break;
                case 'contact_name': configA = a.contact_name?.toLowerCase() || ''; configB = b.contact_name?.toLowerCase() || ''; break;
                case 'duration': configA = a.duration || 0; configB = b.duration || 0; break;
                case 'type': configA = a.direction || ''; configB = b.direction || ''; break;
                default: configA = 0; configB = 0;
            }
            if (configA < configB) return sortOrder === 'asc' ? -1 : 1;
            if (configA > configB) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });
        return result;
    }, [calls, searchQuery, sortBy, sortOrder]);

    const paginatedCalls = filteredAndSortedCalls.slice(page * pageSize, (page + 1) * pageSize);
    const totalPages = Math.ceil(filteredAndSortedCalls.length / pageSize);

    const handleSort = (field: SortField) => {
        if (sortBy === field) {
            setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(field);
            setSortOrder(field === 'date' ? 'desc' : 'asc');
        }
        setPage(0);
    };

    const StatusIcon = ({ direction, status }: { direction: string, status: string }) => {
        if (status === 'missed') return <span className="text-apple-error font-medium">&#8627; Missed</span>;
        if (direction === 'incoming') return <span style={{ color: '#007AFF' }} className="font-medium">&#8601; Incoming</span>;
        if (direction === 'outgoing') return <span className="text-apple-success font-medium">&#8599; Outgoing</span>;
        return <span className="text-text-tertiary">Unknown</span>;
    };

    const getServiceIcon = (app: string) => {
        const a = app.toLowerCase();
        if (a.includes('facetime video')) return <Video size={12} strokeWidth={1.5} />;
        if (a.includes('facetime')) return <Phone size={12} strokeWidth={1.5} />;
        if (a.includes('whatsapp')) return <MessageSquare size={12} strokeWidth={1.5} />;
        return <Smartphone size={12} strokeWidth={1.5} />;
    };

    return (
        <div className="flex flex-col h-full bg-base text-text-primary">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                <div>
                    <h2 className="font-display text-title font-semibold text-text-primary">Calls</h2>
                    <p className="text-caption text-text-tertiary mt-0.5">
                        {loading ? 'Loading...' : `${calls.length.toLocaleString()} calls extracted`}
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
                            value={searchQuery}
                            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
                        />
                    </div>
                    <button
                        onClick={handleExport}
                        disabled={exporting || calls.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                    >
                        <Download size={14} strokeWidth={1.5} />
                        {exporting ? 'Exporting...' : 'Export'}
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 bg-base">
                {loading && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
                        <p className="text-body">Loading call history...</p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center justify-center h-full">
                        {error.toLowerCase().includes('encrypt') ? (
                            <>
                                <Lock size={32} strokeWidth={1.5} className="text-apple-warning mb-3" />
                                <h3 className="text-subhead font-semibold text-text-primary mb-2">Encrypted Backup Required</h3>
                                <p className="text-center text-body text-text-secondary max-w-md">
                                    Apple blocks call history from unencrypted backups.
                                    Enable <strong>"Encrypt local backup"</strong> in iTunes/Finder and create a new backup.
                                </p>
                            </>
                        ) : (
                            <>
                                <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-error mb-3" />
                                <p className="text-body text-apple-error">{error}</p>
                            </>
                        )}
                    </div>
                )}

                {!loading && !error && filteredAndSortedCalls.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <Inbox size={24} strokeWidth={1.5} className="mb-3" />
                        <p className="text-body">No call records found.</p>
                    </div>
                )}

                {!loading && !error && filteredAndSortedCalls.length > 0 && (
                    <div className="bg-base rounded-xl overflow-hidden" style={{ border: '0.5px solid var(--border-default)' }}>
                        <table className="w-full text-body text-left">
                            <thead>
                                <tr className="bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors" onClick={() => handleSort('type')}>
                                        Type {sortBy === 'type' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors" onClick={() => handleSort('contact_name')}>
                                        Contact {sortBy === 'contact_name' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors" onClick={() => handleSort('date')}>
                                        Date {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors" onClick={() => handleSort('duration')}>
                                        Duration {sortBy === 'duration' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">Service</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedCalls.map((call) => (
                                    <tr key={call.call_id} className="hover:bg-accent-subtle transition-colors duration-200" style={{ height: '44px', borderBottom: '0.5px solid var(--border-subtle)' }}>
                                        <td className="px-4 py-2">
                                            <StatusIcon direction={call.direction} status={call.status} />
                                        </td>
                                        <td className="px-4 py-2">
                                            <div className="flex flex-col">
                                                <span className="text-text-primary font-medium truncate max-w-xs">{call.contact_name}</span>
                                                {call.contact_name !== call.address && call.address && (
                                                    <span className="font-mono text-caption text-text-tertiary truncate max-w-xs">{call.address}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 whitespace-nowrap">
                                            <div className="flex flex-col">
                                                <span className="text-text-secondary">{call.date ? format(parseISO(call.date), 'MMM d, yyyy') : 'Unknown'}</span>
                                                <span className="font-mono text-caption text-text-tertiary">{call.date ? format(parseISO(call.date), 'h:mm:ss a') : ''}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-2 font-mono text-text-tertiary">
                                            {formatDuration(call.duration)}
                                        </td>
                                        <td className="px-4 py-2">
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-caption text-text-secondary bg-surface" style={{ border: '0.5px solid var(--border-default)' }}>
                                                {getServiceIcon(call.app)} {call.app}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {totalPages > 1 && (
                            <div className="flex items-center justify-between px-4 py-2.5 bg-surface" style={{ borderTop: '0.5px solid var(--border-default)' }}>
                                <span className="text-caption text-text-tertiary">
                                    Showing <span className="font-medium text-text-primary">{page * pageSize + 1}</span>–<span className="font-medium text-text-primary">{Math.min((page + 1) * pageSize, filteredAndSortedCalls.length)}</span> of <span className="font-medium text-text-primary">{filteredAndSortedCalls.length}</span>
                                </span>
                                <div className="inline-flex gap-1">
                                    <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors" style={{ border: '0.5px solid var(--border-strong)' }}>Prev</button>
                                    <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1} className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors" style={{ border: '0.5px solid var(--border-strong)' }}>Next</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
