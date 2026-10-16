import { useEffect } from 'react';
import { useUpdates, releaseNotesUrl } from '../../hooks/useUpdates';
import { SettingsIcon } from './Icons';
import type { UpdateStatus } from '../../types';

interface Props {
  onClose: () => void;
}

const WEBSITE_URL = 'https://www.openextract.app';
const ISSUES_URL = 'https://github.com/charleswest775/openextract/issues';

export default function SettingsDialog({ onClose }: Props) {
  const { state, setAutoCheck, check, download, install } = useUpdates();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (url: string) => window.openextract.openExternal(url);
  const status = state?.status;
  const busy = status?.state === 'checking' || status?.state === 'downloading';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-base rounded-xl shadow-xl w-[440px] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-elevated flex items-center justify-center">
            <SettingsIcon className="text-text-secondary" size={20} />
          </div>
          <div className="flex-1 text-sm font-medium text-text-primary">Settings</div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">×</button>
        </div>

        <div className="hearth-eyebrow mb-2">Updates</div>
        {!state ? (
          <p className="text-sm text-text-secondary mb-5">Loading…</p>
        ) : (
          <div className="mb-6">
            <p className="text-sm text-text-primary mb-3">You're using OpenExtract {state.currentVersion}.</p>

            {state.supported ? (
              <>
                <label className="flex items-start gap-2.5 mb-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--accent)]"
                    checked={state.autoCheck === true}
                    onChange={e => setAutoCheck(e.target.checked)}
                  />
                  <span className="text-sm text-text-primary">Check for updates automatically when OpenExtract starts</span>
                </label>
                <p className="text-xs text-text-tertiary mb-3 pl-[26px]">
                  Only asks GitHub which version is the latest. Your backups and data are never sent.
                </p>

                <div className="flex items-center gap-3 min-h-[30px]">
                  <button className="hearth-ghost-btn" disabled={busy} onClick={() => check()}>Check now</button>
                  <StatusLine
                    status={status}
                    onUpdate={() => download()}
                    onRestart={() => install()}
                    onNotes={() => open(releaseNotesUrl(state.releasesUrl, status?.version))}
                    onWebsite={() => open(WEBSITE_URL)}
                  />
                </div>
              </>
            ) : (
              <p className="text-sm text-text-secondary">
                This copy of OpenExtract can't update itself. Get new versions from{' '}
                <button className="text-accent hover:underline" onClick={() => open(WEBSITE_URL)}>openextract.app</button>.
              </p>
            )}
          </div>
        )}

        <div className="hearth-eyebrow mb-2">About</div>
        <div className="flex flex-wrap gap-2">
          <button className="hearth-ghost-btn" onClick={() => open(WEBSITE_URL)}>Website</button>
          <button className="hearth-ghost-btn" onClick={() => open(state?.releasesUrl ?? WEBSITE_URL)}>Release notes</button>
          <button className="hearth-ghost-btn" onClick={() => open(ISSUES_URL)}>Report a problem</button>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ status, onUpdate, onRestart, onNotes, onWebsite }: {
  status?: UpdateStatus;
  onUpdate: () => void;
  onRestart: () => void;
  onNotes: () => void;
  onWebsite: () => void;
}) {
  const time = status?.checkedAt
    ? new Date(status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  switch (status?.state) {
    case 'checking':
      return <span className="text-xs text-text-tertiary">Checking…</span>;
    case 'not-available':
      return <span className="text-xs text-text-secondary">You're up to date{time ? ` (checked ${time})` : ''}.</span>;
    case 'available':
      return (
        <span className="text-xs text-text-secondary flex items-center gap-2">
          {status.version} is available.
          <button className="text-accent hover:underline" onClick={onNotes}>What's new</button>
          <button className="hearth-primary-btn" onClick={onUpdate}>Update</button>
        </span>
      );
    case 'downloading':
      return <span className="text-xs text-text-secondary">Downloading {status.version}… {status.percent ?? 0}%</span>;
    case 'downloaded':
      return (
        <span className="text-xs text-text-secondary flex items-center gap-2">
          {status.version} is ready.
          <button className="hearth-primary-btn" onClick={onRestart}>Restart now</button>
        </span>
      );
    case 'error':
      return (
        <span className="text-xs text-apple-error">
          {status.error}{' '}
          <button className="text-accent hover:underline" onClick={onWebsite}>openextract.app</button>
        </span>
      );
    default:
      return null;
  }
}
