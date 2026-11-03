import type { RecentSession } from '../../lib/appState';
import type { BackupStats, BackupStatsOverview } from '../../hooks/useBackupStats';
import type { BackupIndex } from '../../hooks/useTimeline';
import type { TimelineEntry, TimelineFilters } from '../../types/timeline';
import {
  LinesIcon, CameraIcon, ContactIcon, PeopleIcon, CallIcon, NoteIcon, VoicemailIcon, GlobeIcon, ClockIcon,
  CalendarIcon, ChartIcon, ExportIcon, RecoverIcon,
} from '../shared/Icons';

/** Every screen inside a backup. */
export type Tab =
  | 'home' | 'dashboard' | 'people'
  | 'timeline' | 'year' | 'messages' | 'photos' | 'contacts' | 'calls' | 'notes' | 'voicemail'
  | 'browser_history' | 'record_recovery' | 'export';

export type Icon = typeof LinesIcon;

export interface Section {
  id: Tab;
  label: string;
  icon: Icon;
  /** The overview number that says whether the backup has this kind of data. */
  count?: (o: BackupStatsOverview) => number;
}

export const DETAILS: Section = { id: 'dashboard', label: 'Backup details', icon: ChartIcon };
export const TIMELINE: Section = { id: 'timeline', label: 'Timeline', icon: ClockIcon };
export const YEAR: Section = { id: 'year', label: 'Year', icon: CalendarIcon };
export const RECOVER: Section = { id: 'record_recovery', label: 'Recover deleted', icon: RecoverIcon };
export const SAVE: Section = { id: 'export', label: 'Save to computer', icon: ExportIcon };
export const PEOPLE: Section = {
  id: 'people', label: 'People', icon: PeopleIcon,
  count: o => o.total_messages + o.total_calls + o.total_voicemails,
};

/** The kinds of data, in the order the home page lists them. */
export const DATA_SECTIONS: Section[] = [
  { id: 'messages', label: 'Messages', icon: LinesIcon, count: o => o.total_messages },
  { id: 'photos', label: 'Photos', icon: CameraIcon, count: o => o.photos_in_backup },
  PEOPLE,
  { id: 'contacts', label: 'Address book', icon: ContactIcon, count: o => o.total_contacts },
  { id: 'calls', label: 'Calls', icon: CallIcon, count: o => o.total_calls },
  { id: 'notes', label: 'Notes', icon: NoteIcon, count: o => o.total_notes },
  { id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon, count: o => o.total_voicemails },
  { id: 'browser_history', label: 'Web history', icon: GlobeIcon },
];

export function sectionFor(tab: Tab): Section | undefined {
  return [DETAILS, TIMELINE, YEAR, RECOVER, SAVE, ...DATA_SECTIONS].find(s => s.id === tab);
}

/**
 * Screens the top search box filters in place, and what it says there.
 * Everywhere else (home, Photos, Year, Save) it searches the whole backup.
 */
export const SCOPED: Partial<Record<Tab, string>> = {
  people: 'Search people',
  contacts: 'Search the address book',
  messages: 'Search messages',
  calls: 'Search calls',
  notes: 'Search notes',
  voicemail: 'Search voicemail',
  browser_history: 'Search web history',
  timeline: 'Search the timeline',
  record_recovery: 'Search recovered messages',
};

/** The data sections this backup has. Until the overview numbers arrive, all of them. */
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
    .filter(s => s.id !== 'people' && s.count && s.count(overview) === 0)
    .map(s => s.label.toLowerCase());
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
  /** The record to show: the message, note, call, voicemail, photo or web visit a search found. */
  select?: TimelineEntry;
  /** People: who to open, by phone number or email. */
  person?: string;
  /** Address book: the card to show. */
  contactId?: number;
  /** Keep what's in the search box, so the screen opens filtered to it. */
  keepQuery?: boolean;
}

/** What the explore shell gives the screens it draws. */
export interface ExploreContext {
  udid: string;
  session: RecentSession | null;
  stats: BackupStats | null;
  overview: BackupStatsOverview | null;
  hasBrowserHistory: boolean;
  /** Every record in the backup, read once and shared. */
  index: BackupIndex;
  /** The data sections this backup has. */
  data: Section[];
  missing: string[];
  activeTab: Tab;
  openTab: (tab: Tab, opts?: OpenOptions) => void;
  onBack: () => void;
  openSettings: () => void;
}
