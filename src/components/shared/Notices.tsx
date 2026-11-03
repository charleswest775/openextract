import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { ReportProblemButton } from './Feedback';
import type { FeedbackArea } from '../../lib/feedback';

export interface Notice {
  kind: 'success' | 'error';
  title: string;
  detail?: string;
  /** A saved file or folder; adds "Show in folder". */
  path?: string;
  /** For errors: which part of the app, for "Report this problem". */
  area?: FeedbackArea;
}

const NoticeContext = createContext<(notice: Notice) => void>(() => {});

/** Show the result of an action (a save, usually) as an in-app notice. */
export function useNotice() {
  return useContext(NoticeContext);
}

const SUCCESS_MS = 8000;

/** In-app notices, bottom center. Successes fade on their own; errors stay until dismissed. */
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<(Notice & { id: number })[]>([]);

  const dismiss = useCallback((id: number) => {
    setNotices(list => list.filter(n => n.id !== id));
  }, []);

  const notify = useCallback((notice: Notice) => {
    const id = Date.now() + Math.random();
    setNotices(list => [...list.slice(-2), { ...notice, id }]);
    if (notice.kind === 'success') setTimeout(() => dismiss(id), SUCCESS_MS);
  }, [dismiss]);

  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 flex flex-col items-center gap-2 w-[min(480px,90vw)]" aria-live="polite">
        {notices.map(n => (
          <div
            key={n.id}
            role={n.kind === 'error' ? 'alert' : 'status'}
            className="w-full px-4 py-3 rounded-xl flex items-start gap-3 bg-surface border border-border-strong"
            style={{ boxShadow: '0 10px 28px rgba(30,26,22,0.18)' }}
          >
            <span
              className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white text-sm mt-0.5"
              style={{ background: n.kind === 'error' ? 'var(--error)' : 'var(--success)' }}
            >
              {n.kind === 'error' ? '!' : <Check size={14} />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{n.title}</div>
              {n.detail && <div className="text-xs text-text-secondary break-words mt-0.5">{n.detail}</div>}
              {n.path && (
                <button
                  onClick={() => window.openextract.showInFolder(n.path!)}
                  className="text-xs text-accent hover:underline mt-1"
                >
                  Show in folder
                </button>
              )}
              {n.kind === 'error' && (
                <ReportProblemButton error={n.detail ?? n.title} area={n.area ?? 'export'} className="mt-1" />
              )}
            </div>
            <button
              onClick={() => dismiss(n.id)}
              className="text-text-tertiary hover:text-text-primary text-lg leading-none flex-shrink-0"
              aria-label="Dismiss"
            >×</button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
