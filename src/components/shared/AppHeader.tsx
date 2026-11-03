import { useEffect, useState } from 'react';
import SettingsDialog from './SettingsDialog';
import { useFeedback } from './Feedback';
import { HelpIcon, SettingsIcon } from './Icons';

interface Props {
  showVersion?: boolean;
  showSettings?: boolean;
}

export default function AppHeader({ showVersion = true, showSettings = true }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { openFeedback } = useFeedback();

  useEffect(() => {
    window.openextract?.getVersion?.().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="titlebar px-5 border-b border-rule flex items-center justify-between bg-base">
      <div className="flex items-baseline gap-2.5">
        <div
          className="w-5 h-5 rounded-full self-center"
          style={{
            background: 'radial-gradient(circle at 35% 35%, var(--cream), var(--accent-soft) 80%)',
          }}
        />
        <span className="font-serif text-[17px] font-medium text-text-primary tracking-tight">
          OpenExtract
        </span>
        {showVersion && version && (
          <span className="text-xs font-mono text-text-tertiary">v{version}</span>
        )}
      </div>
      {showSettings && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => openFeedback()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
          >
            <HelpIcon size={20} />
            Help
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
          >
            <SettingsIcon size={20} />
            Settings
          </button>
        </div>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
