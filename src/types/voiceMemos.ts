/**
 * What the engine's Voice Memos calls return (python/voice_memos.py, over
 * ios-backup-core's VoiceMemoExtractor, which reads the Voice Memos app's
 * CloudRecordings.db, or the older Recordings.db, and finds each recording's
 * audio file next to it).
 *
 * A recording's `id` is the database row's primary key: what get_voice_memo_audio,
 * get_voice_memo_transcript and export_voice_memos take as `memo_id` / `memo_ids`.
 * Dates are ISO 8601 UTC strings, or null.
 *
 * The audio is in the backup only when it was on the iPhone: a recording kept
 * in iCloud only has `audio_available: false` and `audio_missing_reason:
 * 'in_icloud_only'`. The list never reads audio files; the screen asks for one
 * recording's audio when it's opened.
 */

/** Why a list came back empty, as the engine says it. */
export type VoiceMemosEmptyReason = 'not_in_backup' | 'no_records' | 'unsupported_format';

/** What get_backup_stats says about Voice Memos, in its overview. */
export type VoiceMemosStatus = 'ok' | 'not_in_backup' | 'no_records' | 'unsupported_format' | 'error';

/** Why a recording's audio isn't in the backup. */
export type AudioMissingReason = 'in_icloud_only' | 'not_in_backup';

export interface VoiceMemo {
  id: number;
  /** The recording's own id (ZUNIQUEID); the start of it is in the file's name. */
  unique_id: string | null;
  /** The name it was given on the iPhone, or null: the screen says "Untitled recording". */
  title: string | null;
  date: string | null;
  duration_seconds: number | null;
  /** The folder's id (ZFOLDER.ZUUID), as in `folders`; null when it's in no folder. */
  folder_id: string | null;
  folder: string | null;
  /** Null when the database has no favourite flag (iOS 13 and older). */
  is_favorite: boolean | null;
  /** In Recently Deleted on the iPhone, still in the backup. */
  is_deleted: boolean;
  deleted_date: string | null;
  /** Reported only, never used to leave a recording out (the flag's meaning isn't verified). */
  in_phone_list: boolean | null;
  recorded_on_watch: boolean | null;
  is_enhanced: boolean | null;
  /** A recording with layers (iOS 18.2 and later); saved as a QuickTime .qta file. */
  is_layered: boolean | null;
  is_spatial: boolean | null;
  /** The iPhone transcribed it: get_voice_memo_transcript reads the text from the audio file. */
  has_transcript: boolean | null;
  file_name: string | null;
  /** "m4a", "qta" or "qt", or null. */
  format: string | null;
  audio_available: boolean;
  audio_missing_reason: AudioMissingReason | null;
  /** Which database it came from: "CloudRecordings.db" or "Recordings.db". */
  source: string;
}

/** A folder made in Voice Memos. */
export interface VoiceMemoFolder {
  id: string;
  name: string | null;
  rank: number | null;
  /** Recordings in it that aren't in Recently Deleted. */
  count: number;
}

export interface VoiceMemosResult {
  voice_memos: VoiceMemo[];
  /** Always there when the list was read; [] on an iPhone without folders. */
  folders?: VoiceMemoFolder[];
  empty_reason?: VoiceMemosEmptyReason;
  error?: string;
}

/**
 * get_voice_memo_audio: the audio inline (base64), or `too_large` past the
 * engine's inline limit, or, with `as_file`, a copy under the recording's own
 * name to hand to another app. A recording that isn't in the backup is an
 * `error` with `empty_reason`.
 */
export interface VoiceMemoAudioResult {
  data?: string;
  mime_type?: string;
  memo_id?: number;
  filename?: string;
  size?: number;
  too_large?: boolean;
  path?: string;
  openable?: boolean;
  error?: string;
  empty_reason?: AudioMissingReason | string | null;
}

export interface VoiceMemoTranscriptSegment {
  text: string;
  /** Seconds into the recording. */
  start: number | null;
  end: number | null;
}

/** get_voice_memo_transcript: `text` is null when the recording has none. */
export interface VoiceMemoTranscriptResult {
  memo_id?: number;
  text: string | null;
  segments: VoiceMemoTranscriptSegment[];
  locale: string | null;
  error?: string;
}

export type VoiceMemoSaveFormat = 'recordings' | 'csv';

/** What export_voice_memos returns when it wrote something. */
export interface VoiceMemoExportResult {
  status: 'success';
  /** Recordings copied (recordings), or rows written (csv). */
  count: number;
  /** The "Voice Memos" folder, the CSV, or the one recording saved. */
  path: string;
  files: string[];
  /** Recordings whose audio wasn't in the backup, so weren't copied. */
  not_in_backup?: number;
  /** Recordings that couldn't be copied. */
  failed?: number;
}
