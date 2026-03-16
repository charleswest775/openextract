import { useState, useEffect } from 'react';
import { useBackup } from './hooks/useBackup';
import BackupSelector from './components/BackupSelector';
import Dashboard from './components/Dashboard';
import CreateBackup from './components/CreateBackup';

type Screen = 'select' | 'dashboard' | 'create-backup';

export default function App() {
  const [screen, setScreen] = useState<Screen>('select');
  const backup = useBackup();

  useEffect(() => {
    if (backup.activeBackup) {
      setScreen('dashboard');
    }
  }, [backup.activeBackup]);

  return (
    <div className="h-screen flex flex-col bg-base text-text-primary">
      {/* Header */}
      <header className="bg-surface shadow-toolbar px-5 flex items-center justify-between flex-shrink-0" style={{ height: '44px' }}>
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-body font-semibold text-text-primary">
            OpenExtract
          </h1>
          {backup.activeBackup && (
            <span className="text-caption text-text-secondary">
              — {backup.activeBackup.device_name} &middot; iOS {backup.activeBackup.product_version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Create Backup button — visible on select screen */}
          {screen === 'select' && (
            <button
              onClick={() => setScreen('create-backup')}
              className="text-caption text-text-accent hover:bg-accent-subtle px-2 py-1 rounded-sm transition-colors duration-200"
            >
              Create Backup
            </button>
          )}
          {backup.activeBackup && (
            <button
              onClick={() => {
                backup.setActiveBackup(null);
                setScreen('select');
              }}
              className="text-caption text-text-accent hover:bg-accent-subtle px-2 py-1 rounded-sm transition-colors duration-200"
            >
              Change Backup
            </button>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {screen === 'select' && (
          <BackupSelector
            backups={backup.backups}
            loading={backup.loading}
            error={backup.error}
            onRefresh={backup.listBackups}
            onOpen={backup.openBackup}
            onCreateBackup={() => setScreen('create-backup')}
          />
        )}
        {screen === 'dashboard' && backup.activeBackup && (
          <Dashboard backup={backup.activeBackup} />
        )}
        {screen === 'create-backup' && (
          <CreateBackup
            onBack={() => setScreen('select')}
            onBackupComplete={async (udid, backupPath, password) => {
              const result = await backup.openBackup(udid, password, backupPath);
              if (result === 'open') setScreen('dashboard');
              return result;
            }}
          />
        )}
      </main>
    </div>
  );
}
