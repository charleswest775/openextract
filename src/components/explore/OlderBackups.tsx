import { useCallback, useEffect, useState } from 'react';
import { sidecarCall } from '../../lib/ipc';
import { FolderIcon, LockIcon } from '../shared/Icons';

interface OlderBackup {
  backup_dir: string;
  last_backup: string;
  encrypted: boolean;
}

// With the time: two backups are often made the same day.
function madeAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Older backups of this iPhone in the same folder (python/older_backups.py), each with Move to
 * Trash. Nothing shows when there are none. The main process does the asking and the moving
 * (electron/olderBackups.ts).
 */
export default function OlderBackups({ udid }: { udid: string }) {
  const [backups, setBackups] = useState<OlderBackup[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ dir: string; message: string } | null>(null);
  const [moved, setMoved] = useState(false);

  const load = useCallback(async () => {
    try {
      setBackups((await sidecarCall<{ backups: OlderBackup[] }>('backup.list_older', { udid })).backups ?? []);
    } catch (err) {
      console.error("Couldn't look for older backups:", err);
      setBackups([]);
    }
  }, [udid]);

  useEffect(() => {
    setMoved(false);
    setProblem(null);
    load();
  }, [load]);

  const platform = window.openextract?.platform;
  const windows = platform === 'win32';
  const trash = windows ? 'Recycle Bin' : 'Trash';
  // The engine won't move one on Linux (python/trash_room.py), so don't offer to.
  const canMove = platform === 'darwin' || windows;
  const showLabel = windows ? 'Show in File Explorer' : platform === 'darwin' ? 'Show in Finder' : 'Show in folder';

  const move = async (dir: string) => {
    setWorking(dir);
    setProblem(null);
    setMoved(false);
    try {
      const result = await window.openextract.trashOlderBackup(udid, dir);
      if (result.status === 'moved') {
        setMoved(true);
        await load();
      } else if (result.status !== 'cancelled') {
        setProblem({ dir, message: result.message });
      }
    } catch (err) {
      console.error("Couldn't move the older backup:", err);
      setProblem({ dir, message: "OpenExtract couldn't finish checking that backup, so look at it before trying again." });
    } finally {
      setWorking(null);
    }
  };

  if (backups.length === 0 && !moved) return null;

  return (
    <section className="hearth-card p-5" aria-labelledby="older-backups-title" data-older-backups>
      <div className="flex items-center gap-2.5 mb-1">
        <FolderIcon className="text-text-secondary" size={20} />
        <h3 id="older-backups-title" className="text-[16px] font-semibold text-text-primary">Older backups of this iPhone</h3>
      </div>
      {backups.length > 0 && (
        <p className="text-sm text-text-secondary">
          They're in the same folder as this one and each takes up its own space. An older backup can have
          messages and photos this one doesn't, so look before you remove one.
        </p>
      )}
      <ul className="mt-2 divide-y divide-rule">
        {backups.map(b => (
          <li key={b.backup_dir} className="py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex-1 min-w-[16rem]">
                <div className="text-sm font-medium text-text-primary flex items-center gap-1.5">
                  {madeAt(b.last_backup)}
                  {b.encrypted && <LockIcon className="text-text-tertiary" size={16} />}
                </div>
                <div className="text-xs text-text-tertiary break-all">{b.backup_dir}</div>
              </div>
              <button
                onClick={() => window.openextract.showInFolder(b.backup_dir)}
                className="text-sm text-accent font-medium hover:underline"
              >
                {showLabel}
              </button>
              {canMove && (
                <button
                  onClick={() => move(b.backup_dir)}
                  disabled={working !== null}
                  className="hearth-ghost-btn !px-3 !py-1.5 text-sm disabled:opacity-50"
                >
                  {working === b.backup_dir ? 'Checking…' : `Move to ${trash}`}
                </button>
              )}
            </div>
            {problem?.dir === b.backup_dir && (
              <p role="alert" className="mt-2 text-sm text-text-primary">{problem.message}</p>
            )}
          </li>
        ))}
      </ul>
      {moved && (
        <p role="status" className="mt-2 text-sm text-text-secondary">
          Moved to the {trash}. You get the space back when the {trash} is emptied.
        </p>
      )}
    </section>
  );
}
