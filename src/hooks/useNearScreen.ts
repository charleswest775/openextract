import { useEffect, useState, type RefObject } from 'react';

/*
 * Whether something in a long list is near the part of it on screen, so
 * photos, posters and previews are only asked for when someone is about to
 * see them: the engine answers one call at a time, and a long chat or stream
 * mustn't ask it for hundreds of files nobody is looking at.
 *
 * "Near" is within `margin` pixels above or below what's on screen, a screen
 * or so ahead. Lists that scroll inside their own pane mark that pane with
 * `data-scroll-root` (a chat's thread also has `data-thread-scroll`), so the
 * look-ahead is measured against the pane, not the window. Where
 * IntersectionObserver isn't available both hooks say yes straight away.
 */

const noObserver = () => typeof IntersectionObserver === 'undefined';

/** The pane the element's list scrolls in, or null for the window. */
function scrollPane(el: Element): Element | null {
  return el.closest('[data-scroll-root],[data-thread-scroll]');
}

/**
 * True once the element has come near the screen, and from then on: for
 * something that is fetched once and kept (a small thumbnail).
 */
export function useNearScreen(ref: RefObject<Element>, margin = 800): boolean {
  const [near, setNear] = useState(noObserver);
  useEffect(() => {
    const el = ref.current;
    if (near || !el || noObserver()) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { root: scrollPane(el), rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [near, ref, margin]);
  return near;
}

/**
 * True while the element is near the screen, and false again once it has
 * scrolled further away (or its list is hidden): for work that should only
 * start, or only go on waiting its turn, while someone could see the result.
 * Unlike useNearScreen it keeps watching for as long as the element is drawn,
 * because a card scrolled past in a long stream stays drawn.
 */
export function useInView(ref: RefObject<Element>, margin = 800): boolean {
  const [inView, setInView] = useState(noObserver);
  useEffect(() => {
    const el = ref.current;
    if (!el || noObserver()) return;
    const io = new IntersectionObserver(entries => {
      // After a quick scroll several answers can come at once: the last is the latest
      const latest = entries[entries.length - 1];
      if (latest) setInView(latest.isIntersecting);
    }, { root: scrollPane(el), rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return inView;
}
