import { useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import NoticeCard from './NoticeCard';

export const REPO_URL = 'https://github.com/charleswest775/openextract';
export const RELEASES_URL = 'https://github.com/charleswest775/openextract/releases';
export const SITE_URL = 'https://www.openextract.app';

/**
 * One-time card after a successful export, asking for a GitHub star or a word
 * to a friend. The main process decides when to show it (first export, never
 * again after that, remembered in the local app state file). Nothing here
 * talks to the network: the buttons open the user's browser or copy a link.
 */
export default function SharePrompt() {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = window.openextract?.onSharePrompt?.(() => setVisible(true));
    return () => {
      unsubscribe?.();
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  if (!visible) return null;

  const close = () => setVisible(false);

  const openAndClose = (url: string) => {
    window.openextract.openExternal(url);
    close();
  };

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
    <NoticeCard title="Your export is saved" icon={<Star size={16} />} onClose={close}>
      <p className="text-xs text-text-secondary leading-relaxed mb-3">
        OpenExtract is free and made by one person. If it helped, a GitHub star or telling a friend
        helps others find it.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="hearth-ghost-btn" onClick={() => openAndClose(RELEASES_URL)}>Get release notes</button>
        <button className="hearth-ghost-btn" onClick={copyLink} aria-live="polite">
          {copied ? 'Link copied' : 'Copy link'}
        </button>
        <button className="hearth-ghost-btn" onClick={close}>Not now</button>
        <button className="hearth-primary-btn" onClick={() => openAndClose(REPO_URL)}>Star on GitHub</button>
      </div>
    </NoticeCard>
  );
}
