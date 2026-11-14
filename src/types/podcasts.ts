/**
 * What the engine's Podcasts calls return (python/podcasts.py, over
 * ios-backup-core's PodcastExtractor, which reads the Podcasts app's
 * MTLibrary.sqlite).
 *
 * Ids are MTLibrary primary keys: a show's `id` is what list_podcast_episodes
 * takes as `podcast_id`. Dates are ISO 8601 UTC strings, or null.
 *
 * The audio of an episode is never in an iPhone backup, even when it was
 * downloaded on the phone: `enclosure_url` is where the podcast publishes it.
 * Nothing here is ever fetched: no feeds, artwork or audio.
 */

/** Why a list came back empty, as the engine says it. */
export type PodcastsEmptyReason = 'not_in_backup' | 'no_records';

/** What get_backup_stats says about Podcasts, in its overview. */
export type PodcastsStatus = 'ok' | 'not_in_backup' | 'no_records' | 'unsupported_format' | 'error';

export interface Podcast {
  id: number;
  uuid: string | null;
  title: string | null;
  author: string | null;
  description: string | null;
  category: string | null;
  /** The feed's newest known address: what another podcast app needs. */
  feed_url: string | null;
  /** The address the show was first followed at, when it has moved since. */
  original_feed_url: string | null;
  webpage_url: string | null;
  /** Artwork on the web. Never shown: the app makes no network calls. */
  image_url: string | null;
  store_url: string | null;
  store_id: number | null;
  show_type: string | null;
  /** The person chose to follow it (subscribed, and not only followed by the app for them). */
  followed: boolean;
  subscribed: boolean;
  implicitly_followed: boolean;
  hidden: boolean;
  added_date: string | null;
  last_played_date: string | null;
  unfollowed_date: string | null;
  episode_count: number;
  /** Episodes with signs of listening: a play count, a last played date or a saved place. */
  listened_count: number;
}

export type PlayState = 'played' | 'in_progress' | 'unplayed';

export interface PodcastEpisode {
  id: number;
  podcast_id: number;
  podcast_title: string | null;
  uuid: string | null;
  guid: string | null;
  title: string | null;
  author: string | null;
  published_date: string | null;
  duration_seconds: number | null;
  play_count: number;
  /** Where listening stopped, in seconds; null when there's no saved place. */
  playhead_seconds: number | null;
  last_played_date: string | null;
  /**
   * As the Podcasts app shows it. Following a show marks its whole back
   * catalogue "played", so this alone isn't listening history: `listened` is.
   */
  play_state: PlayState | null;
  listened: boolean;
  saved: boolean;
  /** Downloaded on the iPhone. The audio itself is never in the backup. */
  downloaded_on_phone: boolean;
  /** Where the podcast publishes the audio. */
  enclosure_url: string | null;
  webpage_url: string | null;
  season: number | null;
  episode_number: number | null;
  episode_type: string | null;
  video: boolean;
  removed_from_feed: boolean;
  hidden: boolean;
}

export interface PodcastsResult {
  podcasts: Podcast[];
  empty_reason?: PodcastsEmptyReason;
  error?: string;
}

export interface PodcastEpisodesResult {
  episodes: PodcastEpisode[];
  empty_reason?: PodcastsEmptyReason;
  error?: string;
}

export type PodcastSaveFormat = 'opml' | 'csv';

/** What export_podcasts returns when it wrote something. */
export interface PodcastExportResult {
  status: 'success';
  /** Shows written. */
  count: number;
  /** The main file: Podcasts.opml or Podcasts.csv. */
  path: string;
  /** Every file written (the CSV save writes a second file of episodes). */
  files: string[];
}
