import { useState, useCallback } from 'react';
import { sidecarCall } from '../lib/ipc';

export interface BackupInfo {
  udid: string;
  device_name: string;
  product_type: string;
  product_version: string;
  last_backup: string;
  encrypted: boolean;
  size_gb: number;
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
      setError(e.message);
      return 'error';
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
