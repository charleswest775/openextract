import { useEffect } from 'react';
import type { Section, Tab } from '../sections';

/** Cmd+1 … Cmd+9 (Ctrl on Windows and Linux) open the first nine sections of a layout's navigation. */
export function useSectionShortcuts(items: Section[], openTab: (tab: Tab) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9 || !items[n - 1]) return;
      e.preventDefault();
      openTab(items[n - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, openTab]);
}

/** "⌘3" or "Ctrl+3", for tooltips. */
export function shortcutLabel(n: number): string {
  return `${window.openextract.platform === 'darwin' ? '⌘' : 'Ctrl+'}${n}`;
}
