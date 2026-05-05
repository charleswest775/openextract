import { useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { ExportIcon, LinesIcon, CameraIcon, CallIcon, VoicemailIcon, NoteIcon, GlobeIcon, ContactIcon } from '../shared/Icons';

interface Props {
  udid: string;
}

type ExportType = 'messages' | 'photos' | 'calls' | 'voicemail' | 'notes' | 'browser_history' | 'contacts';

const exportOptions: { id: ExportType; label: string; description: string; icon: typeof LinesIcon }[] = [
  { id: 'messages', label: 'Messages', description: 'Export all messages as CSV', icon: LinesIcon },
  { id: 'photos', label: 'Photos', description: 'Export all photos and videos', icon: CameraIcon },
  { id: 'calls', label: 'Call History', description: 'Export call log as CSV', icon: CallIcon },
  { id: 'voicemail', label: 'Voicemail', description: 'Export voicemail audio and transcripts', icon: VoicemailIcon },
  { id: 'contacts', label: 'Contacts', description: 'Export address book as CSV', icon: ContactIcon },
  { id: 'notes', label: 'Notes', description: 'Export all notes as TXT', icon: NoteIcon },
  { id: 'browser_history', label: 'Browser History', description: 'Export browsing history as CSV', icon: GlobeIcon },
];

export default function ExportPanel({ udid }: Props) {
  const [exporting, setExporting] = useState<ExportType | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleExport(type: ExportType) {
    setExporting(type);
    setStatus(null);
    try {
      if (type === 'notes') {
        await exportNotes();
      } else if (type === 'messages') {
        await exportMessages();
      } else if (type === 'contacts') {
        await exportContacts();
      } else {
        await exportToFolder(type);
      }
    } catch (err: any) {
      setStatus(`Export failed: ${err.message}`);
    } finally {
      setExporting(null);
    }
  }

  async function exportNotes() {
    const result = await sidecarCall<{ notes: { title: string; body: string; created: string; modified: string }[] }>('list_notes', { udid });
    const notes = result.notes || [];
    if (notes.length === 0) {
      setStatus('No notes found in this backup');
      return;
    }
    const filePath = await window.openextract.saveFile({
      title: 'Export Notes',
      defaultPath: 'Notes.txt',
      filters: [{ name: 'Text Files', extensions: ['txt'] }],
    });
    if (!filePath) return;
    const content = notes.map(n =>
      `Title: ${n.title}\nCreated: ${n.created}\nModified: ${n.modified}\n${'='.repeat(40)}\n\n${n.body}`
    ).join('\n\n' + '-'.repeat(60) + '\n\n');
    await window.openextract.writeFile(filePath, content);
    window.openextract.incrementExportCount();
    setStatus(`${notes.length} notes exported successfully`);
  }

  async function exportMessages() {
    const convResult = await sidecarCall<{ conversations: { chat_id: number; display_name: string; message_count: number }[] }>('list_conversations', { udid });
    const conversations = convResult.conversations || [];
    if (conversations.length === 0) {
      setStatus('No messages found in this backup');
      return;
    }
    const filePath = await window.openextract.saveFile({
      title: 'Export Messages',
      defaultPath: 'Messages.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!filePath) return;
    setStatus('Fetching messages...');
    document.body.style.cursor = 'wait';
    try {
      const csvRows: string[] = ['"Date","Conversation","Sender","Message"'];
      for (const conv of conversations) {
        let offset = 0;
        const limit = 500;
        while (true) {
          const msgResult = await sidecarCall<{ messages: { date: string; sender: string; text: string }[]; total: number }>('get_messages', { udid, chat_id: conv.chat_id, offset, limit });
          const msgs = msgResult.messages || [];
          for (const m of msgs) {
            const date = csvEscape(m.date || '');
            const convo = csvEscape(conv.display_name || '');
            const sender = csvEscape(m.sender || '');
            const text = csvEscape(m.text || '');
            csvRows.push(`${date},${convo},${sender},${text}`);
          }
          offset += limit;
          if (offset >= msgResult.total || msgs.length === 0) break;
        }
      }
      await window.openextract.writeFile(filePath, csvRows.join('\n'));
    } finally {
      document.body.style.cursor = '';
    }
    window.openextract.incrementExportCount();
    setStatus(`Messages exported successfully`);
  }

  async function exportContacts() {
    type Contact = {
      first_name: string; last_name: string; display_name: string;
      organization: string; phones: string[]; emails: string[]; note: string;
    };
    const result = await sidecarCall<{ contacts: Contact[] }>('list_contacts', { udid });
    const contacts = result.contacts || [];
    if (contacts.length === 0) {
      setStatus('No contacts found in this backup');
      return;
    }
    const filePath = await window.openextract.saveFile({
      title: 'Export Contacts',
      defaultPath: 'Contacts.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!filePath) return;
    const rows: string[] = ['"First Name","Last Name","Display Name","Organization","Phone Numbers","Email Addresses","Notes"'];
    for (const c of contacts) {
      rows.push([
        c.first_name, c.last_name, c.display_name, c.organization,
        (c.phones || []).join('; '), (c.emails || []).join('; '), c.note,
      ].map(v => csvEscape(v || '')).join(','));
    }
    await window.openextract.writeFile(filePath, rows.join('\n'));
    window.openextract.incrementExportCount();
    setStatus(`${contacts.length} contacts exported successfully`);
  }

  function csvEscape(value: string): string {
    const escaped = value.replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
    return `"${escaped}"`;
  }

  async function exportToFolder(type: ExportType) {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    let method: string;
    let params: any = { udid, output_dir: outputDir };
    switch (type) {
      case 'photos':
        method = 'export_photos';
        params.output_dir = outputDir + '/Photos';
        params.options = {
          include_videos: true, include_live_photo_videos: false,
          format: 'original', jpeg_quality: 90,
          folder_structure: 'flat', export_originals_if_edited: true,
          include_metadata_sidecar: false,
        };
        break;
      case 'calls':
        method = 'export_calls';
        break;
      case 'voicemail':
        method = 'export_voicemails';
        params.output_dir = outputDir + '/Voicemails';
        break;
      case 'browser_history':
        method = 'export_browser_history';
        break;
      default:
        return;
    }
    await sidecarCall(method, params);
    window.openextract.incrementExportCount();
    setStatus(`${type} exported successfully`);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border-default">
        <h2 className="text-sm font-medium text-text-primary">Export Data</h2>
        <p className="text-xs text-text-tertiary mt-0.5">Choose what to export from this backup</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-lg space-y-2.5">
          {exportOptions.map((opt) => {
            const Icon = opt.icon;
            const isExporting = exporting === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => handleExport(opt.id)}
                disabled={isExporting}
                className="w-full flex items-center gap-3 p-3.5 rounded-lg border border-border-default hover:border-border-strong transition-colors text-left disabled:opacity-50"
              >
                <div className="w-8 h-8 rounded-md bg-elevated flex items-center justify-center flex-shrink-0">
                  <Icon className="text-text-secondary" size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                  <div className="text-xs text-text-tertiary">{opt.description}</div>
                </div>
                <ExportIcon className="text-text-tertiary flex-shrink-0" size={16} />
              </button>
            );
          })}
        </div>
        {status && (
          <div className={`mt-4 text-sm ${status.includes('failed') ? 'text-apple-error' : 'text-apple-success'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
