import { useEffect, useState } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon, SearchIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import NoticeBanners, { type ExportStatus } from '../shared/NoticeBanners';
import { formatDateTime, formatDuration } from '../../lib/dates';
import { memoTitle, type VoiceMemo } from '../../lib/voiceMemos';
import VoiceMemoPlayer from './VoiceMemoPlayer';

interface Props {
  udid: string;
}

export default function VoiceMemoExplorer({ udid }: Props) {
  const [memos, setMemos] = useState<VoiceMemo[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);

  useEffect(() => {
    loadMemos();
  }, [udid]);

  async function loadMemos() {
    setLoading(true);
    setExpanded(null);
    try {
      const res = await window.openextract.call('list_voice_memos', { udid });
      if (res.success && res.data) {
        setMemos(res.data.voice_memos || []);
        setErrors((res.data.errors || []).map((e: { message: string }) => e.message));
      } else {
        setErrors([res.error || "Couldn't load voice memos."]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    setStatus(null);
    try {
      const res = await window.openextract.call('export_voice_memos', {
        udid,
        output_dir: `${outputDir}/Voice Memos`,
      });
      const data = res.success ? res.data : null;
      if (data?.success) {
        window.openextract.incrementExportCount();
        const missing = data.missing
          ? data.missing === 1
            ? ' 1 recording had no audio in the backup; its details are in voice_memos.csv.'
            : ` ${data.missing} recordings had no audio in the backup; their details are in voice_memos.csv.`
          : '';
        setStatus({ ok: true, text: `Exported ${data.exported} recording${data.exported === 1 ? '' : 's'} to ${data.path}.${missing}` });
      } else {
        setStatus({ ok: false, text: data?.error || res.error || 'Export failed.' });
      }
    } finally {
      setExporting(false);
    }
  }

  const q = search.trim().toLowerCase();
  const matches = memos.filter(m =>
    !q || memoTitle(m).toLowerCase().includes(q) || (m.folder ?? '').toLowerCase().includes(q)
  );
  const active = matches.filter(m => !m.deleted);
  const deleted = matches.filter(m => m.deleted);
  const activeTotal = memos.filter(m => !m.deleted).length;

  function renderMemo(memo: VoiceMemo) {
    const isOpen = expanded === memo.id;
    return (
      <div key={memo.id} className="border-b border-gray-100">
        <button
          onClick={() => setExpanded(isOpen ? null : memo.id)}
          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 truncate">{memoTitle(memo)}</div>
            <div className="text-xs text-gray-400">
              {formatDateTime(memo.date)} · {formatDuration(memo.duration)}
              {memo.folder && ` · ${memo.folder}`}
              {!memo.has_audio && ' · Audio not in backup'}
            </div>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {isOpen && (
          <div className="px-4 pb-3">
            {memo.has_audio ? (
              <VoiceMemoPlayer udid={udid} memoId={memo.id} autoPlay />
            ) : (
              <div className="text-sm text-gray-500">
                This recording's audio file isn't in the backup — only its details are.
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 bg-base" style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
        <div>
          <div className="hearth-eyebrow mb-1.5">
            Voice Memos{activeTotal > 0 && ` · ${activeTotal}`}
          </div>
          <h1 className="hearth-title text-3xl">
            Thoughts you <span className="font-serif-italic text-accent">recorded.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search recordings..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-48"
            />
          </div>
          <button onClick={handleExport} disabled={exporting || memos.length === 0} className="hearth-ghost-btn" title="Export all recordings">
            <ExportIcon size={13} />
            {exporting ? 'Exporting…' : 'Export audio'}
          </button>
        </div>
      </div>

      <NoticeBanners errors={errors} status={status} />

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && memos.length === 0 && errors.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No voice memos found in this backup</div>
        )}
        {!loading && memos.length > 0 && matches.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No recordings match your search</div>
        )}
        {!loading && active.map(renderMemo)}
        {!loading && deleted.length > 0 && (
          <>
            <div className="px-4 pt-5 pb-2 bg-gray-50/60 border-b border-gray-100">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Recently Deleted · {deleted.length}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                Deleted on the iPhone but still in this backup. You can play and export them.
              </div>
            </div>
            {deleted.map(renderMemo)}
          </>
        )}
      </div>
    </div>
  );
}
