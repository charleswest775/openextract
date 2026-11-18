import { useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { photoExportSummary, photoSaveFailures, photoSaveProgress, PhotoExportResult } from '../../lib/photoCounts';
import { percentDone } from '../../lib/exportProgress';
import {
  BUNDLE_FILES, BUNDLE_KINDS, bundleParams, bundleProgress, bundleSummary, computerTimeZone, defaultBundleChoice,
  type BundleChoice, type BundleResult,
} from '../../lib/bundle';
import {
  checkEngineResult, contactsToCsv, contactsToVcard, notesToText, plural, saveConversations, savePodcasts, saveTextFile,
  saveWhatsAppChats,
  type ContactRecord, type ConversationFormat, type NoteRecord, type SaveResult,
} from '../../lib/saveData';
import type { WhatsAppChatsResult } from '../../types/whatsapp';
import type { PodcastSaveFormat } from '../../types/podcasts';
import type { BackupStatsOverview } from '../../hooks/useBackupStats';
import { useSaveAction } from '../../hooks/useSaveAction';
import { useExportProgress } from '../../hooks/useExportProgress';
import PageHeader from '../shared/PageHeader';
import SaveDialog, { ConversationModeChoice, FORMATS, SaveButton, SaveProgress, type SaveFormat } from '../shared/SaveDialog';
import {
  LinesIcon, CameraIcon, CallIcon, VoicemailIcon, NoteIcon, GlobeIcon, ContactIcon, WhatsAppIcon, PodcastIcon, BundleIcon,
} from '../shared/Icons';

interface Props {
  udid: string;
  /** Overview counts, to leave out kinds of data the backup doesn't have. */
  overview: BackupStatsOverview | null;
  hasBrowserHistory: boolean;
}

type Kind = 'messages' | 'whatsapp' | 'photos' | 'contacts' | 'calls' | 'voicemail' | 'podcasts' | 'notes' | 'browser_history';

interface KindInfo {
  id: Kind;
  label: string;
  icon: typeof LinesIcon;
  count?: (o: BackupStatsOverview) => number;
  /** What you get, with the count when it's known. */
  what: (n: number | null, o: BackupStatsOverview | null) => string;
  formats: SaveFormat[];
  /** What the Save dialog calls it, when lower-casing the label won't do ("WhatsApp" is a name). */
  title?: string;
}

const KINDS: KindInfo[] = [
  {
    id: 'messages', label: 'Messages', icon: LinesIcon, count: o => o.total_messages,
    what: n => `${n != null ? `All ${plural(n, 'message')}` : 'Every conversation'}, with names and dates`,
    formats: [FORMATS.html, FORMATS.pdf, FORMATS.csv, FORMATS.txt],
  },
  {
    id: 'whatsapp', label: 'WhatsApp', icon: WhatsAppIcon, count: o => o.total_whatsapp_messages ?? 0,
    what: n => `${n != null ? `All ${plural(n, 'WhatsApp message')}` : 'Every WhatsApp chat'}, with names, dates, photos and replies`,
    formats: [FORMATS.html, FORMATS.pdf, FORMATS.csv, FORMATS.txt],
    title: 'WhatsApp chats',
  },
  {
    // Every photo, hidden ones too: a complete copy, although All Photos leaves hidden ones out.
    id: 'photos', label: 'Photos & videos', icon: CameraIcon,
    count: o => o.photos_in_backup + (o.hidden_photos_in_backup ?? 0),
    what: (n, o) => {
      const hidden = o?.hidden_photos_in_backup ?? 0;
      const which = n != null ? plural(n, 'photo or video', 'photos and videos') : 'Every photo and video';
      return `${which}${hidden > 0 ? `, including ${hidden.toLocaleString()} hidden` : ''}, as the original files`;
    },
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
    id: 'podcasts', label: 'Podcasts', icon: PodcastIcon, count: o => o.total_podcasts ?? 0,
    what: n => `${n != null ? plural(n, 'podcast') : 'Every podcast'}, to follow in another podcast app or open in a spreadsheet`,
    formats: [FORMATS.opml, FORMATS.csv],
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

// The bundle's one "format", for the Save dialog
const BUNDLE_FORMAT = {
  id: 'bundle', label: 'Data bundle (experimental)',
  detail: 'JSON files, copies of the files you tick, and a SHA-256 integrity check, in one folder',
};

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
    whatsapp: useSaveAction('whatsapp'),
    photos: useSaveAction('photos'),
    contacts: useSaveAction('contacts'),
    calls: useSaveAction('calls'),
    voicemail: useSaveAction('voicemail'),
    podcasts: useSaveAction('podcasts'),
    notes: useSaveAction('notes'),
    browser_history: useSaveAction('browser_history'),
  };
  const photoProgress = useExportProgress('photos', running === 'photos');
  // The data bundle: everything in one documented folder, for other tools (docs/BUNDLE.md)
  const bundleAction = useSaveAction('export');
  const [bundleRunning, setBundleRunning] = useState(false);
  const [bundleChoice, setBundleChoice] = useState<BundleChoice | null>(null);
  const bundleProgressNow = useExportProgress('bundle', bundleRunning);
  const busy = running !== null || bundleRunning;

  const kinds = KINDS.filter(k => {
    if (k.id === 'browser_history') return hasBrowserHistory;
    return !k.count || !overview || k.count(overview) > 0;
  });

  function start(kind: KindInfo) {
    // A subscription list needs a followed show: with none, only the spreadsheet is offered
    if (kind.id === 'podcasts' && overview && (overview.total_podcasts_followed ?? 1) === 0) {
      kind = { ...kind, formats: kind.formats.filter(f => f.id !== 'opml') };
    }
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
      case 'whatsapp': {
        // WhatsApp's own list and export: its chat ids are a different database's numbers
        const result = await sidecarCall<WhatsAppChatsResult>('list_whatsapp_chats', { udid });
        const chats = result?.conversations ?? [];
        if (chats.length === 0) throw new Error(result?.error || 'This backup has no WhatsApp chats to save.');
        return saveWhatsAppChats(udid, chats, format as ConversationFormat, mode);
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
      case 'podcasts':
        // The engine writes the files: subscriptions (OPML), or shows and episodes (CSV)
        return savePodcasts(udid, format as PodcastSaveFormat);
      default:
        return saveToFolder(kind);
    }
  }

  async function saveBundle(choice: BundleChoice) {
    setBundleChoice(null);
    setBundleRunning(true);
    await bundleAction.run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<BundleResult>('export_bundle', {
        udid, output_dir: outputDir, time_zone: computerTimeZone(), ...bundleParams(choice),
      }));
      return { title: 'Saved a data bundle', detail: bundleSummary(result), path: result.path };
    });
    setBundleRunning(false);
  }

  function toggle<T>(set: Set<T>, item: T): Set<T> {
    const next = new Set(set);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    return next;
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
            // Every photo, hidden ones too (python/photos.py LIBRARY); All Photos leaves them out.
            album_id: '__library__',
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
                  <div className="text-sm text-text-secondary">{kind.what(n, overview ?? null)}</div>
                  {kind.id === 'photos' && photoProgress ? (
                    <SaveProgress
                      className="mt-1.5"
                      text={photoSaveProgress(photoProgress.done, photoProgress.total)}
                      failures={photoSaveFailures(photoProgress.failed)}
                      percent={percentDone(photoProgress)}
                    />
                  ) : (
                    <div className="text-xs text-text-tertiary mt-0.5">{formatChoices(kind.formats)}</div>
                  )}
                </div>
                <SaveButton onClick={() => start(kind)} busy={running === kind.id} disabled={busy} />
              </li>
            );
          })}
        </ul>
        <h2 className="max-w-2xl mt-8 mb-3 text-sm font-medium text-text-secondary">For other tools</h2>
        <div className="max-w-2xl hearth-card flex items-center gap-4 p-4">
          <span className="w-12 h-12 rounded-xl bg-accent-wash flex items-center justify-center flex-shrink-0">
            <BundleIcon className="text-accent" size={26} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium text-text-primary">Export a data bundle</div>
            <div className="text-sm text-text-secondary">
              Messages, calls, voicemail, contacts, photo details and people in one folder, in a documented
              format other tools can read, with a hash of every file to check nothing has changed
            </div>
            {bundleProgressNow ? (
              <SaveProgress
                className="mt-1.5"
                text={bundleProgress(bundleProgressNow.done, bundleProgressNow.total)}
                percent={percentDone(bundleProgressNow)}
              />
            ) : (
              <div className="text-xs text-text-tertiary mt-0.5">JSON and JSON Lines · experimental, the format may still change</div>
            )}
          </div>
          <SaveButton
            label="Export"
            onClick={() => setBundleChoice(defaultBundleChoice(overview))}
            busy={bundleRunning}
            disabled={busy}
          />
        </div>
      </div>
      {choosing && (
        <SaveDialog
          title={`Save ${choosing.title ?? choosing.label.toLowerCase()}`}
          formats={choosing.formats}
          onSave={format => save(choosing.id, format)}
          onCancel={() => setChoosing(null)}
        >
          {(choosing.id === 'messages' || choosing.id === 'whatsapp') && (
            <ConversationModeChoice mode={mode} onChange={setMode} noun={choosing.id === 'whatsapp' ? 'chat' : 'conversation'} />
          )}
        </SaveDialog>
      )}
      {bundleChoice && (
        <SaveDialog
          title="Export a data bundle"
          formats={[BUNDLE_FORMAT]}
          canSave={bundleChoice.kinds.size > 0}
          onSave={() => saveBundle(bundleChoice)}
          onCancel={() => setBundleChoice(null)}
        >
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-text-primary mb-1">What to include</legend>
            {BUNDLE_KINDS.map(kind => (
              <label key={kind.id} className="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer">
                <input
                  type="checkbox"
                  checked={bundleChoice.kinds.has(kind.id)}
                  onChange={() => setBundleChoice({ ...bundleChoice, kinds: toggle(bundleChoice.kinds, kind.id) })}
                  className="w-4 h-4 accent-[var(--accent)]"
                />
                {kind.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-text-primary mb-1">Copy these files in too</legend>
            {BUNDLE_FILES.map(file => {
              const off = !bundleChoice.kinds.has(file.needs);
              return (
                <label
                  key={file.id}
                  className={`flex items-center gap-2.5 text-sm cursor-pointer ${off ? 'text-text-tertiary' : 'text-text-primary'}`}
                >
                  <input
                    type="checkbox"
                    checked={!off && bundleChoice.files.has(file.id)}
                    disabled={off}
                    onChange={() => setBundleChoice({ ...bundleChoice, files: toggle(bundleChoice.files, file.id) })}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  {file.label}
                  {file.detail && <span className="text-xs text-text-tertiary">{file.detail}</span>}
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-text-secondary">
            Every date is in UTC. The hashes in SHA256SUMS are an integrity check: they show whether a file has
            changed since you saved it.
          </p>
        </SaveDialog>
      )}
    </div>
  );
}
