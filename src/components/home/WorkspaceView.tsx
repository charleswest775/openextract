import type { AppStateData } from '../../lib/appState';
import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import RecentSessionList from './RecentSessionList';
import QuickActions from './QuickActions';
import { PlusIcon } from '../shared/Icons';

interface Props {
  data: AppStateData;
  onOpenSession: (id: string) => void;
  onGetMoreData: () => void;
  onBrowseForBackup: () => void;
}

export default function WorkspaceView({ data, onOpenSession, onGetMoreData, onBrowseForBackup }: Props) {
  return (
    <div className="h-screen flex flex-col bg-base">
      <AppHeader showVersion={false} showSettings={false} />

      <div className="flex-1 overflow-y-auto px-7 py-8">
        {/* Header row */}
        <div className="mb-6">
          <div className="hearth-eyebrow mb-2">Your archive</div>
          <div className="flex items-end justify-between gap-6">
            <h1 className="text-4xl text-text-primary max-w-xl">
              Your digital life,<br/>
              <span className="font-serif-italic text-accent">in your hands.</span>
            </h1>
            <button onClick={onGetMoreData} className="hearth-primary-btn">
              <PlusIcon className="text-white" size={14} />
              Backup iPhone
            </button>
          </div>
        </div>

        <RecentSessionList
          sessions={data.sessions}
          onOpenSession={onOpenSession}
        />

        <QuickActions
          onExploreData={onBrowseForBackup}
        />

        <PrivacyFooter variant="compact" />
      </div>
    </div>
  );
}
