/**
 * The Podcasts screen's wording and small decisions, kept apart from the
 * component so they can be tested: how the list of shows is grouped and
 * ordered, the listening history's order, what an episode's status chips say,
 * how long an episode is and how far in someone got, and what to say when
 * there's nothing to show.
 *
 * "Listened" means a play count, a last played date or a saved place. The
 * Podcasts app marks a followed show's whole back catalogue "played", so its
 * play state alone isn't history (see ios-backup-core podcasts.py).
 */
import type { Podcast, PodcastEpisode, PodcastsEmptyReason, PodcastsStatus } from '../types/podcasts';
import { formatDate } from './dates';

/** The one note about audio, said once on the screen. */
export const AUDIO_NOTE = "Episode audio isn't kept in iPhone backups. Each episode links to where the podcast publishes it.";

// "1 show", "3 shows". A copy of saveData's plural, so this file needs nothing from the bridge.
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// Newest first; a missing date sorts last.
function newestFirst(a: string | null | undefined, b: string | null | undefined): number {
  const ta = a ? Date.parse(a) : NaN, tb = b ? Date.parse(b) : NaN;
  const ha = !Number.isNaN(ta), hb = !Number.isNaN(tb);
  if (ha && hb) return tb - ta;
  return ha ? -1 : hb ? 1 : 0;
}

const byTitle = (a: Podcast, b: Podcast) =>
  showName(a).localeCompare(showName(b), undefined, { sensitivity: 'base', numeric: true });

// ── Shows ──────────────────────────────────────────────────────────────────

/** What a show is called, even when the library has no title for it. */
export function showName(show: Pick<Podcast, 'title'>): string {
  return show.title?.trim() || 'Untitled podcast';
}

/** What an episode is called, even when the library has no title for it. */
export function episodeName(episode: Pick<PodcastEpisode, 'title'>): string {
  return episode.title?.trim() || 'Untitled episode';
}

export interface ShowGroups {
  /** Shows the person follows, A to Z. */
  followed: Podcast[];
  /** Every other show in the library (played from a link or a search, or unfollowed), most recently played first. */
  others: Podcast[];
}

/** The list's two groups: followed shows, then the quiet "Not followed" group. */
export function groupShows(podcasts: Podcast[]): ShowGroups {
  const followed = podcasts.filter(p => p.followed).sort(byTitle);
  const others = podcasts.filter(p => !p.followed)
    .sort((a, b) => newestFirst(a.last_played_date, b.last_played_date) || byTitle(a, b));
  return { followed, others };
}

/** The words a search looks through for a show. */
export function showMatchFields(show: Podcast): (string | null)[] {
  return [show.title, show.author, show.category];
}

/** The words a search looks through for an episode. */
export function episodeMatchFields(episode: PodcastEpisode): (string | null)[] {
  return [episode.title, episode.podcast_title, episode.author];
}

/** A show's row under its name: who makes it and how much of it was listened to. */
export function showLine(show: Podcast): string {
  const parts = [show.author?.trim() || ''];
  if (show.listened_count > 0) parts.push(`${count(show.listened_count, 'episode')} listened to`);
  return parts.filter(Boolean).join(' · ');
}

/** Whether the person follows the show, as its details say it. */
export function followState(show: Podcast): string {
  if (show.followed) return 'Following';
  if (show.unfollowed_date) return `Unfollowed ${formatDate(show.unfollowed_date)}`;
  return 'Not followed';
}

/** "12 episodes, 3 listened to" */
export function showCounts(show: Podcast): string {
  const all = count(show.episode_count, 'episode');
  return show.listened_count > 0 ? `${all}, ${show.listened_count.toLocaleString()} listened to` : all;
}

/** Which episodes a show opens on: what was listened to when there is some, else all of them. */
export function defaultEpisodeView(show: Pick<Podcast, 'listened_count'>): 'listened' | 'all' {
  return show.listened_count > 0 ? 'listened' : 'all';
}

// ── Episodes ───────────────────────────────────────────────────────────────

/** The listening history: most recently played first, then newest published. */
export function historyOrder(episodes: PodcastEpisode[]): PodcastEpisode[] {
  return [...episodes].sort((a, b) =>
    newestFirst(a.last_played_date, b.last_played_date) || newestFirst(a.published_date, b.published_date));
}

