import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import NoticeCard from './NoticeCard';
import HelpOthersFindIt from './HelpOthersFindIt';
import { useFeedback } from './Feedback';
import { FEEDBACK_AREAS, type FeedbackArea } from '../../lib/feedback';
import { SUPPORT_AMOUNTS_URL, SUPPORT_PAY_URL, onAsk, whatWasSaved, type AskRequest } from '../../lib/payItForward';

type Stage = 'ask' | 'opened' | 'paid';

/**
 * "Pay it forward": Charles asks for $5 from people OpenExtract helped.
 *
 * The main process sends it after exports (electron/main.ts decides: the intro the
 * first time, then after every export unless the card was dismissed in this run or the
 * person said they paid); the header button, Settings and the thank-you screen show
 * it through showAsk(). It never blocks anything and never shows before an export
 * finishes. Its two buttons are "Say thanks" (the in-app thank-you note, for people
 * who can't pay) and "Pay $5"; the × dismisses it. Nothing here talks to the network:
 * "Pay $5" opens the site's payment redirect in the browser, and "I've paid" and
 * dismissing are remembered on this computer only (the app can't see payments, so
 * "I've paid" is taken on trust).
 */
export default function PayItForwardPrompt() {
  const [request, setRequest] = useState<AskRequest | null>(null);
  const [stage, setStage] = useState<Stage>('ask');
  const [status, setStatus] = useState({ paid: false, thanksSent: false });
  const { openFeedback } = useFeedback();

  useEffect(() => {
    // Status first, so the card opens with its final buttons: once a thank-you went out
    // from this computer, Say thanks isn't offered again.
    const show = (r: AskRequest) => {
      const open = (s?: { paid: boolean; thanksSent: boolean }) => {
        if (s) setStatus(s);
        setRequest(r);
        setStage(r.stage ?? 'ask');
      };
      const status = window.openextract?.support?.status?.();
      if (status) status.then(open, () => open());
      else open();
    };
    const offIpc = window.openextract?.onSharePrompt?.((a, intro) => {
      const known = FEEDBACK_AREAS.some(x => x.id === a);
      show({ mode: intro ? 'intro' : 'repeat', area: known ? (a as FeedbackArea) : undefined });
    });
    const offAsk = onAsk(show);
    return () => {
      offIpc?.();
      offAsk();
    };
  }, []);

  if (!request) return null;

  const { noun, plural } = whatWasSaved(request.area);
  // The ×, Say thanks and Close all mean "not this time": no more asks until the app is opened again.
  const snooze = () => {
    window.openextract?.support?.snooze?.();
    setRequest(null);
  };
  const sayThanks = () => {
    snooze();
    openFeedback({ kind: 'thanks', area: request.area ?? 'export' });
  };
  const pay = (url = SUPPORT_PAY_URL) => {
    window.openextract.openExternal(url);
    setStage('opened');
  };
  const markPaid = () => {
    window.openextract?.support?.markPaid?.();
    setStatus(s => ({ ...s, paid: true }));
    setStage('paid');
  };

  if (stage === 'paid') {
    return (
      <NoticeCard title="Thank you, truly" icon={<Heart size={16} fill="currentColor" />} onClose={() => setRequest(null)}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          You just helped keep OpenExtract free for someone who can't pay. I won't ask again.
        </p>
        <p className="text-xs text-text-secondary leading-relaxed mb-1.5">
          If you have one more minute: a like on AlternativeTo or a star on GitHub helps the next
          person find it.
        </p>
        <HelpOthersFindIt className="mb-3" />
        <p className="text-xs text-text-primary mb-3">— Charles</p>
        <div className="flex justify-end">
          <button className="hearth-primary-btn" onClick={() => setRequest(null)}>Close</button>
        </div>
      </NoticeCard>
    );
  }

  if (stage === 'opened') {
    return (
      <NoticeCard title="Thank you" icon={<Heart size={16} fill="currentColor" />} onClose={snooze}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          The payment page is open in your browser. Pay what it was worth to you; any amount helps.
          Once you've paid, let me know here and I'll stop asking.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={snooze}>Close</button>
          <button className="hearth-primary-btn" onClick={markPaid}>I've paid</button>
        </div>
      </NoticeCard>
    );
  }

  const title = request.mode === 'header' ? 'Pay it forward'
    : request.mode === 'checked' ? 'Glad it worked'
    : request.area ? `Your ${noun} ${plural ? 'are' : 'is'} saved`
    : 'Your file is saved';
  const introduce = request.mode === 'intro' || request.mode === 'header';
  const what = request.mode === 'header'
    ? 'If it got your photos, messages or contacts off your iPhone'
    : `If getting your ${noun} off your iPhone helped`;
  // Free first, then the ask: pay what it's worth, only if you can; if you can't, say thanks.
  // Once a thank-you went out, the card doesn't ask for another one.
  const canThank = !status.thanksSent;
  const ask = `${what}, pay what it's worth to you, but only if you can. `
    + (canThank ? "If you can't pay, say thank you instead." : "If you can't, it's yours.");

  return (
    <NoticeCard title={title} icon={<Heart size={16} fill="currentColor" />} onClose={snooze} highlight>
      {introduce && (
        <p className="text-xs text-text-secondary leading-relaxed mb-2">
          Hi, I'm Charles. OpenExtract is free for everyone, no strings.
        </p>
      )}
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        {introduce ? ask : `OpenExtract is free, no strings. ${ask}`}
        {!introduce && <span className="text-text-primary whitespace-nowrap"> — Charles</span>}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        {canThank && <button className="hearth-ghost-btn" onClick={sayThanks}>Say thanks</button>}
        <button className="hearth-primary-btn inline-flex items-center gap-1.5" onClick={() => pay()}>
          <Heart size={14} fill="currentColor" aria-hidden="true" />
          Pay $5
        </button>
      </div>
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 mt-2.5 text-[11px] text-text-tertiary">
        <button className="hover:text-text-primary hover:underline" onClick={() => pay(SUPPORT_AMOUNTS_URL)}>
          Other amounts
        </button>
        {!status.paid && (
          <button className="hover:text-text-primary hover:underline" onClick={markPaid}>
            Already paid? Stop asking
          </button>
        )}
      </div>
    </NoticeCard>
  );
}
