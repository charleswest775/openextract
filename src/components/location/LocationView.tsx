import { useState, useEffect, useMemo } from 'react';
import { MapPin, Search, Loader2, AlertTriangle, Inbox, Download } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { LocationPoint, LocationResult } from '../../types';
import { format, parseISO } from 'date-fns';

interface Props {
    backup: BackupInfo;
}

type SourceFilter = 'all' | 'photo' | 'significant_location' | 'visit' | 'maps_favorite';
type SortField = 'date' | 'label' | 'source';
type SortOrder = 'asc' | 'desc';

const SOURCE_LABELS: Record<string, string> = {
    photo: 'Geotagged Photo',
    significant_location: 'Frequent Location',
    visit: 'Visit',
    maps_favorite: 'Maps Favorite',
};

const PAGE_SIZE = 100;

export default function LocationView({ backup }: Props) {
    const [result, setResult] = useState<LocationResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);

    const [searchQuery, setSearchQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [sortBy, setSortBy] = useState<SortField>('date');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const [page, setPage] = useState(0);

    useEffect(() => {
        loadLocations();
    }, [backup.udid]);

    async function loadLocations() {
        setLoading(true);
        setError(null);
        try {
            const res = await window.openextract.call('list_all_locations', { udid: backup.udid });
            if (!res.success) throw new Error(res.error);
            setResult(res.data as LocationResult);
        } catch (err: any) {
            setError(err.message || 'Failed to load location data');
        } finally {
            setLoading(false);
        }
    }

    async function handleExport(fmt: 'csv' | 'geojson') {
        setExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return;
            const res = await window.openextract.call('export_locations', {
                udid: backup.udid,
                output_dir: folder,
                format: fmt,
            });
            if (!res.success || res.data?.error) throw new Error(res.error || res.data?.error);
            alert(`Successfully exported ${res.data.count} location points to ${res.data.path}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setExporting(false);
        }
    }

    const points = result?.points ?? [];

    const filtered = useMemo(() => {
        let items = points;

        if (sourceFilter !== 'all') {
            items = items.filter(p => p.source === sourceFilter);
        }

        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            items = items.filter(p =>
                p.label?.toLowerCase().includes(q) ||
                p.address?.toLowerCase().includes(q) ||
                SOURCE_LABELS[p.source]?.toLowerCase().includes(q)
            );
        }

        return [...items].sort((a, b) => {
            let va: any, vb: any;
            if (sortBy === 'date') {
                va = a.date ? new Date(a.date).getTime() : 0;
                vb = b.date ? new Date(b.date).getTime() : 0;
            } else if (sortBy === 'label') {
                va = a.label?.toLowerCase() ?? '';
                vb = b.label?.toLowerCase() ?? '';
            } else {
                va = a.source;
                vb = b.source;
            }
            if (va < vb) return sortOrder === 'asc' ? -1 : 1;
            if (va > vb) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });
    }, [points, sourceFilter, searchQuery, sortBy, sortOrder]);

    const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

    const handleSort = (field: SortField) => {
        if (sortBy === field) {
            setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(field);
            setSortOrder(field === 'date' ? 'desc' : 'asc');
        }
        setPage(0);
    };

    const sourceBadgeStyle = (source: string) => {
        switch (source) {
            case 'photo': return { background: 'rgba(0,122,255,0.12)', color: '#007AFF' };
            case 'significant_location': return { background: 'rgba(52,199,89,0.12)', color: '#34C759' };
            case 'visit': return { background: 'rgba(255,149,0,0.12)', color: '#FF9500' };
            case 'maps_favorite': return { background: 'rgba(255,59,48,0.12)', color: '#FF3B30' };
            default: return {};
        }
    };

    return (
        <div className="flex flex-col h-full bg-base text-text-primary">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                <div>
                    <h2 className="font-display text-title font-semibold text-text-primary">Location Data</h2>
                    <p className="text-caption text-text-tertiary mt-0.5">
                        {loading ? 'Loading...' : `${points.length.toLocaleString()} location points`}
                        {result?.counts && !loading && (
                            <span className="ml-2">
                                ({result.counts.photos} photos · {result.counts.significant_locations} frequent · {result.counts.maps_favorites} Maps)
                            </span>
                        )}
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    {/* Source filter */}
                    <select
                        className="bg-base text-body text-text-primary rounded-lg px-3 py-1.5 focus:outline-none focus:shadow-focus transition-colors"
                        style={{ border: '0.5px solid var(--border-strong)' }}
                        value={sourceFilter}
                        onChange={e => { setSourceFilter(e.target.value as SourceFilter); setPage(0); }}
                    >
                        <option value="all">All Sources</option>
                        <option value="photo">Geotagged Photos</option>
                        <option value="significant_location">Frequent Locations</option>
                        <option value="visit">Visits</option>
                        <option value="maps_favorite">Maps Favorites</option>
                    </select>

                    {/* Search */}
                    <div className="relative">
                        <Search size={14} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                        <input
                            type="text"
                            placeholder="Filter..."
                            className="bg-base text-body text-text-primary rounded-lg w-48 pl-8 pr-3 py-1.5 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary transition-colors"
                            style={{ border: '0.5px solid var(--border-strong)' }}
                            value={searchQuery}
                            onChange={e => { setSearchQuery(e.target.value); setPage(0); }}
                        />
                    </div>

                    {/* Export buttons */}
                    <button
                        onClick={() => handleExport('csv')}
                        disabled={exporting || points.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                    >
                        <Download size={14} strokeWidth={1.5} />
                        {exporting ? 'Exporting...' : 'CSV'}
                    </button>
                    <button
                        onClick={() => handleExport('geojson')}
                        disabled={exporting || points.length === 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body font-medium disabled:opacity-50 transition-colors text-text-secondary hover:text-text-primary"
                        style={{ border: '0.5px solid var(--border-strong)' }}
                    >
                        <Download size={14} strokeWidth={1.5} />
                        GeoJSON
                    </button>
                </div>
            </div>

            {/* Partial-source error notices */}
            {result?.errors && Object.keys(result.errors).length > 0 && !loading && (
                <div className="px-6 py-2 flex flex-wrap gap-2" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                    {Object.entries(result.errors).map(([src, msg]) => (
                        <span key={src} className="inline-flex items-center gap-1 text-caption text-apple-warning px-2 py-1 rounded"
                            style={{ background: 'rgba(255,149,0,0.1)' }}>
                            <AlertTriangle size={11} strokeWidth={1.5} />
                            {src}: {msg}
                        </span>
                    ))}
                </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 bg-base">
                {loading && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
                        <p className="text-body">Loading location data...</p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center justify-center h-full">
                        <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-error mb-3" />
                        <p className="text-body text-apple-error">{error}</p>
                    </div>
                )}

                {!loading && !error && filtered.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <MapPin size={24} strokeWidth={1.5} className="mb-3" />
                        <p className="text-body">No location data found.</p>
                        {points.length > 0 && searchQuery && (
                            <p className="text-caption mt-1">Try clearing your search filter.</p>
                        )}
                    </div>
                )}

                {!loading && !error && filtered.length > 0 && (
                    <div className="bg-base rounded-xl overflow-hidden" style={{ border: '0.5px solid var(--border-default)' }}>
                        <table className="w-full text-body text-left">
                            <thead>
                                <tr className="bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                    <th
                                        className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
                                        onClick={() => handleSort('source')}
                                    >
                                        Source {sortBy === 'source' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th
                                        className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
                                        onClick={() => handleSort('label')}
                                    >
                                        Label {sortBy === 'label' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">
                                        Coordinates
                                    </th>
                                    <th
                                        className="px-4 py-2.5 text-caption font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
                                        onClick={() => handleSort('date')}
                                    >
                                        Date {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
                                    </th>
                                    <th className="px-4 py-2.5 text-caption font-medium text-text-secondary">
                                        Address
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginated.map((point, idx) => (
                                    <tr
                                        key={`${point.source}-${idx}`}
                                        className="hover:bg-accent-subtle transition-colors duration-200"
                                        style={{ height: '44px', borderBottom: '0.5px solid var(--border-subtle)' }}
                                    >
                                        <td className="px-4 py-2">
                                            <span
                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-caption font-medium"
                                                style={sourceBadgeStyle(point.source)}
                                            >
                                                <MapPin size={10} strokeWidth={2} />
                                                {SOURCE_LABELS[point.source] ?? point.source}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 max-w-xs">
                                            <span className="text-text-primary truncate block">{point.label}</span>
                                        </td>
                                        <td className="px-4 py-2 font-mono text-caption text-text-tertiary whitespace-nowrap">
                                            {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}
                                        </td>
                                        <td className="px-4 py-2 whitespace-nowrap">
                                            {point.date ? (
                                                <div className="flex flex-col">
                                                    <span className="text-text-secondary">
                                                        {format(parseISO(point.date), 'MMM d, yyyy')}
                                                    </span>
                                                    <span className="font-mono text-caption text-text-tertiary">
                                                        {format(parseISO(point.date), 'h:mm a')}
                                                    </span>
                                                </div>
                                            ) : (
                                                <span className="text-text-tertiary">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2 max-w-xs">
                                            <span className="text-text-tertiary text-caption truncate block">
                                                {point.address || '—'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {totalPages > 1 && (
                            <div
                                className="flex items-center justify-between px-4 py-2.5 bg-surface"
                                style={{ borderTop: '0.5px solid var(--border-default)' }}
                            >
                                <span className="text-caption text-text-tertiary">
                                    Showing{' '}
                                    <span className="font-medium text-text-primary">{page * PAGE_SIZE + 1}</span>–
                                    <span className="font-medium text-text-primary">
                                        {Math.min((page + 1) * PAGE_SIZE, filtered.length)}
                                    </span>{' '}
                                    of{' '}
                                    <span className="font-medium text-text-primary">{filtered.length}</span>
                                </span>
                                <div className="inline-flex gap-1">
                                    <button
                                        onClick={() => setPage(p => Math.max(0, p - 1))}
                                        disabled={page === 0}
                                        className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors"
                                        style={{ border: '0.5px solid var(--border-strong)' }}
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                        disabled={page === totalPages - 1}
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
    );
}
