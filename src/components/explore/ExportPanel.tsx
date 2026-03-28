import { useState } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon, LinesIcon, CameraIcon, CallIcon, VoicemailIcon, NoteIcon } from '../shared/Icons';

interface Props {
  udid: string;
}

type ExportType = 'messages' | 'photos' | 'calls' | 'voicemail' | 'notes';

const exportOptions: { id: ExportType; label: string; description: string; icon: typeof LinesIcon }[] = [
  { id: 'messages', label: 'Messages', description: 'Export all conversations as HTML, CSV, or TXT', icon: LinesIcon },
  { id: 'photos', label: 'Photos', description: 'Export all photos and videos', icon: CameraIcon },
  { id: 'calls', label: 'Call History', description: 'Export call log as CSV', icon: CallIcon },
  { id: 'voicemail', label: 'Voicemail', description: 'Export voicemail audio and transcripts', icon: VoicemailIcon },
  { id: 'notes', label: 'Notes', description: 'Export all notes as TXT or PDF', icon: NoteIcon },
];

export default function ExportPanel({ udid }: Props) {
  const [exporting, setExporting] = useState<ExportType | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleExport(type: ExportType) {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(type);
    setStatus(null);
    try {
      let method: string;
      let params: any = { udid, output_dir: outputDir };
      switch (type) {
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
              <button
                key={opt.id}
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
