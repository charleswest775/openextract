import { useEffect, useState } from 'react';
import { ExportIcon } from './Icons';

export interface SaveFormat<T extends string = string> {
  id: T;
  label: string;
  /** What the file is and what opens it, e.g. "CSV, for Excel or Numbers". */
  detail: string;
}

/** The formats every screen picks from, named by what people get. */
export const FORMATS = {
  pdf: { id: 'pdf', label: 'Readable document', detail: 'PDF, opens anywhere and prints well' },
  html: { id: 'html', label: 'Web page', detail: 'HTML, opens in any browser' },
  csv: { id: 'csv', label: 'Spreadsheet', detail: 'CSV, for Excel, Numbers or Google Sheets' },
  txt: { id: 'txt', label: 'Plain text', detail: 'TXT, opens in any text editor' },
  vcf: { id: 'vcf', label: 'Contact cards', detail: 'vCard, imports into Contacts, Outlook or Google' },
  originals: { id: 'originals', label: 'Original files', detail: 'Copied as they are in the backup' },
  audio: { id: 'audio', label: 'Audio files', detail: 'One file per voicemail, plays in any music app' },
} as const;

/** The Save button every screen uses. */
export function SaveButton({ onClick, disabled, busy, label = 'Save', primary = false }: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={primary ? 'hearth-primary-btn' : 'hearth-ghost-btn'}
    >
      <ExportIcon size={18} />
      {busy ? 'Saving…' : label}
    </button>
  );
}

/**
 * How far a long save has got: "Saving 1,234 of 5,678 photos and videos…" over
 * a bar, with what failed so far (e.g. "3 couldn't be copied") beside it.
 */
export function SaveProgress({ text, failures, percent, className = '' }: {
  text: string;
  failures?: string;
  /** 0 to 100 */
  percent: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-text-secondary">{text}</span>
        {failures && <span className="text-xs text-text-tertiary flex-shrink-0">{failures}</span>}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        className="mt-1.5 h-1.5 rounded-full overflow-hidden bg-sand"
      >
        <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
    </div>
  );
}

interface Props<T extends string> {
  /** e.g. "Save your conversation with Karin" */
  title: string;
  formats: SaveFormat<T>[];
  initial?: T;
  /** Shown under the formats, e.g. a "merged or separate files" choice. */
  children?: React.ReactNode;
  onSave: (format: T) => void;
  onCancel: () => void;
}

/**
 * The one Save dialog: pick a format, then the system dialog asks where.
 * The caller does the saving and reports the result with a notice.
 */
export default function SaveDialog<T extends string>({ title, formats, initial, children, onSave, onCancel }: Props<T>) {
  const [format, setFormat] = useState<T>(initial ?? formats[0].id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
        className="w-full max-w-md rounded-2xl bg-surface border border-rule p-6 flex flex-col gap-4"
        style={{ boxShadow: '0 24px 48px rgba(30,26,22,0.22)' }}
        onClick={e => e.stopPropagation()}
      >
        <h2 id="save-dialog-title" className="text-xl text-text-primary">{title}</h2>
        <div role="radiogroup" aria-label="Format" className="flex flex-col gap-2">
          {formats.map(f => {
            const on = f.id === format;
            return (
              <label
                key={f.id}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors ${
                  on ? 'border-accent bg-accent-wash' : 'border-rule hover:bg-elevated'
                }`}
              >
                <input
                  type="radio"
                  name="save-format"
                  value={f.id}
                  checked={on}
                  onChange={() => setFormat(f.id)}
                  className="w-4 h-4 accent-[var(--accent)]"
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-text-primary">{f.label}</span>
                  <span className="text-xs text-text-secondary">{f.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
        {children}
        <div className="flex items-center gap-3 pt-1">
          <span className="text-xs text-text-tertiary mr-auto">You'll choose where to save it next.</span>
          <button onClick={onCancel} className="hearth-ghost-btn">Cancel</button>
          <button onClick={() => onSave(format)} className="hearth-primary-btn" autoFocus>
            <ExportIcon size={18} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** For saving several conversations: one file each, or all in one. */
export function ConversationModeChoice({ mode, onChange }: {
  mode: 'separate' | 'merged';
  onChange: (mode: 'separate' | 'merged') => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium text-text-primary mb-1">Files</legend>
      {([
        ['separate', 'One file per conversation'],
        ['merged', 'Everything in one file'],
      ] as const).map(([id, label]) => (
        <label key={id} className="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer">
          <input
            type="radio"
            name="save-mode"
            checked={mode === id}
            onChange={() => onChange(id)}
            className="w-4 h-4 accent-[var(--accent)]"
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
