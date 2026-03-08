import { useEffect, useState } from 'react';
import { selectFolder } from '../lib/ipc';
import { formatDateTime } from '../lib/dates';
import { BackupInfo } from '../hooks/useBackup';

interface Props {
  backups: BackupInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: (path?: string) => Promise<void>;
  onOpen: (udid: string, password?: string, backupDir?: string) => Promise<string>;
}

export default function BackupSelector({ backups, loading, error, onRefresh, onOpen }: Props) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pendingBackup, setPendingBackup] = useState<BackupInfo | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    onRefresh();
  }, []);

  const handleOpen = async (backup: BackupInfo) => {
    setOpenError(null);
    if (backup.encrypted) {
      setPendingBackup(backup);
    } else {
      const status = await onOpen(backup.udid, undefined, backup.backup_dir);
      if (status === 'error') {
        setOpenError('Failed to open backup');
      }
    }
  };

  const handlePasswordSubmit = async () => {
    if (!pendingBackup || !password) return;
    setOpenError(null);
    const status = await onOpen(pendingBackup.udid, password, pendingBackup.backup_dir);
    if (status === 'error') {
      setOpenError('Incorrect password or corrupted backup');
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
    <div className="flex items-center justify-center h-full p-8">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">📱</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">
            Welcome to OpenExtract
          </h2>
          <p className="text-gray-600">
            Select an iPhone backup to browse your messages, photos, voicemails, and more.
          </p>
        </div>

        {/* Error display */}
        {(error || openError) && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error || openError}
          </div>
        )}

        {/* Password prompt modal */}
        {pendingBackup && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm font-medium text-blue-800 mb-3">
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <button
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-700"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <button
                onClick={handlePasswordSubmit}
                disabled={!password || loading}
                className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? 'Decrypting...' : 'Unlock'}
              </button>
              <button
                onClick={() => { setPendingBackup(null); setPassword(''); }}
                className="px-3 py-2 text-gray-600 text-sm hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              This is the password you set when enabling encrypted backups in iTunes/Finder.
            </p>
          </div>
        )}

        {/* Backup list */}
        <div className="space-y-3">
          {loading && backups.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              Searching for backups...
            </div>
          )}

          {!loading && backups.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <p className="mb-2">No backups found in default locations.</p>
              <p className="text-sm">Try browsing to a backup folder manually.</p>
            </div>
          )}

          {backups.map((backup) => (
            <button
              key={backup.udid}
              onClick={() => handleOpen(backup)}
              disabled={loading}
              className="w-full text-left p-4 bg-white border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-sm transition-all disabled:opacity-50"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium text-gray-900">
                    {backup.device_name}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    iOS {backup.product_version} · {backup.product_type}
                  </div>
                  <div className="text-sm text-gray-500">
                    Last backup: {formatDateTime(backup.last_backup)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500">
                    {backup.size_gb} GB
                  </div>
                  {backup.encrypted && (
                    <span className="inline-block mt-1 text-xs px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full">
                      🔒 Encrypted
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
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            Browse for backup folder...
          </button>
        </div>
      </div>
    </div>
  );
}
