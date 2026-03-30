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

  const listBackups = useCallback(async (customPath?: string, skipSizes = false): Promise<BackupInfo[]> => {
    setLoading(true);
    setError(null);
    try {
      const result = await sidecarCall<{ backups: BackupInfo[] }>('list_backups', {
        path: customPath,
      });
      setBackups(result.backups);
      if (!skipSizes) {
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
      }
      return result.backups;
    } catch (e: any) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const openBackup = useCallback(async (udid: string, password?: string, backupDir?: string): Promise<{ status: string; info?: BackupInfo }> => {
    setLoading(true);
    setError(null);
    try {
      const result = await sidecarCall<{ status: string; info: BackupInfo }>(
        'open_backup',
        { udid, password, backup_dir: backupDir }
      );
      if (result.status === 'password_required') {
        return { status: 'password_required' };
      }
      setActiveBackup(result.info);

      // Record session
      window.openextract.addSession({
        id: result.info.udid,
        type: 'device',
        name: result.info.device_name,
        subtitle: `Last opened ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · iOS ${result.info.product_version}`,
        exportCount: 0,
        lastOpened: new Date().toISOString(),
        sizeGB: result.info.size_gb ?? 0,
        iosVersion: result.info.product_version,
        backupDir: result.info.backup_dir,
      });

      return { status: 'open', info: result.info };
    } catch (e: any) {
      const msg = e.message || 'Unknown error';
      setError(msg);
      return { status: `error:${msg}` };
    } finally {
      setLoading(false);
    }
  }, []);

  const validatePassword = useCallback(async (udid: string, password: string, backupDir?: string) => {
    try {
      const result = await sidecarCall<{ valid: boolean; error?: string }>(
        'validate_password',
        { udid, password, backup_dir: backupDir }
      );
      return result;
    } catch {
      return { valid: false, error: 'Validation failed' };
    }
  }, []);

  return {
    backups,
    activeBackup,
    loading,
    error,
    listBackups,
    openBackup,
    validatePassword,
    setActiveBackup,
  };
}
