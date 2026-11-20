import { useEffect, useState, type RefObject } from 'react';

/**
 * True once the element is near the visible part of the list it scrolls in,
 * and from then on: photos, posters and previews wait for it, so a long chat
 * or stream doesn't ask the engine (which answers one call at a time) for
 * hundreds of files nobody is looking at.
 *
 * "Near" is within `margin` pixels above or below what's on screen, a screen
 * or so ahead. Lists that scroll inside their own pane mark that pane with
 * `data-scroll-root` (a chat's thread also has `data-thread-scroll`), so the
 * look-ahead is measured against the pane, not the window. Where
 * IntersectionObserver isn't available it's true straight away.
 */
export function useNearScreen(ref: RefObject<Element>, margin = 800): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === 'undefined') return;
    const root = el.closest('[data-scroll-root],[data-thread-scroll]');
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { root, rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref, margin]);
  return near;
}
