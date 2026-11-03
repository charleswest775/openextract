import { useEffect, useRef, useState } from 'react';
import { useTimeline } from '../../../hooks/useTimeline';
import { DEFAULT_FILTERS } from '../../../types/timeline';
import SearchResults from '../../search/SearchResults';
import { SearchIcon } from '../../shared/Icons';
import LaunchpadHome from '../LaunchpadHome';
import { sectionFor, type ExploreContext } from '../sections';
import HomeCrumb from './HomeCrumb';

/**
 * Direction 4: one large search field, always at the top, does most of the
 * navigating. With nothing typed, the backup's tiles (Direction 2) are the way in.
 */
export default function SearchLayout({ ctx }: { ctx: ExploreContext }) {
  // Loaded once for the layout; every search filters what's already read
  const timeline = useTimeline(ctx.udid);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { setFilters } = timeline;

  // Typing waits a moment before searching
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    setFilters({ ...DEFAULT_FILTERS, types: new Set(DEFAULT_FILTERS.types), searchQuery: query });
  }, [query, setFilters]);

  // Cmd+K (Ctrl+K) from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Opening a result leaves the search and shows that screen
  const { openTab } = ctx;
  const leave: typeof openTab = (tab, opts) => { setText(''); setQuery(''); openTab(tab, opts); };
  const inner = { ...ctx, openTab: leave };

  const searching = query !== '';
  const atHome = ctx.activeTab === 'launchpad';
  const section = sectionFor(ctx.activeTab);
  const name = ctx.overview?.device_name ?? ctx.session?.name ?? 'This backup';
  const shortcut = window.openextract.platform === 'darwin' ? '⌘K' : 'Ctrl+K';

  const goHome = () => leave('launchpad');
  const left = atHome && !searching ? undefined : (
    <HomeCrumb onHome={goHome} homeName={name} current={searching ? 'Search results' : section?.label} />
  );

  const field = (
    <div className="relative w-full max-w-[560px]">
      <SearchIcon size={20} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search everything"
        placeholder="Search messages, notes, calls, voicemail, people…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setText(''); }}
        className="w-full h-10 pl-11 pr-16 text-[15px] bg-surface border-2 border-rule rounded-xl text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
      />
      <kbd className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-text-tertiary border border-rule rounded-md px-1.5 py-0.5 pointer-events-none">
        {shortcut}
      </kbd>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-base">
      {ctx.titleBar({ left, center: field, onLogo: goHome })}
      <div className="flex-1 overflow-hidden min-w-0">
        {searching
          ? <SearchResults ctx={inner} timeline={timeline} query={query} />
          : atHome
            ? (
              <LaunchpadHome
                ctx={inner}
                intro={
                  <button
                    onClick={() => inputRef.current?.focus()}
                    className="self-start flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary"
                  >
                    <SearchIcon size={18} />
                    Search everything in this backup from the box at the top, or press {shortcut}.
                  </button>
                }
              />
            )
            : ctx.content}
      </div>
    </div>
  );
}
