/**
 * Shared types and helpers for Voice Memos.
 */

export interface VoiceMemo {
  id: number;
  title: string;
  /** ISO 8601, UTC */
  date: string | null;
  /** Seconds */
  duration: number;
  folder: string | null;
  /** In "Recently Deleted" on the phone, but still in the backup */
  deleted: boolean;
  deleted_date: string | null;
  file_name: string | null;
  has_audio: boolean;
}

export function memoTitle(memo: Pick<VoiceMemo, 'title'>): string {
  return memo.title || 'Untitled recording';
}
