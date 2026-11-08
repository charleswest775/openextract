import { useState, useEffect } from 'react';
import type { AppStateData, RecentSession } from '../lib/appState';
import type { BackupInfo } from '../hooks/useBackup';
import { sidecarCall } from '../lib/ipc';
import { notYetOpened, type FoundBackups } from '../lib/foundBackups';
import FirstVisitView from './home/FirstVisitView';
import ReturnedView from './home/ReturnedView';
import WorkspaceView from './home/WorkspaceView';
import FoundBackupList from './home/FoundBackupList';
import FullDiskAccessDialog from './shared/FullDiskAccessDialog';
import LoadingScreen from './shared/LoadingScreen';

interface Props {
  onOpenBackup: (session: RecentSession) => void;
  onOpenFoundBackup: (backup: BackupInfo) => void;
  onCreateBackup: () => void;
  onBrowseForBackup: () => void;
}

export default function HomeScreen({ onOpenBackup, onOpenFoundBackup, onCreateBackup, onBrowseForBackup }: Props) {
  const [appState, setAppState] = useState<AppStateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState<FoundBackups | null>(null);
  const [askingAccess, setAskingAccess] = useState(false);

  useEffect(() => {
    loadState();
    findBackups();
  }, []);

  async function loadState() {
    setLoading(true);
    try {
      const state = await window.openextract.getAppState();
      setAppState(state);
    } catch (err) {
      console.error('Failed to load app state:', err);
      // Default to first visit on error
      setAppState({
        state: 'first_visit',
        totalDevices: 0,
        totalSizeGB: 0,
        totalMessages: 0,
        totalExports: 0,
        sessions: [],
        stats: { totalExports: 0 },
      });
    } finally {
      setLoading(false);
    }
  }

  // Look in the folders Finder, iTunes and Apple Devices save backups to.
  // Nothing shows until this answers, and nothing shows if it fails.
  async function findBackups() {
    try {
      setFound(await sidecarCall<FoundBackups>('list_backups', {}));
    } catch (err) {
      console.error('Failed to look for backups:', err);
    }
  }

  if (loading || !appState) {
    return <LoadingScreen />;
  }

  const firstVisit = appState.state === 'first_visit';
  const blockedFolder = window.openextract.platform === 'darwin' ? found?.permission_denied?.[0] : undefined;
  const foundList = (
    <FoundBackupList
      title={appState.state === 'has_data' ? 'Also on this computer' : 'Found on this computer'}
      backups={notYetOpened(found?.backups ?? [], appState.sessions)}
      onOpen={(b) => {
        if (firstVisit) window.openextract.setFirstLaunchCompleted();
        onOpenFoundBackup(b);
      }}
      // Someone who already has backups open is past needing the nudge.
      blockedFolder={appState.state === 'has_data' ? undefined : blockedFolder}
      onAllowAccess={() => setAskingAccess(true)}
    />
  );

  let view;
  switch (appState.state) {
    case 'first_visit':
      view = (
        <FirstVisitView
          found={foundList}
          onGetMyData={onCreateBackup}
          onBrowseForBackup={onBrowseForBackup}
          onFirstAction={() => window.openextract.setFirstLaunchCompleted()}
        />
      );
      break;
    case 'returned_no_data':
      view = (
        <ReturnedView
          found={foundList}
          onGetMyData={onCreateBackup}
          onBrowseForBackup={onBrowseForBackup}
        />
      );
      break;
    case 'has_data':
      view = (
        <WorkspaceView
          data={appState}
          found={foundList}
          onOpenSession={(id) => {
            const session = appState.sessions.find(s => s.id === id);
            if (session) {
              onOpenBackup(session);
            }
          }}
          onGetMoreData={onCreateBackup}
          onBrowseForBackup={onBrowseForBackup}
        />
      );
      break;
  }

  return (
    <>
      {view}
      {askingAccess && (
        <FullDiskAccessDialog blockedFolder={blockedFolder} onClose={() => setAskingAccess(false)} />
      )}
    </>
  );
}
