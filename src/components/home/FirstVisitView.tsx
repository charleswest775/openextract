import type { ReactNode } from 'react';
import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import HomeActionCards from './HomeActions';

interface Props {
  /** Backups found in the usual folders, if any. */
  found: ReactNode;
  onGetMyData: () => void;
  onBrowseForBackup: () => void;
  onFirstAction: () => void;
}

export default function FirstVisitView({ found, onGetMyData, onBrowseForBackup, onFirstAction }: Props) {
  return (
    <div className="h-screen flex flex-col bg-base">
      <AppHeader showSettings={false} />

      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-8 py-8">
          <div className="hearth-eyebrow mb-3">Welcome</div>
          <h1 className="text-5xl text-text-primary mb-3 text-center" style={{ maxWidth: 560 }}>
            Your iPhone data,<br/>
            <span className="font-serif-italic text-accent">unlocked.</span>
          </h1>
          <p className="text-base text-text-secondary mb-9 text-center max-w-md">
            Free. Private. Yours. Pulled gently from your backup, kept entirely on this computer.
          </p>

          <div className="w-full max-w-md">{found}</div>

          <HomeActionCards
            onBackUp={() => { onFirstAction(); onGetMyData(); }}
            onOpenFolder={() => { onFirstAction(); onBrowseForBackup(); }}
          />
          <div className="h-9" />

          {/* Value props */}
          <div className="flex items-start gap-8 max-w-md w-full mb-4">
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-text-primary mb-1">Search everything</div>
              <div className="text-sm text-text-secondary leading-snug">
                Messages, contacts, notes, photos — all in one place
              </div>
            </div>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-text-primary mb-1">See the big picture</div>
              <div className="text-sm text-text-secondary leading-snug">
                Timelines, statistics, patterns across your history
              </div>
            </div>
            <div className="flex-1 text-center">
              <div className="text-sm font-medium text-text-primary mb-1">Save anything</div>
              <div className="text-sm text-text-secondary leading-snug">
                PDF, spreadsheets, images — your data, your format
              </div>
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
