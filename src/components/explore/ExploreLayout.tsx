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
  { id: 'dashboard', label: 'Dashboard', icon: ChartIcon },
  { id: 'timeline', label: 'Timeline', icon: ClockIcon },
  { id: 'messages', label: 'Messages', icon: LinesIcon },
  { id: 'photos', label: 'Photos', icon: CameraIcon },
  { id: 'contacts', label: 'Contacts', icon: ContactIcon },
  { id: 'calls', label: 'Calls', icon: CallIcon },
  { id: 'notes', label: 'Notes', icon: NoteIcon },
  { id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon },
  { id: 'browser_history', label: 'Browser History', icon: GlobeIcon },
  { id: 'record_recovery', label: 'Record Recovery', icon: RecoverIcon },
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

  return (
    <div className="h-screen flex bg-base">
      {/* Sidebar */}
      <div className="w-[200px] flex-shrink-0 border-r border-border-default flex flex-col">
        {/* Session info */}
        <div className="px-4 py-3 border-b border-border-default">
          <div className="text-sm font-medium text-text-primary truncate">
            {session?.name || 'Backup'}
          </div>
          {session?.iosVersion && (
            <div className="text-xs text-text-tertiary">iOS {session.iosVersion}</div>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => !item.comingSoon && setActiveTab(item.id)}
                className={`w-full px-4 py-2 flex items-center gap-2.5 text-left transition-colors ${
                  isActive
                    ? 'bg-sidebar-active font-medium border-l-2 border-emerald-500'
                    : 'hover:bg-surface border-l-2 border-transparent'
                } ${item.comingSoon ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Icon
                  className={isActive ? 'text-emerald-600' : 'text-text-tertiary'}
                  size={16}
                />
                <span className={`text-sm ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                  {item.label}
                </span>
                {item.comingSoon && (
                  <span className="text-[10px] bg-elevated text-text-tertiary px-1.5 py-0.5 rounded ml-auto">
                    Soon
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Back link */}
        <button
          onClick={onBack}
          className="px-4 py-3 flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors border-t border-border-default"
        >
          <ArrowLeftIcon size={14} />
          Home
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
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
  );
}
