import { useState } from 'react';
import { SearchIcon } from '../../shared/Icons';
import LaunchpadHome from '../LaunchpadHome';
import { sectionFor, type ExploreContext } from '../sections';
import HomeCrumb from './HomeCrumb';

/**
 * Direction 2: no permanent sidebar. The backup opens on a page of big tiles;
 * each section opens full width with a way back to it.
 */
export default function LaunchpadLayout({ ctx }: { ctx: ExploreContext }) {
  const [query, setQuery] = useState('');
  const atHome = ctx.activeTab === 'launchpad';
  const section = sectionFor(ctx.activeTab);
  const name = ctx.overview?.device_name ?? ctx.session?.name ?? 'This backup';

  const goHome = () => ctx.openTab('launchpad');
  const left = atHome ? undefined : <HomeCrumb onHome={goHome} homeName={name} current={section?.label} />;

  // Searches everything through the Timeline, which already searches every kind of record
  const search = (
    <form
      className="relative w-full max-w-[320px]"
      onSubmit={e => {
        e.preventDefault();
        if (query.trim()) ctx.openTab('timeline', { timeline: { searchQuery: query.trim() } });
      }}
    >
      <SearchIcon size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
      <input
        type="search"
        aria-label="Search everything"
        placeholder="Search everything"
        value={query}
        onChange={e => setQuery(e.target.value)}
        className="w-full h-9 pl-10 pr-3 text-sm bg-surface border border-rule rounded-full focus:outline-none focus:border-accent"
      />
    </form>
  );

  return (
    <div className="h-screen flex flex-col bg-base">
      {ctx.titleBar({ left, center: search, onLogo: goHome })}
      <div className="flex-1 overflow-hidden min-w-0">
        {atHome ? <LaunchpadHome ctx={ctx} /> : ctx.content}
      </div>
    </div>
  );
}
