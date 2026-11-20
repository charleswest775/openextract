/**
 * The Voice Memos screen's wording and small decisions, kept apart from the
 * component so they can be tested: what a recording is called, how long it is,
 * its chips, which lists the sidebar has and what's in each, what to say when
 * a recording's audio isn't in the backup, when there's nothing to show, and
 * what a save wrote.
 *
 * Recently Deleted holds recordings deleted on the iPhone that the backup
 * still has; every other list leaves them out, as the Voice Memos app does.
 */
import type {
  AudioMissingReason, VoiceMemo, VoiceMemoExportResult, VoiceMemoFolder, VoiceMemoSaveFormat, VoiceMemosEmptyReason,
  VoiceMemosStatus,
} from '../types/voiceMemos';
import { formatDateTime } from './dates';

// "1 recording", "3 recordings". A copy of saveData's plural, so this file needs nothing from the bridge.
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** The one note about Recently Deleted, said on that list. */
export const DELETED_NOTE = 'Recordings deleted on the iPhone that are still in this backup.';

// ── A recording ────────────────────────────────────────────────────────────

/** What a recording is called, even when it was never given a name. */
export function memoName(memo: Pick<VoiceMemo, 'title'>): string {
  return memo.title?.trim() || 'Untitled recording';
}

/** "0:42", "41:20", "1:02:09"; '' when the length isn't known. */
export function memoLength(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "About 42 min", "About 1 hr 5 min", "Under a minute"; '' for nothing. */
export function aboutLength(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return 'Under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `About ${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `About ${h} hr ${m} min` : `About ${h} hr`;
}

/** A recording's line under its name: when, how long, and (outside its folder) which folder. */
export function memoLine(memo: VoiceMemo, { showFolder = true } = {}): string {
  const parts = [formatDateTime(memo.date).trim(), memoLength(memo.duration_seconds)];
  if (showFolder && memo.folder?.trim()) parts.push(memo.folder.trim());
  if (memo.is_deleted && memo.deleted_date) parts.push(`Deleted ${formatDateTime(memo.deleted_date).trim()}`);
  return parts.filter(Boolean).join(' · ');
}

/** What the audio being missing is called on a chip. */
export function missingAudioChip(reason: AudioMissingReason | null | undefined): string {
  return reason === 'in_icloud_only' ? 'Kept in iCloud only' : 'Audio not in this backup';
}

/** A recording's chips: favourite, how it was made, and when its audio isn't in the backup. */
export function memoChips(memo: VoiceMemo): string[] {
  const chips: string[] = [];
  if (memo.is_favorite) chips.push('Favorite');
  if (memo.is_enhanced) chips.push('Enhanced');
  if (memo.recorded_on_watch) chips.push('Recorded on Apple Watch');
  if (memo.is_layered) chips.push('Layered');
  if (memo.is_spatial) chips.push('Spatial audio');
  if (!memo.audio_available) chips.push(missingAudioChip(memo.audio_missing_reason));
  return chips;
}

/**
 * Why a recording can't play, in the engine's own words (python/voice_memos.py
 * get_voice_memo_audio): a recording kept in iCloud only is said differently
 * from one that's simply not in the backup.
 */
export function missingAudioText(reason: AudioMissingReason | string | null | undefined): string {
  return reason === 'in_icloud_only'
    ? "This recording was kept in iCloud only, so it isn't in the backup."
    : "This recording isn't in the backup.";
}

/** The words a search looks through for a recording: its name, its folder, and its transcript once read. */
export function memoMatchFields(memo: VoiceMemo, transcript?: string | null): (string | null)[] {
  return [memo.title, memo.folder, transcript ?? null];
}

/** A memo id as a search result names it ("voice_memo:12"). */
export function memoSelectId(memo: Pick<VoiceMemo, 'id'>): string {
  return `voice_memo:${memo.id}`;
}

// ── The sidebar's lists ────────────────────────────────────────────────────

/** 'all', 'favorites', 'deleted', or 'folder:<the folder's id>'. */
export type MemoListId = string;

export const ALL_RECORDINGS = 'all';
export const FAVORITES = 'favorites';
export const RECENTLY_DELETED = 'deleted';
const FOLDER = 'folder:';

export interface MemoList {
  id: MemoListId;
  label: string;
  memos: VoiceMemo[];
}

export interface MemoLists {
  /** Every recording not in Recently Deleted, newest first. */
  all: MemoList;
  /** Only when there's at least one favourite. */
  favorites: MemoList | null;
  /** The folders made in Voice Memos, in the app's order. */
  folders: MemoList[];
  /** Only when something is in it. */
  deleted: MemoList | null;
}

const byRank = (a: VoiceMemoFolder, b: VoiceMemoFolder) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
  || folderName(a).localeCompare(folderName(b), undefined, { sensitivity: 'base', numeric: true });

export function folderName(folder: Pick<VoiceMemoFolder, 'name'>): string {
  return folder.name?.trim() || 'Untitled folder';
}

/** The sidebar: All Recordings, Favorites, the folders, then Recently Deleted. Recordings stay in the engine's order (newest first). */
export function memoLists(memos: VoiceMemo[], folders: VoiceMemoFolder[] = []): MemoLists {
  const kept = memos.filter(m => !m.is_deleted);
  const gone = memos.filter(m => m.is_deleted);
  const favorites = kept.filter(m => m.is_favorite);
  return {
    all: { id: ALL_RECORDINGS, label: 'All Recordings', memos: kept },
    favorites: favorites.length ? { id: FAVORITES, label: 'Favorites', memos: favorites } : null,
    folders: [...folders].sort(byRank).map(f => ({
      id: FOLDER + f.id, label: folderName(f), memos: kept.filter(m => m.folder_id === f.id),
    })),
    deleted: gone.length ? { id: RECENTLY_DELETED, label: 'Recently Deleted', memos: gone } : null,
  };
}

/** Every list, in the sidebar's order. */
export function allLists(lists: MemoLists): MemoList[] {
  return [lists.all, ...(lists.favorites ? [lists.favorites] : []), ...lists.folders, ...(lists.deleted ? [lists.deleted] : [])];
}

/** The list a recording opens in when a search finds it: its own place on the iPhone. */
export function homeListOf(memo: VoiceMemo): MemoListId {
  return memo.is_deleted ? RECENTLY_DELETED : ALL_RECORDINGS;
}

/** What an empty list says. */
export function listEmptyText(id: MemoListId): string {
  if (id === FAVORITES) return 'No recordings are marked as favorites.';
  if (id === RECENTLY_DELETED) return 'Nothing is in Recently Deleted.';
  if (id.startsWith(FOLDER)) return 'This folder has no recordings.';
  return 'Every recording in this backup is in Recently Deleted.';
}

// ── Empty states ───────────────────────────────────────────────────────────

export interface EmptyCopy {
  /** 'error' and 'unsupported' get a Report button; 'empty' is calm. */
  kind: 'error' | 'unsupported' | 'empty';
  title: string;
  detail?: string;
}

/**
 * What the Voice Memos screen says when it has no recordings, from the engine's
 * answer. Never using Voice Memos is normal and calm; a database that can't be
 * read says so.
 */
export function emptyCopy(
  emptyReason: VoiceMemosEmptyReason | string | null | undefined,
  error: string | null | undefined,
): EmptyCopy {
  if (emptyReason === 'unsupported_format') {
    return { kind: 'unsupported', title: "This version of Voice Memos can't be read yet", detail: error || undefined };
  }
  if (error && emptyReason !== 'not_in_backup' && emptyReason !== 'no_records') {
    return { kind: 'error', title: "Couldn't read the voice memos", detail: error };
  }
  if (emptyReason === 'no_records') {
    return { kind: 'empty', title: 'No voice memos in this backup', detail: 'Voice Memos is on this iPhone, but it has no recordings.' };
  }
  return {
    kind: 'empty',
    title: 'No voice memos in this backup',
    detail: emptyReason === 'not_in_backup' ? "Voice Memos wasn't used on this iPhone, or its recordings weren't in the backup." : undefined,
  };
}

/** A search that finds nothing. */
export function noMatchCopy(query: string): { title: string; detail: string } {
  // Transcripts are read when a recording is opened, so search finds only those words
  return { title: `No recordings match "${query}"`, detail: "Try a recording's name or its folder. Transcripts are searched once you've opened the recording." };
}

// ── Saving ─────────────────────────────────────────────────────────────────

/** What a save says under "Saved …": what was written, and what couldn't be. */
export function voiceMemoSaveDetail(result: Partial<VoiceMemoExportResult>, format: VoiceMemoSaveFormat): string {
  const parts = [format === 'csv' ? 'A spreadsheet of the recordings' : 'Audio files, as recorded'];
  const missing = result.not_in_backup ?? 0;
  const failed = result.failed ?? 0;
  if (format === 'recordings' && missing > 0) {
    parts.push(`${count(missing, 'recording')} ${missing === 1 ? "wasn't" : "weren't"} in the backup`);
  }
  if (failed > 0) parts.push(`${count(failed, 'recording')} couldn't be copied`);
  return parts.join('. ');
}

// ── Home and details ───────────────────────────────────────────────────────

/** The overview numbers the home tile reads; an older engine sends none of them. */
export interface VoiceMemosOverview {
  /** Recordings not in Recently Deleted. */
  total_voice_memos?: number;
  total_voice_memo_seconds?: number;
  /** Recordings in Recently Deleted (an older engine doesn't send it). */
  total_deleted_voice_memos?: number;
  /** Listed recordings whose audio is in the backup (an older engine doesn't send it). */
  total_voice_memos_with_audio?: number;
  voice_memos_status?: VoiceMemosStatus;
}

/** Voice Memos is in the backup but couldn't be read: its tile still shows, with no number, to say why. */
export function voiceMemosUnreadable(o: VoiceMemosOverview | null | undefined): boolean {
  return o?.voice_memos_status === 'error' || o?.voice_memos_status === 'unsupported_format';
}

/** Every recording the screen lists and a save writes: those in Recently Deleted too. */
export function voiceMemosListed(o: VoiceMemosOverview | null | undefined): number {
  return (o?.total_voice_memos ?? 0) + (o?.total_deleted_voice_memos ?? 0);
}

/** Whether an "Audio files" save has anything to write: false only when the engine says no recording's audio is in the backup. */
export function voiceMemosAudioSaveable(o: VoiceMemosOverview | null | undefined): boolean {
  return (o?.total_voice_memos_with_audio ?? 1) > 0;
}

/** The home tile's line. */
export function voiceMemosHomeLine(o: VoiceMemosOverview): string {
  if (o.voice_memos_status === 'unsupported_format') return "This Voice Memos version can't be read yet";
  if (o.voice_memos_status === 'error') return "Couldn't be read: open it to see why";
  // Every recording was deleted on the iPhone, and the backup still has them
  if (!o.total_voice_memos && (o.total_deleted_voice_memos ?? 0) > 0) return 'In Recently Deleted';
  const length = aboutLength(o.total_voice_memo_seconds);
  if (length) return `${length} of recordings`;
  return 'Recordings from Voice Memos';
}
