import { useState, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon } from '../shared/Icons';
import type { HistoryVisit } from '../../lib/browserHistoryStats';
import BrowserHistoryOverview from './BrowserHistoryOverview';
import BrowserHistoryTable from './BrowserHistoryTable';

class BrowserHistoryErrorBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };
  static getDerivedStateFromError() { return { crashed: true }; }
  reset = () => this.setState({ crashed: false });
  render() {
    if (this.state.crashed) {
      return (
        <div className="h-full flex items-center justify-center text-sm text-gray-400">
          Couldn't render browser history overview.{' '}
          <button onClick={this.reset} className="text-emerald-600 underline ml-1">Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface Props {
  udid: string;
  preloadedVisits?: HistoryVisit[] | null;
  preloadedLoading?: boolean;
}

export default function BrowserHistoryExplorer({ udid, preloadedVisits, preloadedLoading }: Props) {
  const [visits, setVisits] = useState<HistoryVisit[]>([]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'overview' | 'history'>('overview');
  const [drillDomain, setDrillDomain] = useState<string | null>(null);
  const [drillDate, setDrillDate] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (preloadedVisits !== undefined) {
      // preloadedVisits=null means still loading; non-null array means ready
      if (preloadedVisits !== null) {
        setVisits(preloadedVisits);
      }
    } else {
      // No preload provided — fetch ourselves
      loadHistory();
    }
  }, [preloadedVisits, udid]);

  async function loadHistory() {
    setLoading(true);
    try {
      const res = await window.openextract.call('list_browser_history', { udid });
      if (res.success && res.data) {
        setVisits(res.data.visits || []);
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
      await window.openextract.call('export_browser_history', { udid, output_dir: outputDir });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
  }

  function handleDrillDomain(domain: string) {
    setDrillDomain(domain);
    setDrillDate(null);
    setView('history');
  }

  function handleDrillDate(date: string) {
    setDrillDate(date);
    setDrillDomain(null);
    setView('history');
  }

  function handleViewAll() {
    setDrillDomain(null);
    setDrillDate(null);
    setView('history');
  }

  function handleBackToOverview() {
    setDrillDomain(null);
    setDrillDate(null);
    setView('overview');
  }

  const isLoading = loading || (preloadedVisits === null && (preloadedLoading ?? false));

  // In history view, BrowserHistoryTable renders its own header
  if (view === 'history') {
    return (
      <div className="h-full flex flex-col">
        <BrowserHistoryTable
          visits={visits}
          udid={udid}
          initialDomainFilter={drillDomain}
          initialDateFilter={drillDate}
          onBack={handleBackToOverview}
        />
      </div>
    );
  }

  // Overview
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-medium text-gray-900">
          Browser History
          {visits.length > 0 && (
            <span className="text-gray-400 font-normal ml-1">({visits.length.toLocaleString()})</span>
          )}
        </h2>
        <button
          onClick={handleExport}
          disabled={exporting || visits.length === 0}
          className="p-1.5 rounded-md hover:bg-gray-100 transition-colors disabled:opacity-40"
          title="Export CSV"
        >
          <ExportIcon className="text-gray-500" size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            Loading browser history…
          </div>
        ) : (
          <BrowserHistoryErrorBoundary>
            <BrowserHistoryOverview
              visits={visits}
              onSelectDomain={handleDrillDomain}
              onSelectDate={handleDrillDate}
              onViewAll={handleViewAll}
            />
          </BrowserHistoryErrorBoundary>
        )}
      </div>
    </div>
  );
}
