import { useState, useEffect } from 'react';
import { Loader2, AlertTriangle, Inbox, Download, ChevronDown, ChevronUp, Phone } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import AmrPlayer from './AmrPlayer';

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
    file_path?: string;
}

interface Props {
    backup: BackupInfo;
}

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VoicemailView({ backup }: Props) {
    const [voicemails, setVoicemails] = useState<Voicemail[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [expandedId, setExpandedId] = useState<number | null>(null);
    const [audioCache, setAudioCache] = useState<Record<number, AudioInfo>>({});
    const [loadingAudio, setLoadingAudio] = useState<number | null>(null);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        loadVoicemails();
    }, [backup.udid]);

    const [debugInfo, setDebugInfo] = useState<string>('');

    async function loadVoicemails() {
        setLoading(true);
        setError(null);
        try {
            const res = await window.openextract.call('list_voicemails', { udid: backup.udid });
            setDebugInfo(JSON.stringify(res, null, 2));
            if (!res.success) throw new Error(res.error);
            if (res.data?.error) throw new Error(res.data.error);

            setVoicemails(res.data?.voicemails || []);
        } catch (err: any) {
            setError(err.message || 'Failed to load voicemails');
        } finally {
            setLoading(false);
        }
    }

    const [audioError, setAudioError] = useState<string | null>(null);

    async function expandVoicemail(id: number) {
        if (expandedId === id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(id);
        setAudioError(null);

        if (!audioCache[id]) {
            setLoadingAudio(id);
            try {
                const res = await window.openextract.call('get_voicemail_audio', {
                    udid: backup.udid,
                    voicemail_id: id
                });
                if (res.success && res.data && res.data.data) {
                    setAudioCache(prev => ({ ...prev, [id]: res.data }));
                } else {
                    setAudioError(JSON.stringify(res.data || res.error || res));
                }
            } catch (err: any) {
                console.error('Failed to load audio', err);
                setAudioError(err.message || 'Unknown error');
            } finally {
                setLoadingAudio(null);
            }
        }
    }

    async function handleBulkExport() {
        setExporting(true);
        try {
            const folder = await window.openextract.saveFolder();
            if (!folder) return; // User cancelled

            const res = await window.openextract.call('export_voicemails', {
                udid: backup.udid,
                output_dir: folder
            });

            if (!res.success || res.data.error) {
                throw new Error(res.error || res.data.error);
            }

            alert(`Successfully exported ${res.data.exported} voicemails to ${folder}`);
        } catch (err: any) {
            alert('Export failed: ' + err.message);
        } finally {
            setExporting(false);
        }
    }

    function handleExportSingle(vm: Voicemail, audio: AudioInfo) {
        if (!audio || !audio.data) return;
        const a = document.createElement('a');
        a.href = `data:${audio.mime_type};base64,${audio.data}`;
        const filename = `${vm.contact_name.replace(/\\s+/g, '_')}_${vm.date_received.split('T')[0]}.amr`;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    return (
        <div className="flex flex-col h-full bg-base">
            <div className="flex items-center justify-between p-4" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                <h2 className="font-display text-title font-semibold text-text-primary">Voicemails</h2>
                <button
                    onClick={handleBulkExport}
                    disabled={exporting || voicemails.length === 0}
                    className="px-4 py-2 bg-accent text-white rounded-lg shadow-subtle text-body font-medium hover:bg-accent-hover disabled:opacity-50 transition-colors duration-200 flex items-center gap-2"
                >
                    <Download className="w-4 h-4" />
                    {exporting ? 'Exporting...' : 'Bulk Export CSV & Audio'}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-surface">
                {loading && (
                    <div className="flex items-center justify-center text-text-secondary py-10 gap-2">
                        <Loader2 className="w-5 h-5 animate-spin text-text-accent" />
                        <span className="text-body">Loading voicemails...</span>
                    </div>
                )}
                {error && (
                    <div className="flex flex-col items-center text-apple-error py-10 gap-2">
                        <AlertTriangle className="w-6 h-6" />
                        <span className="text-body">{error}</span>
                    </div>
                )}

                {!loading && voicemails.length === 0 && !error && (
                    <div className="text-center text-text-secondary py-10">
                        <Inbox className="w-10 h-10 mx-auto mb-3 text-text-tertiary opacity-50" />
                        <p className="text-body">No voicemails found in this backup.</p>
                        <pre className="text-caption text-left overflow-auto mt-4 p-2 bg-elevated rounded-lg font-mono">{debugInfo}</pre>
                    </div>
                )}

                <div className="max-w-4xl mx-auto space-y-4">
                    {voicemails.map(vm => {
                        const isExpanded = expandedId === vm.id;
                        const audioData = audioCache[vm.id];

                        return (
                            <div
                                key={vm.id}
                                className={`bg-base rounded-lg overflow-hidden transition-all duration-250
                  ${vm.is_read ? '' : 'bg-accent-subtle'}
                  ${isExpanded ? 'shadow-elevated' : 'shadow-card hover:shadow-elevated'}`}
                                style={{ border: '0.5px solid var(--border-default)' }}
                            >
                                {/* Header row, clickable */}
                                <div
                                    className="p-4 flex flex-wrap items-center justify-between cursor-pointer select-none"
                                    onClick={() => expandVoicemail(vm.id)}
                                >
                                    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                                        <span className="font-semibold text-text-primary text-subhead flex items-center gap-2">
                                            <Phone className="w-4 h-4 text-text-accent" />
                                            {vm.contact_name}
                                        </span>
                                        {vm.contact_name !== vm.phone_number && vm.phone_number && (
                                            <span className="text-body text-text-secondary">{vm.phone_number}</span>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-4 text-body text-text-secondary mt-2 sm:mt-0">
                                        <span className="tabular-nums">
                                            {vm.date_received ? new Date(vm.date_received).toLocaleString() : 'Unknown date'}
                                        </span>
                                        <span className="font-mono bg-elevated px-2 py-0.5 rounded text-caption">
                                            {formatDuration(vm.duration)}
                                        </span>
                                        {isExpanded
                                            ? <ChevronUp className="w-4 h-4 text-text-tertiary" />
                                            : <ChevronDown className="w-4 h-4 text-text-tertiary" />
                                        }
                                    </div>
                                </div>

                                {/* Expanded detail view */}
                                {isExpanded && (
                                    <div className="p-4 bg-surface animate-in fade-in slide-in-from-top-2" style={{ borderTop: '0.5px solid var(--border-subtle)' }}>

                                        {vm.transcript ? (
                                            <div className="mb-4">
                                                <h4 className="text-caption font-semibold text-text-tertiary uppercase tracking-wider mb-2">Transcript</h4>
                                                <p className="text-body text-text-secondary italic pl-3 py-1" style={{ borderLeft: '2px solid var(--accent)' }}>
                                                    "{vm.transcript}"
                                                </p>
                                            </div>
                                        ) : (
                                            <div className="mb-4 text-body text-text-tertiary italic">No transcript available</div>
                                        )}

                                        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-4 pt-4" style={{ borderTop: '0.5px solid var(--border-subtle)' }}>
                                            <div className="flex-1 min-w-[200px] flex items-center">
                                                {loadingAudio === vm.id ? (
                                                    <div className="text-caption text-text-accent animate-pulse flex items-center gap-1.5">
                                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        Loading audio...
                                                    </div>
                                                ) : audioData ? (
                                                    <AmrPlayer base64Data={audioData.data} mimeType={audioData.mime_type} />
                                                ) : (
                                                    <div className="text-caption text-apple-error max-w-sm overflow-auto">
                                                        {audioError ? `Error: ${audioError}` : 'Audio file not found'}
                                                    </div>
                                                )}
                                            </div>

                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (audioData) handleExportSingle(vm, audioData);
                                                }}
                                                disabled={!audioData}
                                                className="px-3 py-1.5 bg-elevated hover:bg-surface text-text-primary text-body font-medium rounded-lg transition-colors duration-200 disabled:opacity-50 flex items-center gap-1.5"
                                                style={{ border: '0.5px solid var(--border-default)' }}
                                            >
                                                <Download className="w-3.5 h-3.5" />
                                                Export Audio
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
