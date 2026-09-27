import { useState, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { browserLabel, type BrowserHistoryError, type HistoryVisit } from '../../lib/browserHistoryStats';
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

function BrowserHistoryNotices({ notice, errors }: { notice: string | null; errors: BrowserHistoryError[] }) {
  if (!notice && errors.length === 0) return null;
  return (
    <div className="px-4 py-2.5 border-b border-amber-200 bg-amber-50 text-xs text-amber-800 space-y-1 flex-shrink-0">
      {notice && <p>{notice}</p>}
      {errors.map((e) => (
        <p key={e.browser}>
          <span className="font-medium">{browserLabel(e.browser)}:</span> {e.message}
        </p>
      ))}
    </div>
  );
}

interface Props {
  udid: string;
  preloadedVisits?: HistoryVisit[] | null;
  preloadedLoading?: boolean;
  /** Explains missing history, e.g. Safari needs an encrypted backup. */
  notice?: string | null;
  /** Browsers whose history was found but couldn't be read. */
  errors?: BrowserHistoryError[];
}

export default function BrowserHistoryExplorer({
  udid,
  preloadedVisits,
  preloadedLoading,
  notice: preloadedNotice,
  errors: preloadedErrors,
}: Props) {
  const [visits, setVisits] = useState<HistoryVisit[]>([]);
  const [fetchedNotice, setFetchedNotice] = useState<string | null>(null);
  const [fetchedErrors, setFetchedErrors] = useState<BrowserHistoryError[]>([]);
  const notice = preloadedNotice ?? fetchedNotice;
  const errors = preloadedErrors?.length ? preloadedErrors : fetchedErrors;
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
        setFetchedNotice(res.data.notice ?? null);
        setFetchedErrors(res.data.errors || []);
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

      <BrowserHistoryNotices notice={notice} errors={errors} />

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-accent">
            <OrganicLoader size={96} />
          </div>
        ) : visits.length === 0 ? (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            No browser history found in this backup.
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
