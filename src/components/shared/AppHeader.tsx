import { useEffect, useState } from 'react';
import SettingsDialog from './SettingsDialog';

interface Props {
  showVersion?: boolean;
  showSettings?: boolean;
}

export default function AppHeader({ showVersion = true, showSettings = true }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    window.openextract?.getVersion?.().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="px-5 py-3 border-b border-rule flex items-center justify-between bg-base">
      <div className="flex items-baseline gap-2.5">
        <div
          className="w-5 h-5 rounded-full self-center"
          style={{
            background: 'radial-gradient(circle at 35% 35%, var(--cream), var(--accent) 80%)',
          }}
        />
        <span className="font-serif text-[17px] font-medium text-text-primary tracking-tight">
          OpenExtract
        </span>
        {showVersion && version && (
          <span className="text-[11px] font-mono text-text-tertiary">v{version}</span>
        )}
      </div>
      {showSettings && (
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Settings
        </button>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
