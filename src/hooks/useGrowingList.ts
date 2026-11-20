import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface GrowingListOptions {
  /** How many to show at first. */
  first?: number;
  /** How many more each time the end comes near. */
  step?: number;
  /** How far ahead of the visible end (in pixels) to add more, so scrolling never meets a gap. */
  ahead?: number;
}

/**
 * A long list shown a part at a time and lengthened as you scroll, instead of
 * pages: the first `first` items, then `step` more whenever the end of what's
 * shown comes within `ahead` pixels of the scroll pane's bottom.
 *
 * Put `scrollRef` on the scrolling element and `sentinelRef` on an element just
 * after the last item. A new `resetKey` (other filters, another person) starts
 * again from the top; more items arriving (the backup still being read) never
 * does, so the list grows under you without jumping.
 */
export function useGrowingList(count: number, resetKey: unknown, { first = 150, step = 150, ahead = 1500 }: GrowingListOptions = {}) {
  const [shown, setShown] = useState(first);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Something else to show: back to the top, and to the first part only
  useLayoutEffect(() => {
    setShown(first);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = shown < count;

  // Watch the end. An observer reports once when it starts watching and then only
  // on changes, so it's made again after each growth: if the end is still in
  // reach (a short list, a tall screen), that first report adds the next part.
  useEffect(() => {
    const root = scrollRef.current;
    const end = sentinelRef.current;
    if (!more || !root || !end || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(seen => {
      if (seen.some(e => e.isIntersecting)) setShown(n => n + step);
    }, { root, rootMargin: `0px 0px ${ahead}px 0px` });
    io.observe(end);
    return () => io.disconnect();
  }, [shown, more, step, ahead]);

  return { shown: Math.min(shown, count), more, scrollRef, sentinelRef };
}
