import { useState, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import PageHeader from '../shared/PageHeader';
import { SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { checkEngineResult, plural } from '../../lib/saveData';
import OrganicLoader from '../shared/OrganicLoader';
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
        <div className="h-full flex items-center justify-center text-sm text-text-secondary">
          Couldn't show the web history overview.{' '}
          <button onClick={this.reset} className="text-accent underline ml-1">Retry</button>
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
  const { busy: exporting, run } = useSaveAction('browser_history');

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

  function handleExport() {
    run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<{ path: string; count: number }>(
        'export_browser_history', { udid, output_dir: outputDir },
      ));
      return { title: `Saved ${plural(result.count, 'page visit')}`, detail: 'Spreadsheet (CSV)', path: result.path };
    });
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
          onSave={handleExport}
          saving={exporting}
        />
      </div>
    );
  }

  // Overview
  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Web history"
        count={visits.length > 0 ? plural(visits.length, 'page visit') : undefined}
        actions={<SaveButton onClick={handleExport} busy={exporting} disabled={visits.length === 0} label="Save all" />}
      />

      {/* Body */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-accent">
            <OrganicLoader size={96} />
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
