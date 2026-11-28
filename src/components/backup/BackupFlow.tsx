import { useCallback, useEffect, useRef, useState } from 'react';
import { saveFolder, sidecarCall, syncedFolder } from '../../lib/ipc';
import { canBackUp, deviceDetail, markNotAnswering, notAnsweringMessages, searchFailedMessage, type DeviceInfo } from '../../lib/deviceSearch';
import { ArrowLeftIcon, PhoneIcon, FolderIcon, LockIcon, DownloadIcon } from '../shared/Icons';
import { ReportProblemButton } from '../shared/Feedback';
import BackupStory from './BackupStory';

// backup.pair_device: 'locked' also covers the iPhone asking for its passcode after Trust.
// 'not_answering' comes with a message: the iPhone stopped answering partway.
type PairState = 'trusted' | 'waiting' | 'locked' | 'denied' | 'not_answering';

interface BackupProgress {
  phase: 'negotiating' | 'waiting' | 'passcode' | 'backing_up' | 'finalizing';
  percent: number;
  files_done: number;
  files_total: number;
  // Received from the iPhone so far; it moves whenever data does, even while percent waits.
  bytes_done?: number;
}

// Decimal units, like Finder, iPhone Storage and the engine's disk-space messages. Two
// decimals, so the figure visibly moves every few seconds even on a slow transfer.
function formatCopied(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB copied` : `${Math.round(bytes / 1e6)} MB copied`;
}

type BackupStatus = 'idle' | 'running' | 'success' | 'error';

// Errors that are steps for the user, not bugs, so they get no "Report this problem"
// (python/device_backup.py). DEVICE_SERVICE_REQUIRED means usbmuxd can't be reached:
// on Windows, Apple Devices or iTunes isn't installed or isn't running.
// DEVICE_DISCONNECTED means the iPhone dropped off during the backup: unplugged, or
// the computer went to sleep (electron/main.ts says which when it knows).
const DEVICE_SERVICE_PREFIX = 'DEVICE_SERVICE_REQUIRED: ';
const SETUP_PREFIX = /^(TRUST_REQUIRED|PASSCODE_REQUIRED|DEVICE_SERVICE_REQUIRED|DEVICE_DISCONNECTED): /;
const APPLE_DEVICES_STORE_URL = 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K';

/**
 * Shown instead of a device list when the system can't talk to iPhones yet. On
 * Windows that means Apple Devices isn't installed, and the engine can install it
 * (backup.install_device_support), with the Microsoft Store page as the fallback.
 */
function DeviceServiceSetup({ message, onCheckAgain }: { message: string; onCheckAgain: () => void }) {
  const windows = window.openextract?.platform === 'win32';
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const openStore = () => window.openextract.openExternal(APPLE_DEVICES_STORE_URL);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await sidecarCall('backup.install_device_support', {});
      setInstalling(false);
      onCheckAgain();
    } catch (err: any) {
      setInstallError(err.message || "Apple Devices couldn't be installed");
      setInstalling(false);
    }
  };

  return (
    <div className="mb-3 p-4 rounded-lg bg-accent-wash/50 border border-accent-line">
      <div className="flex items-center gap-2 mb-2">
        <PhoneIcon className="text-accent" size={18} />
        <p className="text-sm font-medium text-gray-900">
          {windows ? 'Install Apple Devices first' : "Can't reach your iPhone"}
        </p>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        {windows
          ? "Windows needs Apple Devices, Apple's free app, to talk to an iPhone. OpenExtract can install it for you from the Microsoft Store. You don't need it to open backups you already have."
          : message.slice(DEVICE_SERVICE_PREFIX.length)}
      </p>
      {installing ? (
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <div className="w-4 h-4 border-2 border-accent-line border-t-accent rounded-full animate-spin flex-shrink-0" />
          Installing Apple Devices… This usually takes about a minute.
        </div>
      ) : (
        <div className="flex gap-2">
          {windows && (
            <button
              onClick={install}
              className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors"
            >
              Install Apple Devices
            </button>
          )}
          <button
            onClick={onCheckAgain}
            className="px-4 py-2 rounded-md border border-gray-200 text-sm hover:border-gray-300 transition-colors"
          >
            Check again
          </button>
        </div>
      )}
      {installError && (
        <div className="mt-3 text-xs text-red-600">
          {installError}
          <div className="flex gap-3 mt-1.5">
            <button onClick={openStore} className="text-accent hover:underline">Open the Microsoft Store</button>
            <ReportProblemButton error={installError} area="create_backup" />
          </div>
        </div>
      )}
      {windows && !installError && (
        <p className="text-xs text-text-tertiary mt-3">
          Installing it means you accept the Microsoft Store and Apple terms. Rather do it yourself?{' '}
          <button onClick={openStore} className="text-accent hover:underline">Open it in the Microsoft Store</button>.
        </p>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<BackupProgress['phase'], string> = {
  negotiating: 'Connecting to your iPhone...',
  waiting: 'Waiting for your iPhone...',
  passcode: 'Enter your passcode on your iPhone to start the backup',
  backing_up: 'Backing up files...',
  finalizing: 'Finishing the backup...',
};

interface Props {
  onBack: () => void;
  // existingPassword: the backup is encrypted with the password the iPhone already had.
  onBackupComplete?: (udid: string, backupPath: string, existingPassword: boolean) => Promise<void> | void;
}

// Shown in step 3 when the iPhone already has a backup password (OE-68).
const EXISTING_PASSWORD_NOTE =
  "This iPhone already has a backup password, set earlier in Finder, iTunes or OpenExtract. It encrypts every backup with that password, so this backup uses it too. You'll need it to open the backup.";
const FORGOT_PASSWORD_NOTE =
  "Can't remember it? On the iPhone, Settings > General > Transfer or Reset iPhone > Reset > Reset All Settings removes it. That keeps your data but resets settings such as Wi-Fi passwords and wallpaper.";

export default function BackupFlow({ onBack, onBackupComplete }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [outputDir, setOutputDir] = useState('');
  // "OneDrive" etc. when the chosen folder is synced to one, which the backup doesn't suit (OE-212).
  const [synced, setSynced] = useState<string | null>(null);
  const [useEncryption, setUseEncryption] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [status, setStatus] = useState<BackupStatus>('idle');
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  // Set when the folder already held a backup, which is always kept (python/backup_beside.py).
  const [earlierBackup, setEarlierBackup] = useState<string | null>(null);

  const [existingPasswordUsed, setExistingPasswordUsed] = useState(false);
  // The iPhone that was backed up. It can be unplugged, so no longer selected, before Open is clicked.
  const [backedUpUdid, setBackedUpUdid] = useState('');

  const unsubscribeRef = useRef<(() => void) | null>(null);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDeviceError(null);
    try {
      const result = await sidecarCall<{ devices: DeviceInfo[] }>('backup.list_devices', {});
      setDevices(result.devices);
    } catch (err: any) {
      setDeviceError(searchFailedMessage(err.message || 'Failed to detect devices'));
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  useEffect(() => {
    loadDevices();
    return () => { unsubscribeRef.current?.(); };
  }, []);

  // An iPhone that doesn't trust this computer yet: ask it, then check back every couple
  // of seconds. The engine resends the same request each time, so the iPhone asks once.
  const untrusted = devices.find((d) => d.trusted === false);
  const [pairState, setPairState] = useState<PairState>('waiting');
  useEffect(() => {
    if (!untrusted) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPairState('waiting');
    const ask = async () => {
      try {
        const { state, message } = await sidecarCall<{ state: PairState; message?: string }>(
          'backup.pair_device', { udid: untrusted.udid });
        if (cancelled) return;
        if (state === 'trusted') {
          loadDevices();
          return;
        }
        if (state === 'not_answering') {
          // Stop asking: each try would hold up the app for a few seconds. It's shown as not
          // answering, with what to do, and Refresh asks it again.
          setDevices((current) => markNotAnswering(current, untrusted.udid, message));
          return;
        }
        setPairState(state);
        if (state !== 'denied') timer = setTimeout(ask, 2000);
      } catch (err: any) {
        if (!cancelled) setDeviceError(err.message || "Couldn't ask your iPhone to trust this computer");
      }
    };
    ask();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [devices, loadDevices]);

  // Only one device, as on anyone's first backup: select it, so there's nothing to pick.
  // A device that has gone from the list (unplugged, then Refresh) is no longer selected.
  // One still there is replaced by its new entry, which may now trust this computer or
  // have a backup password.
  useEffect(() => {
    setSelectedDevice((current) => {
      if (devices.length === 1) return devices[0];
      return devices.find((d) => d.udid === current?.udid) ?? null;
    });
  }, [devices]);

  // The iPhone already has a backup password, so the backup uses it, asked to encrypt or not.
  const existingPassword = selectedDevice?.encrypts_backups === true;

  const chosenDir = useRef('');
  const handleChooseDir = async () => {
    const folder = await saveFolder();
    if (!folder) return;
    chosenDir.current = folder;
    setOutputDir(folder);
    setSynced(null);
    const service = await syncedFolder(folder);
    if (chosenDir.current === folder) setSynced(service); // not one chosen before it
  };

  const handleStartBackup = async () => {
    if (!selectedDevice || !outputDir) return;
    setStatus('running');
    setProgress({ phase: 'negotiating', percent: 0, files_done: 0, files_total: 0 });
    setBackupError(null);
    setBackupPath(null);
    setEarlierBackup(null);

    if (window.openextract?.onNotification) {
      const cleanup = window.openextract.onNotification((notification: any) => {
        if (notification.method === 'backup.progress') {
          setProgress(notification.params as BackupProgress);
        }
      });
      unsubscribeRef.current = cleanup;
    }

    try {
      const result = await sidecarCall<{ success: boolean; backup_path: string; existing_password?: boolean; earlier_backup?: string }>(
        'backup.start',
        {
          udid: selectedDevice.udid,
          output_dir: outputDir,
          encrypted: useEncryption || existingPassword,
          ...(useEncryption && !existingPassword && password ? { password } : {}),
        },
      );
      setBackupPath(result.backup_path);
      setEarlierBackup(result.earlier_backup ?? null);
      setStatus('success');

      // Add session
      window.openextract.addSession({
        id: selectedDevice.udid,
        type: 'device',
        name: selectedDevice.name,
        subtitle: `iOS ${selectedDevice.ios_version}`,
        exportCount: 0,
        lastOpened: new Date().toISOString(),
        iosVersion: selectedDevice.ios_version,
        backupDir: result.backup_path,
        // This backup just finished; clear a "Didn't finish" left from an earlier try.
        unfinished: false,
      });

      setExistingPasswordUsed(!!result.existing_password);
      setBackedUpUdid(selectedDevice.udid);
      // Opening leaves this screen. With two backups there now, the user needs to read where
      // each one is first, and opens the new one with the button.
      if (!result.earlier_backup) {
        await onBackupComplete?.(selectedDevice.udid, result.backup_path, !!result.existing_password);
      }
    } catch (err: any) {
      setBackupError(err.message || 'Backup failed');
      setStatus('error');
      // The device list then shows the iPhone as untrusted (and asks it to trust us), as
      // gone until it's plugged back in, or with the backup password a failed try set, so
      // a retry doesn't offer to set another (OE-68).
      loadDevices();
    } finally {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setProgress(null);
    setBackupError(null);
    setBackupPath(null);
  };

  // An iPhone that doesn't trust this computer yet, or didn't answer the search, can't be backed up.
  const selectedReady = canBackUp(devices.find((d) => d.udid === selectedDevice?.udid));
  const notAnswering = notAnsweringMessages(devices);
  const canStart = selectedDevice !== null && selectedReady && outputDir !== ''
    && (!useEncryption || existingPassword || password !== '') && status === 'idle';

  return (
    <div className="h-screen flex flex-col bg-base">
      {/* Top row; on macOS also the window's title bar */}
      <div className="titlebar px-5 border-b border-rule flex items-center gap-3">
        <button onClick={onBack} className="hearth-ghost-btn !px-3 !py-1.5">
          <ArrowLeftIcon size={18} />
          Back
        </button>
        <h1 className="text-xl text-text-primary">Back up my iPhone</h1>
        <span className="text-sm text-text-tertiary">Make a new backup of a connected iPhone or iPad</span>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className={status === 'running' ? 'max-w-[980px]' : 'max-w-xl'}>
          {(status as BackupStatus) !== 'running' && (<>
          {/* Step 1: Device selection */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-900">1. Select device</h3>
              <button onClick={loadDevices} disabled={loadingDevices} className="text-xs text-accent hover:text-accent-hover disabled:opacity-50">
                {loadingDevices ? 'Scanning...' : 'Refresh'}
              </button>
            </div>

            {deviceError?.startsWith(DEVICE_SERVICE_PREFIX) ? (
              <DeviceServiceSetup message={deviceError} onCheckAgain={loadDevices} />
            ) : deviceError && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600">
                {deviceError}
                <div className="mt-1.5"><ReportProblemButton error={deviceError} area="create_backup" /></div>
              </div>
            )}

            {loadingDevices && devices.length === 0 && (
              <div className="py-4 text-sm text-text-tertiary flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-gray-300 border-t-accent rounded-full animate-spin" />
                Scanning for devices...
              </div>
            )}

            {!loadingDevices && devices.length === 0 && !deviceError && (
              <div className="py-6 text-center">
                <PhoneIcon className="mx-auto text-text-tertiary mb-2" size={28} />
                <p className="text-sm text-gray-500">No devices found.</p>
                <p className="text-xs text-text-tertiary mt-1">Connect your iPhone via USB and unlock it, then tap Refresh.</p>
              </div>
            )}

            <div className="space-y-2">
              {devices.map((device) => (
                <button
                  key={device.udid}
                  onClick={() => setSelectedDevice(device)}
                  disabled={status === 'running' || !canBackUp(device)}
                  className={`w-full text-left p-3.5 rounded-lg border transition-colors disabled:opacity-50 ${
                    selectedDevice?.udid === device.udid
                      ? 'border-accent bg-accent-wash/50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <PhoneIcon className="text-accent flex-shrink-0" size={18} />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{device.name}</div>
                      <div className="text-xs text-text-tertiary">{deviceDetail(device)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {notAnswering.map((message) => (
              <div key={message} className="mt-2 p-3 rounded-lg bg-accent-wash/50 border border-accent-line flex items-start gap-2 text-sm text-gray-700">
                <PhoneIcon className="text-accent flex-shrink-0 mt-0.5" size={16} />
                <p>{message}</p>
              </div>
            ))}

            {untrusted && (
              <div className="mt-2 p-3 rounded-lg bg-accent-wash/50 border border-accent-line flex items-start gap-2 text-sm text-gray-700">
                {pairState === 'denied' ? (
                  <p>
                    Your iPhone didn&apos;t trust this computer. Unplug it, plug it back in, then click Refresh
                    and tap <strong>Trust</strong>.
                  </p>
                ) : (
                  <>
                    <div className="w-4 h-4 mt-0.5 border-2 border-accent-line border-t-accent rounded-full animate-spin flex-shrink-0" />
                    <p>
                      {pairState === 'locked'
                        ? <>Unlock your iPhone. When it asks <strong>Trust This Computer?</strong>, tap Trust and enter your passcode.</>
                        : <>On your iPhone, tap <strong>Trust</strong>, then enter your passcode.</>}
                    </p>
                  </>
                )}
              </div>
            )}
          </section>

          {/* Step 2: Output directory */}
          <section className="mb-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">2. Backup destination</h3>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 truncate">
                {outputDir || <span className="text-text-tertiary">No folder selected</span>}
              </div>
              <button
                onClick={handleChooseDir}
                disabled={status === 'running'}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm hover:border-gray-300 transition-colors disabled:opacity-50"
              >
                <FolderIcon size={18} />
                Choose...
              </button>
            </div>
            {synced && (
              // A warning, not a block: a synced folder on a big enough drive can work, and the
              // folder name alone can be wrong. The space error says it again (electron/main.ts).
              <div role="status" className="mt-2 px-3 py-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">
                <p className="font-medium text-amber-900 mb-0.5">This folder is in {synced}</p>
                <p>
                  A backup here still takes up space on this computer's own drive: the space in your {synced} account
                  doesn't count. {synced} also uploads each file while the backup is being saved, which can make the
                  backup fail. Choose a folder that isn't in {synced}, such as one on an external drive.
                </p>
              </div>
            )}
          </section>

          {/* Step 3: Encryption */}
          <section className="mb-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">3. Encryption</h3>
            <label className={`flex items-center gap-2 select-none ${existingPassword ? '' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={useEncryption || existingPassword}
                onChange={(e) => setUseEncryption(e.target.checked)}
                disabled={status === 'running' || existingPassword}
                className="w-4 h-4 rounded accent-[var(--accent)]"
              />
              <span className="text-sm text-gray-700">Encrypt backup</span>
              <LockIcon className="text-text-tertiary" size={16} />
            </label>
            <p className="text-xs text-text-tertiary mt-1 ml-6">
              Encrypted backups include Health data, saved passwords, and Wi-Fi credentials.
            </p>
            {existingPassword ? (
              <div className="mt-3 ml-6 p-3 rounded-lg bg-accent-wash/50 border border-accent-line text-xs" data-existing-password>
                <p className="text-gray-700">{EXISTING_PASSWORD_NOTE}</p>
                <p className="text-text-tertiary mt-1.5">{FORGOT_PASSWORD_NOTE}</p>
              </div>
            ) : useEncryption && (
              <div className="mt-3 ml-6 relative w-80">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={status === 'running'}
                  placeholder="Set a backup password"
                  className="w-full px-3 py-2 bg-white text-sm rounded-md border border-gray-200 focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-tertiary hover:text-gray-600"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            )}
          </section>
          </>)}

          {/* While it runs, the three steps fold into one line */}
          {status === 'running' && selectedDevice && (
            <div className="mb-3 flex items-center gap-x-5 gap-y-1 flex-wrap text-sm text-text-secondary" data-backup-summary>
              <span className="flex items-center gap-1.5">
                <PhoneIcon size={16} className="text-accent" />
                <span className="text-text-primary">{selectedDevice.name}</span>
              </span>
              <span className="flex items-center gap-1.5 min-w-0">
                <FolderIcon size={16} className="text-text-tertiary" />
                <span className="truncate" data-backup-dest>{outputDir}</span>
              </span>
              {(useEncryption || existingPassword) && (
                <span className="flex items-center gap-1.5">
                  <LockIcon size={16} className="text-text-tertiary" />
                  Encrypted
                </span>
              )}
            </div>
          )}

          {/* Progress */}
          {status === 'running' && progress && (
            <div className="mb-6 p-4 rounded-lg bg-accent-wash/50 border border-accent-line">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-4 h-4 border-2 border-accent-line border-t-accent rounded-full animate-spin flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{PHASE_LABELS[progress.phase]}</p>
                  {!!progress.bytes_done && (
                    <p className="text-xs text-gray-500">{formatCopied(progress.bytes_done)}</p>
                  )}
                  {progress.files_total > 0 && (
                    <p className="text-xs text-gray-500">{progress.files_done.toLocaleString()} / {progress.files_total.toLocaleString()} files</p>
                  )}
                </div>
                <span className="text-sm font-medium text-accent">{progress.percent}%</span>
              </div>
              <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${Math.max(2, progress.percent)}%` }} />
              </div>
              <p className="text-xs text-text-tertiary mt-2">
                {progress.phase === 'waiting'
                  ? 'If your iPhone asks for its passcode, enter it there. The backup starts once you do.'
                  : 'Keep your device connected and unlocked.'}
              </p>
            </div>
          )}

          {/* Charles's story while the backup copies (not while the iPhone waits for its passcode) */}
          {status === 'running' && (progress?.phase === 'backing_up' || progress?.phase === 'finalizing') && (
            <BackupStory />
          )}

          {/* Success */}
          {status === 'success' && (
            <div className="mb-6">
              <div className="p-4 rounded-lg bg-green-50 border border-green-200 flex items-start gap-3">
                <svg className="text-green-500 flex-shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <div>
                  <p className="text-sm font-medium text-gray-900">Backup complete!</p>
                  <p className="text-xs text-gray-500 mt-0.5 break-all">{backupPath}</p>
                  {earlierBackup && (
                    <p className="text-xs text-gray-500 mt-1.5 break-all" data-earlier-backup>
                      The backup that was already there was kept too, in {earlierBackup}. OpenExtract
                      never removes it by itself. If you need the space, open the new one and check it
                      has everything you want. Its Backup details lists older backups it can move to the Trash.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 flex items-start gap-3">
              <svg className="text-red-500 flex-shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {backupError?.startsWith('TRUST_REQUIRED:') ? 'Trust required' :
                   backupError?.startsWith('PASSCODE_REQUIRED:') ? 'Passcode required' :
                   backupError?.startsWith('DEVICE_DISCONNECTED:') ? 'iPhone disconnected' :
                   backupError?.startsWith(DEVICE_SERVICE_PREFIX) ? "Can't reach your iPhone" : 'Backup failed'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {backupError?.replace(SETUP_PREFIX, '')}
                </p>
                {!backupError?.match(SETUP_PREFIX) && (
                  <ReportProblemButton error={backupError} area="create_backup" className="mt-1.5" />
                )}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {status === 'idle' && (
              <button
                onClick={handleStartBackup}
                disabled={!canStart}
                className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                Start Backup
              </button>
            )}
            {status === 'success' && earlierBackup && backupPath && (
              <button
                onClick={() => onBackupComplete?.(backedUpUdid, backupPath, existingPasswordUsed)}
                className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors"
              >
                Open the new backup
              </button>
            )}
            {(status === 'error' || (status === 'success' && !earlierBackup)) && (
              <button onClick={handleReset} className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-hover transition-colors">
                {status === 'error' ? 'Retry' : 'Back Up Again'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
