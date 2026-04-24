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

      <div className="flex-1 overflow-y-auto px-7 py-8 max-w-2xl mx-auto w-full">
        <div className="hearth-eyebrow mb-2">Welcome back</div>
        <h1 className="text-4xl text-text-primary mb-3">
          Ready to <span className="font-serif-italic text-accent">get your data</span>?
        </h1>
        <p className="text-sm text-text-secondary mb-8 max-w-lg leading-relaxed">
          Once your iPhone is backed up, we'll gently pull out every message, photo, and voicemail —
          all privately on this machine.
        </p>

        {/* Primary action card — terracotta */}
        <button
          onClick={onGetMyData}
          className="w-full text-white rounded-2xl p-5 flex items-center gap-4 mb-3 text-left"
          style={{
            background: 'var(--accent)',
            boxShadow: '0 10px 28px rgba(217,119,87,0.25)',
          }}
        >
          <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
            <DownloadIcon className="text-white" size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium">Get my data</div>
            <div className="text-xs text-white/75">Connect your iPhone to start — takes about 30 minutes</div>
          </div>
          <ChevronRightIcon className="text-white/75 flex-shrink-0" size={20} />
        </button>

        {/* Secondary action — sand card */}
        <button
          onClick={onBrowseForBackup}
          className="w-full hearth-card p-4 flex items-center gap-3 mb-8 hover:bg-[var(--bg-elevated)] text-left transition-colors"
        >
          <div className="w-9 h-9 rounded-lg bg-sand flex items-center justify-center flex-shrink-0">
            <FolderIcon className="text-text-secondary" size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">Already have a backup?</div>
            <div className="text-xs text-text-secondary">Point to an iTunes or Finder backup on your computer</div>
          </div>
        </button>

        {/* What you'll unlock */}
        <div className="mb-7">
          <div className="hearth-eyebrow mb-3">What you'll unlock</div>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { I: LinesIcon, title: 'Every message', sub: 'Including deleted texts' },
              { I: GridIcon, title: 'All your photos', sub: 'With location and metadata' },
              { I: ClockIcon, title: 'Your timeline', sub: 'Activity across apps and dates' },
              { I: PlayIcon, title: 'Export anything', sub: 'PDF, CSV, images — your format' },
            ].map(({ I, title, sub }) => (
              <div key={title} className="flex items-center gap-2.5 p-3 hearth-card">
                <I className="text-accent flex-shrink-0" size={16} />
                <div>
                  <div className="text-sm font-medium text-text-primary">{title}</div>
                  <div className="text-xs text-text-tertiary">{sub}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <PrivacyFooter variant="compact" />
      </div>
    </div>
  );
}
