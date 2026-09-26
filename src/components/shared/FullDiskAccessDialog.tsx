import { LockIcon } from './Icons';

export const FULL_DISK_ACCESS_PREFIX = 'FULL_DISK_ACCESS_REQUIRED:';

const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

interface Props {
  /** The sidecar's FULL_DISK_ACCESS_REQUIRED error message. */
  message: string;
  onClose: () => void;
}

export default function FullDiskAccessDialog({ message, onClose }: Props) {
  const folder = message.match(/from reading (.+?)\. Open System Settings/)?.[1];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div role="dialog" aria-labelledby="fda-title" className="bg-base rounded-xl shadow-xl w-[420px] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-elevated flex items-center justify-center">
            <LockIcon className="text-text-secondary" size={20} />
          </div>
          <div id="fda-title" className="text-sm font-medium text-text-primary">
            Allow Full Disk Access
          </div>
        </div>

        <p className="text-sm text-text-secondary mb-3">
          macOS keeps iPhone backups in a protected folder, so OpenExtract needs Full Disk Access
          to read them. OpenExtract only reads your backups on this Mac and never sends them anywhere.
        </p>

        {folder && (
          <p className="text-xs text-text-tertiary mb-3 break-words">Blocked folder: {folder}</p>
        )}

        <ol className="text-sm text-text-secondary list-decimal pl-5 space-y-1 mb-5">
          <li>Click <span className="text-text-primary">Open System Settings</span>.</li>
          <li>
            Turn on <span className="text-text-primary">OpenExtract</span>. If it isn't listed,
            click <span className="text-text-primary">+</span> and choose it from Applications.
          </li>
          <li>Come back and click <span className="text-text-primary">Quit &amp; Reopen</span>.</li>
        </ol>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => window.openextract.openExternal(SETTINGS_URL)}
            className="px-4 py-2.5 text-sm text-white bg-accent rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
          >
            Open System Settings
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm text-text-secondary bg-elevated rounded-lg hover:opacity-80 transition-colors"
            >
              Not now
            </button>
            <button
              onClick={() => window.openextract.relaunch()}
              className="flex-1 px-4 py-2.5 text-sm text-text-primary bg-elevated rounded-lg hover:opacity-80 transition-colors"
            >
              Quit &amp; Reopen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
