import { useState, useEffect, useCallback, useRef } from 'react';
import type { RecentSession } from '../../lib/appState';
import { ArrowLeftIcon } from '../shared/Icons';
import SettingsDialog from '../shared/SettingsDialog';
import { useBackupStats } from '../../hooks/useBackupStats';
import { useBackupIndex, useTimeline } from '../../hooks/useTimeline';
import BackupDashboard from './BackupDashboard';
import MessageExplorer from './MessageExplorer';
import WhatsAppExplorer from './WhatsAppExplorer';
import PhotoExplorer from './PhotoExplorer';
import ContactExplorer from './ContactExplorer';
import CallExplorer from './CallExplorer';
import NoteExplorer from './NoteExplorer';
import VoicemailExplorer from './VoicemailExplorer';
import PodcastExplorer from './PodcastExplorer';
import BrowserHistoryExplorer from './BrowserHistoryExplorer';
import RecordRecoveryView from './RecordRecoveryView';
import ExportPanel from './ExportPanel';
import TimelineView from '../timeline/TimelineView';
import YearView, { DEFAULT_YEAR_SELECTION, YearSelection } from '../year/YearView';
import PeopleView from '../people/PeopleView';
import SearchBox from '../search/SearchBox';
import SearchResults from '../search/SearchResults';
import { DEFAULT_FILTERS } from '../../types/timeline';
import type { HistoryVisit } from '../../lib/browserHistoryStats';
import type { FeedbackArea } from '../../lib/feedback';
import { useFeedback } from '../shared/Feedback';
import TitleBar from './TitleBar';
import HomeCrumb from './HomeCrumb';
import BackupHome from './BackupHome';
import UnfinishedBanner from './UnfinishedBanner';
import {
  availableData, missingKinds, sectionFor, SCOPED,
  type ExploreContext, type OpenOptions, type Tab,
} from './sections';

interface Props {
  udid: string;
  session: RecentSession | null;
  onBack: () => void;
  /** The backup stopped partway: say so above every screen, and offer a new backup. */
  unfinished?: boolean;
  onNewBackup?: () => void;
}

const FEEDBACK_AREAS = new Set<string>([
  'dashboard', 'people', 'timeline', 'year', 'messages', 'whatsapp', 'photos', 'contacts', 'calls', 'notes', 'voicemail',
  'podcasts', 'browser_history', 'record_recovery', 'export',
]);

/** The WhatsApp message a search result names ("whatsapp:<id>"), or null. */
function whatsappMessageId(select: OpenOptions['select']): number | null {
  if (select?.type !== 'whatsapp') return null;
  const id = Number(select.id.slice('whatsapp:'.length));
  return Number.isFinite(id) ? id : null;
}

/**
 * Everything inside an open backup: a home page of tiles, one screen per kind of
 * data, and one search box at the top. On a screen that has a list, the box
 * filters that list in place; elsewhere it searches the whole backup.
 */
