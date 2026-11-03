import { useState, useEffect } from 'react';
import { PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { saveFolder, sidecarCall } from '../../lib/ipc';
import { CallIcon, LockIcon } from '../shared/Icons';
import { formatDateTime } from '../../lib/dates';
import { displayName, formatPhone } from '../../lib/people';
import OrganicLoader from '../shared/OrganicLoader';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import { SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { checkEngineResult, plural } from '../../lib/saveData';

interface Call {
  call_id: number;
  address: string;
  contact_name: string;
  date: string;
  duration: number;
  direction: 'incoming' | 'outgoing' | 'unknown';
  status: 'answered' | 'missed' | 'unknown';
  app: string;
}

interface Props {
  udid: string;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s % 1 === 0 ? s : s.toFixed(1)}s`);
  return parts.join(' ');
}

export default function CallExplorer({ udid }: Props) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const { busy, run } = useSaveAction('calls');
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  useEffect(() => {
    loadCalls();
  }, [udid]);

  async function loadCalls() {
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    try {
      const res = await window.openextract.call('list_calls', { udid, limit: 10000 });
      if (!res.success) {
        setCalls([]);
        setTotal(0);
        setError(res.error || 'Failed to load calls');
      } else if (res.data) {
        setCalls(res.data.calls || []);
        setTotal(res.data.total ?? res.data.calls?.length ?? 0);
        setEmptyReason(res.data.empty_reason ?? null);
        // An unencrypted backup without call history also carries an error;
        // it gets the encryption hint below instead.
        if (res.data.error && res.data.empty_reason !== 'requires_encryption') {
          setError(res.data.error);
        }
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSave() {
    run(async () => {
      const outputDir = await saveFolder();
      if (!outputDir) return null;
      const result = checkEngineResult(await sidecarCall<{ path: string; count: number }>('export_calls', { udid, output_dir: outputDir }));
      return { title: `Saved ${plural(result.count, 'call')}`, detail: 'Spreadsheet (CSV)', path: result.path };
    });
  }

  const filtered = calls.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.contact_name.toLowerCase().includes(q) ||
      c.address.toLowerCase().includes(q) ||
      c.app.toLowerCase().includes(q);
  });

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Calls"
        count={total > 0 ? plural(total, 'call') : undefined}
        search={{ value: search, onChange: setSearch, placeholder: 'Search calls' }}
        actions={<SaveButton onClick={handleSave} busy={busy} disabled={calls.length === 0} />}
      />
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-base border-b border-rule">
            <tr>
              <th className="text-left px-6 py-2.5 font-medium text-text-secondary text-xs">Who</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">When</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">How long</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">Call</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">App</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const kind = c.status === 'missed'
                ? { Icon: PhoneMissed, label: 'Missed', color: 'text-apple-error' }
                : c.direction === 'incoming'
                  ? { Icon: PhoneIncoming, label: 'Incoming', color: 'text-text-secondary' }
                  : c.direction === 'outgoing'
                    ? { Icon: PhoneOutgoing, label: 'Outgoing', color: 'text-text-secondary' }
                    : { Icon: CallIcon, label: 'Unknown', color: 'text-text-tertiary' };
              return (
                <tr key={c.call_id} className="border-b border-rule hover:bg-surface">
                  <td className="px-6 py-3">
                    <div className="font-medium text-text-primary">{displayName(c.contact_name, c.address)}</div>
                    {c.address && displayName(c.contact_name, c.address) !== formatPhone(c.address) && (
                      <div className="text-xs text-text-tertiary">{formatPhone(c.address)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{formatDateTime(c.date)}</td>
                  <td className="px-4 py-3 text-text-secondary tabular-nums">{formatDuration(c.duration)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-2 font-medium ${kind.color}`}>
                      <kind.Icon size={18} />
                      {kind.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{c.app || 'Phone'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && filtered.length === 0 && (
          calls.length > 0 ? (
            <EmptyState icon={CallIcon} title={`No calls match "${search}"`} detail="Try part of a name or a phone number." />
          ) : error ? (
            <EmptyState
              icon={CallIcon}
              title="Couldn't read the call history"
              detail={<>{error}<div><ReportProblemButton error={error} area="calls" className="mt-2" /></div></>}
            />
          ) : emptyReason === 'requires_encryption' ? (
            <EmptyState
              icon={LockIcon}
              title="Call history needs an encrypted backup"
              detail={<>Apple leaves call history out of unencrypted backups. Make a new backup with
                encryption on: tick "Encrypt backup" when backing up in OpenExtract, or turn on
                "Encrypt local backup" in Finder or iTunes.</>}
            />
          ) : (
            <EmptyState icon={CallIcon} title="No calls in this backup" />
          )
        )}
      </div>
    </div>
  );
}
