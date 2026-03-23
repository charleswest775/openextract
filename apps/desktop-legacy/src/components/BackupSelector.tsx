import { useEffect, useState } from 'react';
import { Smartphone, Lock, Loader2, FolderOpen, PlusCircle } from 'lucide-react';
import { selectFolder } from '../lib/ipc';
import { formatDateTime } from '../lib/dates';
import { BackupInfo } from '../hooks/useBackup';

interface Props {
  backups: BackupInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: (path?: string) => Promise<void>;
  onOpen: (udid: string, password?: string, backupDir?: string) => Promise<string>;
  onValidatePassword: (udid: string, password: string, backupDir?: string) => Promise<{ valid: boolean; error?: string }>;
  onCreateBackup: () => void;
}

export default function BackupSelector({ backups, loading, error, onRefresh, onOpen, onValidatePassword, onCreateBackup }: Props) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pendingBackup, setPendingBackup] = useState<BackupInfo | null>(null);
  const [pendingBackupDir, setPendingBackupDir] = useState<string | undefined>(undefined);
  const [openError, setOpenError] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    onRefresh();
  }, []);

  const handleOpen = async (backup: BackupInfo) => {
    setOpenError(null);
    if (backup.encrypted) {
      setPendingBackup(backup);
      setPendingBackupDir(backup.backup_dir);
    } else {
      const status = await onOpen(backup.udid, undefined, backup.backup_dir);
      if (status.startsWith('error:')) {
        setOpenError(status.slice(6) || 'Failed to open backup');
      }
    }
  };

  const handlePasswordSubmit = async () => {
    if (!pendingBackup || !password) return;
    setOpenError(null);

    // Fast password check before showing progress UI
    setValidating(true);
    const validation = await onValidatePassword(pendingBackup.udid, password, pendingBackupDir);
    setValidating(false);
    if (!validation.valid) {
      setOpenError('Incorrect password.');
      return;
    }

    // Password confirmed — now show decrypting progress and open
    setDecrypting(true);
    const status = await onOpen(pendingBackup.udid, password, pendingBackupDir);
    setDecrypting(false);
    if (status.startsWith('error:')) {
      setOpenError(status.slice(6) || 'Failed to open backup');
    } else if (status === 'open') {
      setPendingBackup(null);
      setPassword('');
    }
  };

  const handleBrowse = async () => {
    const folder = await selectFolder();
    if (folder) {
      await onRefresh(folder);
    }
  };

  return (
    <div className="flex items-center justify-center h-full p-8 bg-base">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <Smartphone size={40} strokeWidth={1.5} className="mx-auto mb-4 text-text-accent" />
          <h2 className="text-title font-display font-semibold text-text-primary mb-2">
            Welcome to OpenExtract
          </h2>
          <p className="text-body text-text-secondary">
            Select an iPhone backup to browse your messages, photos, voicemails, and more.
          </p>
          <button
            onClick={onCreateBackup}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-body font-medium transition-colors duration-200"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            <PlusCircle size={16} strokeWidth={2} />
            Create New Backup from iPhone
          </button>
        </div>

        {/* Error display */}
        {(error || openError) && (
          <div className="mb-4 p-3 rounded-lg text-body" style={{ background: 'rgba(255,59,48,0.08)', border: '0.5px solid rgba(255,59,48,0.2)', color: 'var(--error)' }}>
            {error || openError}
          </div>
        )}

        {/* Decryption progress panel */}
        {decrypting && pendingBackup && (
          <div className="mb-6 p-6 bg-accent-subtle rounded-lg" style={{ border: '0.5px solid var(--border-default)' }}>
            <div className="flex items-center gap-3 mb-4">
              <Loader2 size={20} strokeWidth={2} className="animate-spin text-text-accent flex-shrink-0" />
              <div>
                <p className="text-body font-semibold text-text-primary">Decrypting backup…</p>
                <p className="text-caption text-text-secondary mt-0.5">{pendingBackup.device_name}</p>
              </div>
            </div>

            {/* Indeterminate progress bar */}
            <div className="w-full h-1.5 bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full"
                style={{
                  width: '40%',
                  animation: 'decryptSlide 1.6s ease-in-out infinite',
                }}
              />
            </div>

            <p className="text-caption text-text-secondary mt-3">
              Decrypting and indexing backup files — this takes 15–30 seconds the first time and will be instant afterwards.
            </p>

            <style>{`
              @keyframes decryptSlide {
                0%   { transform: translateX(-100%); }
                50%  { transform: translateX(150%); }
                100% { transform: translateX(150%); }
              }
            `}</style>
          </div>
        )}

        {/* Password prompt */}
        {pendingBackup && !decrypting && (
          <div className="mb-6 p-4 bg-accent-subtle rounded-lg" style={{ border: '0.5px solid var(--border-default)' }}>
            {validating ? (
              <div className="flex items-center gap-3">
                <Loader2 size={20} strokeWidth={2} className="animate-spin text-text-accent flex-shrink-0" />
                <p className="text-body font-medium text-text-primary">Checking encryption…</p>
              </div>
            ) : (
              <>
                <p className="text-body font-medium text-text-primary mb-3">
                  This backup is encrypted. Enter your backup password:
                </p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                      placeholder="Backup password"
                      className="w-full px-3 py-2 bg-base text-body text-text-primary rounded-md focus:outline-none focus:ring-2 focus:shadow-focus"
                      style={{ border: '0.5px solid var(--border-strong)' }}
                      autoFocus
                    />
                    <button
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-caption text-text-tertiary hover:text-text-secondary transition-colors"
                    >
                      {showPassword ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <button
                    onClick={handlePasswordSubmit}
                    disabled={!password || loading}
                    className="px-4 py-2 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors"
                  >
                    Unlock
                  </button>
                  <button
                    onClick={() => { setPendingBackup(null); setPassword(''); setPendingBackupDir(undefined); }}
                    className="px-3 py-2 text-text-secondary text-body hover:text-text-primary transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
            <p className="text-caption text-text-tertiary mt-2">
              This is the password you set when enabling encrypted backups in iTunes/Finder.
            </p>
          </div>
        )}

        {/* Backup list */}
        <div className="space-y-3">
          {loading && backups.length === 0 && (
            <div className="flex flex-col items-center py-8 text-text-tertiary">
              <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-2" />
              <span className="text-body">Searching for backups...</span>
            </div>
          )}

          {!loading && backups.length === 0 && (
            <div className="text-center py-8 text-text-tertiary">
              <p className="text-body mb-1">No backups found in default locations.</p>
              <p className="text-caption">Try browsing to a backup folder manually.</p>
            </div>
          )}

          {backups.map((backup) => (
            <button
              key={backup.backup_dir || backup.udid}
              onClick={() => handleOpen(backup)}
              disabled={loading}
              className="w-full text-left p-4 bg-surface rounded-lg hover:shadow-card transition-all duration-250 disabled:opacity-50"
              style={{ border: '0.5px solid var(--border-default)' }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--border-strong)'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border-default)'}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-display text-subhead font-semibold text-text-primary">
                    {backup.device_name}
                  </div>
                  <div className="text-caption text-text-secondary mt-1">
                    iOS {backup.product_version} &middot; {backup.product_type}
                  </div>
                  <div className="text-caption text-text-secondary">
                    Last backup: {formatDateTime(backup.last_backup)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-caption text-text-tertiary">
                    {backup.size_gb !== null ? `${backup.size_gb} GB` : '— GB'}
                  </div>
                  {backup.encrypted && (
                    <span
                      className="inline-flex items-center gap-1 mt-1.5 text-caption font-medium px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(255,159,10,0.1)', color: '#c77c00', border: '0.5px solid rgba(255,159,10,0.25)' }}
                    >
                      <Lock size={10} strokeWidth={2} /> Encrypted
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Browse button */}
        <div className="mt-6 text-center">
          <button
            onClick={handleBrowse}
            className="inline-flex items-center gap-1.5 text-body text-text-accent hover:underline transition-colors"
          >
            <FolderOpen size={14} strokeWidth={1.5} />
            Browse for backup folder...
          </button>
        </div>
      </div>
    </div>
  );
}
