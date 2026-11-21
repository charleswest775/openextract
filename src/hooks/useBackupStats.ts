import { useState, useEffect } from 'react';
import { sidecarCall } from '../lib/ipc';
import type { WhatsAppStatus } from '../types/whatsapp';
import type { PodcastsStatus } from '../types/podcasts';
import type { VoiceMemosStatus } from '../types/voiceMemos';
import type { CalendarStatus } from '../types/calendar';

export interface TopConversation {
  display_name: string;
  message_count: number;
}

export interface TopContact {
  name: string;
  count: number;
}

export interface BackupStatsOverview {
  device_name: string;
  product_type: string;
  ios_version: string;
  last_backup: string;
  encrypted: boolean;
  size_gb: number;
  total_messages: number;
  total_conversations: number;
  // Rows in the Photos library, including ones only in iCloud (#106).
  total_photos: number;
  total_videos: number;
  // Photos and videos the backup has a file for: the Photos screen's count (All Photos,
  // which leaves out hidden photos, as the iPhone does).
  photos_in_backup: number;
  // All Photos rows whose file the backup lists but its folder doesn't have (OE-102), so they
  // aren't counted as only in iCloud; older engines don't send it.
  photos_missing_from_folder?: number;
  // Hidden photos and videos the backup has a file for. Save to this computer saves them
  // as well; older engines don't send it.
  hidden_photos_in_backup?: number;
  total_contacts: number;
  total_calls: number;
  total_notes: number;
  total_voicemails: number;
  // WhatsApp (python/stats.py): messages in its listable chats, system rows
  // included, and the chats. Kept apart from total_messages, which is sms.db.
  total_whatsapp_messages: number;
  total_whatsapp_chats: number;
  /** Whether WhatsApp could be read: the section shows on 'error' and 'unsupported_format' too, to say so. */
  whatsapp_status: WhatsAppStatus;
  // Podcasts (python/stats.py, MTLibrary.sqlite): every show in the library,
  // the ones followed, and episodes with signs of listening. An older engine
  // sends none of these, so read them with ?? 0.
  total_podcasts: number;
  total_podcasts_followed: number;
  total_podcast_episodes_listened: number;
  /** Whether Podcasts could be read: the section shows on 'error' and 'unsupported_format' too, to say so. */
  podcasts_status: PodcastsStatus;
  // Voice Memos (python/stats.py, CloudRecordings.db): recordings not in Recently
  // Deleted, and their length added up, in seconds. Read with ?? 0 (older engines).
  total_voice_memos: number;
  total_voice_memo_seconds: number;
  /** Recordings in Recently Deleted, which the screen lists and a save writes too. Read with ?? 0 (older engines). */
  total_deleted_voice_memos: number;
  /** Listed recordings (deleted ones too) whose audio is in the backup: 0 means an "Audio files" save has nothing to write. Read with ?? 1 (older engines). */
  total_voice_memos_with_audio: number;
  /** Whether Voice Memos could be read: the section shows on 'error' and 'unsupported_format' too, to say so. */
  voice_memos_status: VoiceMemosStatus;
  // Calendar (python/stats.py, Calendar.sqlitedb): events in the person's own
  // calendars, events in every other calendar (holidays, birthdays, Found in
  // Mail, subscriptions), and the person's own calendars (empty ones too). Read with ?? 0.
  total_calendar_events: number;
  total_subscribed_events: number;
  total_calendars: number;
  /** The person's own calendars that have events. Read with ?? 0 (older engines). */
  total_calendars_with_events: number;
  /** Whether Calendar could be read: the section shows on 'error' and 'unsupported_format' too, to say so. */
  calendar_status: CalendarStatus;
}

export interface MessageStats {
  sent: number;
  received: number;
  imessage_count: number;
  sms_count: number;
  group_conversations: number;
  one_on_one_conversations: number;
  top_conversations: TopConversation[];
  busiest_day: string;
  busiest_hour: number;
  avg_messages_per_day: number;
  total_attachments: number;
  first_message_date: string | null;
  last_message_date: string | null;
}

// The photos the backup has a file for, like the Photos screen lists, except
// total_photos/total_videos, which are rows in the Photos library (#106).
export interface PhotoStats {
  by_kind: Record<string, number>;
  total_photos: number;
  total_videos: number;
  total_favorites: number;
  with_location: number;
  earliest_date: string | null;
  latest_date: string | null;
  total_video_duration_seconds: number;
}

export interface CallStats {
  incoming: number;
  outgoing: number;
  answered: number;
  missed: number;
  total_duration_seconds: number;
  avg_duration_seconds: number;
  longest_call_seconds: number;
  facetime_count: number;
  regular_count: number;
  top_contacts: TopContact[];
}

export interface NoteStats {
  total: number;
  avg_length_chars: number;
  longest_chars: number;
}

export interface VoicemailStats {
  total: number;
  total_duration_seconds: number;
  read: number;
  unread: number;
}

export interface BackupStats {
  overview: BackupStatsOverview;
  messages: MessageStats;
  photos: PhotoStats;
  calls: CallStats;
  notes: NoteStats;
  voicemails: VoicemailStats;
  errors: string[];
}

export function useBackupStats(udid: string) {
  const [stats, setStats] = useState<BackupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await sidecarCall<BackupStats>('get_backup_stats', { udid });
        if (!cancelled) setStats(data);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Failed to load stats');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [udid]);

  return { stats, loading, error };
}
