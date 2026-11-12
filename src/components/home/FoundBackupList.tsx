import type { BackupInfo } from '../../hooks/useBackup';
import { formatDate } from '../../lib/dates';
import { whenLine } from '../../lib/foundBackups';
import UnfinishedLabel from '../shared/UnfinishedLabel';
import { ChevronRightIcon, LockIcon, PhoneIcon, SearchIcon } from '../shared/Icons';

interface Props {
  title: string;
  backups: BackupInfo[];
  onOpen: (backup: BackupInfo) => void;
  /** A usual backup folder macOS wouldn't let OpenExtract read, to ask for Full Disk Access. */
  blockedFolder?: string;
  onAllowAccess: () => void;
  /** Why looking for backups failed, in plain words; shown with a Look again button. */
  lookFailed?: string;
  onLookAgain: () => void;
  /** True while looking again. */
  looking?: boolean;
}

function subtitle(b: BackupInfo): string {
  return [
    b.product_version && b.product_version !== 'Unknown' && `iOS ${b.product_version}`,
    whenLine(b, formatDate),
    b.encrypted && 'Encrypted',
  ].filter(Boolean).join(' · ');
}

// Backups in the folders Finder, iTunes and Apple Devices use, so most people
// never need the folder picker. The folder path is in the tooltip.
export default function FoundBackupList({
  title, backups, onOpen, blockedFolder, onAllowAccess, lookFailed, onLookAgain, looking,
}: Props) {
  if (backups.length === 0 && !blockedFolder && !lookFailed) return null;

  return (
    <div className="w-full mb-6">
      {backups.length > 0 && <div className="hearth-eyebrow mb-3">{title}</div>}
      <div className="flex flex-col gap-2.5">
        {backups.map((b) => (
          <button
            key={b.backup_dir}
            onClick={() => onOpen(b)}
            title={b.backup_dir}
            className="hearth-card px-5 py-4 flex items-center gap-4 hover:bg-[var(--bg-elevated)] transition-colors text-left w-full"
          >
            <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-accent-wash">
              <PhoneIcon className="text-accent" size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-medium text-text-primary truncate">
                  {b.device_name && b.device_name !== 'Unknown' ? b.device_name : 'iPhone backup'}
                </span>
                {b.unfinished && <UnfinishedLabel />}
              </div>
              <div className="text-sm text-text-secondary leading-snug">{subtitle(b)}</div>
            </div>
            <span className="hearth-ghost-btn flex-shrink-0 pointer-events-none">
              Open
              <ChevronRightIcon size={18} />
            </span>
          </button>
        ))}

        {blockedFolder && (
          <div className="hearth-card px-4 py-3 flex items-center gap-3">
            <LockIcon className="text-text-tertiary flex-shrink-0" size={18} />
            <div className="flex-1 min-w-0 text-sm text-text-secondary leading-snug">
              macOS needs your OK before OpenExtract can list Finder's backups here.
            </div>
            <button onClick={onAllowAccess} className="hearth-ghost-btn flex-shrink-0">
              Allow access
            </button>
          </div>
        )}

        {lookFailed && (
          <div className="hearth-card px-4 py-3 flex items-center gap-3" role="status">
            <SearchIcon className="text-text-tertiary flex-shrink-0" size={18} />
            <div className="flex-1 min-w-0 text-sm text-text-secondary leading-snug">{lookFailed}</div>
            <button onClick={onLookAgain} disabled={looking} className="hearth-ghost-btn flex-shrink-0">
              {looking ? 'Looking…' : 'Look again'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
