import { useMemo } from 'react';
import { useTimeline } from '../../../hooks/useTimeline';
import PeopleView from '../../people/PeopleView';
import { ContactIcon } from '../../shared/Icons';
import { RECOVER, SAVE, TIMELINE, type ExploreContext, type Section } from '../sections';
import { shortcutLabel, useSectionShortcuts } from './useSectionShortcuts';

const PEOPLE: Section = { id: 'people', label: 'People', icon: ContactIcon };

/**
 * Direction 3: People is the main door, in place of Messages, Contacts, Calls and
 * Voicemail. Things that aren't about one person keep their own places.
 */
export default function PeopleLayout({ ctx }: { ctx: ExploreContext }) {
  // Loaded once for the layout, so going back to People doesn't read the backup again
  const timeline = useTimeline(ctx.udid);
  const items = useMemo(() => [
    PEOPLE,
    ...ctx.data.filter(s => s.id === 'photos' || s.id === 'notes' || s.id === 'browser_history'),
    TIMELINE,
    RECOVER,
    SAVE,
  ], [ctx.data]);
  useSectionShortcuts(items, ctx.openTab);

  return (
    <div className="h-screen flex flex-col bg-base">
      {ctx.titleBar()}
      <div className="flex flex-1 min-h-0">
        <nav aria-label="Sections" className="w-[92px] flex-shrink-0 border-r border-rule overflow-y-auto overflow-x-hidden py-2.5 px-2 flex flex-col gap-0.5 items-center" style={{ background: 'color-mix(in srgb, var(--bg-elevated) 45%, var(--bg-base))' }}>
          {items.map((item, i) => {
            const Icon = item.icon;
            const isActive = ctx.activeTab === item.id;
            return (
              <button
                key={item.id}
                title={`${item.label} (${shortcutLabel(i + 1)})`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => ctx.openTab(item.id)}
                className={`w-[76px] flex-shrink-0 py-2 rounded-[14px] flex flex-col items-center justify-center gap-1 transition-colors border ${
                  isActive ? 'bg-surface border-rule' : 'border-transparent hover:bg-surface/60'
                }`}
              >
                <Icon size={26} className={isActive ? 'text-accent' : 'text-text-secondary'} />
                <span className={`text-xs ${isActive ? 'text-accent font-semibold' : 'text-text-secondary'}`}>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-hidden min-w-0">
          {ctx.activeTab === 'people' ? <PeopleView ctx={ctx} timeline={timeline} /> : ctx.content}
        </div>
      </div>
    </div>
  );
}
