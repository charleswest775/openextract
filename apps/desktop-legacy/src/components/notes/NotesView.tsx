import { useState, useEffect } from 'react';
import { Search, Loader2, AlertTriangle, FileText, Download } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';
import { sidecarCall, saveFolder } from '../../lib/ipc';

interface Note {
    note_id: number | string;
    title: string;
    body: string;
    created: string;
    modified: string;
}

interface Props {
    backup: BackupInfo;
}

export default function NotesView({ backup }: Props) {
    const [notes, setNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [selectedNoteId, setSelectedNoteId] = useState<number | string | null>(null);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        async function fetchNotes() {
            try {
                setLoading(true);
                setError(null);
                const res = await sidecarCall<any>('list_notes', { udid: backup.udid });
                setNotes(res.notes || []);
            } catch (err: any) {
                setError(err.message || 'Failed to load notes');
            } finally {
                setLoading(false);
            }
        }
        fetchNotes();
    }, [backup.udid]);

    const handleExport = async (format: 'txt' | 'pdf') => {
        if (!selectedNoteId) return;
        try {
            setExporting(true);
            const folder = await saveFolder();
            if (!folder) return;

            const res = await sidecarCall('export_notes', {
                udid: backup.udid,
                note_ids: [selectedNoteId],
                format: format,
                output_dir: folder
            });

            if (res.status === 'ok') {
                alert(`Exported successfully to: ${folder}`);
            } else {
                alert(`Export failed: ${res.message}`);
            }
        } catch (e: any) {
            alert(`Export error: ${e.message}`);
        } finally {
            setExporting(false);
        }
    };

    const filteredNotes = notes.filter((n) =>
        n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        n.body.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const selectedNote = notes.find(n => n.note_id === selectedNoteId);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center bg-surface">
                <div className="text-text-secondary flex flex-col items-center">
                    <Loader2 className="w-8 h-8 text-text-accent animate-spin mb-4" />
                    <span className="text-body">Loading notes...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-full items-center justify-center bg-surface">
                <div className="text-center">
                    <AlertTriangle className="w-10 h-10 text-apple-error mx-auto mb-3" />
                    <p className="text-subhead font-semibold text-apple-error mb-2">Error</p>
                    <p className="text-body text-text-secondary">{error}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full bg-base text-text-primary">
            {/* List Pane */}
            <div className="w-80 flex flex-col bg-surface flex-shrink-0" style={{ borderRight: '0.5px solid var(--border-default)' }}>
                {/* Header & Search */}
                <div className="p-4 bg-base shadow-subtle z-10" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                    <h2 className="font-display text-title font-semibold text-text-primary mb-3">Notes ({filteredNotes.length})</h2>
                    <div className="relative">
                        <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-text-tertiary">
                            <Search className="w-4 h-4" />
                        </span>
                        <input
                            type="text"
                            placeholder="Search notes..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 rounded-lg text-body bg-elevated text-text-primary placeholder:text-text-tertiary focus:outline-none focus:shadow-focus transition-colors duration-200"
                            style={{ border: '0.5px solid var(--border-default)' }}
                        />
                    </div>
                </div>

                {/* Note List */}
                <div className="flex-1 overflow-y-auto">
                    {filteredNotes.length === 0 ? (
                        <div className="p-8 text-center text-text-tertiary text-body">
                            No notes found.
                        </div>
                    ) : (
                        <div>
                            {filteredNotes.map((note) => (
                                <div
                                    key={note.note_id}
                                    onClick={() => setSelectedNoteId(note.note_id)}
                                    className={`p-4 cursor-pointer transition-colors duration-200 ${selectedNoteId === note.note_id
                                            ? 'bg-accent-subtle shadow-subtle'
                                            : 'hover:bg-elevated'
                                        }`}
                                    style={{
                                        borderLeft: selectedNoteId === note.note_id ? '2px solid var(--accent)' : '2px solid transparent',
                                        borderBottom: '0.5px solid var(--border-subtle)',
                                    }}
                                >
                                    <h3 className="font-semibold text-text-primary truncate tracking-tight mb-1 text-body">
                                        {note.title}
                                    </h3>
                                    <div className="flex justify-between items-baseline mb-1">
                                        <p className="text-caption text-text-accent font-medium tracking-wide">
                                            {new Date(note.modified).toLocaleDateString(undefined, {
                                                month: 'short', day: 'numeric', year: 'numeric'
                                            })}
                                        </p>
                                    </div>
                                    <p className="text-body text-text-secondary line-clamp-2 leading-relaxed">
                                        {note.body}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Detail Pane */}
            <div className="flex-1 flex flex-col bg-base">
                {selectedNote ? (
                    <>
                        {/* Toolbar */}
                        <div className="h-14 flex items-center justify-between px-6 bg-surface" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                            <div className="text-caption text-text-secondary">
                                Created: {new Date(selectedNote.created).toLocaleString()}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => handleExport('txt')}
                                    disabled={exporting}
                                    className="px-3 py-1.5 bg-elevated text-text-primary rounded-lg text-body font-medium hover:bg-surface transition-colors duration-200 shadow-subtle disabled:opacity-50 flex items-center gap-1.5"
                                    style={{ border: '0.5px solid var(--border-default)' }}
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    Export TXT
                                </button>
                                <button
                                    onClick={() => handleExport('pdf')}
                                    disabled={exporting}
                                    className="px-3 py-1.5 bg-accent text-white rounded-lg text-body font-medium hover:bg-accent-hover transition-colors duration-200 shadow-subtle disabled:opacity-50 flex items-center gap-1.5"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    Export PDF
                                </button>
                            </div>
                        </div>

                        {/* Note Content */}
                        <div className="flex-1 overflow-y-auto px-12 py-10">
                            <div className="max-w-3xl mx-auto">
                                <h1 className="text-3xl font-display font-bold text-text-primary tracking-tight mb-4 pb-4" style={{ borderBottom: '0.5px solid var(--border-subtle)' }}>
                                    {selectedNote.title}
                                </h1>
                                <div className="prose prose-blue max-w-none text-text-secondary leading-relaxed font-serif text-[1.05rem] whitespace-pre-wrap">
                                    {selectedNote.body}
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center text-text-tertiary bg-surface">
                        <div className="text-center">
                            <FileText className="w-16 h-16 mx-auto mb-4 opacity-40" />
                            <p className="text-subhead font-medium text-text-secondary">Select a note to view</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
