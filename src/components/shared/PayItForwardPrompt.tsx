import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { useFeedback } from './Feedback';
import { FEEDBACK_AREAS, type FeedbackArea } from '../../lib/feedback';
import { SUPPORT_PAY_URL, onAsk, whatWasSaved, type AskRequest } from '../../lib/payItForward';

type Stage = 'ask' | 'opened' | 'paid';

/**
 * "Pay it forward": Charles asks for $5 from people OpenExtract helped.
 *
 * The main process sends it after exports (electron/main.ts decides: the intro the
 * first time, then after every export unless "Not now" was picked in this run or the
 * person said they paid); the header button, Settings and the thank-you screen show
 * it through showAsk(). It never blocks anything and never shows before an export
 * finishes. Nothing here talks to the network: "Pay $5" opens the site's payment
 * redirect in the browser, and "I've paid" / "Not now" are remembered on this
 * computer only (the app can't see payments, so "I've paid" is taken on trust).
 */
export default function PayItForwardPrompt() {
  const [request, setRequest] = useState<AskRequest | null>(null);
  const [stage, setStage] = useState<Stage>('ask');
  const [status, setStatus] = useState({ paid: false, thanksSent: false });
  const { openFeedback } = useFeedback();

  useEffect(() => {
    const show = (r: AskRequest) => {
      setRequest(r);
      setStage(r.stage ?? 'ask');
      window.openextract?.support?.status?.().then(setStatus).catch(() => {});
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
  // "Not now", the ×, Say thanks and Close all mean "not this time": no more asks until the app is opened again.
  const snooze = () => {
    window.openextract?.support?.snooze?.();
    setRequest(null);
  };
  const pay = () => {
    window.openextract.openExternal(SUPPORT_PAY_URL);
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
          You just helped keep OpenExtract free for the next person. I won't ask again.
        </p>
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
          The payment page is open in your browser. $5 is the suggestion; any amount helps. Once
          you've paid, let me know here and I'll stop asking.
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
  const worth = request.mode === 'header'
    ? 'If OpenExtract got your photos, messages or contacts off your iPhone, was that worth $5 to you? Please pay it forward.'
    : `If getting your ${noun} off your iPhone was worth $5 to you, please pay it forward.`;
  const introduce = request.mode === 'intro' || request.mode === 'header';

  return (
    <NoticeCard title={title} icon={<Heart size={16} fill="currentColor" />} onClose={snooze} highlight>
      {introduce && (
        <p className="text-xs text-text-secondary leading-relaxed mb-2">
          Hi, I'm Charles. I make OpenExtract and give it away free.
        </p>
      )}
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        {worth} {introduce ? 'It takes a minute, and it' : 'It'} keeps OpenExtract free for the next person.
        {!introduce && <span className="text-text-primary whitespace-nowrap"> — Charles</span>}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="hearth-ghost-btn" onClick={snooze}>Not now</button>
        <button className="hearth-primary-btn inline-flex items-center gap-1.5" onClick={pay}>
          <Heart size={14} fill="currentColor" aria-hidden="true" />
          Pay $5
        </button>
      </div>
      {(!status.thanksSent || !status.paid) && (
        <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 mt-2.5 text-[11px] text-text-tertiary">
          {!status.thanksSent && (
            <button
              className="hover:text-text-primary hover:underline"
              onClick={() => {
                snooze();
                openFeedback({ kind: 'thanks', area: request.area ?? 'export' });
              }}
            >
              Say thanks
            </button>
          )}
          {!status.paid && (
            <button className="hover:text-text-primary hover:underline" onClick={markPaid}>
              Already paid? Stop asking
            </button>
          )}
        </div>
      )}
    </NoticeCard>
  );
}
