import type { ReactNode } from 'react';
import { HelpIcon, SettingsIcon } from '../shared/Icons';

interface Props {
  left?: ReactNode;
  center?: ReactNode;
  /** Makes the logo a way home. */
  onLogo?: () => void;
  onHelp: () => void;
  onSettings: () => void;
}

/** The top row inside a backup; on macOS it is also the window's title bar. */
export default function TitleBar({ left, center, onLogo, onHelp, onSettings }: Props) {
  const logo = (
    <>
      <span
        className="w-5 h-5 rounded-full flex-shrink-0"
        style={{ background: 'radial-gradient(circle at 35% 35%, var(--cream), var(--accent-soft) 80%)' }}
      />
      <span className="hidden md:inline font-serif text-[17px] font-medium tracking-tight text-text-primary">
        OpenExtract
      </span>
    </>
  );
  return (
    <div className="titlebar flex items-center gap-2.5 px-4 border-b border-rule bg-base">
      {onLogo ? (
        <button onClick={onLogo} title="Home" className="flex items-center gap-2.5 mr-2 rounded-full pr-2 hover:opacity-80">
          {logo}
        </button>
      ) : (
        <span className="flex items-center gap-2.5 mr-2">{logo}</span>
      )}
      {left}
      <div className="flex-1 min-w-0 flex justify-center">{center}</div>
      <button
        onClick={onHelp}
        title="Help and feedback"
        aria-label="Help"
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-full text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
      >
        <HelpIcon size={20} />
        <span className="hidden xl:inline">Help</span>
      </button>
      <button
        onClick={onSettings}
        title="Settings"
        aria-label="Settings"
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-full text-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
      >
        <SettingsIcon size={20} />
        <span className="hidden xl:inline">Settings</span>
      </button>
    </div>
  );
}
