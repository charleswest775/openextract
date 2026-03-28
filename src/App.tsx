import { useState, useCallback } from 'react';
import { useBackup, type BackupInfo } from './hooks/useBackup';
import HomeScreen from './components/HomeScreen';
import ExploreLayout from './components/explore/ExploreLayout';
import BackupFlow from './components/backup/BackupFlow';
import PasswordDialog from './components/shared/PasswordDialog';
import type { RecentSession } from './lib/appState';

type Screen = 'home' | 'explore' | 'create-backup';

interface PendingOpen {
  udid: string;
  backupDir?: string;
  deviceName?: string;
  session?: RecentSession;
  backupInfo?: BackupInfo;
}

function sessionFromInfo(info: BackupInfo, existing?: RecentSession): RecentSession {
  return existing ?? {
    id: info.udid,
    type: 'device',
    name: info.device_name,
    subtitle: `iOS ${info.product_version}`,
    exportCount: 0,
    lastOpened: new Date().toISOString(),
    iosVersion: info.product_version,
    backupDir: info.backup_dir,
  };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const backup = useBackup();
  const [currentSession, setCurrentSession] = useState<RecentSession | null>(null);
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  const openAndNavigate = useCallback(async (
    udid: string,
    password: string | undefined,
    backupDir: string | undefined,
    session: RecentSession | undefined,
    backupInfo: BackupInfo | undefined,
  ) => {
    const result = await backup.openBackup(udid, password, backupDir);

    if (result.status === 'password_required') {
      setPendingOpen({ udid, backupDir, deviceName: session?.name ?? backupInfo?.device_name, session, backupInfo });
      return;
    }

    if (result.status === 'open' && result.info) {
      setCurrentSession(sessionFromInfo(result.info, session));
      setScreen('explore');
      setPendingOpen(null);
      setPasswordError(null);
    }
  }, [backup]);

  const handlePasswordSubmit = useCallback(async (password: string) => {
    if (!pendingOpen) return;
    setUnlocking(true);
    setPasswordError(null);
    try {
      const result = await backup.openBackup(pendingOpen.udid, password, pendingOpen.backupDir);
      if (result.status === 'password_required') {
        setPasswordError('Incorrect password. Please try again.');
      } else if (result.status === 'open' && result.info) {
        setCurrentSession(sessionFromInfo(result.info, pendingOpen.session));
        setScreen('explore');
        setPendingOpen(null);
        setPasswordError(null);
      } else if (result.status.startsWith('error:')) {
        setPasswordError(result.status.slice(6));
      }
    } finally {
      setUnlocking(false);
    }
  }, [pendingOpen, backup]);

  return (
    <div className="h-screen flex flex-col bg-white text-gray-900">
      {screen === 'home' && (
        <HomeScreen
          onOpenBackup={async (session) => {
            await openAndNavigate(session.id, undefined, session.backupDir, session, undefined);
          }}
          onCreateBackup={() => setScreen('create-backup')}
          onBrowseForBackup={async () => {
            const path = await window.openextract.selectFolder();
            if (!path) return;
            const found = await backup.listBackups(path, true);
            if (found.length >= 1) {
              const b = found[0];
              await openAndNavigate(b.udid, undefined, b.backup_dir, undefined, b);
            }
          }}
        />
      )}

      {screen === 'explore' && backup.activeBackup && (
        <ExploreLayout
          udid={backup.activeBackup.udid}
          session={currentSession}
          onBack={() => {
            backup.setActiveBackup(null);
            setCurrentSession(null);
            setScreen('home');
          }}
        />
      )}

      {screen === 'create-backup' && (
        <BackupFlow
          onBack={() => setScreen('home')}
          onBackupComplete={async (udid, backupPath) => {
            await openAndNavigate(udid, undefined, backupPath, undefined, undefined);
            return 'open';
          }}
        />
      )}

      {pendingOpen && (
        <PasswordDialog
          deviceName={pendingOpen.deviceName}
          error={passwordError}
          loading={unlocking}
          onSubmit={handlePasswordSubmit}
          onCancel={() => {
            setPendingOpen(null);
            setPasswordError(null);
          }}
        />
      )}
    </div>
  );
}
