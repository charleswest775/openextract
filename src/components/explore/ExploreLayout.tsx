import { useState, useEffect, useCallback, type ComponentType } from 'react';
import type { RecentSession } from '../../lib/appState';
import { ArrowLeftIcon } from '../shared/Icons';
import SettingsDialog from '../shared/SettingsDialog';
import { useBackupStats } from '../../hooks/useBackupStats';
import BackupDashboard from './BackupDashboard';
import MessageExplorer from './MessageExplorer';
import PhotoExplorer from './PhotoExplorer';
import ContactExplorer from './ContactExplorer';
import CallExplorer from './CallExplorer';
import NoteExplorer from './NoteExplorer';
import VoicemailExplorer from './VoicemailExplorer';
import BrowserHistoryExplorer from './BrowserHistoryExplorer';
import RecordRecoveryView from './RecordRecoveryView';
import ExportPanel from './ExportPanel';
import TimelineView from '../timeline/TimelineView';
import YearView, { DEFAULT_YEAR_SELECTION, YearSelection } from '../year/YearView';
import type { TimelineFilters } from '../../types/timeline';
import type { HistoryVisit } from '../../lib/browserHistoryStats';
import type { FeedbackArea } from '../../lib/feedback';
import { useFeedback } from '../shared/Feedback';
import TitleBar, { LAYOUTS, type LayoutId } from './TitleBar';
import { availableData, missingKinds, type ExploreContext, type OpenOptions, type Tab } from './sections';
import RailLayout from './layouts/RailLayout';
import SidebarLayout from './layouts/SidebarLayout';
import LaunchpadLayout from './layouts/LaunchpadLayout';
import PeopleLayout from './layouts/PeopleLayout';
import SearchLayout from './layouts/SearchLayout';

interface Props {
  udid: string;
  session: RecentSession | null;
  onBack: () => void;
}

// The layout to compare is remembered on this computer; it changes nothing else.
const LAYOUT_KEY = 'openextract.layout';

function savedLayout(): LayoutId {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (LAYOUTS.some(l => l.id === v)) return v as LayoutId;
  } catch {
    // No storage: use the default
  }
  return 'rail';
}

const LAYOUT_COMPONENTS: Record<LayoutId, ComponentType<{ ctx: ExploreContext }>> = {
  rail: RailLayout,
  sidebar: SidebarLayout,
  launchpad: LaunchpadLayout,
  people: PeopleLayout,
  search: SearchLayout,
};

// Where each layout opens a backup
const HOME: Record<LayoutId, Tab> = {
  rail: 'dashboard',
  sidebar: 'dashboard',
  launchpad: 'launchpad',
  people: 'people',
  search: 'launchpad',
};

const FEEDBACK_AREAS = new Set<string>([
  'dashboard', 'timeline', 'year', 'messages', 'photos', 'contacts', 'calls', 'notes', 'voicemail',
  'browser_history', 'record_recovery', 'export',
]);

/**
 * Everything inside an open backup: the data every layout shares, and the screens.
 * The chosen layout (the title bar's Layout menu) decides how they're arranged.
 */
