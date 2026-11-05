import { useCallback, useEffect, useRef, useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { ArrowLeftIcon, PhoneIcon, FolderIcon, LockIcon, DownloadIcon } from '../shared/Icons';
import { ReportProblemButton } from '../shared/Feedback';

interface DeviceInfo {
  udid: string;
  name: string;
  ios_version: string;
  connection_type: 'usb' | 'wifi';
  // false until the iPhone trusts this computer (backup.pair_device)
  trusted?: boolean;
}

// backup.pair_device: 'locked' also covers the iPhone asking for its passcode after Trust.
type PairState = 'trusted' | 'waiting' | 'locked' | 'denied';

interface BackupProgress {
  phase: 'negotiating' | 'waiting' | 'passcode' | 'backing_up' | 'finalizing';
  percent: number;
  files_done: number;
  files_total: number;
  // Received from the iPhone so far; it moves whenever data does, even while percent waits.
  bytes_done?: number;
}

// Decimal units, like Finder, iPhone Storage and the engine's disk-space messages.
function formatCopied(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB copied` : `${Math.round(bytes / 1e6)} MB copied`;
}

type BackupStatus = 'idle' | 'running' | 'success' | 'error';

// Errors that are steps for the user, not bugs, so they get no "Report this problem"
// (python/device_backup.py). DEVICE_SERVICE_REQUIRED means usbmuxd can't be reached:
// on Windows, Apple Devices or iTunes isn't installed or isn't running.
// DEVICE_DISCONNECTED means the iPhone was unplugged during the backup.
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
  onBackupComplete?: (udid: string, backupPath: string, password?: string) => Promise<string | void> | void;
}

export default function BackupFlow({ onBack, onBackupComplete }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [useEncryption, setUseEncryption] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [status, setStatus] = useState<BackupStatus>('idle');
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);

  const [passwordRequired, setPasswordRequired] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<{ udid: string; backupPath: string } | null>(null);
  const [openPassword, setOpenPassword] = useState('');
  const [openPasswordError, setOpenPasswordError] = useState<string | null>(null);
  const [openingBackup, setOpeningBackup] = useState(false);

  const unsubscribeRef = useRef<(() => void) | null>(null);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setDeviceError(null);
    try {
      const result = await sidecarCall<{ devices: DeviceInfo[] }>('backup.list_devices', {});
      setDevices(result.devices);
    } catch (err: any) {
      setDeviceError(err.message || 'Failed to detect devices');
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
        const { state } = await sidecarCall<{ state: PairState }>('backup.pair_device', { udid: untrusted.udid });
        if (cancelled) return;
        if (state === 'trusted') {
          loadDevices();
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

  const handleChooseDir = async () => {
    const folder = await saveFolder();
    if (folder) setOutputDir(folder);
  };

  const handleStartBackup = async () => {
    if (!selectedDevice || !outputDir) return;
    setStatus('running');
    setProgress({ phase: 'negotiating', percent: 0, files_done: 0, files_total: 0 });
    setBackupError(null);
    setBackupPath(null);

    if (window.openextract?.onNotification) {
      const cleanup = window.openextract.onNotification((notification: any) => {
        if (notification.method === 'backup.progress') {
          setProgress(notification.params as BackupProgress);
        }
      });
      unsubscribeRef.current = cleanup;
    }

    try {
      const result = await sidecarCall<{ success: boolean; backup_path: string }>(
        'backup.start',
        {
          udid: selectedDevice.udid,
          output_dir: outputDir,
          encrypted: useEncryption,
          ...(useEncryption && password ? { password } : {}),
        },
      );
      setBackupPath(result.backup_path);
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
      });

      if (onBackupComplete) {
        const openResult = await onBackupComplete(selectedDevice.udid, result.backup_path);
        if (openResult === 'password_required') {
          setPasswordRequired(true);
          setPendingOpen({ udid: selectedDevice.udid, backupPath: result.backup_path });
        }
      }
    } catch (err: any) {
      setBackupError(err.message || 'Backup failed');
      setStatus('error');
      // The device list then shows the iPhone as untrusted (and asks it to trust us),
      // or as gone until it's plugged back in.
      if (/^(TRUST_REQUIRED|DEVICE_DISCONNECTED):/.test(err.message ?? '')) loadDevices();
    } finally {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    }
  };

  const handleSubmitOpenPassword = async () => {
    if (!pendingOpen || !openPassword || !onBackupComplete) return;
    setOpenPasswordError(null);
    setOpeningBackup(true);
    const result = await onBackupComplete(pendingOpen.udid, pendingOpen.backupPath, openPassword);
    setOpeningBackup(false);
    if (result?.startsWith('error:')) {
      setOpenPasswordError(result.slice(6) || 'Incorrect password');
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setProgress(null);
    setBackupError(null);
    setBackupPath(null);
    setPasswordRequired(false);
    setPendingOpen(null);
    setOpenPassword('');
    setOpenPasswordError(null);
    setOpeningBackup(false);
  };

  const selectedTrusted = devices.find((d) => d.udid === selectedDevice?.udid)?.trusted !== false;
  const canStart = selectedDevice !== null && selectedTrusted && outputDir !== '' && (!useEncryption || password !== '') && status === 'idle';

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
        <div className="max-w-xl">
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
                <ReportProblemButton error={deviceError} area="create_backup" className="block mt-1.5" />
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
                  disabled={status === 'running' || device.trusted === false}
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
                      <div className="text-xs text-text-tertiary">
                        iOS {device.ios_version} · {device.connection_type === 'usb' ? 'USB' : 'Wi-Fi'}
                        {device.trusted === false && ' · Waiting for you to trust this computer'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

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
          </section>

          {/* Step 3: Encryption */}
          <section className="mb-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">3. Encryption</h3>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useEncryption}
                onChange={(e) => setUseEncryption(e.target.checked)}
                disabled={status === 'running'}
                className="w-4 h-4 rounded accent-[var(--accent)]"
              />
              <span className="text-sm text-gray-700">Encrypt backup</span>
              <LockIcon className="text-text-tertiary" size={16} />
            </label>
            <p className="text-xs text-text-tertiary mt-1 ml-6">
              Encrypted backups include Health data, saved passwords, and Wi-Fi credentials.
            </p>
            {useEncryption && (
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

          {/* Success */}
          {status === 'success' && (
            <div className="mb-6 space-y-3">
              <div className="p-4 rounded-lg bg-green-50 border border-green-200 flex items-start gap-3">
                <svg className="text-green-500 flex-shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <div>
                  <p className="text-sm font-medium text-gray-900">Backup complete!</p>
                  <p className="text-xs text-gray-500 mt-0.5 break-all">{backupPath}</p>
                </div>
              </div>
              {passwordRequired && (
                <div className="p-4 rounded-lg bg-accent-wash/50 border border-accent-line">
                  <div className="flex items-center gap-2 mb-2">
                    <LockIcon className="text-accent" size={18} />
                    <p className="text-sm font-medium text-gray-900">Backup is encrypted</p>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">Enter the password you set when enabling encrypted backups.</p>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={openPassword}
                      onChange={(e) => setOpenPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSubmitOpenPassword()}
                      placeholder="Backup password"
                      disabled={openingBackup}
                      autoFocus
                      className="flex-1 px-3 py-2 text-sm rounded-md border border-gray-200 focus:outline-none focus:border-accent disabled:opacity-50"
                    />
                    <button
                      onClick={handleSubmitOpenPassword}
                      disabled={!openPassword || openingBackup}
                      className="px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-40 transition-colors"
                    >
                      {openingBackup ? 'Unlocking...' : 'Unlock'}
                    </button>
                  </div>
                  {openPasswordError && <p className="mt-2 text-xs text-red-500">{openPasswordError}</p>}
                </div>
              )}
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
            {status === 'running' && (
              <button disabled className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium opacity-60 cursor-not-allowed">
                Backing up...
              </button>
            )}
            {(status === 'success' || status === 'error') && (
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
