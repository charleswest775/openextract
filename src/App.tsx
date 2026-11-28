import { useState, useCallback } from 'react';
import { useBackup, type BackupInfo } from './hooks/useBackup';
import HomeScreen from './components/HomeScreen';
import ExploreLayout from './components/explore/ExploreLayout';
import BackupFlow from './components/backup/BackupFlow';
import PasswordDialog from './components/shared/PasswordDialog';
import BackupChooserDialog from './components/shared/BackupChooserDialog';
import type { RecentSession } from './lib/appState';
import { backupMissingMessage, noBackupsMessage } from './lib/foundBackups';
import FullDiskAccessDialog, { FULL_DISK_ACCESS_PREFIX } from './components/shared/FullDiskAccessDialog';
import UpdateNotice from './components/shared/UpdateNotice';
import PayItForwardPrompt from './components/shared/PayItForwardPrompt';
import PriceStepHost from './components/shared/PriceStepHost';
import BusinessUsePrompt from './components/shared/BusinessUsePrompt';
import ExportCheckPrompt from './components/shared/ExportCheckPrompt';
import FixedReportNotice from './components/shared/FixedReportNotice';
import { FeedbackProvider, ReportProblemButton } from './components/shared/Feedback';
import { NoticeProvider } from './components/shared/Notices';

type Screen = 'home' | 'explore' | 'create-backup';

interface PendingOpen {
  udid: string;
  backupDir?: string;
  deviceName?: string;
  session?: RecentSession;
  backupInfo?: BackupInfo;
  // Said instead of the password dialog's usual words.
  hint?: string;
}

