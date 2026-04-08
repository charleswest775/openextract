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
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-medium text-text-primary">
            Your digital life, in your hands.
          </h1>
          <button
            onClick={onGetMoreData}
            className="bg-gradient-to-r from-emerald-500 to-emerald-400 text-white rounded-lg px-4 py-2.5 flex items-center gap-1.5 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            <PlusIcon className="text-white" size={14} />
            Backup iPhone
          </button>
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
