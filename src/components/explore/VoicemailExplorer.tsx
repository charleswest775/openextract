import { useState, useEffect, useRef } from 'react';
import BenzAMRRecorder from 'benz-amr-recorder';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon } from '../shared/Icons';
import { formatDateTime, formatDuration } from '../../lib/dates';

interface Voicemail {
  id: number;
  phone_number: string;
  contact_name: string;
  date_received: string;
  duration: number;
  is_read: boolean;
  transcript: string;
}

interface AudioInfo {
  data: string;
  mime_type: string;
  voicemail_id: number;
}

interface PlayerState {
  isPlaying: boolean;
  isLoaded: boolean;
  duration: number;
  currentTime: number;
  error: string | null;
}

interface Props {
  udid: string;
}

function formatTime(seconds: number) {
  if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoicemailExplorer({ udid }: Props) {
  const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [audioCache, setAudioCache] = useState<Record<number, AudioInfo>>({});
  const [playerStates, setPlayerStates] = useState<Record<number, PlayerState>>({});
  const [exporting, setExporting] = useState(false);

  const playersRef = useRef<Record<number, BenzAMRRecorder>>({});
  const timersRef = useRef<Record<number, number>>({});

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
    try {
      const res = await window.openextract.call('list_voicemails', { udid });
      if (res.success && res.data) {
        setVoicemails(res.data.voicemails || []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function initPlayer(id: number, audio: AudioInfo) {
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

  async function toggleExpand(id: number) {
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
      if (res.success && res.data) {
        setAudioCache(prev => ({ ...prev, [id]: res.data }));
        await initPlayer(id, res.data);
      }
    } else if (!playersRef.current[id]) {
      await initPlayer(id, audioCache[id]);
    }
  }

  function togglePlay(id: number) {
    const player = playersRef.current[id];
    if (!player) return;
    if (player.isPlaying()) {
      player.pause();
    } else {
      player.play();
    }
  }

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    try {
      await window.openextract.call('export_voicemails', { udid, output_dir: outputDir });
      window.openextract.incrementExportCount();
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-900">
          Voicemail {voicemails.length > 0 && <span className="text-gray-400 font-normal">({voicemails.length})</span>}
        </h2>
        <button onClick={handleExport} disabled={exporting} className="p-1.5 rounded-md hover:bg-gray-100 transition-colors" title="Export all">
          <ExportIcon className="text-gray-500" size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="text-center py-8 text-sm text-gray-400">Loading voicemails...</div>}
        {!loading && voicemails.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No voicemails found</div>
        )}
        {voicemails.map((vm) => {
          const ps = playerStates[vm.id];
          const progress = ps && ps.duration > 0 ? (ps.currentTime / ps.duration) * 100 : 0;

          return (
            <div key={vm.id} className={`border-b border-gray-100 ${!vm.is_read ? 'bg-emerald-50/30' : ''}`}>
              <button
                onClick={() => toggleExpand(vm.id)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900">
                    {vm.contact_name || vm.phone_number}
                  </div>
                  <div className="text-xs text-gray-400">
                    {formatDateTime(vm.date_received)} · {formatDuration(vm.duration)}
                  </div>
                </div>
                <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded === vm.id ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {expanded === vm.id && (
                <div className="px-4 pb-3">
                  {ps?.error && (
                    <div className="text-sm text-red-500 mb-2">{ps.error}</div>
                  )}
                  {ps && !ps.isLoaded && !ps.error && (
                    <div className="text-sm text-gray-500 animate-pulse flex items-center h-10 px-2">Loading audio...</div>
                  )}
                  {!ps && audioCache[vm.id] && (
                    <div className="text-sm text-gray-500 animate-pulse flex items-center h-10 px-2">Loading audio...</div>
                  )}
                  {ps?.isLoaded && (
                    <div className="flex items-center gap-3 bg-gray-100 rounded-full px-3 py-2 w-full max-w-sm mb-2">
                      <button
                        onClick={() => togglePlay(vm.id)}
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex-shrink-0 transition-colors shadow-sm"
                        aria-label={ps.isPlaying ? 'Pause' : 'Play'}
                      >
                        {ps.isPlaying ? (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                      <span className="text-xs font-mono text-gray-600 tabular-nums w-10 text-right shrink-0">
                        {formatTime(ps.currentTime)}
                      </span>
                      <div className="flex-1 h-2 bg-gray-300 rounded-full overflow-hidden relative">
                        <div
                          className="absolute top-0 left-0 h-full bg-emerald-500 transition-all duration-100 ease-linear"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-gray-500 tabular-nums w-10 text-left shrink-0">
                        {formatTime(ps.duration)}
                      </span>
                    </div>
                  )}
                  {vm.transcript && (
                    <div className="border-l-2 border-emerald-300 pl-3 py-1">
                      <div className="text-xs text-gray-400 mb-1">Transcript</div>
                      <div className="text-sm text-gray-600 italic">{vm.transcript}</div>
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
