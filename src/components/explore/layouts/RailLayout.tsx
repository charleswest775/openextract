import { useMemo } from 'react';
import { OVERVIEW, RECOVER, SAVE, TIMELINE, YEAR, type ExploreContext } from '../sections';
import { shortcutLabel, useSectionShortcuts } from './useSectionShortcuts';

/** The icon rail: every section as a large icon with its name, in one column. */
export default function RailLayout({ ctx }: { ctx: ExploreContext }) {
  const items = useMemo(() => [OVERVIEW, TIMELINE, YEAR, ...ctx.data, RECOVER, SAVE], [ctx.data]);
  useSectionShortcuts(items, ctx.openTab);

  return (
    <div className="h-screen flex flex-col bg-base">
      {ctx.titleBar()}
      <div className="flex flex-1 min-h-0">
        <nav aria-label="Sections" className="w-[92px] flex-shrink-0 border-r border-rule bg-base overflow-y-auto overflow-x-hidden py-2.5 px-2 flex flex-col gap-0.5 items-center">
          {items.map((item, i) => {
            const Icon = item.icon;
            const isActive = ctx.activeTab === item.id;
            return (
              <button
                key={item.id}
                title={i < 9 ? `${item.label} (${shortcutLabel(i + 1)})` : item.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => ctx.openTab(item.id)}
                className={`w-[76px] flex-shrink-0 py-1.5 rounded-[14px] flex flex-col items-center justify-center gap-0.5 transition-colors border ${
                  isActive ? 'bg-surface border-rule' : 'border-transparent hover:bg-surface/60'
                }`}
                style={isActive ? { boxShadow: '0 1px 2px rgba(30,26,22,.06), 0 4px 14px rgba(180,83,47,.10)' } : undefined}
              >
                <Icon size={24} className={isActive ? 'text-accent' : 'text-text-secondary'} />
                <span className={`text-xs ${isActive ? 'text-accent font-semibold' : 'text-text-secondary'}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="flex-1 overflow-hidden min-w-0">{ctx.content}</div>
      </div>
    </div>
  );
}
