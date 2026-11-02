import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import {
  FEEDBACK_AREAS, FEEDBACK_KINDS, formatDiagnostics, fullReport, githubIssueUrl,
  type FeedbackArea, type FeedbackForm, type FeedbackKind, type FeedbackRequest,
} from '../../lib/feedback';

/**
 * In-app feedback. Any component can open the form with useFeedback(), or show
 * <ReportProblemButton> next to an error. The form opens a pre-filled GitHub
 * issue in the user's own browser; OpenExtract itself
 * sends nothing, and the user sees and can edit every word first.
 */

const FeedbackContext = createContext<{ openFeedback: (req?: FeedbackRequest) => void }>({
  openFeedback: () => {},
});

export function useFeedback() {
  return useContext(FeedbackContext);
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<FeedbackRequest | null>(null);
  const openFeedback = useCallback((req: FeedbackRequest = {}) => setRequest(req), []);

  return (
    <FeedbackContext.Provider value={{ openFeedback }}>
      {children}
      {request && <FeedbackDialog request={request} onClose={() => setRequest(null)} />}
    </FeedbackContext.Provider>
  );
}

/** Small link for error messages: opens the form with the error and area filled in. */
export function ReportProblemButton({ error, area, className = '' }: {
  error?: string | null;
  area: FeedbackArea;
  className?: string;
}) {
  const { openFeedback } = useFeedback();
  return (
    <button
      type="button"
      className={`text-xs text-accent hover:underline ${className}`}
      onClick={() => openFeedback({ kind: 'broken', area, error: error ?? undefined })}
    >
      Report this problem
    </button>
  );
}

type Sent = { shortened: boolean } | null;

function FeedbackDialog({ request, onClose }: { request: FeedbackRequest; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? 'broken');
  const [area, setArea] = useState<FeedbackArea>(request.area ?? 'general');
  const [details, setDetails] = useState('');
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent>(null);
  const [copied, setCopied] = useState(false);
  const detailsRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = window.openextract?.feedback?.getDiagnostics;
    if (!load) {
      setDiagnostics('');
      return;
    }
    load(request.error)
      .then(d => { if (!cancelled) setDiagnostics(formatDiagnostics(d)); })
      .catch(() => { if (!cancelled) setDiagnostics(''); });
    return () => { cancelled = true; };
  }, [request.error]);

  useEffect(() => {
    detailsRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const form: FeedbackForm = { kind, area, details, diagnostics: diagnostics ?? '' };
  const ready = details.trim().length > 0 && diagnostics !== null;

  const copyReport = async () => {
    try {
      await window.openextract.copyText(fullReport(form));
      return true;
    } catch {
      return false;
    }
  };

  const send = async () => {
    if (!ready) return;
    // Copy first: if the link had to be shortened, or the browser doesn't
    // open, the whole report is still on the clipboard.
    await copyReport();
    const { url, shortened } = githubIssueUrl(form);
    window.openextract.openExternal(url);
    setSent({ shortened });
  };

  if (sent) {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-text-primary mb-2">
          Your browser should now show the report on GitHub. Check it over, then click "Create" to send it.
          If GitHub asks you to sign in, you'll come back to the report afterwards.
        </p>
        <p className="text-xs text-text-secondary mb-4">
          {sent.shortened
            ? 'The report was too long for a link, so part of it was left out. The whole report is on your clipboard: paste it in to include the rest.'
            : 'A copy of the report is also on your clipboard, in case nothing opened.'}
        </p>
        <div className="flex justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={() => setSent(null)}>Back</button>
          <button className="hearth-primary-btn" onClick={onClose}>Done</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      <fieldset className="mb-4">
        <legend className="hearth-eyebrow mb-2">What kind of feedback?</legend>
        <div className="grid grid-cols-2 gap-2">
          {FEEDBACK_KINDS.map(k => (
            <label
              key={k.id}
              className={`p-2.5 rounded-lg border cursor-pointer text-left transition-colors focus-within:ring-2 focus-within:ring-accent ${
                kind === k.id ? 'border-accent bg-surface' : 'border-border-default hover:border-border-strong'
              }`}
            >
              <input type="radio" name="feedback-kind" className="sr-only" checked={kind === k.id} onChange={() => setKind(k.id)} />
              <div className="text-sm text-text-primary leading-snug">{k.label}</div>
              <div className="text-[11px] text-text-tertiary leading-snug mt-0.5">{k.hint}</div>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block mb-4">
        <span className="hearth-eyebrow block mb-1.5">Which part of OpenExtract?</span>
        <select
          className="w-full text-sm rounded-md border border-border-default bg-base px-2.5 py-1.5 text-text-primary"
          value={area}
          onChange={e => setArea(e.target.value as FeedbackArea)}
        >
          {FEEDBACK_AREAS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </label>

      <label className="block mb-4">
        <span className="hearth-eyebrow block mb-1.5">What happened?</span>
        <textarea
          ref={detailsRef}
          className="w-full h-24 text-sm rounded-md border border-border-default bg-base px-2.5 py-2 text-text-primary resize-y"
          placeholder={kind === 'idea'
            ? 'What would you like OpenExtract to do, and what would it help you with?'
            : 'What did you do, what did you expect, and what happened instead?'}
          value={details}
          onChange={e => setDetails(e.target.value)}
        />
        <span className="text-[11px] text-text-tertiary">
          Please don't include message text, names or phone numbers from your backup.
        </span>
      </label>

      <label className="block mb-4">
        <span className="hearth-eyebrow block mb-1.5">Details we'll include (you can edit or delete any of it)</span>
        <textarea
          className="w-full h-32 text-[11px] font-mono rounded-md border border-border-default bg-surface px-2.5 py-2 text-text-secondary resize-y"
          value={diagnostics ?? 'Gathering details…'}
          disabled={diagnostics === null}
          onChange={e => setDiagnostics(e.target.value)}
          spellCheck={false}
        />
        <span className="text-[11px] text-text-tertiary">
          App and system versions, your phone's model and iOS version, and recent errors. Your
          folder names, device name, email addresses and phone numbers are replaced with
          placeholders. Nothing from inside your backup is included.
        </span>
      </label>

      <p className="text-xs text-text-secondary mb-4">
        OpenExtract doesn't send this itself. It opens the report on GitHub in your browser so you
        can check it before sending. GitHub reports are public, and you need a free GitHub account
        to send one.
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          className="text-xs text-text-secondary hover:text-text-primary mr-auto"
          disabled={!ready}
          onClick={async () => {
            if (await copyReport()) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
        <button className="hearth-primary-btn" disabled={!ready} onClick={() => send()}>
          Open on GitHub
        </button>
      </div>
    </Shell>
  );
}

function Shell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="bg-base rounded-xl shadow-xl w-[560px] max-w-[94vw] max-h-[92vh] overflow-y-auto p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-full bg-elevated flex items-center justify-center">
            <MessageSquare className="text-text-secondary" size={18} />
          </div>
          <div id="feedback-title" className="flex-1 text-sm font-medium text-text-primary">Send feedback</div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
