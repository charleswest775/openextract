import { useState, useEffect } from 'react';
import { sidecarCall } from '../lib/ipc';

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
  total_photos: number;
  total_videos: number;
  total_contacts: number;
  total_calls: number;
  total_notes: number;
  total_voicemails: number;
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
