import type { RecentSession } from '../../lib/appState';
import { PhoneIcon, CaseIcon } from '../shared/Icons';

interface Props {
  sessions: RecentSession[];
  onOpenSession: (id: string) => void;
}

function formatSubtitle(session: RecentSession): string {
  const parts: string[] = [];

  if (session.lastOpened) {
    const d = new Date(session.lastOpened);
    parts.push(`Last opened ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  }

  if (session.iosVersion) {
    parts.push(`iOS ${session.iosVersion}`);
  }

  return parts.join(' · ') || session.subtitle;
}

export default function RecentSessionList({ sessions, onOpenSession }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wide">Recent</span>
        {sessions.length > 5 && (
          <button className="text-xs text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors">
            View all
          </button>
        )}
      </div>
      <div className="rounded-md border border-border-default overflow-hidden bg-border-default flex flex-col gap-px">
        {sessions.slice(0, 5).map((session) => (
          <button
            key={session.id}
            onClick={() => onOpenSession(session.id)}
            className="px-4 py-3.5 flex items-center gap-3 bg-base hover:bg-surface transition-colors text-left w-full"
          >
            <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
              session.type === 'case' ? 'bg-amber-50' : 'bg-elevated'
            }`}>
              {session.type === 'case'
                ? <CaseIcon className="text-amber-600" size={16} />
                : <PhoneIcon className="text-text-secondary" size={16} />
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-text-primary truncate">{session.name}</span>
                {session.type === 'case' && (
                  <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                    CASE
                  </span>
                )}
              </div>
              <div className="text-xs text-text-tertiary truncate">{formatSubtitle(session)}</div>
              {session.backupDir && (
                <div className="text-xs text-text-tertiary truncate mt-0.5" title={session.backupDir}>
                  {session.backupDir}
                </div>
              )}
            </div>
            {session.exportCount > 0 && (
              <span className="text-xs text-text-tertiary flex-shrink-0">
                {session.exportCount} export{session.exportCount !== 1 ? 's' : ''}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
