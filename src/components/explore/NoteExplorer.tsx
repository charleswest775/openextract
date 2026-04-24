import { useState, useEffect } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { SearchIcon, ExportIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { formatDate } from '../../lib/dates';

interface Note {
  note_id: number | string;
  title: string;
  body: string;
  created: string;
  modified: string;
}

interface Props {
  udid: string;
}

export default function NoteExplorer({ udid }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Note | null>(null);

  useEffect(() => {
    loadNotes();
  }, [udid]);

  async function loadNotes() {
    setLoading(true);
    try {
      const result = await sidecarCall<{ notes: Note[] }>('list_notes', { udid });
      setNotes(result.notes);
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(format: 'txt' | 'pdf') {
    if (!selected) return;
    const outputDir = await saveFolder();
    if (!outputDir) return;
    try {
      await sidecarCall('export_notes', {
        udid,
        note_ids: [selected.note_id],
        format,
        output_dir: outputDir,
      });
      window.openextract.incrementExportCount();
    } catch (err) {
      console.error('Export failed:', err);
    }
  }

  const filtered = notes.filter(n => {
    if (!search) return true;
    const q = search.toLowerCase();
    return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
  });

  return (
    <div className="h-full flex">
      {/* Notes list */}
      <div className="w-[280px] flex-shrink-0 border-r border-gray-200 flex flex-col">
        <div className="p-3 border-b border-gray-200">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search notes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-8 text-accent">
              <OrganicLoader size={56} />
            </div>
          )}
          {filtered.map((note) => (
            <button
              key={note.note_id}
              onClick={() => setSelected(note)}
              className={`w-full px-3 py-2.5 text-left border-b border-gray-100 transition-colors ${
                selected?.note_id === note.note_id ? 'bg-gray-100' : 'hover:bg-gray-50'
              }`}
            >
              <div className="text-sm font-medium text-gray-900 truncate">{note.title || 'Untitled'}</div>
              <div className="text-xs text-gray-400 mt-0.5">{formatDate(note.modified)}</div>
              <div className="text-xs text-gray-400 line-clamp-2 mt-0.5">{note.body}</div>
            </button>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-4 text-sm text-gray-400">No notes found</div>
          )}
        </div>
      </div>

      {/* Note detail */}
      <div className="flex-1 flex flex-col">
        {selected ? (
          <>
            <div className="px-7 py-5 border-b border-rule flex items-end justify-between bg-base">
              <div>
                <div className="hearth-eyebrow mb-1.5">
                  {formatDate(selected.modified)}
                </div>
                <div className="font-serif text-2xl text-text-primary" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
                  {selected.title || 'Untitled'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleExport('txt')} className="hearth-ghost-btn">TXT</button>
                <button onClick={() => handleExport('pdf')} className="hearth-ghost-btn">PDF</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-10 py-8">
              <div
                className="whitespace-pre-wrap text-text-primary"
                style={{
                  fontFamily: 'Fraunces, Newsreader, Georgia, serif',
                  fontSize: 16,
                  lineHeight: 1.7,
                  maxWidth: 680,
                }}
              >
                {selected.body}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a note to view
          </div>
        )}
      </div>
    </div>
  );
}
