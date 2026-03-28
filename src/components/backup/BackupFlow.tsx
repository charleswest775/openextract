import { useCallback, useEffect, useRef, useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { ArrowLeftIcon, PhoneIcon, FolderIcon, LockIcon, DownloadIcon } from '../shared/Icons';

interface DeviceInfo {
  udid: string;
  name: string;
  ios_version: string;
  connection_type: 'usb' | 'wifi';
}

interface BackupProgress {
  phase: 'negotiating' | 'backing_up' | 'finalizing';
  percent: number;
  files_done: number;
  files_total: number;
}

type BackupStatus = 'idle' | 'running' | 'success' | 'error';

const PHASE_LABELS: Record<BackupProgress['phase'], string> = {
  negotiating: 'Negotiating with device...',
  backing_up: 'Backing up files...',
  finalizing: 'Finalizing backup...',
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

  const canStart = selectedDevice !== null && outputDir !== '' && (!useEncryption || password !== '') && status === 'idle';

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeftIcon size={18} />
        </button>
        <div>
          <h2 className="text-sm font-medium text-gray-900">Create Backup</h2>
          <p className="text-xs text-gray-400">Back up a connected iPhone or iPad</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-xl">
          {/* Step 1: Device selection */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-900">1. Select device</h3>
              <button onClick={loadDevices} disabled={loadingDevices} className="text-xs text-emerald-600 hover:text-emerald-700 disabled:opacity-50">
                {loadingDevices ? 'Scanning...' : 'Refresh'}
              </button>
            </div>

            {deviceError && (
              <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-600">{deviceError}</div>
            )}

            {loadingDevices && devices.length === 0 && (
              <div className="py-4 text-sm text-gray-400 flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-gray-300 border-t-emerald-500 rounded-full animate-spin" />
                Scanning for devices...
              </div>
            )}

            {!loadingDevices && devices.length === 0 && !deviceError && (
              <div className="py-6 text-center">
                <PhoneIcon className="mx-auto text-gray-300 mb-2" size={28} />
                <p className="text-sm text-gray-500">No devices found.</p>
                <p className="text-xs text-gray-400 mt-1">Connect your iPhone via USB and unlock it, then tap Refresh.</p>
              </div>
            )}

            <div className="space-y-2">
              {devices.map((device) => (
                <button
                  key={device.udid}
                  onClick={() => setSelectedDevice(device)}
                  disabled={status === 'running'}
                  className={`w-full text-left p-3.5 rounded-lg border transition-colors disabled:opacity-50 ${
                    selectedDevice?.udid === device.udid
                      ? 'border-emerald-400 bg-emerald-50/50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <PhoneIcon className="text-emerald-500 flex-shrink-0" size={18} />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{device.name}</div>
                      <div className="text-xs text-gray-400">
                        iOS {device.ios_version} · {device.connection_type === 'usb' ? 'USB' : 'Wi-Fi'}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Step 2: Output directory */}
          <section className="mb-6">
            <h3 className="text-sm font-medium text-gray-900 mb-2">2. Backup destination</h3>
            <div className="flex gap-2">
              <div className="flex-1 px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-700 truncate">
                {outputDir || <span className="text-gray-400">No folder selected</span>}
              </div>
              <button
                onClick={handleChooseDir}
                disabled={status === 'running'}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-sm hover:border-gray-300 transition-colors disabled:opacity-50"
              >
                <FolderIcon size={14} />
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
                className="w-4 h-4 rounded accent-emerald-500"
              />
              <span className="text-sm text-gray-700">Encrypt backup</span>
              <LockIcon className="text-gray-400" size={13} />
            </label>
            <p className="text-xs text-gray-400 mt-1 ml-6">
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
                  className="w-full px-3 py-2 bg-white text-sm rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400"
                />
                <button
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            )}
          </section>

          {/* Progress */}
          {status === 'running' && progress && (
            <div className="mb-6 p-4 rounded-lg bg-emerald-50/50 border border-emerald-200">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-4 h-4 border-2 border-emerald-300 border-t-emerald-600 rounded-full animate-spin flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{PHASE_LABELS[progress.phase]}</p>
                  {progress.files_total > 0 && (
                    <p className="text-xs text-gray-500">{progress.files_done.toLocaleString()} / {progress.files_total.toLocaleString()} files</p>
                  )}
                </div>
                <span className="text-sm font-medium text-emerald-600">{progress.percent}%</span>
              </div>
              <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${Math.max(2, progress.percent)}%` }} />
              </div>
              <p className="text-xs text-gray-400 mt-2">Keep your device connected and unlocked.</p>
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
                <div className="p-4 rounded-lg bg-emerald-50/50 border border-emerald-200">
                  <div className="flex items-center gap-2 mb-2">
                    <LockIcon className="text-emerald-500" size={14} />
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
                      className="flex-1 px-3 py-2 text-sm rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 disabled:opacity-50"
                    />
                    <button
                      onClick={handleSubmitOpenPassword}
                      disabled={!openPassword || openingBackup}
                      className="px-4 py-2 bg-emerald-500 text-white rounded-md text-sm font-medium hover:bg-emerald-600 disabled:opacity-40 transition-colors"
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
                   backupError?.startsWith('PASSCODE_REQUIRED:') ? 'Passcode required' : 'Backup failed'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {backupError?.replace(/^(TRUST_REQUIRED|PASSCODE_REQUIRED): /, '')}
                </p>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3">
            {status === 'idle' && (
              <button
                onClick={handleStartBackup}
                disabled={!canStart}
                className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-400 text-white rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                Start Backup
              </button>
            )}
            {status === 'running' && (
              <button disabled className="px-5 py-2.5 bg-emerald-500 text-white rounded-lg text-sm font-medium opacity-60 cursor-not-allowed">
                Backing up...
              </button>
            )}
            {(status === 'success' || status === 'error') && (
              <button onClick={handleReset} className="px-5 py-2.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 transition-colors">
                {status === 'error' ? 'Retry' : 'Back Up Again'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
