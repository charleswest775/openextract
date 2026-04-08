import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import { DownloadIcon, FolderIcon, ChevronRightIcon, LinesIcon, GridIcon, ClockIcon, PlayIcon } from '../shared/Icons';

interface Props {
  onGetMyData: () => void;
  onBrowseForBackup: () => void;
}

export default function ReturnedView({ onGetMyData, onBrowseForBackup }: Props) {
  return (
    <div className="h-screen flex flex-col bg-base">
      <AppHeader />

      <div className="flex-1 overflow-y-auto px-7 py-8">
        {/* Hero */}
        <div className="mb-7">
          <h1 className="text-xl font-medium text-text-primary mb-2">
            Welcome back. Ready to get your data?
          </h1>
          <p className="text-sm text-text-secondary max-w-lg leading-relaxed">
            Once your iPhone is backed up, you'll be able to search every message, browse every
            photo, and explore your entire digital history — all privately on your machine.
          </p>
        </div>

        {/* Primary action card */}
        <button
          onClick={onGetMyData}
          className="w-full bg-surface rounded-xl p-5 flex items-center gap-4 mb-5 border border-transparent hover:border-border-strong transition-colors text-left"
        >
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-400 flex items-center justify-center flex-shrink-0">
            <DownloadIcon className="text-white" size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium text-text-primary">Get my data</div>
            <div className="text-sm text-text-secondary">Connect your iPhone to start — takes about 30 minutes</div>
          </div>
          <ChevronRightIcon className="text-text-tertiary flex-shrink-0" size={20} />
        </button>

        {/* Secondary action — already have a backup */}
        <button
          onClick={onBrowseForBackup}
          className="w-full bg-base border border-border-default rounded-xl p-4 flex items-center gap-3 mb-7 hover:border-border-strong transition-colors text-left"
        >
          <div className="w-8 h-8 rounded-md bg-elevated flex items-center justify-center flex-shrink-0">
            <FolderIcon className="text-text-secondary" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">Already have a backup?</div>
            <div className="text-xs text-text-secondary">Point to an iTunes or Finder backup on your computer</div>
          </div>
        </button>

        {/* What you'll unlock grid */}
        <div className="mb-7">
          <div className="text-xs font-medium text-text-tertiary uppercase tracking-wide mb-3">
            What you'll unlock
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="flex items-center gap-2.5 p-2.5 bg-surface rounded-md">
              <LinesIcon className="text-blue-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-text-primary">Every message</div>
                <div className="text-xs text-text-tertiary">Including deleted texts</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-surface rounded-md">
              <GridIcon className="text-green-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-text-primary">All your photos</div>
                <div className="text-xs text-text-tertiary">With location and metadata</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-surface rounded-md">
              <ClockIcon className="text-amber-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-text-primary">Your timeline</div>
                <div className="text-xs text-text-tertiary">Activity across apps and dates</div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 p-2.5 bg-surface rounded-md">
              <PlayIcon className="text-red-500 flex-shrink-0" size={16} />
              <div>
                <div className="text-sm font-medium text-text-primary">Export anything</div>
                <div className="text-xs text-text-tertiary">PDF, CSV, images — your format</div>
              </div>
            </div>
          </div>
        </div>

        <PrivacyFooter variant="compact" />
      </div>
    </div>
  );
}
