import { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { VoiceMemoIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import Highlight from '../shared/Highlight';
import { useSaveAction } from '../../hooks/useSaveAction';
import { plural, saveVoiceMemos } from '../../lib/saveData';
import { matches } from '../../lib/search';
import { handOver } from '../../lib/openFile';
import {
  ALL_RECORDINGS, DELETED_NOTE, RECENTLY_DELETED, aboutLength, allLists, emptyCopy, homeListOf, listEmptyText, memoChips,
  memoLine, memoLists, memoMatchFields, memoName, memoSelectId, missingAudioText, noMatchCopy, type MemoList, type MemoListId,
} from '../../lib/voiceMemos';
import type {
  VoiceMemo, VoiceMemoAudioResult, VoiceMemoFolder, VoiceMemoSaveFormat, VoiceMemoTranscriptResult, VoiceMemosResult,
} from '../../types/voiceMemos';

interface Props {
  udid: string;
  /** What the top search box holds; the list shows only recordings that match. */
  query: string;
  /** The recording a search found ("voice_memo:12"): opened, in its list, and scrolled to. */
  selectId?: string;
}

/** The open recording's sound: loading, playing from memory, or why it can't play here. */
type Player =
  | { id: number; kind: 'loading' }
  | { id: number; kind: 'ready'; url: string }
  | { id: number; kind: 'cant-play' }
  | { id: number; kind: 'too-large' }
  | { id: number; kind: 'missing'; text: string }
  | { id: number; kind: 'problem'; text: string };

/** A transcript as the engine answered it; undefined while it's read. */
interface Transcript {
  text: string | null;
  error: string | null;
}

// A long list is shown a page at a time
const PAGE = 200;

/**
 * The Voice Memos app's recordings (CloudRecordings.db), with a sidebar like
 * the app's: All Recordings, Favorites, the folders made on the iPhone, and
 * Recently Deleted. Opening a recording reads its audio from the backup and
 * plays it from memory (a blob: URL, freed when the recording closes or the
 * screen goes); a kind the computer can't play, or one too long to hold in
 * memory, opens in another app instead. A recording whose audio isn't in the
 * backup (kept in iCloud only) says so and is never asked for.
 */
export default function VoiceMemoExplorer({ udid, query, selectId }: Props) {
  const [memos, setMemos] = useState<VoiceMemo[]>([]);
  const [folders, setFolders] = useState<VoiceMemoFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [listId, setListId] = useState<MemoListId>(ALL_RECORDINGS);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  // "Opening…", or what happened when a recording was handed to another app, by recording
  const [opening, setOpening] = useState<Record<number, string | null>>({});
  const [transcripts, setTranscripts] = useState<Record<number, Transcript>>({});
  const askedTranscript = useRef<Set<number>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('voice_memos');
  // The blob: URL holding the open recording's sound, and which recording's sound is wanted
  const audioUrl = useRef<string | null>(null);
  const wanted = useRef<number | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    loadMemos();
  }, [udid]);

  // A blob URL holds the whole recording in memory until it's let go: let it go when the screen does
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      wanted.current = null;
      freeAudio();
    };
  }, []);

  function freeAudio() {
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
  }

  async function loadMemos() {
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    try {
      const res = await window.openextract.call('list_voice_memos', { udid });
      if (!res.success) {
        setMemos([]);
        setError(res.error || "The voice memos couldn't be read.");
      } else if (res.data) {
        const data = res.data as VoiceMemosResult;
        const list = Array.isArray(data.voice_memos) ? data.voice_memos : [];
        setMemos(list);
        setFolders(Array.isArray(data.folders) ? data.folders : []);
        setEmptyReason(data.empty_reason ?? null);
        if (data.error) setError(data.error);
        const found = list.find(m => memoSelectId(m) === selectId);
        if (found) {
          setListId(homeListOf(found));
          open(found);
        } else if (list.length > 0 && list.every(m => m.is_deleted)) {
          setListId(RECENTLY_DELETED);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  /** Close the open recording: its sound stops (the player goes) and is let go. */
  function close() {
    wanted.current = null;
    freeAudio();
    setPlayer(null);
    setExpanded(null);
  }

  function toggle(memo: VoiceMemo) {
    if (expanded === memo.id) close();
    else open(memo);
  }

  function open(memo: VoiceMemo) {
    freeAudio();
    setExpanded(memo.id);
    wanted.current = memo.id;
    loadAudio(memo);
    loadTranscript(memo);
  }

  async function loadAudio(memo: VoiceMemo) {
    // Not in the backup: say so, and don't ask the engine for it
    if (!memo.audio_available) {
      setPlayer({ id: memo.id, kind: 'missing', text: missingAudioText(memo.audio_missing_reason) });
      return;
    }
    setPlayer({ id: memo.id, kind: 'loading' });
    let next: Player;
    try {
      const res = await window.openextract.call('get_voice_memo_audio', { udid, memo_id: memo.id });
      // Closed, another recording opened, or the screen gone while it loaded: nothing would let a blob go
      if (!alive.current || wanted.current !== memo.id) return;
      const data = res.data as VoiceMemoAudioResult | undefined;
      if (!res.success) next = { id: memo.id, kind: 'problem', text: res.error || "The recording couldn't be read." };
      else if (data?.empty_reason) next = { id: memo.id, kind: 'missing', text: data.error || missingAudioText(data.empty_reason) };
      else if (data?.error) next = { id: memo.id, kind: 'problem', text: data.error };
      else if (data?.too_large) {
        next = { id: memo.id, kind: 'too-large' };
        openInApp(memo);
      } else if (!data?.data) next = { id: memo.id, kind: 'problem', text: "The recording couldn't be read." };
      else {
        const bin = atob(data.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        freeAudio();
        audioUrl.current = URL.createObjectURL(new Blob([bytes], { type: data.mime_type || 'audio/mp4' }));
        next = { id: memo.id, kind: 'ready', url: audioUrl.current };
      }
    } catch (err: any) {
      if (!alive.current || wanted.current !== memo.id) return;
      next = { id: memo.id, kind: 'problem', text: err?.message || String(err) };
    }
    setPlayer(next);
  }

  /** The sound couldn't play here (a kind Chromium doesn't know): offer another app, and let the sound go. */
  function cantPlay(memo: VoiceMemo) {
    freeAudio();
    setPlayer({ id: memo.id, kind: 'cant-play' });
  }

  /** Copy the recording out under its own name and open it in the computer's own app. */
  async function openInApp(memo: VoiceMemo) {
    setOpening(prev => ({ ...prev, [memo.id]: 'Opening…' }));
    let said: string | null;
    try {
      const res = await window.openextract.call('get_voice_memo_audio', { udid, memo_id: memo.id, as_file: true });
      said = await handOver(res.success ? (res.data as VoiceMemoAudioResult) : { error: res.error || "The recording couldn't be copied." }, window.openextract);
    } catch (err: any) {
      said = err?.message || String(err);
    }
    if (alive.current) setOpening(prev => ({ ...prev, [memo.id]: said }));
  }

  async function loadTranscript(memo: VoiceMemo) {
    // The transcript is inside the audio file: none to read when the file isn't in the backup
    if (!memo.has_transcript || !memo.audio_available || askedTranscript.current.has(memo.id)) return;
    askedTranscript.current.add(memo.id);
    let result: Transcript;
    try {
      const res = await window.openextract.call('get_voice_memo_transcript', { udid, memo_id: memo.id });
      const data = res.data as VoiceMemoTranscriptResult | undefined;
      result = !res.success
        ? { text: null, error: res.error || "The transcript couldn't be read." }
        : data?.error ? { text: null, error: data.error } : { text: data?.text?.trim() || null, error: null };
    } catch (err: any) {
      result = { text: null, error: err?.message || String(err) };
    }
    if (result.error) askedTranscript.current.delete(memo.id); // asked again the next time it's opened
    if (alive.current) setTranscripts(prev => ({ ...prev, [memo.id]: result }));
  }

  const lists = useMemo(() => memoLists(memos, folders), [memos, folders]);
  const every = allLists(lists);
  const current: MemoList = every.find(l => l.id === listId) ?? lists.all;
  const keep = (m: VoiceMemo) => memoSelectId(m) === selectId || matches(query, ...memoMatchFields(m, transcripts[m.id]?.text));
  const shown = useMemo(() => current.memos.filter(keep), [current, query, transcripts, selectId]);

  useEffect(() => { setLimit(PAGE); }, [listId]);

  // A search that hides the open recording closes it, so its sound isn't held in memory unseen
  const hidden = expanded !== null && !shown.some(m => m.id === expanded);
  useEffect(() => { if (hidden) close(); }, [hidden]);

  function chooseList(id: MemoListId) {
    if (id === current.id) return;
    close();
    setListId(id);
  }

  function save(format: VoiceMemoSaveFormat) {
    setChoosing(false);
    run(() => saveVoiceMemos(udid, format));
  }

  function saveOne(memo: VoiceMemo) {
    run(() => saveVoiceMemos(udid, 'recordings', { memoIds: [memo.id], name: memoName(memo) }));
  }

  const countOf = (l: MemoList) => (query ? l.memos.filter(keep).length : l.memos.length);
  const length = aboutLength(current.memos.reduce((n, m) => n + (m.duration_seconds ?? 0), 0));
  const inFolder = current.id.startsWith('folder:');

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Voice Memos"
        count={memos.length > 0
          ? (query ? `${shown.length} of ${plural(current.memos.length, 'recording')}` : plural(current.memos.length, 'recording'))
          : undefined}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={memos.length === 0} label="Save" />}
      />
      {loading && (
        <div className="flex justify-center py-12 text-accent">
          <OrganicLoader size={72} />
        </div>
      )}
      {!loading && memos.length === 0 && (
        <div className="flex-1 overflow-y-auto">
          <VoiceMemosEmpty emptyReason={emptyReason} error={error} />
        </div>
      )}
      {!loading && memos.length > 0 && (
        <div className="flex-1 flex min-h-0">
          <nav aria-label="Voice memo lists" className="w-[240px] flex-shrink-0 border-r border-rule overflow-y-auto py-2 px-2">
            <SidebarButton title={lists.all.label} count={countOf(lists.all)} current={current.id === lists.all.id} onClick={() => chooseList(lists.all.id)} />
            {lists.favorites && (
              <SidebarButton title={lists.favorites.label} count={countOf(lists.favorites)} current={current.id === lists.favorites.id} onClick={() => chooseList(lists.favorites!.id)} />
            )}
            {lists.folders.length > 0 && <SidebarHeading>My folders</SidebarHeading>}
            {lists.folders.map(f => (
              <SidebarButton key={f.id} title={f.label} count={countOf(f)} current={current.id === f.id} onClick={() => chooseList(f.id)} />
            ))}
            {lists.deleted && (
              <div className="mt-3 pt-2 border-t border-rule">
                <SidebarButton quiet title={lists.deleted.label} count={countOf(lists.deleted)} current={current.id === lists.deleted.id} onClick={() => chooseList(lists.deleted!.id)} />
              </div>
            )}
          </nav>

          <section aria-label={current.label} className="flex-1 min-w-0 overflow-y-auto">
            <div className="px-6 pt-5 pb-3 border-b border-rule">
              <h2 className="text-2xl text-text-primary">{current.label}</h2>
              <div className="text-sm text-text-secondary mt-0.5">
                {[plural(current.memos.length, 'recording'), length].filter(Boolean).join(' · ')}
              </div>
            </div>
            {current.id === RECENTLY_DELETED && (
              <p className="px-6 py-3 text-xs text-text-tertiary border-b border-rule">{DELETED_NOTE}</p>
            )}
            {current.memos.length === 0 && (
              <div className="px-6 py-8 text-sm text-text-secondary">{listEmptyText(current.id)}</div>
            )}
            {current.memos.length > 0 && shown.length === 0 && (
              <div className="text-center px-6 py-8">
                <div className="text-sm text-text-primary">{noMatchCopy(query).title}</div>
                <div className="text-xs text-text-secondary mt-1">{noMatchCopy(query).detail}</div>
              </div>
            )}
            {shown.length > 0 && (
              <ul>
                {shown.slice(0, limit).map(m => (
                  <MemoRow
                    key={m.id}
                    memo={m}
                    query={query}
                    open={expanded === m.id}
                    found={memoSelectId(m) === selectId}
                    showFolder={!inFolder}
                    player={player?.id === m.id ? player : null}
                    opening={opening[m.id] ?? null}
                    transcript={transcripts[m.id]}
                    onToggle={() => toggle(m)}
                    onSave={() => saveOne(m)}
                    onOpenInApp={() => openInApp(m)}
                    onCantPlay={() => cantPlay(m)}
                  />
                ))}
              </ul>
            )}
            {shown.length > limit && (
              <div className="px-6 py-4">
                <button type="button" className="hearth-ghost-btn" onClick={() => setLimit(n => n + PAGE)}>
                  Show {Math.min(PAGE, shown.length - limit).toLocaleString()} more of {plural(shown.length, 'recording')}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {choosing && (
        <SaveDialog
          title="Save your voice memos"
          formats={memos.some(m => m.audio_available) ? [FORMATS.recordings, FORMATS.csv] : [FORMATS.csv]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** Why the screen has no recordings: calm when Voice Memos wasn't used, the error and a Report button when it can't be read. */
function VoiceMemosEmpty({ emptyReason, error }: { emptyReason: string | null; error: string | null }) {
  const copy = emptyCopy(emptyReason, error);
  const report = copy.kind !== 'empty';
  return (
    <EmptyState
      icon={VoiceMemoIcon}
      title={copy.title}
      detail={copy.detail || report ? (
        <>
          {copy.detail}
          {report && <div><ReportProblemButton error={error || copy.title} area="voice_memos" className="mt-2" /></div>}
        </>
      ) : undefined}
    />
  );
}

function SidebarHeading({ children }: { children: string }) {
  return <h3 className="hearth-eyebrow px-3 pt-4 pb-1">{children}</h3>;
}

function SidebarButton({ title, count, current, onClick, quiet = false }: {
  title: string;
  count: number;
  current: boolean;
  onClick: () => void;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      title={title}
      className={`w-full py-2 px-3 rounded-lg text-left text-sm flex justify-between ${
        current ? 'bg-accent-wash font-medium' : 'hover:bg-surface'
      } ${quiet ? 'text-text-secondary' : 'text-text-primary'}`}
    >
      <span className="truncate">{title}</span>
      {count > 0 && <span className="text-xs text-text-tertiary flex-shrink-0 ml-1 tabular-nums">{count.toLocaleString()}</span>}
    </button>
  );
}

function MemoRow({ memo, query, open, found, showFolder, player, opening, transcript, onToggle, onSave, onOpenInApp, onCantPlay }: {
  memo: VoiceMemo;
  query: string;
  open: boolean;
  /** The recording a search found: tinted and scrolled to. */
  found: boolean;
  showFolder: boolean;
  player: Player | null;
  opening: string | null;
  transcript: Transcript | undefined;
  onToggle: () => void;
  onSave: () => void;
  onOpenInApp: () => void;
  onCantPlay: () => void;
}) {
  const name = memoName(memo);
  const chips = memoChips(memo);
  return (
    <li
      ref={found ? el => el?.scrollIntoView?.({ block: 'center' }) : undefined}
      className={`border-b border-rule ${found ? 'bg-accent-wash' : ''}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-6 py-3.5 flex items-center gap-4 text-left hover:bg-surface transition-colors"
      >
        <span className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
          memo.audio_available && !memo.is_deleted ? 'bg-accent-wash text-accent' : 'bg-sand text-text-secondary'
        }`}>
          <VoiceMemoIcon size={20} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[16px] font-medium text-text-primary truncate"><Highlight text={name} query={query} /></div>
          <div className="text-sm text-text-secondary">{memoLine(memo, { showFolder })}</div>
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {chips.map(c => (
                <span key={c} className="px-2 py-0.5 rounded-full bg-sand text-xs text-text-secondary">{c}</span>
              ))}
            </div>
          )}
        </div>
        <ChevronDown size={20} className={`text-text-tertiary transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="pl-[80px] pr-6 pb-4 flex flex-col gap-3">
          <Sound memo={memo} player={player} onCantPlay={onCantPlay} />
          {memo.audio_available && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="hearth-ghost-btn !px-3 !py-1.5"
                aria-label={`Open "${name}" in another app`}
                onClick={onOpenInApp}
              >
                Open in another app
              </button>
              <button
                type="button"
                className="hearth-ghost-btn !px-3 !py-1.5"
                aria-label={`Save "${name}"`}
                onClick={onSave}
              >
                Save
              </button>
            </div>
          )}
          {opening && <div role="status" className="text-sm text-text-secondary">{opening}</div>}
          {memo.has_transcript && memo.audio_available && (
            <TranscriptBlock transcript={transcript} query={query} />
          )}
        </div>
      )}
    </li>
  );
}

/** The player, or what's said instead of one. */
function Sound({ memo, player, onCantPlay }: { memo: VoiceMemo; player: Player | null; onCantPlay: () => void }) {
  if (!player || player.kind === 'loading') {
    return <div className="text-sm text-text-tertiary h-10 flex items-center">Loading the recording…</div>;
  }
  switch (player.kind) {
    case 'ready':
      return (
        <audio
          controls
          src={player.url}
          aria-label={`Recording: ${memoName(memo)}`}
          className="w-full max-w-md"
          onError={onCantPlay}
        />
      );
    case 'cant-play':
      return <div className="text-sm text-text-secondary">This kind of recording can't play here. Open it in another app to listen.</div>;
    case 'too-large':
      return <div className="text-sm text-text-secondary">This recording is too long to play here, so it opens in another app.</div>;
    case 'missing':
      return <div className="text-sm text-text-secondary">{player.text}</div>;
    case 'problem':
      return (
        <div className="text-sm text-apple-error">
          Couldn't load the recording: {player.text}
          <div><ReportProblemButton error={player.text} area="voice_memos" className="mt-1" /></div>
        </div>
      );
  }
}

function TranscriptBlock({ transcript, query }: { transcript: Transcript | undefined; query: string }) {
  if (!transcript) return <div className="text-sm text-text-tertiary">Reading the transcript…</div>;
  if (transcript.error) return <div className="text-sm text-text-secondary">Couldn't read the transcript: {transcript.error}</div>;
  if (!transcript.text) return null;
  return (
    <div className="border-l-2 border-accent-line pl-3 py-1 max-w-2xl">
      <div className="text-xs text-text-tertiary mb-1">Transcript</div>
      <div className="text-sm text-text-primary whitespace-pre-wrap"><Highlight text={transcript.text} query={query} /></div>
    </div>
  );
}
