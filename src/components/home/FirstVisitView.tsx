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
    <div className="h-screen flex flex-col bg-surface">
      <AppHeader showSettings={false} />

      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <h1 className="text-2xl font-semibold text-text-primary mb-1 text-center">
          Your iPhone data, unlocked.
        </h1>
        <p className="text-sm text-text-tertiary mb-8 text-center">
          Free. Private. Yours.
        </p>

        {/* Primary CTA */}
        <button
          onClick={() => { onFirstAction(); onGetMyData(); }}
          className="w-full max-w-sm bg-teal-600 hover:bg-teal-700 text-white rounded-xl px-6 py-4 flex items-center gap-4 mb-3 transition-colors text-left shadow-sm"
        >
          <div className="w-9 h-9 rounded-lg bg-teal-500 flex items-center justify-center flex-shrink-0">
            <PhoneIcon className="text-white" size={20} />
          </div>
          <div className="flex-1">
            <div className="text-base font-medium">Get my data</div>
            <div className="text-xs text-teal-200">Explore your iPhone</div>
          </div>
          <ChevronRightIcon className="text-teal-300 flex-shrink-0" size={20} />
        </button>

        {/* Secondary CTA */}
        <button
          onClick={() => { onFirstAction(); onBrowseForBackup(); }}
          className="w-full max-w-sm bg-base hover:bg-surface rounded-xl px-6 py-4 flex items-center gap-4 mb-8 transition-colors text-left border border-border-default shadow-sm"
        >
          <div className="w-9 h-9 rounded-lg bg-elevated flex items-center justify-center flex-shrink-0">
            <SearchIcon className="text-text-secondary" size={20} />
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-text-secondary">Explore my Data</div>
            <div className="text-xs text-text-tertiary">Open an existing backup folder</div>
          </div>
          <ChevronRightIcon className="text-text-tertiary flex-shrink-0" size={20} />
        </button>

        {/* Value props */}
        <div className="flex items-start gap-8 max-w-sm w-full mb-4">
          <div className="flex-1 text-center">
            <div className="text-xs font-semibold text-text-secondary mb-0.5">Search everything</div>
            <div className="text-[11px] text-text-tertiary leading-snug">
              Messages, contacts, notes, photos — all in one place
            </div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-xs font-semibold text-text-secondary mb-0.5">See the big picture</div>
            <div className="text-[11px] text-text-tertiary leading-snug">
              Timelines, statistics, and patterns across your history
            </div>
          </div>
          <div className="flex-1 text-center">
            <div className="text-xs font-semibold text-text-secondary mb-0.5">Export anything</div>
            <div className="text-[11px] text-text-tertiary leading-snug">
              PDF reports, spreadsheets, images — your data, your format
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-border-default bg-base">
        <PrivacyFooter variant="minimal" />
      </div>
    </div>
  );
}
