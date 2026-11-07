import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Heart, MessageSquare } from 'lucide-react';
import {
  FEEDBACK_AREAS, FEEDBACK_KINDS, FIXES_URL, PRIVACY_URL, SITE_URL, formatDiagnostics, fullReport, githubIssueUrl, newReportToken,
  type FeedbackArea, type FeedbackForm, type FeedbackKind, type FeedbackRequest,
} from '../../lib/feedback';
import type { KnownFix } from '../../types';

/**
 * In-app feedback. Any component can open the form with useFeedback(), or show
 * <ReportProblemButton> next to an error. Send delivers the report to
 * openextract.app (electron/feedbackReports.ts), where it's filed privately; no
 * account is needed. The user sees and can edit every word first. If sending
 * fails, they can copy the report or post it on GitHub instead.
 *
 * openFeedback({ kind: 'thanks' }) opens a short "Say thanks" form instead: an
 * optional message and email, no diagnostics, and nothing to follow up on.
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

/**
 * Small links for error messages: one opens the form with the error and area filled in, the
 * other the fixes for common problems on openextract.app, so people can try those first.
 */
export function ReportProblemButton({ error, area, className = '' }: {
  error?: string | null;
  area: FeedbackArea;
  className?: string;
}) {
  const { openFeedback } = useFeedback();
  return (
    <span className={`inline-block text-xs ${className}`}>
      <button
        type="button"
        className="text-accent hover:underline"
        onClick={() => openFeedback({ kind: 'broken', area, error: error ?? undefined })}
      >
        Report this problem
      </button>
      <span className="text-text-secondary" aria-hidden="true"> · </span>
      <button
        type="button"
        className="text-accent hover:underline"
        onClick={() => window.openextract.openExternal(FIXES_URL)}
      >
        Common fixes
      </button>
    </span>
  );
}

type Done =
  | { via: 'app'; reference: string; knownFixes: KnownFix[] }
  | { via: 'github'; shortened: boolean };