// A backup just made of an iPhone that already had a backup password (OE-68).
const EXISTING_PASSWORD_HINT =
  "This iPhone already had a backup password, so this backup uses that one, not a new one. It's the password set when this iPhone first made an encrypted backup, in Finder, iTunes or OpenExtract.";

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
  const [openError, setOpenError] = useState<string | null>(null);
  // The recent backup that couldn't be found, which the alert offers to take off the list.
  const [missingSessionId, setMissingSessionId] = useState<string | null>(null);
  // Counts up to have the home screen read its list again.
  const [homeReload, setHomeReload] = useState(0);
  const [browseChoices, setBrowseChoices] = useState<{ folder: string; backups: BackupInfo[] } | null>(null);

  const openAndNavigate = useCallback(async (
    udid: string,
    password: string | undefined,
    backupDir: string | undefined,
    session: RecentSession | undefined,
    backupInfo: BackupInfo | undefined,
    passwordHint?: string,
  ) => {
    setOpenError(null);
    setMissingSessionId(null);
    const result = await backup.openBackup(udid, password, backupDir);

    if (result.status === 'password_required') {
      setPendingOpen({ udid, backupDir, deviceName: session?.name ?? backupInfo?.device_name, session, backupInfo, hint: passwordHint });
      return;
    }

    if (result.status === 'open' && result.info) {
      setCurrentSession(sessionFromInfo(result.info, session));
      setScreen('explore');
      setPendingOpen(null);
      setPasswordError(null);
      return;
    }

    if (result.status.startsWith('error:')) {
      const message = result.status.slice(6);
      setOpenError(message);
      if (session && backupMissingMessage(message)) setMissingSessionId(session.id);
    } else {
      setOpenError(`Could not open backup (status: ${result.status}).`);
    }
  }, [backup]);

  // "Open a backup folder" on the home screen, and Find it on a backup that isn't
  // where it was. Opening it again saves its new folder in the recent list.
  const browseForBackup = useCallback(async () => {
    setOpenError(null);
    setMissingSessionId(null);
    const path = await window.openextract.selectFolder();
    if (!path) return;
    try {
      const { backups: found, hint } = await backup.listBackups(path, true);
      if (found.length === 0) {
        setOpenError(noBackupsMessage(path, hint, window.openextract.platform));
        return;
      }
      if (found.length > 1) {
        // Several backups in the picked folder — let the user choose
        // rather than silently opening whichever one is listed first (#81).
        setBrowseChoices({ folder: path, backups: found });
        return;
      }
      const b = found[0];
      await openAndNavigate(b.udid, undefined, b.backup_dir, undefined, b);
    } catch (e: any) {
      setOpenError(e?.message || 'Failed to read backup folder.');
    }
  }, [backup, openAndNavigate]);

  // A backup that isn't where it was (moved, or on a drive that isn't plugged in): its
  // words, shown with Find it. null for any other error.
  const missingBackup = backupMissingMessage(openError, !!missingSessionId);

  // Remove from list, on a recent backup that isn't where it was: one deleted along with the
  // folder it was in, or kept on a drive that's gone (OE-214). Only the app's list changes.
  const removeMissingSession = useCallback(async () => {
    if (!missingSessionId) return;
    await window.openextract.removeSession(missingSessionId);
    setOpenError(null);
    setMissingSessionId(null);
    setHomeReload(n => n + 1);
  }, [missingSessionId]);

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
      } else if (result.status.startsWith(`error:${FULL_DISK_ACCESS_PREFIX}`)) {
        setPendingOpen(null);
        setOpenError(result.status.slice(6));
      } else if (result.status.startsWith('error:')) {
        setPasswordError(result.status.slice(6));
      }
    } finally {
      setUnlocking(false);
    }
  }, [pendingOpen, backup]);

  return (
    <FeedbackProvider>
    <NoticeProvider>
    <div className="h-screen flex flex-col bg-base text-text-primary">
      {screen === 'home' && (
        <HomeScreen
          reload={homeReload}
          onOpenBackup={async (session) => {
            await openAndNavigate(session.id, undefined, session.backupDir, session, undefined);
          }}
          onOpenFoundBackup={async (b) => {
            await openAndNavigate(b.udid, undefined, b.backup_dir, undefined, b);
          }}
          onCreateBackup={() => setScreen('create-backup')}
          onBrowseForBackup={browseForBackup}
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
          unfinished={!!backup.activeBackup.unfinished}
          onNewBackup={() => {
            backup.setActiveBackup(null);
            setCurrentSession(null);
            setScreen('create-backup');
          }}
        />
      )}

      {screen === 'create-backup' && (
        <BackupFlow
          onBack={() => setScreen('home')}
          onBackupComplete={async (udid, backupPath, existingPassword) => {
            await openAndNavigate(udid, undefined, backupPath, undefined, undefined,
              existingPassword ? EXISTING_PASSWORD_HINT : undefined);
          }}
        />
      )}

      {/* Bottom-right notices, stacked so they never overlap */}
      <div className="fixed right-6 bottom-6 z-40 flex flex-col items-end gap-3">
        <PayItForwardPrompt />
        <BusinessUsePrompt />
        <ExportCheckPrompt />
        <FixedReportNotice />
        <UpdateNotice />
      </div>

      {/* "What's this worth to you?" before saves that skip the Save window */}
      <PriceStepHost />

      {openError?.startsWith(FULL_DISK_ACCESS_PREFIX) && (
        <FullDiskAccessDialog message={openError} onClose={() => setOpenError(null)} />
      )}

      {openError && screen === 'home' && !openError.startsWith(FULL_DISK_ACCESS_PREFIX) && (
        <div
          role="alert"
          className="fixed left-1/2 -translate-x-1/2 bottom-6 z-40 max-w-md w-[90%] px-4 py-3 rounded-xl flex items-start gap-3 text-sm"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
            boxShadow: '0 10px 28px rgba(30,26,22,0.18)',
          }}
        >
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs mt-0.5"
            style={{ background: 'var(--error)' }}
          >!</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium mb-0.5">{missingBackup ? "Can't find this backup" : "Couldn't open backup"}</div>
            <div className="text-xs text-text-secondary break-words">{missingBackup ?? openError}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {missingBackup && (
                <button type="button" onClick={browseForBackup} className="text-xs font-medium text-accent hover:underline">
                  Find it
                </button>
              )}
              {missingBackup && missingSessionId && (
                <button type="button" onClick={removeMissingSession} className="text-xs font-medium text-accent hover:underline">
                  Remove from list
                </button>
              )}
              <ReportProblemButton error={openError} area="open_backup" />
            </div>
          </div>
          <button
            onClick={() => { setOpenError(null); setMissingSessionId(null); }}
            className="text-text-tertiary hover:text-text-primary flex-shrink-0"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {browseChoices && (
        <BackupChooserDialog
          folder={browseChoices.folder}
          backups={browseChoices.backups}
          onChoose={async (b) => {
            setBrowseChoices(null);
            await openAndNavigate(b.udid, undefined, b.backup_dir, undefined, b);
          }}
          onCancel={() => setBrowseChoices(null)}
        />
      )}

      {pendingOpen && (
        <PasswordDialog
          deviceName={pendingOpen.deviceName}
          hint={pendingOpen.hint}
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
    </NoticeProvider>
    </FeedbackProvider>
  );
}
