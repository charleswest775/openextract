import { useState, useEffect, useMemo, useRef } from 'react';
import BenzAMRRecorder from 'benz-amr-recorder';
import { ChevronDown } from 'lucide-react';
import { exportFolder, sidecarCall } from '../../lib/ipc';
import { VoicemailIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { formatDateTime, formatDuration } from '../../lib/dates';
import { displayName } from '../../lib/people';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import { SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { checkEngineResult, plural } from '../../lib/saveData';
import { matches } from '../../lib/search';
import Highlight from '../shared/Highlight';

/** The list the Phone app shows a voicemail in. */
type Folder = 'voicemail' | 'spam' | 'deleted';

/** A ROWID in the main voicemail store, or "<account folder>.<ROWID>" for a per-account one. */
type VoicemailId = number | string;

interface Voicemail {
  id: VoicemailId;
  phone_number: string;
  contact_name: string;
  date_received: string;
  duration: number;
  is_read: boolean;
  transcript: string;
  folder?: Folder;
}

interface AudioInfo {
  data: string;
  mime_type: string;
  voicemail_id: VoicemailId;
}

const FOLDERS: { id: Folder; label: string; note?: string }[] = [
  { id: 'voicemail', label: 'Voicemail' },
  { id: 'spam', label: 'Spam', note: 'Voicemails the iPhone put in Spam.' },
  { id: 'deleted', label: 'Deleted', note: 'Voicemails deleted on the iPhone that are still in this backup.' },
];

const folderOf = (vm: Voicemail): Folder => vm.folder ?? 'voicemail';

interface PlayerState {
  isPlaying: boolean;
  isLoaded: boolean;
  duration: number;
  currentTime: number;
  error: string | null;
}

interface Props {
  udid: string;
  /** What the top search box holds; the list shows only voicemail that matches. */
  query: string;
  /** The voicemail a search found, as a timeline id ("voicemail:7"): opened and scrolled to. */
  selectId?: string;
}

function formatTime(seconds: number) {
  if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoicemailExplorer({ udid, query, selectId }: Props) {
  const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
  const [loading, setLoading] = useState(false);
  const [folder, setFolder] = useState<Folder>('voicemail');
  const [expanded, setExpanded] = useState<VoicemailId | null>(null);
  const [audioCache, setAudioCache] = useState<Record<string, AudioInfo>>({});
  const [playerStates, setPlayerStates] = useState<Record<string, PlayerState>>({});
  const { busy, run } = useSaveAction('voicemail');
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  const playersRef = useRef<Record<string, BenzAMRRecorder>>({});
  const timersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    loadVoicemails();
  }, [udid]);

  // Cleanup all players on unmount
  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(t => window.clearInterval(t));
      Object.values(playersRef.current).forEach(p => { try { p.stop(); } catch {} });
    };
  }, []);

  async function loadVoicemails() {
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    try {
      const res = await window.openextract.call('list_voicemails', { udid, include_deleted: true });
      if (!res.success) {
        setVoicemails([]);
        setError(res.error || 'Failed to load voicemails');
      } else if (res.data) {
        const list: Voicemail[] = res.data.voicemails || [];
        setVoicemails(list);
        setEmptyReason(res.data.empty_reason ?? null);
        if (res.data.error) setError(res.data.error);
        // Opened from a search: play-ready, with its transcript showing
        const found = list.find(vm => `voicemail:${vm.id}` === selectId);
        if (found) {
          setFolder(folderOf(found));
          toggleExpand(found.id);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  async function initPlayer(id: VoicemailId, audio: AudioInfo) {
    try {
      const binStr = atob(audio.data);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);

      const blob = new Blob([bytes], { type: audio.mime_type });
      const amr = new BenzAMRRecorder();
      await amr.initWithBlob(blob);

      playersRef.current[id] = amr;
      setPlayerStates(prev => ({
        ...prev,
        [id]: { isPlaying: false, isLoaded: true, duration: amr.getDuration(), currentTime: 0, error: null },
      }));

      amr.onPlay(() => {
        setPlayerStates(prev => ({ ...prev, [id]: { ...prev[id], isPlaying: true } }));
        timersRef.current[id] = window.setInterval(() => {
          setPlayerStates(prev => ({
            ...prev,
            [id]: { ...prev[id], currentTime: playersRef.current[id]?.getCurrentPosition() || 0 },
          }));
        }, 100);
      });
      amr.onPause(() => {
        setPlayerStates(prev => ({ ...prev, [id]: { ...prev[id], isPlaying: false } }));
        if (timersRef.current[id]) { window.clearInterval(timersRef.current[id]); delete timersRef.current[id]; }
      });
      const onStop = () => {
        setPlayerStates(prev => ({ ...prev, [id]: { ...prev[id], isPlaying: false, currentTime: 0 } }));
        if (timersRef.current[id]) { window.clearInterval(timersRef.current[id]); delete timersRef.current[id]; }
      };
      amr.onStop(onStop);
      amr.onEnded(onStop);
    } catch (err: any) {
      console.error('Failed to initialize AMR player:', err);
      setPlayerStates(prev => ({
        ...prev,
        [id]: { isPlaying: false, isLoaded: false, duration: 0, currentTime: 0, error: 'Unable to load audio' },
      }));
    }
  }

  async function toggleExpand(id: VoicemailId) {
    // Stop any currently playing audio when collapsing or switching
    if (expanded !== null && playersRef.current[expanded]) {
      try { playersRef.current[expanded].stop(); } catch {}
    }

    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);

    if (!audioCache[id]) {
      const res = await window.openextract.call('get_voicemail_audio', { udid, voicemail_id: id });
      if (res.success && res.data?.data) {
        setAudioCache(prev => ({ ...prev, [id]: res.data }));
        await initPlayer(id, res.data);
      } else {
        // OE-85: a voicemail listed in voicemail.db whose audio file isn't in the backup
        const reason = res.data?.error || res.error || "Couldn't load this voicemail's audio.";
        setPlayerStates(prev => ({
          ...prev,
          [id]: { isPlaying: false, isLoaded: false, duration: 0, currentTime: 0, error: reason },
        }));
      }
    } else if (!playersRef.current[id]) {
      await initPlayer(id, audioCache[id]);
    }
  }

  function togglePlay(id: VoicemailId) {
    const player = playersRef.current[id];
    if (!player) return;
    if (player.isPlaying()) {
      player.pause();
    } else {
      player.play();
    }
  }

  function handleSave() {
    run(async () => {
      const outputDir = await exportFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<{ exported: number; path?: string }>(
        'export_voicemails', { udid, output_dir: outputDir },
      ));
      return {
        title: `Saved ${plural(result.exported, 'voicemail')}`,
        detail: counts.spam || counts.deleted ? 'Audio files, with spam and deleted ones in their own folders' : 'Audio files',
        path: result.path ?? outputDir,
      };
    });
  }

  const counts = useMemo(() => {
    const c: Record<Folder, number> = { voicemail: 0, spam: 0, deleted: 0 };
    for (const vm of voicemails) c[folderOf(vm)] += 1;
    return c;
  }, [voicemails]);

  const inFolder = useMemo(() => voicemails.filter(vm => folderOf(vm) === folder), [voicemails, folder]);

  const shown = useMemo(
    () => inFolder.filter(vm => `voicemail:${vm.id}` === selectId
      || matches(query, vm.contact_name, vm.phone_number, vm.transcript, 'voicemail')),
    [inFolder, query, selectId],
  );

  function chooseFolder(next: Folder) {
    if (next === folder) return;
    if (expanded !== null && playersRef.current[expanded]) {
      try { playersRef.current[expanded].stop(); } catch {}
    }
    setExpanded(null);
    setFolder(next);
  }

  const folderTabs = FOLDERS.filter(f => f.id === 'voicemail' || counts[f.id] > 0);
  const folderNote = FOLDERS.find(f => f.id === folder)?.note;
  const noun = folder === 'voicemail' ? 'voicemail' : folder === 'spam' ? 'spam voicemail' : 'deleted voicemail';

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Voicemail"
        count={inFolder.length > 0
          ? (query ? `${shown.length} of ${plural(inFolder.length, noun)}` : plural(inFolder.length, noun))
          : undefined}
        actions={<SaveButton onClick={handleSave} busy={busy} disabled={voicemails.length === 0} label="Save all" />}
      />
      {!loading && folderTabs.length > 1 && (
        <div className="px-6 py-3 border-b border-rule">
          <div role="group" aria-label="Which voicemails" className="inline-flex rounded-full border border-rule bg-surface p-0.5">
            {folderTabs.map(f => (
              <button
                key={f.id}
                type="button"
                aria-pressed={folder === f.id}
                onClick={() => chooseFolder(f.id)}
                className={`px-3.5 py-1 rounded-full text-sm transition-colors ${
                  folder === f.id ? 'bg-accent-wash text-accent font-medium' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label} <span className="tabular-nums">{counts[f.id].toLocaleString()}</span>
              </button>
            ))}
          </div>
          {folderNote && <div className="mt-2 text-sm text-text-tertiary">{folderNote}</div>}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && voicemails.length === 0 && (
          error ? (
            <EmptyState
              icon={VoicemailIcon}
              title="Couldn't read the voicemail"
              detail={<>{error}<div><ReportProblemButton error={error} area="voicemail" className="mt-2" /></div></>}
            />
          ) : (
            <EmptyState
              icon={VoicemailIcon}
              title="No voicemails in this backup"
              detail={emptyReason === 'not_in_backup'
                ? 'iPhones only keep voicemail when the carrier supports Visual Voicemail.'
                : undefined}
            />
          )
        )}
        {!loading && voicemails.length > 0 && inFolder.length === 0 && (
          <EmptyState
            icon={VoicemailIcon}
            title="No voicemails in this list"
            detail="This backup's voicemails are under Spam or Deleted."
          />
        )}
        {!loading && inFolder.length > 0 && shown.length === 0 && (
          <EmptyState icon={VoicemailIcon} title={`No voicemail matches "${query}"`} detail="Try a name, a number or a word they said." />
        )}
        {shown.map((vm) => {
          const ps = playerStates[vm.id];
          const progress = ps && ps.duration > 0 ? (ps.currentTime / ps.duration) * 100 : 0;

          return (
            <div
              key={vm.id}
              ref={`voicemail:${vm.id}` === selectId ? el => el?.scrollIntoView({ block: 'center' }) : undefined}
              className={`border-b border-rule ${`voicemail:${vm.id}` === selectId ? 'bg-accent-wash' : ''}`}
            >
              <button
                onClick={() => toggleExpand(vm.id)}
                aria-expanded={expanded === vm.id}
                className="w-full px-6 py-3.5 flex items-center gap-4 text-left hover:bg-surface transition-colors"
              >
                <span className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                  vm.is_read ? 'bg-sand text-text-secondary' : 'bg-accent-wash text-accent'
                }`}>
                  <VoicemailIcon size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium text-text-primary">
                    <Highlight text={displayName(vm.contact_name, vm.phone_number)} query={query} />
                    {!vm.is_read && <span className="ml-2 text-xs font-medium text-accent">Unheard</span>}
                  </div>
                  <div className="text-sm text-text-secondary">
                    {formatDateTime(vm.date_received)} · {formatDuration(vm.duration)}
                  </div>
                </div>
                <ChevronDown size={20} className={`text-text-tertiary transition-transform ${expanded === vm.id ? 'rotate-180' : ''}`} />
              </button>
              {expanded === vm.id && (
                <div className="pl-[80px] pr-6 pb-4">
                  {ps?.error && (
                    <div className="text-sm text-apple-error mb-2">{ps.error}</div>
                  )}
                  {ps && !ps.isLoaded && !ps.error && (
                    <div className="text-sm text-gray-500 animate-pulse flex items-center h-10 px-2">Loading audio...</div>
                  )}
                  {!ps && audioCache[vm.id] && (
                    <div className="text-sm text-gray-500 animate-pulse flex items-center h-10 px-2">Loading audio...</div>
                  )}
                  {ps?.isLoaded && (
                    <div className="flex items-center gap-3 bg-sand rounded-full px-3 py-2 w-full max-w-md mb-2">
                      <button
                        onClick={() => togglePlay(vm.id)}
                        className="w-10 h-10 flex items-center justify-center rounded-full bg-accent hover:bg-accent-hover text-white flex-shrink-0 transition-colors shadow-sm"
                        aria-label={ps.isPlaying ? 'Pause' : 'Play'}
                      >
                        {ps.isPlaying ? (
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                          </svg>
                        ) : (
                          <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                      <span className="text-xs font-mono text-gray-600 tabular-nums w-10 text-right shrink-0">
                        {formatTime(ps.currentTime)}
                      </span>
                      <div className="flex-1 h-2 bg-gray-300 rounded-full overflow-hidden relative">
                        <div
                          className="absolute top-0 left-0 h-full bg-accent transition-all duration-100 ease-linear"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-gray-500 tabular-nums w-10 text-left shrink-0">
                        {formatTime(ps.duration)}
                      </span>
                    </div>
                  )}
                  {vm.transcript && (
                    <div className="border-l-2 border-accent-line pl-3 py-1">
                      <div className="text-xs text-text-tertiary mb-1">Transcript</div>
                      <div className="text-sm text-text-primary italic"><Highlight text={vm.transcript} query={query} /></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
