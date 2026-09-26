import type { BackupInfo } from '../../hooks/useBackup';
import { formatDate } from '../../lib/dates';
import { LockIcon } from './Icons';

interface Props {
  folder: string;
  backups: BackupInfo[];
  onChoose: (backup: BackupInfo) => void;
  onCancel: () => void;
}

export default function BackupChooserDialog({ folder, backups, onChoose, onCancel }: Props) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-base rounded-xl shadow-xl w-[420px] max-h-[80vh] flex flex-col p-6">
        <div className="text-sm font-medium text-text-primary mb-1">Choose a backup</div>
        <p className="text-xs text-text-tertiary mb-4 break-words">
          {backups.length} backups found in {folder}
        </p>

        <div className="flex-1 overflow-y-auto -mx-2">
          {backups.map((b) => (
            <button
              key={b.backup_dir}
              onClick={() => onChoose(b)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-elevated transition-colors flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">{b.device_name || b.udid}</div>
                <div className="text-xs text-text-tertiary truncate">
                  {[b.product_version && `iOS ${b.product_version}`, formatDate(b.last_backup)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {b.encrypted && <LockIcon className="text-text-tertiary flex-shrink-0" size={14} />}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 px-4 py-2.5 text-sm text-text-secondary bg-elevated rounded-lg hover:opacity-80 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
