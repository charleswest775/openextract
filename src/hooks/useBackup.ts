import { useState, useCallback } from 'react';
import { sidecarCall } from '../lib/ipc';

export interface BackupInfo {
  udid: string;
  device_name: string;
  product_type: string;
  product_version: string;
  last_backup: string;
  encrypted: boolean;
  size_gb: number | null;
  backup_dir: string;
}

export function useBackup() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [activeBackup, setActiveBackup] = useState<BackupInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listBackups = useCallback(async (customPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sidecarCall<{ backups: BackupInfo[] }>('list_backups', {
        path: customPath,
      });
      setBackups(result.backups);
      // Fetch sizes in the background — non-blocking, updates each card as it resolves
      for (const backup of result.backups) {
        sidecarCall<{ size_bytes: number; size_gb: number }>('get_backup_size', {
          backup_dir: backup.backup_dir,
        }).then(sizes => {
          setBackups(prev =>
            prev.map(b =>
              b.backup_dir === backup.backup_dir ? { ...b, ...sizes } : b
            )
          );
        }).catch(() => {});
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const openBackup = useCallback(async (udid: string, password?: string, backupDir?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await sidecarCall<{ status: string; info: BackupInfo }>(
        'open_backup',
        { udid, password, backup_dir: backupDir }
      );
      if (result.status === 'password_required') {
        return 'password_required';
      }
      setActiveBackup(result.info);
      return 'open';
    } catch (e: any) {
      const msg = e.message || 'Unknown error';
      setError(msg);
      console.error('[openBackup] failed:', msg, '| udid:', udid, '| dir:', backupDir);
      return `error:${msg}`;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    backups,
    activeBackup,
    loading,
    error,
    listBackups,
    openBackup,
    setActiveBackup,
  };
}