function FeedbackDialog({ request, onClose }: { request: FeedbackRequest; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? 'broken');
  const [area, setArea] = useState<FeedbackArea>(request.area ?? 'general');
  const [details, setDetails] = useState('');
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);
  const [quote, setQuote] = useState(false);
  const thanks = kind === 'thanks';
  // Opened straight to "Say thanks" (from a card after an export): skip the list of problem kinds.
  const thanksOnly = request.kind === 'thanks';
  // One code per form, so pressing Send again after a failure can't file the report twice.
  const [token] = useState(newReportToken);
  const detailsRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.openextract?.feedback;
    api?.savedEmail?.().then(saved => { if (!cancelled && saved) setEmail(e => e || saved); }).catch(() => {});
    const load = api?.getDiagnostics;
    if (!load || request.kind === 'thanks') {
      setDiagnostics('');
      return;
    }
    load(request.error)
      .then(d => { if (!cancelled) setDiagnostics(formatDiagnostics(d)); })
      .catch(() => { if (!cancelled) setDiagnostics(''); });
    return () => { cancelled = true; };
  }, [request.error, request.kind]);

  useEffect(() => {
    detailsRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const form: FeedbackForm = thanks
    ? { kind, area, details, diagnostics: '', quote: quote && details.trim().length > 0 }
    : { kind, area, details, diagnostics: diagnostics ?? '' };
  // A thank-you can be sent without a message.
  const ready = !sending && (thanks || (details.trim().length > 0 && diagnostics !== null));

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
    setSending(true);
    setSendError(null);
    try {
      const result = await window.openextract.feedback.send({ ...form, email: email.trim(), token });
      if (result.ok) setDone({ via: 'app', reference: result.reference, knownFixes: result.knownFixes });
      else setSendError(result.error);
    } catch {
      setSendError(thanks
        ? "Your thanks couldn't be sent right now. Please try again later."
        : "The report couldn't be sent. Copy it, or post it on GitHub instead.");
    } finally {
      setSending(false);
    }
  };

  const openOnGitHub = async () => {
    // Copy first: if the link had to be shortened, or the browser doesn't
    // open, the whole report is still on the clipboard.
    await copyReport();
    const { url, shortened } = githubIssueUrl(form);
    window.openextract.openExternal(url);
    setDone({ via: 'github', shortened });
  };

  if (done?.via === 'app' && thanks) {
    return (
      <Shell onClose={onClose} thanks>
        <p className="text-sm text-text-primary mb-1">Thank you. Your message was sent.</p>
        <p className="text-xs text-text-secondary leading-relaxed mb-4">
          Hearing that OpenExtract helped is what keeps it going. If you know someone who could use it,
          passing on the link helps them find it.
        </p>
        <div className="flex justify-end gap-2">
          <button
            className="hearth-ghost-btn"
            aria-live="polite"
            onClick={async () => {
              try {
                await window.openextract.copyText(SITE_URL);
                setCopied(true);
                setTimeout(() => setCopied(false), 2500);
              } catch {
                // Clipboard unavailable: leave the button as it was.
              }
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <button className="hearth-primary-btn" onClick={onClose}>Done</button>
        </div>
      </Shell>
    );
  }

  if (done?.via === 'app') {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-text-primary mb-1">Thanks. Your report was sent.</p>
        <p className="text-xs text-text-secondary mb-3">
          Reference <span className="font-mono text-text-primary select-text">{done.reference}</span>
        </p>
        <p className="text-xs text-text-secondary leading-relaxed mb-4">
          {email.trim()
            ? "We'll write to you if we need anything else. "
            : ''}
          OpenExtract will let you know here when it's fixed.
        </p>
        {done.knownFixes.length > 0 && (
          <div className="rounded-lg border border-border-default bg-surface p-3 mb-4">
            <div className="hearth-eyebrow mb-2">This might help right now</div>
            {done.knownFixes.map(fix => (
              <div key={fix.id || fix.title} className="mb-2 last:mb-0">
                <div className="text-sm text-text-primary mb-0.5">{fix.title}</div>
                <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line">{fix.text}</p>
                {fix.url && (
                  <button className="text-xs text-accent hover:underline mt-1" onClick={() => window.openextract.openExternal(fix.url!)}>
                    Read more
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <button className="hearth-primary-btn" onClick={onClose}>Done</button>
        </div>
      </Shell>
    );
  }

  if (done?.via === 'github') {
    return (
      <Shell onClose={onClose}>
        <p className="text-sm text-text-primary mb-2">
          Your browser should now show the report on GitHub. Check it over, then click "Create" to send it.
          If GitHub asks you to sign in, you'll come back to the report afterwards.
        </p>
        <p className="text-xs text-text-secondary mb-4">
          {done.shortened
            ? 'The report was too long for a link, so part of it was left out. The whole report is on your clipboard: paste it in to include the rest.'
            : 'A copy of the report is also on your clipboard, in case nothing opened.'}
        </p>
        <div className="flex justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={() => setDone(null)}>Back</button>
          <button className="hearth-primary-btn" onClick={onClose}>Done</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose} thanks={thanksOnly}>
      {thanksOnly ? (
        <p className="text-sm text-text-secondary leading-relaxed mb-4">
          OpenExtract is free, made by an independent developer with help from contributors. A few
          words about how it helped mean a lot.
        </p>
      ) : (
        <fieldset className="mb-4">
          <legend className="hearth-eyebrow mb-2">What kind of feedback?</legend>
          <div className="grid grid-cols-2 gap-2">
            {FEEDBACK_KINDS.map(k => (
              <label
                key={k.id}
                className={`p-2.5 rounded-lg border cursor-pointer text-left transition-colors focus-within:ring-2 focus-within:ring-accent ${
                  kind === k.id ? 'border-accent bg-surface' : 'border-border-default hover:border-border-strong'
                } ${k.id === 'thanks' ? 'col-span-2' : ''}`}
              >
                <input type="radio" name="feedback-kind" className="sr-only" checked={kind === k.id} onChange={() => setKind(k.id)} />
                <div className="text-sm text-text-primary leading-snug">{k.label}</div>
                <div className="text-xs text-text-tertiary leading-snug mt-0.5">{k.hint}</div>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!thanks && (
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
      )}

      <label className="block mb-4">
        <span className="hearth-eyebrow block mb-1.5">{thanks ? 'Your message (optional)' : 'What happened?'}</span>
        <textarea
          ref={detailsRef}
          className="w-full h-24 text-sm rounded-md border border-border-default bg-base px-2.5 py-2 text-text-primary resize-y"
          placeholder={thanks
            ? 'What did OpenExtract help you do?'
            : kind === 'idea'
              ? 'What would you like OpenExtract to do, and what would it help you with?'
              : 'What did you do, what did you expect, and what happened instead?'}
          value={details}
          onChange={e => setDetails(e.target.value)}
        />
        <span className="text-xs text-text-tertiary">
          Please don't include message text, names or phone numbers from your backup.
        </span>
      </label>

      {thanks && (
        <label className="flex items-start gap-2 mb-4 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={quote} onChange={e => setQuote(e.target.checked)} />
          <span>OK to quote what I wrote on openextract.app, without my name</span>
        </label>
      )}

      {!thanks && (
        <label className="block mb-4">
          <span className="hearth-eyebrow block mb-1.5">Details we'll include (you can edit or delete any of it)</span>
          <textarea
            className="w-full h-32 text-xs font-mono rounded-md border border-border-default bg-surface px-2.5 py-2 text-text-secondary resize-y"
            value={diagnostics ?? 'Gathering details…'}
            disabled={diagnostics === null}
            onChange={e => setDiagnostics(e.target.value)}
            spellCheck={false}
          />
          <span className="text-xs text-text-tertiary">
            App and system versions, your phone's model and iOS version, and recent errors. Your
            folder names, device name, email addresses and phone numbers are replaced with
            placeholders. Nothing from inside your backup is included.
          </span>
        </label>
      )}

      <label className="block mb-4">
        <span className="hearth-eyebrow block mb-1.5">Your email (optional)</span>
        <input
          type="email"
          className="w-full text-sm rounded-md border border-border-default bg-base px-2.5 py-1.5 text-text-primary"
          placeholder="Only if you'd like a reply"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
        />
        <span className="text-[11px] text-text-tertiary">
          {thanks ? 'Only used to write back to you.' : 'Only used to write to you about this report.'}
          {' '}It's never shared or added to a mailing list.
        </span>
      </label>

      <p className="text-xs text-text-secondary mb-4">
        {thanks
          ? "Send delivers your message privately to OpenExtract's developer. Nothing about your computer or your backup is included, and you don't need an account."
          : "Send delivers this report privately to OpenExtract's developer. It isn't posted anywhere public, and you don't need an account. While it's open, OpenExtract checks on it every few days and tells you here when it's fixed."}
        {' '}
        <button className="text-accent hover:underline" onClick={() => window.openextract.openExternal(PRIVACY_URL)}>
          How this works
        </button>
      </p>

      {sendError && (
        <div role="alert" className="rounded-lg border border-border-strong bg-surface p-3 mb-4">
          <p className={`text-xs text-text-primary leading-relaxed ${thanks ? '' : 'mb-2'}`}>{sendError}</p>
          {!thanks && (
            <button className="text-xs text-accent hover:underline" disabled={!ready} onClick={() => openOnGitHub()}>
              Post it on GitHub instead (public, needs a GitHub account)
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {!thanks && (
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
        )}
        <button className="hearth-primary-btn" disabled={!ready} onClick={() => send()}>
          {sending ? 'Sending…' : sendError ? 'Try again' : thanks ? 'Send thanks' : 'Send report'}
        </button>
      </div>
    </Shell>
  );
}

function Shell({ onClose, thanks = false, children }: { onClose: () => void; thanks?: boolean; children: ReactNode }) {
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
            {thanks ? <Heart className="text-accent" size={18} /> : <MessageSquare className="text-text-secondary" size={18} />}
          </div>
          <div id="feedback-title" className="flex-1 text-sm font-medium text-text-primary">{thanks ? 'Say thanks' : 'Send feedback'}</div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary" aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
