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
        <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent</span>
        {sessions.length > 5 && (
          <button className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer transition-colors">
            View all
          </button>
        )}
      </div>
      <div className="rounded-md border border-gray-200 overflow-hidden bg-gray-200 flex flex-col gap-px">
        {sessions.slice(0, 5).map((session) => (
          <button
            key={session.id}
            onClick={() => onOpenSession(session.id)}
            className="px-4 py-3.5 flex items-center gap-3 bg-white hover:bg-gray-50 transition-colors text-left w-full"
          >
            <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
              session.type === 'case' ? 'bg-amber-50' : 'bg-gray-100'
            }`}>
              {session.type === 'case'
                ? <CaseIcon className="text-amber-600" size={16} />
                : <PhoneIcon className="text-gray-500" size={16} />
              }
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-gray-900 truncate">{session.name}</span>
                {session.type === 'case' && (
                  <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                    CASE
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-400 truncate">{formatSubtitle(session)}</div>
            </div>
            {session.exportCount > 0 && (
              <span className="text-xs text-gray-400 flex-shrink-0">
                {session.exportCount} export{session.exportCount !== 1 ? 's' : ''}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
