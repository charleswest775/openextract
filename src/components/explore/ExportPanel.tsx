import { useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { photoExportSummary, PhotoExportResult } from '../../lib/photoCounts';
import {
  checkEngineResult, contactsToCsv, contactsToVcard, notesToText, plural, saveConversations, saveTextFile,
  type ContactRecord, type ConversationFormat, type NoteRecord, type SaveResult,
} from '../../lib/saveData';
import type { BackupStatsOverview } from '../../hooks/useBackupStats';
import { useSaveAction } from '../../hooks/useSaveAction';
import PageHeader from '../shared/PageHeader';
import SaveDialog, { ConversationModeChoice, FORMATS, SaveButton, type SaveFormat } from '../shared/SaveDialog';
import { LinesIcon, CameraIcon, CallIcon, VoicemailIcon, NoteIcon, GlobeIcon, ContactIcon } from '../shared/Icons';

interface Props {
  udid: string;
  /** Overview counts, to leave out kinds of data the backup doesn't have. */
  overview: BackupStatsOverview | null;
  hasBrowserHistory: boolean;
}

type Kind = 'messages' | 'photos' | 'contacts' | 'calls' | 'voicemail' | 'notes' | 'browser_history';

interface KindInfo {
  id: Kind;
  label: string;
  icon: typeof LinesIcon;
  count?: (o: BackupStatsOverview) => number;
  /** What you get, with the count when it's known. */
  what: (n: number | null) => string;
  formats: SaveFormat[];
}

const KINDS: KindInfo[] = [
  {
    id: 'messages', label: 'Messages', icon: LinesIcon, count: o => o.total_messages,
    what: n => `${n != null ? `All ${plural(n, 'message')}` : 'Every conversation'}, with names and dates`,
    formats: [FORMATS.html, FORMATS.pdf, FORMATS.csv, FORMATS.txt],
  },
  {
    id: 'photos', label: 'Photos & videos', icon: CameraIcon, count: o => o.photos_in_backup,
    what: n => `${n != null ? plural(n, 'photo or video', 'photos and videos') : 'Every photo and video'}, as the original files`,
    formats: [FORMATS.originals],
  },
  {
    id: 'contacts', label: 'Address book', icon: ContactIcon, count: o => o.total_contacts,
    what: n => `${n != null ? plural(n, 'contact') : 'Your address book'}, to import elsewhere or open in a spreadsheet`,
    formats: [FORMATS.vcf, FORMATS.csv],
  },
  {
    id: 'calls', label: 'Call history', icon: CallIcon, count: o => o.total_calls,
    what: n => `${n != null ? plural(n, 'call') : 'Every call'}, with who, when and how long`,
    formats: [FORMATS.csv],
  },
  {
    id: 'voicemail', label: 'Voicemail', icon: VoicemailIcon, count: o => o.total_voicemails,
    what: n => `${n != null ? plural(n, 'voicemail') : 'Every voicemail'}, as audio you can play anywhere`,
    formats: [FORMATS.audio],
  },
  {
    id: 'notes', label: 'Notes', icon: NoteIcon, count: o => o.total_notes,
    what: n => `${n != null ? plural(n, 'note') : 'Every note'}, in one text file`,
    formats: [FORMATS.txt],
  },
  {
    id: 'browser_history', label: 'Web history', icon: GlobeIcon,
    what: () => 'Every page visited, with titles and dates',
    formats: [FORMATS.csv],
  },
];

// "Web page, readable document, spreadsheet or plain text"
function formatChoices(formats: SaveFormat[]): string {
  const names = formats.map((f, i) => (i === 0 ? f.label : f.label.toLowerCase()));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

export default function ExportPanel({ udid, overview, hasBrowserHistory }: Props) {
  const [choosing, setChoosing] = useState<KindInfo | null>(null);
  const [mode, setMode] = useState<'separate' | 'merged'>('separate');
  const [running, setRunning] = useState<Kind | null>(null);
  const actions = {
    messages: useSaveAction('messages'),
    photos: useSaveAction('photos'),
    contacts: useSaveAction('contacts'),
    calls: useSaveAction('calls'),
    voicemail: useSaveAction('voicemail'),
    notes: useSaveAction('notes'),
    browser_history: useSaveAction('browser_history'),
  };

  const kinds = KINDS.filter(k => {
    if (k.id === 'browser_history') return hasBrowserHistory;
    return !k.count || !overview || k.count(overview) > 0;
  });

  function start(kind: KindInfo) {
    if (kind.formats.length > 1) setChoosing(kind);
    else save(kind.id, kind.formats[0].id);
  }

  async function save(kind: Kind, format: string) {
    setChoosing(null);
    setRunning(kind);
    await actions[kind].run(() => saveKind(kind, format));
    setRunning(null);
  }

  async function saveKind(kind: Kind, format: string): Promise<SaveResult | null> {
    switch (kind) {
      case 'messages': {
        const { conversations } = await sidecarCall<{ conversations: { chat_id: number; display_name: string; chat_identifier: string }[] }>(
          'list_conversations', { udid },
        );
        if (!conversations?.length) throw new Error('This backup has no conversations to save.');
        return saveConversations(udid, conversations, format as ConversationFormat, mode);
      }
      case 'contacts': {
        const { contacts } = await sidecarCall<{ contacts: ContactRecord[] }>('list_contacts', { udid });
        const vcf = format === 'vcf';
        const path = await saveTextFile({
          title: 'Save contacts',
          defaultName: vcf ? 'Contacts.vcf' : 'Contacts.csv',
          filter: vcf ? { name: 'vCard', extensions: ['vcf'] } : { name: 'CSV', extensions: ['csv'] },
          content: vcf ? contactsToVcard(contacts) : contactsToCsv(contacts),
        });
        return path ? { title: `Saved ${plural(contacts.length, 'contact')}`, path } : null;
      }
      case 'notes': {
        const { notes } = await sidecarCall<{ notes: NoteRecord[] }>('list_notes', { udid });
        const path = await saveTextFile({
          title: 'Save notes',
          defaultName: 'Notes.txt',
          filter: { name: 'Text', extensions: ['txt'] },
          content: notesToText(notes),
        });
        return path ? { title: `Saved ${plural(notes.length, 'note')}`, path } : null;
      }
      default:
        return saveToFolder(kind);
    }
  }

  async function saveToFolder(kind: Kind): Promise<SaveResult | null> {
    const outputDir = await saveFolder();
    if (!outputDir) return null;
    switch (kind) {
      case 'photos': {
        const result = checkEngineResult(await sidecarCall<PhotoExportResult>('export_photos', {
          udid,
          output_dir: outputDir + '/Photos',
          options: {
            include_videos: true, include_live_photo_videos: false,
            format: 'original', jpeg_quality: 90,
            folder_structure: 'flat', export_originals_if_edited: true,
            include_metadata_sidecar: false,
          },
        }));
        return { title: 'Saved photos and videos', detail: photoExportSummary(result), path: outputDir + '/Photos' };
      }
      case 'calls': {
        const result = checkEngineResult(await sidecarCall<{ path: string; count: number }>('export_calls', { udid, output_dir: outputDir }));
        return { title: `Saved ${plural(result.count, 'call')}`, path: result.path };
      }
      case 'voicemail': {
        const result = checkEngineResult(await sidecarCall<{ exported: number; path?: string }>(
          'export_voicemails', { udid, output_dir: outputDir + '/Voicemails' },
        ));
        return { title: `Saved ${plural(result.exported, 'voicemail')}`, path: result.path ?? outputDir + '/Voicemails' };
      }
      case 'browser_history': {
        const result = checkEngineResult(await sidecarCall<{ path: string; count: number }>(
          'export_browser_history', { udid, output_dir: outputDir },
        ));
        return { title: `Saved ${plural(result.count, 'page visit')}`, path: result.path };
      }
      default:
        return null;
    }
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Save to computer" count="Copy what's in this backup into files you keep" />
      <div className="flex-1 overflow-y-auto p-6">
        <ul className="max-w-2xl flex flex-col gap-3">
          {kinds.map(kind => {
            const Icon = kind.icon;
            const n = kind.count && overview ? kind.count(overview) : null;
            return (
              <li key={kind.id} className="hearth-card flex items-center gap-4 p-4">
                <span className="w-12 h-12 rounded-xl bg-accent-wash flex items-center justify-center flex-shrink-0">
                  <Icon className="text-accent" size={26} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium text-text-primary">{kind.label}</div>
                  <div className="text-sm text-text-secondary">{kind.what(n)}</div>
                  <div className="text-xs text-text-tertiary mt-0.5">{formatChoices(kind.formats)}</div>
                </div>
                <SaveButton onClick={() => start(kind)} busy={running === kind.id} disabled={running !== null} />
              </li>
            );
          })}
        </ul>
      </div>
      {choosing && (
        <SaveDialog
          title={`Save ${choosing.label.toLowerCase()}`}
          formats={choosing.formats}
          onSave={format => save(choosing.id, format)}
          onCancel={() => setChoosing(null)}
        >
          {choosing.id === 'messages' && <ConversationModeChoice mode={mode} onChange={setMode} />}
        </SaveDialog>
      )}
    </div>
  );
}
