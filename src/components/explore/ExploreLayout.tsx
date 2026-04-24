import { useState, useEffect } from 'react';
import type { RecentSession } from '../../lib/appState';
import {
  LinesIcon, CameraIcon, ContactIcon, CallIcon, NoteIcon,
  VoicemailIcon, GlobeIcon, ClockIcon, ChartIcon, ArrowLeftIcon, ExportIcon,
  RecoverIcon,
} from '../shared/Icons';
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
import type { HistoryVisit } from '../../lib/browserHistoryStats';

type Tab = 'dashboard' | 'timeline' | 'messages' | 'photos' | 'contacts' | 'calls' | 'notes' | 'voicemail' | 'browser_history' | 'record_recovery' | 'export';

interface Props {
  udid: string;
  session: RecentSession | null;
  onBack: () => void;
}

const allNavItems: { id: Tab; label: string; icon: typeof LinesIcon; comingSoon?: boolean }[] = [
  { id: 'dashboard', label: 'Overview', icon: ChartIcon },
  { id: 'timeline', label: 'Timeline', icon: ClockIcon },
  { id: 'messages', label: 'Messages', icon: LinesIcon },
  { id: 'photos', label: 'Photos', icon: CameraIcon },
  { id: 'contacts', label: 'Contacts', icon: ContactIcon },
  { id: 'calls', label: 'Calls', icon: CallIcon },
  { id: 'notes', label: 'Notes', icon: NoteIcon },
  { id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon },
  { id: 'browser_history', label: 'History', icon: GlobeIcon },
  { id: 'record_recovery', label: 'Recover', icon: RecoverIcon },
  { id: 'export', label: 'Export', icon: ExportIcon },
];

export default function ExploreLayout({ udid, session, onBack }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const handleNavigate = (tab: string) => setActiveTab(tab as Tab);
  const [hasBrowserHistory, setHasBrowserHistory] = useState(false);
  const [preloadedBrowserHistory, setPreloadedBrowserHistory] = useState<HistoryVisit[] | null>(null);
  const [browserHistoryPreloading, setBrowserHistoryPreloading] = useState(false);

  useEffect(() => {
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

  const navItems = allNavItems.filter(item =>
    item.id !== 'browser_history' || hasBrowserHistory
  );

  const initial = (session?.name ?? 'B')[0]?.toUpperCase() ?? 'B';

  return (
    <div className="h-screen flex bg-base">
      {/* Chrome header (mac traffic lights + device pill) */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="h-11 flex items-center px-4 border-b border-rule bg-base flex-shrink-0">
          <div className="flex gap-[7px]">
            <span className="w-3 h-3 rounded-full" style={{ background: '#ff5f57' }} />
            <span className="w-3 h-3 rounded-full" style={{ background: '#febc2e' }} />
            <span className="w-3 h-3 rounded-full" style={{ background: '#28c840' }} />
          </div>
          <div className="ml-4 flex items-baseline gap-2">
            <div
              className="w-[18px] h-[18px] rounded-full self-center"
              style={{
                background: 'radial-gradient(circle at 35% 35%, var(--cream), var(--accent) 80%)',
              }}
            />
            <span className="font-serif text-[16px] font-medium tracking-tight text-text-primary">
              OpenExtract
            </span>
          </div>
          <div className="flex-1" />
          {session && (
            <div className="hearth-pill">
              <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'var(--sage)' }} />
              {session.name}
              {session.iosVersion ? ` · iOS ${session.iosVersion}` : ''}
            </div>
          )}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Hearth icon-rail sidebar */}
          <nav className="w-[86px] flex-shrink-0 border-r border-rule bg-base py-3.5 px-2 flex flex-col gap-1 items-center">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  title={item.label}
                  onClick={() => !item.comingSoon && setActiveTab(item.id)}
                  className={`w-[68px] h-[64px] rounded-[14px] flex flex-col items-center justify-center gap-[3px] transition-all ${
                    isActive ? 'bg-surface border border-rule' : 'border border-transparent hover:bg-surface/60'
                  } ${item.comingSoon ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                  style={
                    isActive
                      ? { boxShadow: '0 1px 2px rgba(30,26,22,.06), 0 4px 14px rgba(217,119,87,.10)' }
                      : undefined
                  }
                >
                  <Icon
                    size={18}
                    className={isActive ? 'text-accent' : 'text-text-secondary'}
                  />
                  <span
                    className={`text-[10px] ${isActive ? 'text-accent font-medium' : 'text-text-secondary'}`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
            <div className="flex-1" />
            {/* Back home */}
            <button
              onClick={onBack}
              title="Home"
              className="w-[68px] h-[44px] rounded-[12px] flex items-center justify-center text-text-secondary hover:bg-surface transition-colors border border-transparent"
            >
              <ArrowLeftIcon size={15} />
            </button>
            {/* Session avatar */}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center border border-rule font-serif text-[15px]"
              style={{ background: 'oklch(82% 0.07 14)', color: '#fff' }}
              title={session?.name ?? 'Backup'}
            >
              {initial}
            </div>
          </nav>

          {/* Content area */}
          <div className="flex-1 overflow-hidden min-w-0">
            {activeTab === 'dashboard' && <BackupDashboard udid={udid} onNavigate={handleNavigate} />}
            {activeTab === 'timeline' && <TimelineView udid={udid} />}
            {activeTab === 'messages' && <MessageExplorer udid={udid} />}
            {activeTab === 'photos' && <PhotoExplorer udid={udid} />}
            {activeTab === 'contacts' && <ContactExplorer udid={udid} />}
            {activeTab === 'calls' && <CallExplorer udid={udid} />}
            {activeTab === 'notes' && <NoteExplorer udid={udid} />}
            {activeTab === 'voicemail' && <VoicemailExplorer udid={udid} />}
            {activeTab === 'browser_history' && (
              <BrowserHistoryExplorer
                udid={udid}
                preloadedVisits={preloadedBrowserHistory}
                preloadedLoading={browserHistoryPreloading}
              />
            )}
            {activeTab === 'record_recovery' && <RecordRecoveryView udid={udid} />}
            {activeTab === 'export' && <ExportPanel udid={udid} />}
          </div>
        </div>
      </div>
    </div>
  );
}
