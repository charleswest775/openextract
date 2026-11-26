import { useAskAi } from '../../hooks/useAskAi';
import { appNames, markNoteSeen, newNoteShown, openAskAi, PRICE_LINE, setAskAiHidden } from '../../lib/askAi';
import { AskAiIcon } from '../shared/Icons';

/**
 * The one-time "New" note about Ask AI, on the home screen's list of backups. It's part of
 * the page, never one of the cards that come after a save (pay it forward, thanks, the
 * export check). It shows once: closing it or opening Ask AI puts it away for good, and
 * "Don't show this again" hides Ask AI altogether (Settings brings it back).
 */
export default function AskAiNote() {
  const state = useAskAi();
  if (!newNoteShown(state) || !state?.enabled) return null;
  const names = appNames(state.apps);
  const are = state.apps.length > 1 ? 'are' : 'is';

  return (
    <div role="note" aria-label="New: Ask AI" className="hearth-card p-4 mb-6 flex items-start gap-3">
      <span className="w-10 h-10 rounded-xl bg-accent-wash flex items-center justify-center flex-shrink-0">
        <AskAiIcon size={22} className="text-accent" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="hearth-pill !py-0.5 !px-2 !text-[11px] font-medium text-accent">New</span>
          <span className="text-sm font-medium text-text-primary">Ask AI about your backups</span>
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">
          {names} {are} on this computer. With the OpenExtract AI add-on, {state.apps.length > 1 ? 'they' : 'it'} can
          read your backups and answer questions about them. {PRICE_LINE}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button className="hearth-primary-btn !py-1.5" onClick={() => { markNoteSeen(); openAskAi(); }}>
            See how it works
          </button>
          <button className="text-sm text-text-secondary hover:text-text-primary hover:underline" onClick={() => setAskAiHidden(true)}>
            Don't show this again
          </button>
        </div>
      </div>
      <button onClick={() => markNoteSeen()} className="text-text-tertiary hover:text-text-primary flex-shrink-0" aria-label="Dismiss">×</button>
    </div>
  );
}
