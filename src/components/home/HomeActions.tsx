import { ChevronRightIcon, FolderIcon, PhoneIcon } from '../shared/Icons';

// The two ways in, named the same on every home screen.
export const BACK_UP_LABEL = 'Back up my iPhone';
export const OPEN_FOLDER_LABEL = 'Open a backup folder';

interface Props {
  onBackUp: () => void;
  onOpenFolder: () => void;
  /** Fill the column instead of a centered 448px stack. */
  wide?: boolean;
}

/** The two large choices on the welcome screens. */
export default function HomeActionCards({ onBackUp, onOpenFolder, wide = false }: Props) {
  return (
    <div className={`w-full ${wide ? '' : 'max-w-md'} flex flex-col gap-3`}>
      <button
        onClick={onBackUp}
        className="w-full text-white rounded-2xl px-6 py-5 flex items-center gap-4 text-left transition-colors bg-accent hover:bg-accent-hover"
        style={{ boxShadow: '0 10px 28px rgba(180,83,47,0.25)' }}
      >
        <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
          <PhoneIcon className="text-white" size={26} />
        </div>
        <div className="flex-1">
          <div className="text-lg font-medium">{BACK_UP_LABEL}</div>
          <div className="text-sm text-white/85">Connect it with a cable. Takes about 30 minutes.</div>
        </div>
        <ChevronRightIcon className="text-white/80" size={22} />
      </button>

      <button
        onClick={onOpenFolder}
        className="w-full hearth-card hover:bg-[var(--bg-elevated)] px-6 py-5 flex items-center gap-4 text-left transition-colors"
      >
        <div className="w-12 h-12 rounded-xl bg-sand flex items-center justify-center flex-shrink-0">
          <FolderIcon className="text-text-secondary" size={26} />
        </div>
        <div className="flex-1">
          <div className="text-lg font-medium text-text-primary">{OPEN_FOLDER_LABEL}</div>
          <div className="text-sm text-text-secondary">Use a backup Finder or iTunes already made</div>
        </div>
        <ChevronRightIcon className="text-text-tertiary" size={22} />
      </button>
    </div>
  );
}
