import { useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import NoticeCard from './NoticeCard';
import { useFeedback } from './Feedback';
import { FEEDBACK_AREAS, SITE_URL, type FeedbackArea } from '../../lib/feedback';

export const REPO_URL = 'https://github.com/charleswest775/openextract';

/**
 * One-time card after a successful export, asking for a thank-you, a word to a
 * friend, or a GitHub star. The main process decides when to show it (first
 * export, or the next one for people who saw the older star-only card; never
 * again after that, or after a thank-you; remembered in the local app state file).
 * Nothing here talks to the network: "Say thanks" opens the feedback form, which
 * sends only if the user clicks Send there; the rest open the user's browser or
 * copy a link.
 */
export default function SharePrompt() {
  const [area, setArea] = useState<FeedbackArea | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { openFeedback } = useFeedback();

  useEffect(() => {
    const unsubscribe = window.openextract?.onSharePrompt?.((a) => {
      const known = FEEDBACK_AREAS.some(x => x.id === a);
      setArea(known ? (a as FeedbackArea) : 'export');
    });
    return () => {
      unsubscribe?.();
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  if (!area) return null;

  const close = () => setArea(null);

  const copyLink = async () => {
    try {
      await window.openextract.copyText(SITE_URL);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard unavailable: leave the button as it was.
    }
  };

  return (
    <NoticeCard title="Your file is saved" icon={<Heart size={16} />} onClose={close}>
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        OpenExtract is free, made by an independent developer with help from contributors. If it
        helped, a quick thank-you means a lot, and telling a friend helps others find it.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="hearth-ghost-btn" onClick={close}>Not now</button>
        <button className="hearth-ghost-btn" onClick={copyLink} aria-live="polite">
          {copied ? 'Link copied' : 'Copy link'}
        </button>
        <button
          className="hearth-ghost-btn"
          onClick={() => {
            window.openextract.openExternal(REPO_URL);
            close();
          }}
        >
          Star on GitHub
        </button>
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
