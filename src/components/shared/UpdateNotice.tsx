import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUpdates, releaseNotesUrl } from '../../hooks/useUpdates';
import { DownloadIcon } from './Icons';

/**
 * Bottom-corner card for auto-updates, shown on every screen:
 *  - once, to ask whether OpenExtract may check for updates automatically
 *  - when an update is available, downloading, or ready to install
 * Background check failures (e.g. offline) stay quiet here; Settings shows them.
 */
export default function UpdateNotice() {
  const { state, setAutoCheck, download, install } = useUpdates();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [askedThisSession, setAskedThisSession] = useState(false);
  const prevState = useRef<string | undefined>(undefined);
  const [downloadFailed, setDownloadFailed] = useState<string | null>(null);

  const status = state?.status;
  useEffect(() => {
    if (status?.state === 'error' && (prevState.current === 'downloading' || prevState.current === 'downloaded')) {
      setDownloadFailed(status.error || 'The update failed.');
    } else if (status?.state !== 'error') {
      setDownloadFailed(null);
    }
    prevState.current = status?.state;
  }, [status]);

  if (!state || !state.supported || !status) return null;

  const openNotes = () => window.openextract.openExternal(releaseNotesUrl(state.releasesUrl, status.version));

  if (state.autoCheck === null && !askedThisSession) {
    return (
      <Card title="Keep OpenExtract up to date?">
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          OpenExtract can check GitHub for new versions when it starts. It only asks what the latest
          version is. Your backups and data are never sent. You can change this in Settings.
        </p>
        <div className="flex justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={() => { setAskedThisSession(true); setAutoCheck(false); }}>
            Not now
          </button>
          <button className="hearth-primary-btn" onClick={() => { setAskedThisSession(true); setAutoCheck(true); }}>
            Check automatically
          </button>
        </div>
      </Card>
    );
  }

  if (downloadFailed) {
    return (
      <Card title="Update didn't finish" onClose={() => setDownloadFailed(null)}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">{downloadFailed}</p>
        <div className="flex justify-end">
          <button className="hearth-ghost-btn" onClick={() => window.openextract.openExternal('https://www.openextract.app')}>
            Open openextract.app
          </button>
        </div>
      </Card>
    );
  }

  if (status.state === 'available' && status.version !== dismissedVersion) {
    return (
      <Card title={`OpenExtract ${status.version} is available`} onClose={() => setDismissedVersion(status.version ?? null)}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          You have {state.currentVersion}.{' '}
          <button className="text-accent hover:underline" onClick={openNotes}>What's new</button>
        </p>
        <div className="flex justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={() => setDismissedVersion(status.version ?? null)}>Later</button>
          <button className="hearth-primary-btn" onClick={() => download()}>Update</button>
        </div>
      </Card>
    );
  }

  if (status.state === 'downloading') {
    const pct = status.percent ?? 0;
    return (
      <Card title={`Downloading OpenExtract ${status.version ?? ''}`}>
        <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden mb-1.5">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs text-text-tertiary">{pct}%</div>
      </Card>
    );
  }

  if (status.state === 'downloaded' && status.version !== dismissedVersion) {
    return (
      <Card title={`OpenExtract ${status.version} is ready`} onClose={() => setDismissedVersion(status.version ?? null)}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          Restart to finish updating. If you keep working, it installs the next time you quit.
        </p>
        <div className="flex justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={() => setDismissedVersion(status.version ?? null)}>Later</button>
          <button className="hearth-primary-btn" onClick={() => install()}>Restart now</button>
        </div>
      </Card>
    );
  }

  return null;
}

function Card({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div
      role="status"
      className="fixed right-6 bottom-6 z-40 w-[340px] px-4 py-3.5 rounded-xl"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 10px 28px rgba(30,26,22,0.18)',
      }}
    >
      <div className="flex items-start gap-2.5 mb-1.5">
        <DownloadIcon className="text-accent flex-shrink-0 mt-0.5" size={16} />
        <div className="flex-1 text-sm font-medium text-text-primary">{title}</div>
        {onClose && (
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary flex-shrink-0" aria-label="Dismiss">×</button>
        )}
      </div>
      <div className="pl-[26px]">{children}</div>
    </div>
  );
}
