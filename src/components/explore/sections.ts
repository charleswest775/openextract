import type { RecentSession } from '../../lib/appState';
import type { BackupStats, BackupStatsOverview } from '../../hooks/useBackupStats';
import type { BackupIndex } from '../../hooks/useTimeline';
import type { TimelineEntry, TimelineFilters } from '../../types/timeline';
import {
  LinesIcon, CameraIcon, ContactIcon, PeopleIcon, CallIcon, NoteIcon, VoicemailIcon, GlobeIcon, ClockIcon,
  CalendarIcon, ChartIcon, ExportIcon, RecoverIcon, WhatsAppIcon, PodcastIcon,
} from '../shared/Icons';
import { podcastsUnreadable } from '../../lib/podcasts';

/** Every screen inside a backup. */
export type Tab =
  | 'home' | 'dashboard' | 'people'
  | 'timeline' | 'year' | 'messages' | 'whatsapp' | 'photos' | 'contacts' | 'calls' | 'notes' | 'voicemail'
  | 'podcasts' | 'browser_history' | 'record_recovery' | 'export';

export type Icon = typeof LinesIcon;

export interface Section {
  id: Tab;
  label: string;
  icon: Icon;
  /** The overview number that says whether the backup has this kind of data. */
  count?: (o: BackupStatsOverview) => number;
  /** Whether to show the section, when that isn't just count > 0. */
  shown?: (o: BackupStatsOverview) => boolean;
}

export const DETAILS: Section = { id: 'dashboard', label: 'Backup details', icon: ChartIcon };
export const TIMELINE: Section = { id: 'timeline', label: 'Timeline', icon: ClockIcon };
export const YEAR: Section = { id: 'year', label: 'Year', icon: CalendarIcon };
export const RECOVER: Section = { id: 'record_recovery', label: 'Recover deleted', icon: RecoverIcon };
export const SAVE: Section = { id: 'export', label: 'Save to computer', icon: ExportIcon };
export const PEOPLE: Section = {
  id: 'people', label: 'People', icon: PeopleIcon,
  count: o => o.total_messages + (o.total_whatsapp_messages ?? 0) + o.total_calls + o.total_voicemails,
};

/**
 * WhatsApp is in the backup but couldn't be read (damaged, or a version the
 * engine doesn't know). Its section still shows, with no number, so the
 * screen can say why and offer a report, rather than looking like there's no WhatsApp.
 */
export function whatsappUnreadable(o: BackupStatsOverview | null | undefined): boolean {
  return o?.whatsapp_status === 'error' || o?.whatsapp_status === 'unsupported_format';
}

/** Podcasts in the backup that couldn't be read: shown with no number, like WhatsApp. */
export { podcastsUnreadable };

/** The kinds of data, in the order the home page lists them. */
export const DATA_SECTIONS: Section[] = [
  { id: 'messages', label: 'Messages', icon: LinesIcon, count: o => o.total_messages },
  {
    id: 'whatsapp', label: 'WhatsApp', icon: WhatsAppIcon, count: o => o.total_whatsapp_messages ?? 0,
    shown: o => (o.total_whatsapp_messages ?? 0) > 0 || whatsappUnreadable(o),
  },
  { id: 'photos', label: 'Photos', icon: CameraIcon, count: o => o.photos_in_backup },
  PEOPLE,
  { id: 'contacts', label: 'Address book', icon: ContactIcon, count: o => o.total_contacts },
  { id: 'calls', label: 'Calls', icon: CallIcon, count: o => o.total_calls },
  { id: 'notes', label: 'Notes', icon: NoteIcon, count: o => o.total_notes },
  { id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon, count: o => o.total_voicemails },
  {
    id: 'podcasts', label: 'Podcasts', icon: PodcastIcon, count: o => o.total_podcasts ?? 0,
    shown: o => (o.total_podcasts ?? 0) > 0 || podcastsUnreadable(o),
  },
  { id: 'browser_history', label: 'Web history', icon: GlobeIcon },
];

export function sectionFor(tab: Tab): Section | undefined {
  return [DETAILS, TIMELINE, YEAR, RECOVER, SAVE, ...DATA_SECTIONS].find(s => s.id === tab);
}

/** How the top search box reads on a screen it filters in place. */
export interface Scope {
  /** What the empty box says. */
  placeholder: string;
  /** What the screen's list holds, as its count line says it: "Showing only page visits that match …" */
  items: string;
}

/**
 * Screens the top search box filters in place, and what it says there.
 * Everywhere else (home, Photos, Year, Save) it searches the whole backup.
 */
export const SCOPED: Partial<Record<Tab, Scope>> = {
  people: { placeholder: 'Search people', items: 'people' },
  contacts: { placeholder: 'Search the address book', items: 'cards' },
  messages: { placeholder: 'Search messages', items: 'messages' },
  whatsapp: { placeholder: 'Search WhatsApp', items: 'WhatsApp messages' },
  calls: { placeholder: 'Search calls', items: 'calls' },
  notes: { placeholder: 'Search notes', items: 'notes' },
  voicemail: { placeholder: 'Search voicemail', items: 'voicemails' },
  podcasts: { placeholder: 'Search podcasts', items: 'podcasts' },
  browser_history: { placeholder: 'Search web history', items: 'page visits' },
  timeline: { placeholder: 'Search the timeline', items: 'events' },
  record_recovery: { placeholder: 'Search deleted messages', items: 'deleted messages' },
};

/** The data sections this backup has. Until the overview numbers arrive, all of them. */
export function availableData(overview: BackupStatsOverview | null, hasBrowserHistory: boolean): Section[] {
  return DATA_SECTIONS.filter(s => {
    if (s.id === 'browser_history') return hasBrowserHistory;
    if (!overview) return true;
    if (s.shown) return s.shown(overview);
    return !s.count || s.count(overview) > 0;
  });
}

/**
 * Lower-case names of the kinds of data the backup has none of, e.g. ["photos", "web history"].
 * WhatsApp isn't one: most iPhones don't have it, so a backup without it isn't missing anything.
 * Podcasts isn't either: many iPhones never use the Podcasts app.
 */
export function missingKinds(overview: BackupStatsOverview | null, hasBrowserHistory: boolean): string[] {
  if (!overview) return [];
  const missing = DATA_SECTIONS
    .filter(s => s.id !== 'people' && s.id !== 'whatsapp' && s.id !== 'podcasts' && s.count && s.count(overview) === 0)
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
  /** Messages: the conversation to open (an sms.db chat). */
  chatId?: number;
  /** WhatsApp: the chat to open (a ChatStorage chat; its ids overlap sms.db's, so never in chatId). */
  waChatId?: number;
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
  /** The backup stopped partway (python/backup_status.py). */
  unfinished: boolean;
}
