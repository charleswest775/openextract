import type { ReactNode } from 'react';
import type { AppStateData } from '../../lib/appState';
import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import RecentSessionList from './RecentSessionList';
import { BACK_UP_LABEL, OPEN_FOLDER_LABEL } from './HomeActions';
import { FolderIcon, PhoneIcon } from '../shared/Icons';

interface Props {
  data: AppStateData;
  /** Backups found in the usual folders that aren't in the recent list. */
  found: ReactNode;
  onOpenSession: (id: string) => void;
  onGetMoreData: () => void;
  onBrowseForBackup: () => void;
}

export default function WorkspaceView({ data, found, onOpenSession, onGetMoreData, onBrowseForBackup }: Props) {
  return (
    <div className="h-screen flex flex-col bg-base">
      <AppHeader showVersion={false} />

      <div className="flex-1 overflow-y-auto px-8 py-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-end justify-between gap-6 mb-6 flex-wrap">
            <h1 className="text-4xl text-text-primary">Your backups</h1>
            <div className="flex items-center gap-2">
              <button onClick={onBrowseForBackup} className="hearth-ghost-btn">
                <FolderIcon size={18} />
                {OPEN_FOLDER_LABEL}
              </button>
              <button onClick={onGetMoreData} className="hearth-primary-btn">
                <PhoneIcon className="text-white" size={18} />
                {BACK_UP_LABEL}
              </button>
            </div>
          </div>

          <RecentSessionList
            sessions={data.sessions}
            onOpenSession={onOpenSession}
          />

          {found}

          <PrivacyFooter variant="compact" />
        </div>
      </div>
    </div>
  );
}
