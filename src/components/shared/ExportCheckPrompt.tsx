import { useEffect, useState } from 'react';
import { ClipboardCheck, Heart } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { useFeedback } from './Feedback';
import { FEEDBACK_AREAS, type FeedbackArea } from '../../lib/feedback';

/**
 * "Did this export come out right?" after an export. Catches exports that
 * finish without an error but come out empty or wrong, which nothing else
 * would tell us about. The main process shows it at most once per run and
 * never on the same export as the share prompt. The answer isn't recorded
 * or sent anywhere: "Looks right" just closes the card, or, when the main
 * process allows it (once ever, never after a thank-you was sent), turns it
 * into "Glad it worked" with a way to say thanks.
 */
export default function ExportCheckPrompt() {
  const [area, setArea] = useState<FeedbackArea | null>(null);
  const [offerThanks, setOfferThanks] = useState(false);
  const [gladItWorked, setGladItWorked] = useState(false);
  const { openFeedback } = useFeedback();

  useEffect(() => {
    return window.openextract?.feedback?.onExportCheck?.((a, offer) => {
      const known = FEEDBACK_AREAS.some(x => x.id === a);
      setArea(known ? (a as FeedbackArea) : 'export');
      setOfferThanks(offer === true);
      setGladItWorked(false);
    });
  }, []);

  if (!area) return null;
  const close = () => setArea(null);

  if (gladItWorked) {
    return (
      <NoticeCard title="Glad it worked" icon={<Heart size={16} />} onClose={close}>
        <p className="text-xs text-text-secondary leading-relaxed mb-3">
          OpenExtract is free, made by an independent developer with help from contributors. If
          you'd like to say thanks, it only takes a moment.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="hearth-ghost-btn" onClick={close}>Not now</button>
          <button
            className="hearth-primary-btn"
            onClick={() => {
              close();
              openFeedback({ kind: 'thanks', area });
            }}
          >
            Say thanks
          </button>
        </div>
      </NoticeCard>
    );
  }

  return (
    <NoticeCard title="Did that come out right?" icon={<ClipboardCheck size={16} />} onClose={close}>
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        If something's missing or looks wrong, telling us is the fastest way to get it fixed.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          className="hearth-ghost-btn"
          onClick={() => {
            window.openextract.feedback.optOutOfExportCheck();
            close();
          }}
        >
          Don't ask again
        </button>
        <button
          className="hearth-ghost-btn"
          onClick={() => {
            if (!offerThanks) return close();
            window.openextract.feedback.thanksOffered();
            setGladItWorked(true);
          }}
        >
          Looks right
        </button>
        <button
          className="hearth-primary-btn"
          onClick={() => {
            close();
            openFeedback({ kind: 'missing', area });
          }}
        >
          Something's wrong
        </button>
      </div>
    </NoticeCard>
  );
}