/** "42 min", "1 hr 5 min", "2 hr"; '' when the length isn't known. */
export function episodeLength(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return '';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "3:07", "1:02:09": a place in an episode. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = s.toString().padStart(2, '0');
  return h ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * An episode's status chips: how often it was played, or how far in, whether
 * it was saved, and whether it was downloaded on the iPhone (information only:
 * the audio isn't in the backup).
 */
export function episodeChips(episode: PodcastEpisode): string[] {
  const chips: string[] = [];
  const plays = episode.play_count || 0;
  if (plays > 0) {
    chips.push(plays === 1 ? 'Played once' : `Played ${plays.toLocaleString()} times`);
  } else if (episode.play_state === 'in_progress') {
    chips.push(episode.playhead_seconds ? `In progress, ${clock(episode.playhead_seconds)} in` : 'In progress');
  } else if (episode.listened) {
    chips.push('Played');
  }
  if (plays > 0 && episode.play_state === 'in_progress' && episode.playhead_seconds) {
    chips.push(`${clock(episode.playhead_seconds)} in`);
  }
  if (episode.saved) chips.push('Saved');
  if (episode.downloaded_on_phone) chips.push('Downloaded on the iPhone');
  return chips;
}

/** An episode's line under its title: when it came out, how long it is, and in the history which show and when it was played. */
export function episodeLine(episode: PodcastEpisode, { inHistory = false } = {}): string {
  const parts = inHistory
    ? [episode.podcast_title?.trim() || '', episode.last_played_date ? `Played ${formatDate(episode.last_played_date)}` : '']
    : [formatDate(episode.published_date)];
  parts.push(episodeLength(episode.duration_seconds));
  return parts.filter(Boolean).join(' · ');
}

/** Where an episode can be found on the web: its page, else the audio's address. */
export function episodeLink(episode: Pick<PodcastEpisode, 'webpage_url' | 'enclosure_url'>): string | null {
  return webAddress(episode.webpage_url) ?? webAddress(episode.enclosure_url);
}

/** A link the app will open: only http and https, never a file or app address. */
export function webAddress(url: string | null | undefined): string | null {
  const u = url?.trim();
  return u && /^https?:\/\//i.test(u) ? u : null;
}

// ── Empty states ───────────────────────────────────────────────────────────

export interface EmptyCopy {
  /** 'error' and 'unsupported' get a Report button; 'empty' is calm. */
  kind: 'error' | 'unsupported' | 'empty';
  title: string;
  detail?: string;
}

/**
 * What the Podcasts screen says when it has no shows, from the engine's answer.
 * Not using the Podcasts app is normal and calm; a library that can't be read says so.
 */
export function emptyCopy(
  emptyReason: PodcastsEmptyReason | 'unsupported_format' | string | null | undefined,
  error: string | null | undefined,
): EmptyCopy {
  if (emptyReason === 'unsupported_format') {
    return { kind: 'unsupported', title: "This version of Podcasts can't be read yet", detail: error || undefined };
  }
  if (error && emptyReason !== 'not_in_backup' && emptyReason !== 'no_records') {
    return { kind: 'error', title: "Couldn't read the podcasts", detail: error };
  }
  if (emptyReason === 'no_records') {
    return { kind: 'empty', title: 'No podcasts in this backup', detail: "The Podcasts app is on this iPhone, but it doesn't follow any shows." };
  }
  return {
    kind: 'empty',
    title: 'No podcasts in this backup',
    detail: emptyReason === 'not_in_backup' ? "The Podcasts app wasn't used on this iPhone, or its library wasn't in the backup." : undefined,
  };
}

/** What an episode list says when it's empty. */
export function episodesEmptyText(view: 'history' | 'listened' | 'all'): string {
  switch (view) {
    case 'history': return 'No episodes were listened to on this iPhone.';
    case 'listened': return 'No episodes of this show were listened to.';
    default: return 'This show has no episodes in the library.';
  }
}

/** A search that finds nothing. */
export function noMatchCopy(query: string): { title: string; detail: string } {
  return { title: `No podcasts match "${query}"`, detail: "Try a show's name or who makes it." };
}

// ── Home and details ───────────────────────────────────────────────────────

/** The overview numbers the home tile reads; an older engine sends none of them. */
export interface PodcastsOverview {
  total_podcasts?: number;
  total_podcasts_followed?: number;
  total_podcast_episodes_listened?: number;
  podcasts_status?: PodcastsStatus;
}

/** Podcasts is in the backup but couldn't be read: its tile still shows, with no number, to say why. */
export function podcastsUnreadable(o: PodcastsOverview | null | undefined): boolean {
  return o?.podcasts_status === 'error' || o?.podcasts_status === 'unsupported_format';
}

/** The home tile's line. */
export function podcastsHomeLine(o: PodcastsOverview): string {
  if (o.podcasts_status === 'unsupported_format') return "This Podcasts version can't be read yet";
  if (o.podcasts_status === 'error') return "Couldn't be read: open it to see why";
  if (o.total_podcasts_followed) return `${count(o.total_podcasts_followed, 'show')} you follow`;
  if (o.total_podcast_episodes_listened) return `${count(o.total_podcast_episodes_listened, 'episode')} listened to`;
  return 'Shows and listening history';
}
