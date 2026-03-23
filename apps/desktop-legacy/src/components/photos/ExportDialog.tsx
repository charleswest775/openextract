import { useState } from 'react';
import { X, CheckCircle, FolderOpen, Loader2 } from 'lucide-react';
import { ExportOptions } from '../../types';
import { selectFolder } from '../../lib/ipc';

interface Props {
  onClose: () => void;
  onExport: (outputDir: string, options: ExportOptions) => Promise<{ exported: number; errors: number }>;
}

const DEFAULTS: ExportOptions = {
  include_videos: true,
  include_live_photo_videos: true,
  format: 'original',
  jpeg_quality: 90,
  folder_structure: 'by_date',
  export_originals_if_edited: false,
  include_metadata_sidecar: false,
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-text-secondary text-caption block mb-1">{label}</label>
      {children}
    </div>
  );
}

function StyledSelect({
  value, onChange, children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-surface text-text-primary text-body px-3 py-1.5 rounded-lg focus:outline-none focus:shadow-focus"
      style={{ border: '0.5px solid var(--border-default)' }}
    >
      {children}
    </select>
  );
}

function Toggle({
  label, description, checked, onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 accent-[var(--accent)] flex-shrink-0"
      />
      <span>
        <span className="text-text-secondary text-body">{label}</span>
        {description && (
          <span className="block text-text-tertiary text-caption mt-0.5">{description}</span>
        )}
      </span>
    </label>
  );
}

export default function ExportDialog({ onClose, onExport }: Props) {
  const [options, setOptions] = useState<ExportOptions>(DEFAULTS);
  const [outputDir, setOutputDir] = useState('');
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ exported: number; errors: number } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(o => ({ ...o, [key]: value }));

  const pickFolder = async () => {
    const dir = await selectFolder();
    if (dir) setOutputDir(dir);
  };

  const handleExport = async () => {
    if (!outputDir) return;
    setExporting(true);
    setExportError(null);
    try {
      const r = await onExport(outputDir, options);
      setResult(r);
    } catch (e: any) {
      setExportError(e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-elevated rounded-xl w-full max-w-md shadow-2xl" style={{ border: '0.5px solid var(--border-default)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
          <h2 className="text-text-primary font-medium text-subhead">Export Photos</h2>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary transition-colors focus:outline-none focus:shadow-focus rounded-md p-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {result ? (
          /* Completion screen */
          <div className="px-5 py-10 text-center">
            <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-400" />
            <p className="text-text-primary font-medium text-lg">Export Complete</p>
            <p className="text-text-secondary text-body mt-2">
              {result.exported.toLocaleString()} items exported
              {result.errors > 0 && (
                <span className="text-yellow-500"> · {result.errors} errors</span>
              )}
            </p>
            <button
              onClick={onClose}
              className="mt-5 bg-accent hover:bg-accent-hover text-white text-body px-5 py-2 rounded-lg transition-colors focus:outline-none focus:shadow-focus"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            {/* Output folder */}
            <Field label="Output Folder">
              <div className="flex gap-2">
                <input
                  readOnly
                  value={outputDir}
                  placeholder="Choose a destination folder..."
                  className="flex-1 bg-surface text-text-secondary text-body px-3 py-1.5 rounded-lg placeholder:text-text-tertiary focus:outline-none"
                  style={{ border: '0.5px solid var(--border-default)' }}
                />
                <button
                  onClick={pickFolder}
                  className="bg-surface hover:bg-base text-text-primary text-body px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 focus:outline-none focus:shadow-focus inline-flex items-center gap-1.5"
                  style={{ border: '0.5px solid var(--border-default)' }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              </div>
            </Field>

            {/* Folder structure */}
            <Field label="Folder Structure">
              <StyledSelect
                value={options.folder_structure}
                onChange={v => set('folder_structure', v as ExportOptions['folder_structure'])}
              >
                <option value="flat">Flat -- all files in one folder</option>
                <option value="by_date">By Date -- organised as YYYY/MM/</option>
                <option value="by_album">By Album</option>
              </StyledSelect>
            </Field>

            {/* Format */}
            <Field label="Photo Format">
              <StyledSelect
                value={options.format}
                onChange={v => set('format', v as ExportOptions['format'])}
              >
                <option value="original">Original -- preserve HEIC/RAW</option>
                <option value="jpeg">Convert to JPEG</option>
              </StyledSelect>
            </Field>

            {/* JPEG quality slider */}
            {options.format === 'jpeg' && (
              <Field label={`JPEG Quality: ${options.jpeg_quality}`}>
                <input
                  type="range"
                  min={60}
                  max={100}
                  value={options.jpeg_quality}
                  onChange={e => set('jpeg_quality', Number(e.target.value))}
                  className="w-full accent-[var(--accent)]"
                />
                <div className="flex justify-between text-text-tertiary text-caption mt-0.5">
                  <span>Smaller file</span>
                  <span>Higher quality</span>
                </div>
              </Field>
            )}

            {/* Toggle options */}
            <div className="space-y-3 pt-1">
              <Toggle
                label="Include Videos"
                checked={options.include_videos}
                onChange={v => set('include_videos', v)}
              />
              <Toggle
                label="Include Live Photo Videos"
                checked={options.include_live_photo_videos}
                onChange={v => set('include_live_photo_videos', v)}
              />
              <Toggle
                label="Export Original (if photo was edited)"
                description="Saves the unedited original alongside the edited version"
                checked={options.export_originals_if_edited}
                onChange={v => set('export_originals_if_edited', v)}
              />
              <Toggle
                label="Write Metadata Sidecar (.json)"
                description="Saves date, GPS, album info next to each file"
                checked={options.include_metadata_sidecar}
                onChange={v => set('include_metadata_sidecar', v)}
              />
            </div>

            {/* Error */}
            {exportError && (
              <p className="text-red-700 text-body bg-red-50 rounded-lg px-3 py-2" style={{ border: '0.5px solid var(--border-danger)' }}>
                {exportError}
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1" style={{ borderTop: '0.5px solid var(--border-default)' }}>
              <button
                onClick={onClose}
                className="text-text-tertiary hover:text-text-primary text-body px-4 py-2 transition-colors focus:outline-none focus:shadow-focus rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={!outputDir || exporting}
                className="bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white text-body px-4 py-2 rounded-lg transition-colors focus:outline-none focus:shadow-focus inline-flex items-center gap-1.5"
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Exporting...
                  </>
                ) : (
                  'Export'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