export default function ExploreLayout({ udid, session, onBack }: Props) {
  const [layout, setLayoutState] = useState<LayoutId>(savedLayout);
  const [activeTab, setActiveTab] = useState<Tab>(HOME[layout]);
  // What the Timeline opens on after a click on a day, a person or a search. The Timeline tab itself opens on everything.
  const [timelineStart, setTimelineStart] = useState<Partial<TimelineFilters> | null>(null);
  // Kept here so coming back from a day finds the same year, types and person.
  const [yearSelection, setYearSelection] = useState<YearSelection>(DEFAULT_YEAR_SELECTION);
  const [openChatId, setOpenChatId] = useState<number | null>(null);
  const [openNoteId, setOpenNoteId] = useState<number | string | null>(null);
  const { openFeedback } = useFeedback();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const backupStats = useBackupStats(udid);
  const overview = backupStats.stats?.overview ?? null;
  const [hasBrowserHistory, setHasBrowserHistory] = useState(false);
  const [preloadedBrowserHistory, setPreloadedBrowserHistory] = useState<HistoryVisit[] | null>(null);
  const [browserHistoryPreloading, setBrowserHistoryPreloading] = useState(false);

  const openTab = useCallback((tab: Tab, opts: OpenOptions = {}) => {
    setTimelineStart(opts.timeline ?? null);
    setOpenChatId(opts.chatId ?? null);
    setOpenNoteId(opts.noteId ?? null);
    setActiveTab(tab);
  }, []);

  function setLayout(next: LayoutId) {
    setLayoutState(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* not remembered */ }
    openTab(HOME[next]);
  }

  useEffect(() => {
    setTimelineStart(null);
    setYearSelection(DEFAULT_YEAR_SELECTION);
    setPreloadedBrowserHistory(null);
    setBrowserHistoryPreloading(false);
    window.openextract.call('has_browser_history', { udid }).then((res: any) => {
      if (res.success && res.data?.has_any) {
        setHasBrowserHistory(true);
        setBrowserHistoryPreloading(true);
        window.openextract.call('list_browser_history', { udid })
          .then((r: any) => {
            setPreloadedBrowserHistory(r.success && r.data ? r.data.visits || [] : []);
          })
          .catch(() => {})
          .finally(() => setBrowserHistoryPreloading(false));
      }
    }).catch(() => {});
  }, [udid]);

  function renderSection(tab: Tab) {
    switch (tab) {
      case 'dashboard':
        return <BackupDashboard {...backupStats} onNavigate={t => openTab(t as Tab)} hasBrowserHistory={hasBrowserHistory} />;
      case 'timeline':
        return (
          <TimelineView
            key={timelineStart ? JSON.stringify({ ...timelineStart, types: [...(timelineStart.types ?? [])] }) : 'everything'}
            udid={udid}
            startingFilters={timelineStart ?? undefined}
          />
        );
      case 'year':
        return (
          <YearView
            udid={udid}
            selection={yearSelection}
            onSelectionChange={setYearSelection}
            onOpenDay={filters => openTab('timeline', { timeline: filters })}
          />
        );
      case 'messages':
        return <MessageExplorer key={`chat-${openChatId ?? ''}`} udid={udid} openChatId={openChatId} />;
      case 'photos':
        return <PhotoExplorer udid={udid} />;
      case 'contacts':
        return <ContactExplorer udid={udid} />;
      case 'calls':
        return <CallExplorer udid={udid} />;
      case 'notes':
        return <NoteExplorer key={`note-${openNoteId ?? ''}`} udid={udid} openNoteId={openNoteId} />;
      case 'voicemail':
        return <VoicemailExplorer udid={udid} />;
      case 'browser_history':
        return (
          <BrowserHistoryExplorer
            udid={udid}
            preloadedVisits={preloadedBrowserHistory}
            preloadedLoading={browserHistoryPreloading}
          />
        );
      case 'record_recovery':
        return <RecordRecoveryView udid={udid} />;
      case 'export':
        return <ExportPanel udid={udid} overview={overview} hasBrowserHistory={hasBrowserHistory} />;
      default:
        // launchpad, people and search are drawn by the layouts that have them
        return null;
    }
  }

  const ctx: ExploreContext = {
    udid,
    session,
    stats: backupStats.stats,
    overview,
    hasBrowserHistory,
    data: availableData(overview, hasBrowserHistory),
    missing: missingKinds(overview, hasBrowserHistory),
    activeTab,
    openTab,
    content: renderSection(activeTab),
    titleBar: ({ left, center, showDevice, onLogo } = {}) => (
      <TitleBar
        session={session}
        showDevice={showDevice}
        onLogo={onLogo}
        left={left ?? (
          <button
            onClick={onBack}
            title="Close this backup and go back to your backups"
            className="hearth-ghost-btn !px-3 !py-1.5"
          >
            <ArrowLeftIcon size={18} />
            All backups
          </button>
        )}
        center={center}
        layout={layout}
        onLayoutChange={setLayout}
        onHelp={() => openFeedback({ area: (FEEDBACK_AREAS.has(activeTab) ? activeTab : 'general') as FeedbackArea })}
        onSettings={() => setSettingsOpen(true)}
      />
    ),
    onBack,
    openSettings: () => setSettingsOpen(true),
  };

  const Layout = LAYOUT_COMPONENTS[layout];

  return (
    <>
      <Layout ctx={ctx} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}
