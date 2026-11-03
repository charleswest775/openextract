import type { ReactNode } from 'react';
import type { RecentSession } from '../../lib/appState';
import type { BackupStats, BackupStatsOverview } from '../../hooks/useBackupStats';
import type { TimelineFilters } from '../../types/timeline';
import {
  LinesIcon, CameraIcon, ContactIcon, CallIcon, NoteIcon, VoicemailIcon, GlobeIcon, ClockIcon,
  CalendarIcon, ChartIcon, ExportIcon, RecoverIcon,
} from '../shared/Icons';

/** Every screen inside a backup. launchpad, people and search are homes of the layouts that use them. */
export type Tab =
  | 'dashboard' | 'launchpad' | 'people' | 'search'
  | 'timeline' | 'year' | 'messages' | 'photos' | 'contacts' | 'calls' | 'notes' | 'voicemail'
  | 'browser_history' | 'record_recovery' | 'export';

export type Icon = typeof LinesIcon;

export interface Section {
  id: Tab;
  label: string;
  icon: Icon;
  /** The Overview number that says whether the backup has this kind of data. */
  count?: (o: BackupStatsOverview) => number;
}

export const OVERVIEW: Section = { id: 'dashboard', label: 'Overview', icon: ChartIcon };
export const TIMELINE: Section = { id: 'timeline', label: 'Timeline', icon: ClockIcon };
export const YEAR: Section = { id: 'year', label: 'Year', icon: CalendarIcon };
export const RECOVER: Section = { id: 'record_recovery', label: 'Recover', icon: RecoverIcon };
export const SAVE: Section = { id: 'export', label: 'Save', icon: ExportIcon };

/** The kinds of data, in the order every layout lists them. */
export const DATA_SECTIONS: Section[] = [
  { id: 'messages', label: 'Messages', icon: LinesIcon, count: o => o.total_messages },
  { id: 'photos', label: 'Photos', icon: CameraIcon, count: o => o.photos_in_backup },
  { id: 'contacts', label: 'Contacts', icon: ContactIcon, count: o => o.total_contacts },
  { id: 'calls', label: 'Calls', icon: CallIcon, count: o => o.total_calls },
  { id: 'notes', label: 'Notes', icon: NoteIcon, count: o => o.total_notes },
  { id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon, count: o => o.total_voicemails },
  { id: 'browser_history', label: 'Web', icon: GlobeIcon },
];

export function sectionFor(tab: Tab): Section | undefined {
  return [OVERVIEW, TIMELINE, YEAR, RECOVER, SAVE, ...DATA_SECTIONS].find(s => s.id === tab);
}

/** The data sections this backup has. Until the Overview numbers arrive, all of them. */
export function availableData(overview: BackupStatsOverview | null, hasBrowserHistory: boolean): Section[] {
  return DATA_SECTIONS.filter(s => {
    if (s.id === 'browser_history') return hasBrowserHistory;
    return !s.count || !overview || s.count(overview) > 0;
  });
}

/** Lower-case names of the kinds of data the backup has none of, e.g. ["photos", "web history"]. */
export function missingKinds(overview: BackupStatsOverview | null, hasBrowserHistory: boolean): string[] {
  if (!overview) return [];
  const missing = DATA_SECTIONS
    .filter(s => s.count && s.count(overview) === 0)
    .map(s => (s.id === 'voicemail' ? 'voicemail' : s.label.toLowerCase()));
  if (!hasBrowserHistory) missing.push('web history');
  return missing;
}

/** "photos, calls and notes" */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Where to land when opening a screen from somewhere else. */
export interface OpenOptions {
  /** Timeline filters to start from, e.g. one day, one person or a search. */
  timeline?: Partial<TimelineFilters>;
  /** Messages: the conversation to open. */
  chatId?: number;
  /** Notes: the note to open. */
  noteId?: number | string;
}

/** What the explore shell gives each layout. */
export interface ExploreContext {
  udid: string;
  session: RecentSession | null;
  stats: BackupStats | null;
  overview: BackupStatsOverview | null;
  hasBrowserHistory: boolean;
  /** The data sections this backup has. */
  data: Section[];
  missing: string[];
  activeTab: Tab;
  openTab: (tab: Tab, opts?: OpenOptions) => void;
  /** The active screen, for every tab except a layout's own home. */
  content: ReactNode;
  /** The shared top row; `left` and `center` are the layout's own controls. */
  titleBar: (slots?: { left?: ReactNode; center?: ReactNode; showDevice?: boolean; onLogo?: () => void }) => ReactNode;
  onBack: () => void;
  openSettings: () => void;
}
