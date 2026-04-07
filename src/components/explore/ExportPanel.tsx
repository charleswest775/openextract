import { useState } from 'react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { ExportIcon, LinesIcon, CameraIcon, CallIcon, VoicemailIcon, NoteIcon, GlobeIcon } from '../shared/Icons';

interface Props {
  udid: string;
}

type ExportType = 'messages' | 'photos' | 'calls' | 'voicemail' | 'notes' | 'browser_history';
type MessageFormat = 'html' | 'csv' | 'txt';

const exportOptions: { id: ExportType; label: string; description: string; icon: typeof LinesIcon }[] = [
  { id: 'messages', label: 'Messages', description: 'Export all conversations as HTML, CSV, or TXT', icon: LinesIcon },
  { id: 'photos', label: 'Photos', description: 'Export all photos and videos', icon: CameraIcon },
  { id: 'calls', label: 'Call History', description: 'Export call log as CSV', icon: CallIcon },
  { id: 'voicemail', label: 'Voicemail', description: 'Export voicemail audio and transcripts', icon: VoicemailIcon },
  { id: 'notes', label: 'Notes', description: 'Export all notes as TXT or PDF', icon: NoteIcon },
  { id: 'browser_history', label: 'Browser History', description: 'Export browsing history as CSV', icon: GlobeIcon },
];

const MSG_FORMATS: { id: MessageFormat; label: string }[] = [
  { id: 'html', label: 'HTML' },
  { id: 'csv', label: 'CSV' },
  { id: 'txt', label: 'TXT' },
];

export default function ExportPanel({ udid }: Props) {
  const [exporting, setExporting] = useState<ExportType | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [msgFormat, setMsgFormat] = useState<MessageFormat>('html');

  async function handleExport(type: ExportType) {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(type);
    setStatus(null);
    try {
      let method: string;
      let params: any = { udid, output_dir: outputDir };
      switch (type) {
        case 'messages': {
          const { conversations } = await sidecarCall<{ conversations: Array<{ chat_id: number; display_name: string }> }>(
            'list_conversations', { udid }
          );
          const chat_ids = conversations.map((c) => c.chat_id);
          const conversation_names: Record<string, string> = {};
          conversations.forEach((c) => { conversation_names[String(c.chat_id)] = c.display_name; });
          method = 'export_conversations';
          params = { udid, output_dir: outputDir, chat_ids, conversation_names, format: msgFormat, mode: 'merged' };
          break;
        }
        case 'photos':
          method = 'export_photos';
          params.options = {
            include_videos: true, include_live_photo_videos: false,
            format: 'original', jpeg_quality: 90,
            folder_structure: 'by_date', export_originals_if_edited: true,
            include_metadata_sidecar: false,
          };
          break;
        case 'calls':
          method = 'export_calls';
          break;
        case 'voicemail':
          method = 'export_voicemails';
          break;
        case 'browser_history':
          method = 'export_browser_history';
          break;
        default:
          setExporting(null);
          return;
      }
      await window.openextract.call(method, params);
      window.openextract.incrementExportCount();
      setStatus(`${type} exported successfully`);
    } catch (err: any) {
      setStatus(`Export failed: ${err.message}`);
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-medium text-gray-900">Export Data</h2>
        <p className="text-xs text-gray-400 mt-0.5">Choose what to export from this backup</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-lg space-y-2.5">
          {exportOptions.map((opt) => {
            const Icon = opt.icon;
            const isExporting = exporting === opt.id;
            return (
              <div key={opt.id}>
                <button
                  onClick={() => handleExport(opt.id)}
                  disabled={isExporting}
                  className="w-full flex items-center gap-3 p-3.5 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors text-left disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-md bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <Icon className="text-gray-500" size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                    <div className="text-xs text-gray-400">{opt.description}</div>
                  </div>
                  <ExportIcon className="text-gray-400 flex-shrink-0" size={16} />
                </button>
                {opt.id === 'messages' && (
                  <div className="flex gap-1 mt-1 ml-1">
                    {MSG_FORMATS.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setMsgFormat(f.id)}
                        className={`px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                          msgFormat === f.id
                            ? 'bg-blue-100 text-blue-700'
                            : 'text-gray-400 hover:text-gray-600'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {status && (
          <div className={`mt-4 text-sm ${status.includes('failed') ? 'text-red-500' : 'text-green-600'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
