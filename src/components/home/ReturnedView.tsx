import AppHeader from '../shared/AppHeader';
import PrivacyFooter from '../shared/PrivacyFooter';
import { LinesIcon, CameraIcon, ClockIcon, ExportIcon } from '../shared/Icons';
import HomeActionCards from './HomeActions';

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
        <p className="text-base text-text-secondary mb-8 max-w-lg leading-relaxed">
          Once your iPhone is backed up, we'll gently pull out every message, photo, and voicemail —
          all privately on this machine.
        </p>

        <HomeActionCards onBackUp={onGetMyData} onOpenFolder={onBrowseForBackup} wide />
        <div className="h-8" />

        {/* What you'll unlock */}
        <div className="mb-7">
          <div className="hearth-eyebrow mb-3">What you'll unlock</div>
          <div className="grid grid-cols-2 gap-2.5">
            {[
              { I: LinesIcon, title: 'Every message', sub: 'Including deleted texts' },
              { I: CameraIcon, title: 'All your photos', sub: 'With location and metadata' },
              { I: ClockIcon, title: 'Your timeline', sub: 'Activity across apps and dates' },
              { I: ExportIcon, title: 'Save anything', sub: 'PDF, spreadsheets, original files' },
            ].map(({ I, title, sub }) => (
              <div key={title} className="flex items-center gap-3 p-4 hearth-card">
                <I className="text-accent flex-shrink-0" size={24} />
                <div>
                  <div className="text-sm font-medium text-text-primary">{title}</div>
                  <div className="text-xs text-text-secondary">{sub}</div>
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
