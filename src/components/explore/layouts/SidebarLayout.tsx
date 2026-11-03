import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { ChevronRightIcon, PhoneIcon, ExportIcon, RecoverIcon } from '../../shared/Icons';
import { OVERVIEW, RECOVER, SAVE, TIMELINE, listOf, type ExploreContext, type Section, type Tab } from '../sections';
import { shortcutLabel, useSectionShortcuts } from './useSectionShortcuts';

// Below this width the sidebar shrinks to icons, so the 800px minimum window still fits.
const WIDE = '(min-width: 1024px)';

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

function formatBackupDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Direction 1: a labeled sidebar in groups, with counts and a backup switcher at the top. */
export default function SidebarLayout({ ctx }: { ctx: ExploreContext }) {
  const wide = useWide();
  const [menuOpen, setMenuOpen] = useState(false);
  const { overview } = ctx;
  const tools: Section[] = [
    { ...RECOVER, label: 'Recover deleted', icon: RecoverIcon },
    { ...SAVE, label: 'Save to computer', icon: ExportIcon },
  ];
  const shortcuts = useMemo(() => [OVERVIEW, ...ctx.data, TIMELINE, ...tools], [ctx.data]);
  useSectionShortcuts(shortcuts, ctx.openTab);
  const timelineOpen = ctx.activeTab === 'timeline' || ctx.activeTab === 'year';

  function row(item: Section, opts: { count?: number | null; tab?: Tab; label?: string; indent?: boolean; active?: boolean } = {}) {
    const tab = opts.tab ?? item.id;
    const Icon = item.icon;
    const isActive = opts.active ?? ctx.activeTab === tab;
    const index = shortcuts.findIndex(s => s.id === tab);
    const label = opts.label ?? item.label;
    return (
      <button
        key={`${item.id}-${tab}`}
        onClick={() => ctx.openTab(tab)}
        aria-current={isActive ? 'page' : undefined}
        title={wide ? (index >= 0 && index < 9 ? shortcutLabel(index + 1) : undefined) : label}
        className={`w-full flex items-center gap-3 rounded-[10px] transition-colors ${
          wide ? `h-9 ${opts.indent ? 'pl-[46px]' : 'px-2.5'} pr-2.5` : 'h-11 justify-center'
        } ${isActive ? 'bg-surface font-semibold text-text-primary' : 'text-text-primary hover:bg-surface/60'}`}
        style={isActive ? { boxShadow: '0 0 0 1px var(--border-default), 0 1px 3px rgba(30,26,22,.06)' } : undefined}
      >
        {!opts.indent && <Icon size={22} className={isActive ? 'text-accent' : 'text-text-secondary'} />}
        {wide && <span className="text-[15px] truncate">{label}</span>}
        {wide && opts.count != null && (
          <span className="ml-auto text-xs text-text-tertiary tabular-nums">{opts.count.toLocaleString()}</span>
        )}
      </button>
    );
  }

  const group = (label: string) => wide
    ? <div className="font-mono text-[11.5px] tracking-[0.08em] uppercase text-text-tertiary px-2.5 pt-3 pb-1">{label}</div>
    : <div className="h-px bg-rule mx-2 my-2" />;

  return (
    <div className="h-screen flex flex-col bg-base">
      {ctx.titleBar({ left: <span />, showDevice: false })}
      <div className="flex flex-1 min-h-0">
        <aside className={`${wide ? 'w-[244px]' : 'w-[76px]'} flex-shrink-0 border-r border-rule flex flex-col`} style={{ background: 'color-mix(in srgb, var(--bg-elevated) 45%, var(--bg-base))' }}>
          {/* Backup switcher */}
          <div className="relative p-3 pb-1">
            <button
              onClick={() => setMenuOpen(o => !o)}
              aria-expanded={menuOpen}
              title={ctx.session?.name}
              className={`w-full flex items-center gap-2.5 rounded-xl bg-surface border border-rule hover:border-border-strong transition-colors ${wide ? 'p-2.5' : 'p-1.5 justify-center'}`}
            >
              <span className="w-9 h-9 rounded-[10px] bg-sand flex items-center justify-center flex-shrink-0">
                <PhoneIcon size={20} className="text-text-secondary" />
              </span>
              {wide && (
                <>
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block text-sm font-semibold text-text-primary truncate">{ctx.session?.name ?? overview?.device_name}</span>
                    <span className="block text-xs text-text-tertiary truncate">
                      {[formatBackupDate(overview?.last_backup), overview?.ios_version && `iOS ${overview.ios_version}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <ChevronRightIcon size={18} className={`text-text-tertiary transition-transform ${menuOpen ? 'rotate-90' : ''}`} />
                </>
              )}
            </button>
            {menuOpen && (
              <div className="absolute left-3 right-3 top-full mt-1 z-20 rounded-xl bg-surface border border-rule p-1 shadow-lg min-w-[200px]">
                <button onClick={ctx.onBack} className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-elevated">
                  Switch to another backup
                </button>
                <button onClick={() => { setMenuOpen(false); ctx.openSettings(); }} className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-elevated">
                  Settings
                </button>
              </div>
            )}
          </div>

          <nav aria-label="Sections" className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-1 flex flex-col gap-px">
            {row(OVERVIEW)}
            {group('Your data')}
            {ctx.data.map(item => row(item, { count: item.count && overview ? item.count(overview) : null }))}
            {group('Over time')}
            {/* Timeline and Year are one entry; when it's open, its two views show under it */}
            {row(TIMELINE, { active: !wide && timelineOpen })}
            {wide && timelineOpen && (
              <>
                {row(TIMELINE, { tab: 'timeline', label: 'Every event', indent: true })}
                {row(TIMELINE, { tab: 'year', label: 'One year, day by day', indent: true })}
              </>
            )}
            {group('Tools')}
            {tools.map(item => row(item))}
          </nav>

          {wide && ctx.missing.length > 0 && (
            <div className="m-3 mt-2 p-3 rounded-xl border border-dashed border-rule flex gap-2 text-xs text-text-secondary">
              <Info size={16} className="text-text-tertiary mt-px" />
              <span>
                <span className="font-medium text-text-primary">Not in this backup: </span>
                {listOf(ctx.missing)}.
                {overview && !overview.encrypted && overview.total_calls === 0 && ' Call history needs an encrypted backup.'}
              </span>
            </div>
          )}
        </aside>
        <div className="flex-1 overflow-hidden min-w-0">{ctx.content}</div>
      </div>
    </div>
  );
}
