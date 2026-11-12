import type { RecentSession } from '../../lib/appState';
import { PhoneIcon, CaseIcon, ChevronRightIcon } from '../shared/Icons';
import UnfinishedLabel from '../shared/UnfinishedLabel';

interface Props {
  sessions: RecentSession[];
  onOpenSession: (id: string) => void;
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

// Every remembered backup (the app keeps the last 20), newest first. The folder
// path is in the tooltip rather than on screen.
export default function RecentSessionList({ sessions, onOpenSession }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div className="mb-5 flex flex-col gap-2.5">
      {sessions.map((session) => (
        <button
          key={session.id}
          onClick={() => onOpenSession(session.id)}
          title={session.backupDir}
          className="hearth-card px-5 py-4 flex items-center gap-4 hover:bg-[var(--bg-elevated)] transition-colors text-left w-full"
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
      ))}
    </div>
  );
}
