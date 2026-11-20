import type { ReactNode } from 'react';
import { Star, ThumbsUp } from 'lucide-react';
import { SUPPORT_LIKE_URL, SUPPORT_STAR_URL } from '../../lib/payItForward';

/**
 * Two buttons for people who just said thanks or paid: "Like it on AlternativeTo" and
 * "Star it on GitHub". OpenExtract doesn't pay for ads, so likes and stars are how the
 * next person finds it: AlternativeTo's lists of alternatives to paid apps rank by them,
 * and stars put the repo in front of more people on GitHub. They come after any way to
 * pay, never before it. Both open the site's redirects in the browser; nothing here
 * talks to the network, and the app never learns whether anyone liked or starred.
 *
 * `stack` puts them one above the other, full width (the narrow notice card); `extra`
 * goes after them in the same row (the thank-you screen's Copy link).
 */
export default function HelpOthersFindIt({ stack = false, extra, className = '' }: {
  stack?: boolean;
  extra?: ReactNode;
  className?: string;
}) {
  const open = (url: string) => window.openextract.openExternal(url);
  const layout = stack ? 'grid gap-2' : 'flex flex-wrap gap-2';
  const fill = stack ? 'justify-center' : '';
  return (
    <div className={`${layout} ${className}`}>
      <button type="button" className={`hearth-soft-btn ${fill}`} onClick={() => open(SUPPORT_LIKE_URL)}>
        <ThumbsUp size={14} aria-hidden="true" />
        Like it on AlternativeTo
      </button>
      <button type="button" className={`hearth-soft-btn ${fill}`} onClick={() => open(SUPPORT_STAR_URL)}>
        <Star size={14} aria-hidden="true" />
        Star it on GitHub
      </button>
      {extra}
    </div>
  );
}
