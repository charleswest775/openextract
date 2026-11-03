import { useState, useEffect } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { NoteIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { formatDate } from '../../lib/dates';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { checkEngineResult, plural } from '../../lib/saveData';

// Notes start with their title, so the list's preview skips it.
function preview(note: { title: string; body: string }): string {
  const body = note.body || '';
  return note.title && body.startsWith(note.title) ? body.slice(note.title.length).trim() : body;
}

interface Note {
  note_id: number | string;
  title: string;
  body: string;
  created: string;
  modified: string;
}

interface Props {
  udid: string;
  /** Open this note instead of the newest one. */
  openNoteId?: number | string | null;
}

export default function NoteExplorer({ udid, openNoteId }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Note | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('notes');

  useEffect(() => {
    loadNotes();
  }, [udid]);

  async function loadNotes() {
    setLoading(true);
    try {
      const result = await sidecarCall<{ notes: Note[] }>('list_notes', { udid });
      setNotes(result.notes);
      // Open on the asked-for note, else the newest rather than an empty pane
      setSelected(result.notes.find(n => n.note_id === openNoteId) ?? result.notes[0] ?? null);
    } finally {
      setLoading(false);
    }
  }

  function save(format: 'pdf' | 'txt') {
    setChoosing(false);
    const note = selected;
    if (!note) return;
    run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<{ exported?: string[] }>('export_notes', {
        udid, note_ids: [note.note_id], format, output_dir: outputDir,
      }));
      return { title: `Saved "${note.title || 'Untitled'}"`, path: result.exported?.[0] ?? outputDir };
    });
  }

  const filtered = notes.filter(n => {
    if (!search) return true;
    const q = search.toLowerCase();
    return n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
  });

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Notes"
        count={notes.length > 0 ? plural(notes.length, 'note') : undefined}
        search={{ value: search, onChange: setSearch, placeholder: 'Search notes' }}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={!selected} label="Save note" />}
      />
      <div className="flex-1 flex min-h-0">
        {/* Notes list */}
        <div className="w-[300px] flex-shrink-0 border-r border-rule overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-8 text-accent">
              <OrganicLoader size={56} />
            </div>
          )}
          {filtered.map((note) => (
            <button
              key={note.note_id}
              onClick={() => setSelected(note)}
              aria-current={selected?.note_id === note.note_id ? 'true' : undefined}
              className={`w-full px-4 py-3 text-left border-b border-rule transition-colors ${
                selected?.note_id === note.note_id ? 'bg-accent-wash' : 'hover:bg-surface'
              }`}
            >
              <div className="text-sm font-medium text-text-primary truncate">{note.title || 'Untitled'}</div>
              <div className="text-xs text-text-tertiary mt-0.5">{formatDate(note.modified)}</div>
              <div className="text-xs text-text-secondary line-clamp-2 mt-0.5">{preview(note)}</div>
            </button>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="text-center px-4 py-6 text-sm text-text-secondary">
              {search ? `No notes match "${search}"` : 'No notes in this backup'}
            </div>
          )}
        </div>

        {/* Note detail */}
        <div className="flex-1 flex flex-col min-w-0">
          {selected ? (
            <div className="flex-1 overflow-y-auto px-10 py-8">
              <div className="text-sm text-text-tertiary mb-1">Edited {formatDate(selected.modified)}</div>
              <h2 className="text-2xl text-text-primary mb-5">{selected.title || 'Untitled'}</h2>
              <div
                className="whitespace-pre-wrap text-text-primary"
                style={{
                  fontFamily: 'Fraunces, Newsreader, Georgia, serif',
                  fontSize: 17,
                  lineHeight: 1.7,
                  maxWidth: 680,
                }}
              >
                {preview(selected)}
              </div>
            </div>
          ) : (
            !loading && <EmptyState icon={NoteIcon} title="Pick a note to read it" />
          )}
        </div>
      </div>
      {choosing && selected && (
        <SaveDialog
          title={`Save "${selected.title || 'Untitled'}"`}
          formats={[FORMATS.pdf, FORMATS.txt]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
