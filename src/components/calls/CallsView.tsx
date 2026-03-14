import { useState, useEffect, useMemo } from 'react';
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
    if (!seconds) return '0s';
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
            if (!folder) return; // User cancelled

            const res = await window.openextract.call('export_calls', {
                udid: backup.udid,
                output_dir: folder
            });

            if (!res.success || res.data.error) {
                throw new Error(res.error || res.data.error);
            }

            alert(`Successfully exported calls to ${folder}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setExporting(false);
        }
    }

    const filteredAndSortedCalls = useMemo(() => {
        let result = calls;

        // Filter
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter(c =>
                c.contact_name?.toLowerCase().includes(q) ||
                c.address?.toLowerCase().includes(q) ||
                c.app?.toLowerCase().includes(q)
            );
        }

        // Sort
        result = [...result].sort((a, b) => {
            let configA, configB;
            switch (sortBy) {
                case 'date':
                    configA = new Date(a.date).getTime();
                    configB = new Date(b.date).getTime();
                    break;
                case 'contact_name':
                    configA = a.contact_name?.toLowerCase() || '';
                    configB = b.contact_name?.toLowerCase() || '';
                    break;
                case 'duration':
                    configA = a.duration || 0;
                    configB = b.duration || 0;
                    break;
                case 'type':
                    configA = a.direction || '';
                    configB = b.direction || '';
                    break;
                default:
                    configA = 0;
                    configB = 0;
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
        setPage(0); // Reset page on sort
    };

    const StatusIcon = ({ direction, status }: { direction: string, status: string }) => {
        if (status === 'missed') {
            return <div className="text-red-500" title="Missed Call">↳ Missed</div>;
        }
        if (direction === 'incoming') {
            return <div className="text-blue-500" title="Incoming Call">↙ Incoming</div>;
        }
        if (direction === 'outgoing') {
            return <div className="text-green-500" title="Outgoing Call">↗ Outgoing</div>;
        }
        return <div className="text-gray-400">? Unknown</div>;
    };

    const getIconPrefix = (app: string) => {
        const a = app.toLowerCase();
        if (a.includes('facetime video')) return '📹 ';
        if (a.includes('facetime')) return '📞 ';
        if (a.includes('whatsapp')) return '💬 ';
        if (a.includes('skype')) return '🚾 ';
        return '📱 ';
    };

    return (
        <div className="flex flex-col h-full bg-[#0f1115] text-gray-200 font-sans">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-[#161920]">
                <div>
                    <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        Call History
                    </h2>
                    <p className="text-sm text-gray-400 mt-1">
                        {loading ? 'Analyzing iOS backup logs...' : `${calls.length.toLocaleString()} calls extracted`}
                    </p>
                </div>

                <div className="flex items-center gap-4">
                    <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-500">
                            🔍
                        </span>
                        <input
                            type="text"
                            placeholder="Filter by name, number, service..."
                            className="bg-[#1f222b] border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-64 pl-10 pt-2 pb-2 transition-colors"
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                setPage(0);
                            }}
                        />
                    </div>
                    <button
                        onClick={handleExport}
                        disabled={exporting || calls.length === 0}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-lg text-sm font-medium disabled:opacity-50 transition-all flex items-center gap-2"
                    >
                        <span>{exporting ? 'Exporting CSV...' : 'Export to CSV'}</span> ⬇
                    </button>
                </div>
            </div>

            {/* Table Container */}
            <div className="flex-1 overflow-auto p-6 bg-[#0f1115]">
                {loading && (
                    <div className="flex flex-col items-center justify-center h-full text-blue-400 animate-pulse">
                        <div className="text-4xl mb-4">⏳</div>
                        <p>Decrypting call history database...</p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center justify-center h-full text-red-400">
                        {error.toLowerCase().includes('encrypt') ? (
                            <>
                                <div className="text-4xl mb-4 text-yellow-500">🔒</div>
                                <h3 className="text-xl font-semibold text-gray-200 mb-2">Encrypted Backup Required</h3>
                                <p className="text-center text-gray-400 max-w-md">
                                    Apple specifically blocks call history logs from saving to unencrypted iTunes backups.
                                    To view your calls, please check the <strong>"Encrypt local backup"</strong> box in iTunes/Finder and perform a fresh backup of your device.
                                </p>
                            </>
                        ) : (
                            <>
                                <div className="text-4xl mb-4">⚠️</div>
                                <p>{error}</p>
                            </>
                        )}
                    </div>
                )}

                {!loading && !error && filteredAndSortedCalls.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                        <div className="text-4xl mb-4 mb-2 opacity-50">📭</div>
                        <p>No valid call records found matching criteria.</p>
                    </div>
                )}

                {!loading && !error && filteredAndSortedCalls.length > 0 && (
                    <div className="ring-1 ring-gray-800 rounded-xl overflow-hidden shadow-2xl bg-[#161920]">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-gray-400 uppercase bg-[#1a1d24] border-b border-gray-800">
                                <tr>
                                    <th scope="col" className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('type')}>
                                        Type/Status {sortBy === 'type' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th scope="col" className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('contact_name')}>
                                        Contact {sortBy === 'contact_name' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th scope="col" className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('date')}>
                                        Date {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th scope="col" className="px-6 py-4 cursor-pointer hover:text-white transition-colors" onClick={() => handleSort('duration')}>
                                        Duration {sortBy === 'duration' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th scope="col" className="px-6 py-4">
                                        Service
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-800">
                                {paginatedCalls.map((call) => (
                                    <tr key={call.call_id} className="hover:bg-[#1f222b] transition-colors group">
                                        <td className="px-6 py-3 font-medium">
                                            <StatusIcon direction={call.direction} status={call.status} />
                                        </td>
                                        <td className="px-6 py-3">
                                            <div className="flex flex-col">
                                                <span className="text-gray-100 font-semibold truncate max-w-xs">{call.contact_name}</span>
                                                {call.contact_name !== call.address && call.address && (
                                                    <span className="text-gray-500 text-xs truncate max-w-xs">{call.address}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-6 py-3 whitespace-nowrap text-gray-300">
                                            <div className="flex flex-col">
                                                <span>{call.date ? format(parseISO(call.date), 'MMM d, yyyy') : 'Unknown'}</span>
                                                <span className="text-gray-500 text-xs">{call.date ? format(parseISO(call.date), 'h:mm:ss a') : ''}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-3 font-mono text-gray-400">
                                            {formatDuration(call.duration)}
                                        </td>
                                        <td className="px-6 py-3 text-gray-400">
                                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#1a1d24] border border-gray-700 group-hover:bg-[#252833] transition-colors">
                                                {getIconPrefix(call.app)} {call.app}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {/* Pagination Footer */}
                        {totalPages > 1 && (
                            <div className="flex items-center justify-between px-6 py-3 bg-[#1a1d24] border-t border-gray-800">
                                <span className="text-sm text-gray-400">
                                    Showing <span className="font-semibold text-white">{page * pageSize + 1}</span> to <span className="font-semibold text-white">{Math.min((page + 1) * pageSize, filteredAndSortedCalls.length)}</span> of <span className="font-semibold text-white">{filteredAndSortedCalls.length}</span> Calls
                                </span>
                                <div className="inline-flex mt-2 xs:mt-0 gap-1">
                                    <button
                                        onClick={() => setPage(p => Math.max(0, p - 1))}
                                        disabled={page === 0}
                                        className="inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-[#252833] rounded-md hover:bg-[#2d303b] disabled:opacity-50 transition-colors"
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                        disabled={page === totalPages - 1}
                                        className="inline-flex items-center px-3 py-1 text-sm font-medium text-white bg-[#252833] rounded-md hover:bg-[#2d303b] disabled:opacity-50 transition-colors"
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
    );
}