export default function ExploreLayout({ udid, session, onBack, unfinished = false, onNewBackup }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  // What the active screen opens on: a day, a conversation, the record a search found
  const [target, setTarget] = useState<OpenOptions>({});
  // Kept here so coming back from a day finds the same year, types and person.
  const [yearSelection, setYearSelection] = useState<YearSelection>(DEFAULT_YEAR_SELECTION);
  const { openFeedback } = useFeedback();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const backupStats = useBackupStats(udid);
  const overview = backupStats.stats?.overview ?? null;
  const [hasBrowserHistory, setHasBrowserHistory] = useState(false);
  const [preloadedBrowserHistory, setPreloadedBrowserHistory] = useState<HistoryVisit[] | null>(null);
  const [browserHistoryPreloading, setBrowserHistoryPreloading] = useState(false);

  // Every record, read once for search, People and the Timeline
  const index = useBackupIndex(udid);

  // ── The search box ──────────────────────────────────────────────────────
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // The "in Notes" tag was removed: search the whole backup from this screen
  const [everywhere, setEverywhere] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsKey = useRef<((e: React.KeyboardEvent<HTMLInputElement>) => void) | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const scope = everywhere ? undefined : SCOPED[activeTab];
  // The tag names the screen the same way the breadcrumb beside it does
  const scopeLabel = scope ? sectionFor(activeTab)?.label ?? null : null;
  const searchingAll = query !== '' && !scopeLabel;
  const screenQuery = scopeLabel ? query : '';

  function changeText(next: string) {
    // Clearing the box after searching everywhere brings the screen's tag back
    if (next === '' && everywhere) setEverywhere(false);
    setText(next);
    if (next === '') setQuery('');
  }

  const openTab = useCallback((tab: Tab, opts: OpenOptions = {}) => {
    setTarget(opts);
    setActiveTab(tab);
    setEverywhere(false);
    if (!(opts.keepQuery && SCOPED[tab])) {
      setText('');
      setQuery('');
    }
  }, []);
  const goHome = useCallback(() => openTab('home'), [openTab]);

  // Cmd+K (Ctrl+K) from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The whole-backup results, filtered from the shared index
  const results = useTimeline(index);
  const { setFilters } = results;
  useEffect(() => {
    if (searchingAll) setFilters({ ...DEFAULT_FILTERS, types: new Set(DEFAULT_FILTERS.types), searchQuery: query });
  }, [searchingAll, query, setFilters]);

  useEffect(() => {
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

  const ctx: ExploreContext = {
    udid,
    session,
    stats: backupStats.stats,
    overview,
    hasBrowserHistory,
    index,
    data: availableData(overview, hasBrowserHistory),
    missing: missingKinds(overview, hasBrowserHistory),
    activeTab,
    openTab,
    onBack,
    openSettings: () => setSettingsOpen(true),
    unfinished,
  };

  // A screen opened from a search result remounts on the new record
  const select = target.select;
  const selectKey = select?.id ?? '';

  function renderSection(tab: Tab) {
    switch (tab) {
      case 'home':
        return <BackupHome ctx={ctx} onSearch={() => inputRef.current?.focus()} />;
      case 'dashboard':
        return <BackupDashboard {...backupStats} onNavigate={t => openTab(t as Tab)} hasBrowserHistory={hasBrowserHistory} />;
      case 'people':
        return <PeopleView key={target.person ?? ''} ctx={ctx} query={screenQuery} person={target.person} />;
      case 'timeline':
        return (
          <TimelineView
            key={target.timeline ? JSON.stringify({ ...target.timeline, types: [...(target.timeline.types ?? [])] }) : 'everything'}
            udid={udid}
            index={index}
            startingFilters={target.timeline}
            query={screenQuery}
            onOpenWhatsApp={entry => openTab('whatsapp', { select: entry })}
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
        return (
          <MessageExplorer
            key={`chat-${target.chatId ?? select?.message?.chatId ?? ''}-${selectKey}`}
            udid={udid}
            index={index}
            query={screenQuery}
            openChatId={target.chatId ?? select?.message?.chatId ?? null}
            openMessageId={select?.type === 'message' ? Number(select.id.slice('message:'.length)) : null}
          />
        );
      case 'whatsapp':
        // WhatsApp's chat and message ids are its own (they overlap sms.db's): never chatId or 'message:'
        return (
          <WhatsAppExplorer
            key={`wa-${target.waChatId ?? select?.whatsapp?.chatId ?? ''}-${selectKey}`}
            udid={udid}
            index={index}
            query={screenQuery}
            openChatId={target.waChatId ?? (select?.type === 'whatsapp' ? select.whatsapp?.chatId : undefined) ?? null}
            openMessageId={whatsappMessageId(select)}
          />
        );
      case 'photos':
        return <PhotoExplorer key={selectKey} udid={udid} open={select?.type === 'photo' ? select : undefined} />;
      case 'contacts':
        return (
          <ContactExplorer
            key={target.contactId ?? ''}
            ctx={ctx}
            query={screenQuery}
            openContactId={target.contactId}
          />
        );
      case 'calls':
        return <CallExplorer key={selectKey} udid={udid} query={screenQuery} selectId={select?.type === 'call' ? select.id : undefined} />;
      case 'notes':
        return (
          <NoteExplorer
            key={`note-${select?.note?.noteId ?? ''}`}
            udid={udid}
            query={screenQuery}
            openNoteId={select?.note?.noteId ?? null}
          />
        );
      case 'voicemail':
        return <VoicemailExplorer key={selectKey} udid={udid} query={screenQuery} selectId={select?.type === 'voicemail' ? select.id : undefined} />;
      case 'podcasts':
        return <PodcastExplorer udid={udid} query={screenQuery} />;
      case 'browser_history':
        return (
          <BrowserHistoryExplorer
            key={selectKey}
            udid={udid}
            query={screenQuery}
            selectId={select?.type === 'browser' ? select.id : undefined}
            preloadedVisits={preloadedBrowserHistory}
            preloadedLoading={browserHistoryPreloading}
          />
        );
      case 'record_recovery':
        return <RecordRecoveryView udid={udid} query={screenQuery} />;
      case 'export':
        return <ExportPanel udid={udid} overview={overview} hasBrowserHistory={hasBrowserHistory} />;
    }
  }

  const atHome = activeTab === 'home' && !searchingAll;
  const section = sectionFor(activeTab);
  const deviceName = overview?.device_name ?? session?.name ?? 'This backup';

  const left = atHome ? (
    <button
      onClick={onBack}
      title="Close this backup and go back to your backups"
      className="hearth-ghost-btn !px-3 !py-1.5"
    >
      <ArrowLeftIcon size={18} />
      All backups
    </button>
  ) : (
    <HomeCrumb onHome={goHome} homeName={deviceName} current={searchingAll ? 'Search results' : section?.label} />
  );

  const area = searchingAll ? 'search' : FEEDBACK_AREAS.has(activeTab) ? activeTab : 'general';

  return (
    <div className="h-screen flex flex-col bg-base">
      <TitleBar
        left={left}
        center={
          <SearchBox
            inputRef={inputRef}
            text={text}
            onText={changeText}
            scope={scopeLabel}
            onClearScope={() => setEverywhere(true)}
            placeholder={scope ? scope.placeholder : 'Search messages, WhatsApp, notes, calls, voicemail, people…'}
            onKey={e => searchingAll && resultsKey.current?.(e)}
          />
        }
        onLogo={goHome}
        onHelp={() => openFeedback({ area: area as FeedbackArea })}
        onSettings={() => setSettingsOpen(true)}
      />
      {unfinished && <UnfinishedBanner key={udid} onNewBackup={onNewBackup} />}
      {scope && query && (
        <div className="flex-shrink-0 px-6 py-2 border-b border-rule bg-accent-wash flex items-center gap-3 text-sm">
          <span className="text-text-secondary">
            Showing only {scope.items} that match <span className="font-medium text-text-primary">“{query}”</span>
          </span>
          <button onClick={() => setEverywhere(true)} className="text-accent font-medium hover:underline">
            Search all of {deviceName} →
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden min-w-0">
        {searchingAll
          ? <SearchResults ctx={ctx} timeline={results} query={query} keyRef={resultsKey} />
          : renderSection(activeTab)}
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
