import type { ReactNode } from 'react';
import type { RecentSession } from '../../lib/appState';
import { HelpIcon, SettingsIcon } from '../shared/Icons';

export type LayoutId = 'rail' | 'sidebar' | 'launchpad' | 'people' | 'search';

/** The layouts from the UI overhaul review, to compare side by side. */
export const LAYOUTS: { id: LayoutId; label: string }[] = [
  { id: 'rail', label: 'Icon rail (current)' },
  { id: 'sidebar', label: '1 · Organized sidebar' },
  { id: 'launchpad', label: '2 · Launchpad home' },
  { id: 'people', label: '3 · People first' },
  { id: 'search', label: '4 · One search box' },
];

interface Props {
  session: RecentSession | null;
  left?: ReactNode;
  center?: ReactNode;
  /** The device pill on the right; layouts that show the backup elsewhere turn it off. */
  showDevice?: boolean;
  /** Makes the logo a way home, for layouts that have a home page. */
  onLogo?: () => void;
  layout: LayoutId;
  onLayoutChange: (layout: LayoutId) => void;
  onHelp: () => void;
  onSettings: () => void;
}

/** The top row of every layout; on macOS it is also the window's title bar. */
export default function TitleBar({ session, left, center, showDevice = true, onLogo, layout, onLayoutChange, onHelp, onSettings }: Props) {
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
      {session && showDevice && !center && (
        <div className="hearth-pill whitespace-nowrap min-w-0 max-w-[30%]">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--sage)' }} />
          <span className="truncate">{session.name}</span>
          {session.iosVersion && <span className="hidden xl:inline">· iOS {session.iosVersion}</span>}
        </div>
      )}
      <label className="flex items-center gap-1.5 text-sm text-text-secondary">
        <span className="hidden lg:inline">Layout</span>
        <select
          aria-label="Layout"
          value={layout}
          onChange={e => onLayoutChange(e.target.value as LayoutId)}
          className="h-9 pl-3 pr-2 rounded-full border border-accent bg-accent-wash text-sm text-accent font-medium"
        >
          {LAYOUTS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </label>
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
