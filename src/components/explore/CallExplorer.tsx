import { useState, useEffect } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { SearchIcon, ExportIcon } from '../shared/Icons';
import { formatDateTime } from '../../lib/dates';

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
  udid: string;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

export default function CallExplorer({ udid }: Props) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCalls();
  }, [udid]);

  async function loadCalls() {
    setLoading(true);
    setError(null);
    try {
      const res = await window.openextract.call('list_calls', { udid, limit: 10000 });
      if (res.success && res.data) {
        setCalls(res.data.calls || []);
        if (res.data.error) {
          setError(res.data.error);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    try {
      await window.openextract.call('export_calls', { udid, output_dir: outputDir });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
  }

  const filtered = calls.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.contact_name.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q) ||
      c.app.toLowerCase().includes(q);
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-900">
          Calls {calls.length > 0 && <span className="text-gray-400 font-normal">({calls.length})</span>}
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search calls..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-48"
            />
          </div>
          <button onClick={handleExport} disabled={exporting} className="p-1.5 rounded-md hover:bg-gray-100 transition-colors" title="Export">
            <ExportIcon className="text-gray-500" size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Contact</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Date</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Duration</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">Type</th>
              <th className="text-left px-4 py-2 font-medium text-gray-500 text-xs">App</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.call_id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-gray-900">{c.contact_name || c.address}</div>
                  {c.contact_name && c.address && (
                    <div className="text-xs text-gray-400">{c.address}</div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-600">{formatDateTime(c.date)}</td>
                <td className="px-4 py-2.5 text-gray-600">{formatDuration(c.duration)}</td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs font-medium ${
                    c.status === 'missed' ? 'text-red-500' :
                    c.direction === 'incoming' ? 'text-blue-500' :
                    'text-green-500'
                  }`}>
                    {c.status === 'missed' ? 'Missed' :
                     c.direction === 'incoming' ? 'Incoming' :
                     c.direction === 'outgoing' ? 'Outgoing' : 'Unknown'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-500">{c.app || 'Phone'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="text-center py-8 text-sm text-gray-400">Loading calls...</div>}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">
            {error || 'No calls found'}
          </div>
        )}
      </div>
    </div>
  );
}
