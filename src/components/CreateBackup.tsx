import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Smartphone,
  Wifi,
  Usb,
  FolderOpen,
  Lock,
  Loader2,
  RefreshCw,
  CheckCircle,
  XCircle,
  ChevronLeft,
  ShieldAlert,
} from 'lucide-react';
import { saveFolder, sidecarCall } from '../lib/ipc';

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface Props {
  onBack: () => void;
  onBackupComplete?: (udid: string, backupPath: string) => Promise<string | void> | void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<BackupProgress['phase'], string> = {
  negotiating: 'Negotiating with device…',
  backing_up: 'Backing up files…',
  finalizing: 'Finalizing backup…',
};

function ConnectionIcon({ type }: { type: 'usb' | 'wifi' }) {
  return type === 'usb'
    ? <Usb size={12} strokeWidth={1.8} className="inline-block mr-1" />
    : <Wifi size={12} strokeWidth={1.8} className="inline-block mr-1" />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CreateBackup({ onBack, onBackupComplete }: Props) {
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
  const [autoOpenFailed, setAutoOpenFailed] = useState<string | null>(null);

  // Dev-mode only: skip the real backup and immediately trigger the open flow.
  // Only visible when running in the Vite dev server (http:), not in a packaged app.
  const isDev = typeof window !== 'undefined' && window.location.protocol !== 'file:';
  const [skipBackup, setSkipBackup] = useState(false);

  // Cleanup ref for the notification unsubscribe function
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── Device detection ──────────────────────────────────────────────────────

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
    return () => {
      // Unsubscribe from any active progress listener on unmount
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // ── Output directory picker ───────────────────────────────────────────────

  const handleChooseDir = async () => {
    const folder = await saveFolder();
    if (folder) setOutputDir(folder);
  };

  // ── Start backup ──────────────────────────────────────────────────────────

  const handleStartBackup = async () => {
    if (!selectedDevice || !outputDir) return;

    setStatus('running');
    setProgress({ phase: 'negotiating', percent: 0, files_done: 0, files_total: 0 });
    setBackupError(null);
    setBackupPath(null);

    // Subscribe to progress notifications from the sidecar before sending
    // the backup.start RPC call so no events are missed.
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
          ...(skipBackup ? { dry_run: true } : {}),
        },
      );
      setBackupPath(result.backup_path);
      setStatus('success');
      if (onBackupComplete) {
        const openResult = await onBackupComplete(selectedDevice.udid, result.backup_path);
        if (openResult?.startsWith('error:')) {
          setAutoOpenFailed(openResult.slice(6) || 'Failed to open backup');
        }
      }
    } catch (err: any) {
      setBackupError(err.message || 'Backup failed');
      setStatus('error');
    } finally {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setProgress(null);
    setBackupError(null);
    setBackupPath(null);
    setAutoOpenFailed(null);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const canStart =
    selectedDevice !== null &&
    outputDir !== '' &&
    (!useEncryption || password !== '') &&
    status === 'idle';

  return (
    <div className="flex items-start justify-center h-full p-8 bg-base overflow-y-auto">
      <div className="max-w-2xl w-full">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={onBack}
            className="text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Go back"
          >
            <ChevronLeft size={20} strokeWidth={1.8} />
          </button>
          <div>
            <h2 className="text-title font-display font-semibold text-text-primary">
              Create Backup
            </h2>
            <p className="text-caption text-text-secondary mt-0.5">
              Back up a connected iPhone or iPad to your Mac.
            </p>
          </div>
        </div>

        {/* ── Step 1: Device list ── */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-subhead font-semibold text-text-primary">
              1. Select device
            </h3>
            <button
              onClick={loadDevices}
              disabled={loadingDevices}
              className="inline-flex items-center gap-1 text-caption text-text-accent hover:underline disabled:opacity-50"
            >
              <RefreshCw size={12} strokeWidth={2} className={loadingDevices ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          {deviceError && (
            <div
              className="mb-3 p-3 rounded-lg text-caption"
              style={{
                background: 'rgba(255,59,48,0.08)',
                border: '0.5px solid rgba(255,59,48,0.2)',
                color: 'var(--error)',
              }}
            >
              {deviceError}
            </div>
          )}

          {loadingDevices && devices.length === 0 && (
            <div className="flex items-center gap-2 py-4 text-text-tertiary">
              <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
              <span className="text-body">Scanning for devices…</span>
            </div>
          )}

          {!loadingDevices && devices.length === 0 && !deviceError && (
            <div className="py-4 text-center text-text-tertiary">
              <Smartphone size={28} strokeWidth={1.2} className="mx-auto mb-2" />
              <p className="text-body">No devices found.</p>
              <p className="text-caption mt-1">
                Connect your iPhone via USB and unlock it, then tap Refresh.
              </p>
            </div>
          )}

          <div className="space-y-2">
            {devices.map((device) => (
              <button
                key={device.udid}
                onClick={() => setSelectedDevice(device)}
                disabled={status === 'running'}
                className="w-full text-left p-4 rounded-lg transition-all duration-200 disabled:opacity-50"
                style={{
                  background: selectedDevice?.udid === device.udid
                    ? 'var(--accent-subtle)'
                    : 'var(--surface)',
                  border: selectedDevice?.udid === device.udid
                    ? '1.5px solid var(--accent)'
                    : '0.5px solid var(--border-default)',
                }}
              >
                <div className="flex items-center gap-3">
                  <Smartphone size={20} strokeWidth={1.5} className="text-text-accent flex-shrink-0" />
                  <div>
                    <div className="text-body font-semibold text-text-primary">
                      {device.name}
                    </div>
                    <div className="text-caption text-text-secondary mt-0.5">
                      iOS {device.ios_version}
                      &ensp;·&ensp;
                      <ConnectionIcon type={device.connection_type} />
                      {device.connection_type === 'usb' ? 'USB' : 'Wi-Fi'}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* ── Step 2: Output directory ── */}
        <section className="mb-6">
          <h3 className="text-subhead font-semibold text-text-primary mb-2">
            2. Backup destination
          </h3>
          <div className="flex gap-2">
            <div
              className="flex-1 px-3 py-2 rounded-lg text-body text-text-primary truncate"
              style={{ background: 'var(--surface)', border: '0.5px solid var(--border-default)' }}
            >
              {outputDir || <span className="text-text-tertiary">No folder selected</span>}
            </div>
            <button
              onClick={handleChooseDir}
              disabled={status === 'running'}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface rounded-lg text-body text-text-primary hover:shadow-card transition-all disabled:opacity-50"
              style={{ border: '0.5px solid var(--border-default)' }}
            >
              <FolderOpen size={15} strokeWidth={1.8} />
              Choose…
            </button>
          </div>
        </section>

        {/* ── Step 3: Encryption options ── */}
        <section className="mb-6">
          <h3 className="text-subhead font-semibold text-text-primary mb-2">
            3. Encryption
          </h3>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={useEncryption}
              onChange={(e) => setUseEncryption(e.target.checked)}
              disabled={status === 'running'}
              className="w-4 h-4 rounded accent-[var(--accent)]"
            />
            <span className="text-body text-text-primary">
              Encrypt backup
            </span>
            <Lock size={13} strokeWidth={1.8} className="text-text-tertiary" />
          </label>
          <p className="text-caption text-text-tertiary mt-1 ml-6">
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
                className="w-full px-3 py-2 bg-base text-body text-text-primary rounded-md focus:outline-none focus:ring-2 focus:shadow-focus"
                style={{ border: '0.5px solid var(--border-strong)' }}
              />
              <button
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-caption text-text-tertiary hover:text-text-secondary transition-colors"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          )}
        </section>

        {/* ── Progress / status panel ── */}
        {status === 'running' && progress && (
          <div
            className="mb-6 p-5 rounded-lg"
            style={{ background: 'var(--accent-subtle)', border: '0.5px solid var(--border-default)' }}
          >
            <div className="flex items-center gap-3 mb-3">
              <Loader2 size={18} strokeWidth={2} className="animate-spin text-text-accent flex-shrink-0" />
              <div>
                <p className="text-body font-semibold text-text-primary">
                  {PHASE_LABELS[progress.phase]}
                </p>
                {progress.files_total > 0 && (
                  <p className="text-caption text-text-secondary mt-0.5">
                    {progress.files_done.toLocaleString()} / {progress.files_total.toLocaleString()} files
                  </p>
                )}
              </div>
              <span className="ml-auto font-mono text-caption text-text-accent">
                {progress.percent}%
              </span>
            </div>
            {/* Progress bar */}
            <div className="w-full h-1.5 bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-500"
                style={{ width: `${Math.max(2, progress.percent)}%` }}
              />
            </div>
            <p className="text-caption text-text-tertiary mt-3">
              Keep your device connected and unlocked until the backup finishes.
            </p>
          </div>
        )}

        {status === 'success' && (
          <div
            className="mb-6 p-4 rounded-lg flex items-start gap-3"
            style={{
              background: 'rgba(52,199,89,0.08)',
              border: '0.5px solid rgba(52,199,89,0.25)',
            }}
          >
            <CheckCircle size={18} strokeWidth={1.8} className="text-green-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-body font-semibold text-text-primary">Backup complete!</p>
              <p className="text-caption text-text-secondary mt-0.5 break-all">{backupPath}</p>
              {autoOpenFailed && (
                <div className="mt-2">
                  <p className="text-caption font-medium" style={{ color: 'var(--error)' }}>
                    Could not open backup automatically:
                  </p>
                  <p className="text-caption text-text-secondary mt-0.5 break-all">
                    {autoOpenFailed}
                  </p>
                  <button
                    onClick={onBack}
                    className="mt-2 text-caption text-text-accent hover:underline"
                  >
                    Browse backup manually →
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {status === 'error' && (() => {
          const isTrust = backupError?.startsWith('TRUST_REQUIRED:');
          const msg = isTrust
            ? backupError!.replace('TRUST_REQUIRED: ', '')
            : backupError;
          return isTrust ? (
            <div
              className="mb-6 p-4 rounded-lg flex items-start gap-3"
              style={{
                background: 'rgba(255,179,0,0.08)',
                border: '0.5px solid rgba(255,179,0,0.35)',
              }}
            >
              <ShieldAlert size={18} strokeWidth={1.8} className="flex-shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
              <div>
                <p className="text-body font-semibold text-text-primary">Trust required</p>
                <p className="text-caption text-text-secondary mt-0.5">{msg}</p>
              </div>
            </div>
          ) : (
            <div
              className="mb-6 p-4 rounded-lg flex items-start gap-3"
              style={{
                background: 'rgba(255,59,48,0.08)',
                border: '0.5px solid rgba(255,59,48,0.2)',
              }}
            >
              <XCircle size={18} strokeWidth={1.8} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--error)' }} />
              <div>
                <p className="text-body font-semibold text-text-primary">Backup failed</p>
                <p className="text-caption text-text-secondary mt-0.5">{msg}</p>
              </div>
            </div>
          );
        })()}

        {/* ── Dev: skip backup toggle ── */}
        {isDev && (
          <div className="mb-4 flex items-center gap-2 opacity-60">
            <input
              type="checkbox"
              id="skip-backup"
              checked={skipBackup}
              onChange={(e) => setSkipBackup(e.target.checked)}
              disabled={status === 'running'}
              className="w-3.5 h-3.5 accent-[var(--accent)]"
            />
            <label htmlFor="skip-backup" className="text-caption text-text-tertiary cursor-pointer select-none">
              Dev: skip backup (test open flow only)
            </label>
          </div>
        )}

        {/* ── Action buttons ── */}
        <div className="flex gap-3">
          {status === 'idle' && (
            <button
              onClick={handleStartBackup}
              disabled={!canStart}
              className="px-5 py-2.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-40 transition-colors"
            >
              Start Backup
            </button>
          )}

          {status === 'running' && (
            <button
              disabled
              className="px-5 py-2.5 bg-accent text-white rounded-lg text-body font-medium opacity-60 cursor-not-allowed"
            >
              Backing up…
            </button>
          )}

          {status === 'success' && (
            <button
              onClick={handleReset}
              className="px-5 py-2.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover transition-colors"
            >
              Back Up Again
            </button>
          )}

          {status === 'error' && (
            <button
              onClick={handleReset}
              className="px-5 py-2.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover transition-colors"
            >
              {backupError?.startsWith('TRUST_REQUIRED:') ? 'Retry' : 'Back Up Again'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
