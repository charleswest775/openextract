import { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { useFeedback } from './Feedback';
import { FEEDBACK_AREAS, type FeedbackArea } from '../../lib/feedback';
import { showAsk } from '../../lib/payItForward';

/**
 * "Did this export come out right?" after an export. Catches exports that
 * finish without an error but come out empty or wrong, which nothing else
 * would tell us about. The main process shows it at most once per run and
 * never on the same export as the "Pay it forward" introduction. The answer
 * isn't recorded or sent anywhere: "Looks right" just closes the card, or,
 * when the main process allows it (not after "Not now" in this run, never
 * after "I've paid"), turns into the "Pay it forward" ask.
 */
export default function ExportCheckPrompt() {
  const [area, setArea] = useState<FeedbackArea | null>(null);
  const [offerAsk, setOfferAsk] = useState(false);
  const { openFeedback } = useFeedback();

  useEffect(() => {
    return window.openextract?.feedback?.onExportCheck?.((a, offer) => {
      const known = FEEDBACK_AREAS.some(x => x.id === a);
      setArea(known ? (a as FeedbackArea) : 'export');
      setOfferAsk(offer === true);
    });
  }, []);

  if (!area) return null;
  const close = () => setArea(null);

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
            close();
            if (offerAsk) showAsk({ mode: 'checked', area: area === 'export' ? undefined : area });
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
