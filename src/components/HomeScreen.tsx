import { useState, useEffect } from 'react';
import type { AppStateData, RecentSession } from '../lib/appState';
import FirstVisitView from './home/FirstVisitView';
import ReturnedView from './home/ReturnedView';
import WorkspaceView from './home/WorkspaceView';
import LoadingScreen from './shared/LoadingScreen';

interface Props {
  onOpenBackup: (session: RecentSession) => void;
  onCreateBackup: () => void;
  onBrowseForBackup: () => void;
}

export default function HomeScreen({ onOpenBackup, onCreateBackup, onBrowseForBackup }: Props) {
  const [appState, setAppState] = useState<AppStateData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadState();
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

  if (loading || !appState) {
    return <LoadingScreen />;
  }

  switch (appState.state) {
    case 'first_visit':
      return (
        <FirstVisitView
          onGetMyData={onCreateBackup}
          onBrowseForBackup={onBrowseForBackup}
          onFirstAction={() => window.openextract.setFirstLaunchCompleted()}
        />
      );
    case 'returned_no_data':
      return (
        <ReturnedView
          onGetMyData={onCreateBackup}
          onBrowseForBackup={onBrowseForBackup}
        />
      );
    case 'has_data':
      return (
        <WorkspaceView
          data={appState}
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
  }
}
