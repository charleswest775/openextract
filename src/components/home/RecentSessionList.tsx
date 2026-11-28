import { useEffect, useRef, useState } from 'react';
import type { RecentSession } from '../../lib/appState';
import { backupMenuWords } from '../../lib/foundBackups';
import { PhoneIcon, CaseIcon, ChevronRightIcon, MoreIcon } from '../shared/Icons';
import UnfinishedLabel from '../shared/UnfinishedLabel';

interface Props {
  sessions: RecentSession[];
  onOpenSession: (id: string) => void;
  /** The list changed (a backup moved to the Trash or taken off the list): read it again. */
  onChanged?: () => void;
}

function formatSubtitle(session: RecentSession): string {
  const parts: string[] = [];

  if (session.iosVersion) {
    parts.push(`iOS ${session.iosVersion}`);
  }

  if (session.sizeGB) {
    parts.push(`${session.sizeGB.toFixed(1)} GB`);
  }

  if (session.lastOpened) {
    const d = new Date(session.lastOpened);
    parts.push(`Last opened ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  }

  return parts.join(' · ') || session.subtitle;
}

/** A row's ⋯ menu: Show in Finder, Move to Trash…, Remove from list. Escape or a click elsewhere closes it. */
function RowMenu({ session, busy, onMove, onRemove }: {
  session: RecentSession;
  busy: boolean;
  onMove: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const words = backupMenuWords(window.openextract?.platform ?? '');

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const item = 'block w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-[var(--bg-elevated)] disabled:opacity-50';
  return (
    <div ref={box} className="relative flex-shrink-0 pr-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${session.name}`}
        title="More"
        disabled={busy}
        className="w-9 h-9 rounded-lg flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-[var(--bg-elevated)] disabled:opacity-50"
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${session.name}`}
          className="absolute right-3 top-10 z-30 min-w-[13rem] py-1 rounded-xl"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', boxShadow: '0 10px 28px rgba(30,26,22,0.18)' }}
        >
          {session.backupDir && (
            <button type="button" role="menuitem" className={item}
              onClick={pick(() => window.openextract.showInFolder(session.backupDir!))}>
              {words.show}
            </button>
          )}
          {session.backupDir && words.canMove && (
            <button type="button" role="menuitem" className={item} onClick={pick(onMove)}>
              {words.move}
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={pick(onRemove)}>
            {words.remove}
          </button>
        </div>
      )}
    </div>
  );
}

// Every remembered backup (the app keeps the last 20), newest first. The folder
// path is in the tooltip rather than on screen. A backup deleted since is left out
// by the main process (electron/recentBackups.ts).
export default function RecentSessionList({ sessions, onOpenSession, onChanged }: Props) {
  // Which backup is being checked or moved, what went wrong with which, and whether one moved.
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null);
  const [moved, setMoved] = useState(false);
  const words = backupMenuWords(window.openextract?.platform ?? '');

  if (sessions.length === 0 && !moved) return null;

  // The main process checks, asks in its own dialog and moves (electron/olderBackups.ts).
  const moveToTrash = async (session: RecentSession) => {
    if (!session.backupDir) return;
    setWorking(session.id);
    setProblem(null);
    setMoved(false);
    try {
      const result = await window.openextract.trashBackup(session.backupDir);
      if (result.status === 'moved') {
        setMoved(true);
        onChanged?.();
      } else if (result.status !== 'cancelled') {
        setProblem({ id: session.id, message: result.message });
      }
    } catch (err) {
      console.error("Couldn't move the backup:", err);
      setProblem({ id: session.id, message: "OpenExtract couldn't finish checking that backup, so it didn't move it." });
    } finally {
      setWorking(null);
    }
  };

  // Only the app's list changes; the backup stays where it is.
  const removeFromList = async (session: RecentSession) => {
    setProblem(null);
    setMoved(false);
    await window.openextract.removeSession(session.id);
    onChanged?.();
  };

  return (
    <div className="mb-5 flex flex-col gap-2.5" data-recent-backups>
      {moved && (
        <p role="status" className="text-sm text-text-secondary">{words.moved}</p>
      )}
      {sessions.map((session) => (
        <div key={session.id}>
          <div className="hearth-card flex items-center hover:bg-[var(--bg-elevated)] transition-colors">
            <button
              onClick={() => onOpenSession(session.id)}
              title={session.backupDir}
              disabled={working === session.id}
              className="px-5 py-4 flex items-center gap-4 text-left flex-1 min-w-0"
            >
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
                session.type === 'case' ? 'bg-amber-50' : 'bg-accent-wash'
              }`}>
                {session.type === 'case'
                  ? <CaseIcon className="text-amber-700" size={24} />
                  : <PhoneIcon className="text-accent" size={24} />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-text-primary truncate">{session.name}</span>
                  {session.type === 'case' && (
                    <span className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                      CASE
                    </span>
                  )}
                  {session.unfinished && <UnfinishedLabel />}
                </div>
                <div className="text-sm text-text-secondary truncate">{formatSubtitle(session)}</div>
              </div>
              {session.exportCount > 0 && (
                <span className="text-sm text-text-tertiary flex-shrink-0">
                  {session.exportCount} save{session.exportCount !== 1 ? 's' : ''}
                </span>
              )}
              <span className="hearth-ghost-btn flex-shrink-0 pointer-events-none">
                Open
                <ChevronRightIcon size={18} />
              </span>
            </button>
            <RowMenu
              session={session}
              busy={working !== null}
              onMove={() => moveToTrash(session)}
              onRemove={() => removeFromList(session)}
            />
          </div>
          {working === session.id && (
            <p role="status" className="mt-1.5 px-1 text-sm text-text-secondary">{words.checking}</p>
          )}
          {problem?.id === session.id && (
            <p role="alert" className="mt-1.5 px-1 text-sm text-text-primary">{problem.message}</p>
          )}
        </div>
      ))}
    </div>
  );
}
