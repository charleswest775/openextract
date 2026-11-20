import { SUPPORT_LIKE_URL, SUPPORT_STAR_URL } from '../../lib/payItForward';

/**
 * Two small links for people who just said thanks or paid: "Like it on AlternativeTo"
 * and "Star it on GitHub". OpenExtract doesn't pay for ads, so likes and stars are how
 * the next person finds it: AlternativeTo's lists of alternatives to paid apps rank by
 * them, and stars put the repo in front of more people on GitHub. Both open the site's
 * redirects in the browser; nothing here talks to the network.
 */
export default function HelpOthersFindIt({ className = '' }: { className?: string }) {
  const open = (url: string) => window.openextract.openExternal(url);
  return (
    <p className={`text-xs ${className}`}>
      <button type="button" className="text-accent hover:underline" onClick={() => open(SUPPORT_LIKE_URL)}>
        Like it on AlternativeTo
      </button>
      <span className="text-text-secondary" aria-hidden="true"> · </span>
      <button type="button" className="text-accent hover:underline" onClick={() => open(SUPPORT_STAR_URL)}>
        Star it on GitHub
      </button>
    </p>
  );
}
