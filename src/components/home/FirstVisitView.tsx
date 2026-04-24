import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import { PhoneIcon, SearchIcon, ChevronRightIcon } from '../shared/Icons';

interface Props {
  onGetMyData: () => void;
  onBrowseForBackup: () => void;
  onFirstAction: () => void;
}

export default function FirstVisitView({ onGetMyData, onBrowseForBackup, onFirstAction }: Props) {
  return (
    <div className="h-screen flex flex-col bg-base">
      <AppHeader showSettings={false} />

      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="hearth-eyebrow mb-3">Welcome</div>
        <h1 className="text-5xl text-text-primary mb-3 text-center" style={{ maxWidth: 560 }}>
          Your iPhone data,<br/>
          <span className="font-serif-italic text-accent">unlocked.</span>
        </h1>
        <p className="text-sm text-text-secondary mb-9 text-center max-w-sm">
          Free. Private. Yours. Pulled gently from your backup, kept entirely on this computer.
        </p>

        {/* Primary CTA — terracotta */}
        <button
          onClick={() => { onFirstAction(); onGetMyData(); }}
          className="w-full max-w-sm text-white rounded-2xl px-6 py-4 flex items-center gap-4 mb-3 transition-colors text-left"
          style={{
            background: 'var(--accent)',
            boxShadow: '0 10px 28px rgba(217,119,87,0.28)',
          }}
        >
          <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
            <PhoneIcon className="text-white" size={20} />
          </div>
          <div className="flex-1">
            <div className="text-base font-medium">Get my data</div>
            <div className="text-xs text-white/70">Explore your iPhone</div>
          </div>
          <ChevronRightIcon className="text-white/70 flex-shrink-0" size={20} />
        </button>

        {/* Secondary CTA — white card */}
        <button
          onClick={() => { onFirstAction(); onBrowseForBackup(); }}
          className="w-full max-w-sm hearth-card hover:bg-[var(--bg-elevated)] px-6 py-4 flex items-center gap-4 mb-9 transition-colors text-left"
        >
          <div className="w-10 h-10 rounded-xl bg-sand flex items-center justify-center flex-shrink-0">
            <SearchIcon className="text-text-secondary" size={20} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-text-primary">Explore my data</div>
            <div className="text-xs text-text-tertiary">Open an existing backup folder</div>
          </div>
          <ChevronRightIcon className="text-text-tertiary flex-shrink-0" size={20} />
        </button>

        {/* Value props */}
        <div className="flex items-start gap-8 max-w-md w-full mb-4">
          <div className="flex-1 text-center">
            <div className="text-sm font-medium text-text-primary mb-1">Search everything</div>
            <div className="text-[11.5px] text-text-tertiary leading-snug">
              Messages, contacts, notes, photos — all in one place
            </div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-sm font-medium text-text-primary mb-1">See the big picture</div>
            <div className="text-[11.5px] text-text-tertiary leading-snug">
              Timelines, statistics, patterns across your history
            </div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-sm font-medium text-text-primary mb-1">Export anything</div>
            <div className="text-[11.5px] text-text-tertiary leading-snug">
              PDF, spreadsheets, images — your data, your format
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 py-3 border-t border-rule bg-base">
        <PrivacyFooter variant="minimal" />
      </div>
    </div>
  );
}
