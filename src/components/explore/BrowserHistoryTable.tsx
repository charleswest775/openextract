import { useState } from 'react';
import { saveFolder } from '../../lib/ipc';
import { SearchIcon, ExportIcon, ArrowLeftIcon } from '../shared/Icons';
import { formatDateTime } from '../../lib/dates';
import type { HistoryVisit } from '../../lib/browserHistoryStats';

interface Props {
  visits: HistoryVisit[];
  udid: string;
  initialDomainFilter?: string | null;
  initialDateFilter?: string | null;
  onBack: () => void;
}

export default function BrowserHistoryTable({
  visits,
  udid,
  initialDomainFilter,
  initialDateFilter,
  onBack,
}: Props) {
  const [search, setSearch] = useState(initialDomainFilter || '');
  const [dateFilter, setDateFilter] = useState(initialDateFilter || '');
  const [browserFilter, setBrowserFilter] = useState<'all' | 'safari' | 'firefox'>('all');
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    try {
      await window.openextract.call('export_browser_history', { udid, output_dir: outputDir });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
  }

  const filtered = visits.filter(v => {
    if (browserFilter !== 'all' && v.browser !== browserFilter) return false;
    if (dateFilter && !v.visit_date?.startsWith(dateFilter)) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      v.title.toLowerCase().includes(q) ||
      v.url.toLowerCase().includes(q) ||
      v.domain.toLowerCase().includes(q)
    );
  });

  const hasActiveFilter = !!dateFilter || (!!search && search !== '');

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors flex-shrink-0"
          >
            <ArrowLeftIcon size={14} />
            Overview
          </button>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-900 truncate">
            History
            {filtered.length > 0 && (
              <span className="text-gray-400 font-normal ml-1">({filtered.length})</span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Active filter chips */}
          {dateFilter && (
            <span className="flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-2 py-0.5">
              {dateFilter}
              <button onClick={() => setDateFilter('')} className="hover:text-emerald-900 ml-0.5">×</button>
            </span>
          )}

          {/* Browser filter pills */}
          <div className="flex items-center bg-gray-100 rounded-md p-0.5">
            {(['all', 'safari', 'firefox'] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBrowserFilter(b)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  browserFilter === b
                    ? 'bg-white text-gray-900 shadow-sm font-medium'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {b === 'all' ? 'All' : b === 'safari' ? 'Safari' : 'Firefox'}
              </button>
            ))}
          </div>

          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search history..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-44"
            />
          </div>

          <button
            onClick={handleExport}
            disabled={exporting}
            className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
            title="Export CSV"
          >
            <ExportIcon className="text-gray-500" size={16} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Title / URL</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Domain</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Date</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Browser</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr key={v.visit_id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5 max-w-xs">
                  <div className="font-medium text-gray-900 truncate">{v.title || v.url}</div>
                  {v.title && (
                    <div className="text-xs text-gray-400 truncate">{v.url}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-600 text-xs">{v.domain}</td>
                <td className="px-4 py-2.5 text-gray-600 text-xs whitespace-nowrap">
                  {formatDateTime(v.visit_date)}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    v.browser === 'safari'
                      ? 'bg-blue-50 text-blue-600'
                      : 'bg-orange-50 text-orange-600'
                  }`}>
                    {v.browser === 'safari' ? 'Safari' : 'Firefox'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">
            {hasActiveFilter ? 'No results match your filters' : 'No browser history found'}
          </div>
        )}
      </div>
    </div>
  );
}
