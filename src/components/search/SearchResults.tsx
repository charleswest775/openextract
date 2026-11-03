import { useEffect, useMemo, useState } from 'react';
import type { UseTimelineReturn } from '../../hooks/useTimeline';
import type { TimelineEntry, TimelineEntryType } from '../../types/timeline';
import { formatDate, formatDuration } from '../../lib/dates';
import { formatPhone } from '../../lib/people';
import { plural } from '../../lib/saveData';
import EmptyState from '../shared/EmptyState';
import OrganicLoader from '../shared/OrganicLoader';
import { ChevronRightIcon, ContactIcon, SearchIcon } from '../shared/Icons';
import TimelineEntryCard from '../timeline/TimelineEntryCard';
import { TYPE_COLORS } from '../timeline/TimelineTypeChips';
import { DATA_SECTIONS, type ExploreContext, type Icon, type Tab } from '../explore/sections';

const ORDER: TimelineEntryType[] = ['note', 'message', 'voicemail', 'call', 'photo', 'browser'];
const KIND: Record<TimelineEntryType, { one: string; many: string; tab: Tab }> = {
  note: { one: 'Note', many: 'Notes', tab: 'notes' },
  message: { one: 'Message', many: 'Messages', tab: 'messages' },
  voicemail: { one: 'Voicemail', many: 'Voicemail', tab: 'voicemail' },
  call: { one: 'Call', many: 'Calls', tab: 'calls' },
  photo: { one: 'Photo', many: 'Photos', tab: 'photos' },
  browser: { one: 'Web page', many: 'Web history', tab: 'browser_history' },
};
const PER_GROUP = 5;

function iconFor(type: TimelineEntryType): Icon {
  return DATA_SECTIONS.find(s => s.id === KIND[type].tab)!.icon;
}

/** A title and the line that matched, for one result. */
function describe(e: TimelineEntry): { title: string; text: string } {
  switch (e.type) {
    case 'message': return { title: e.message!.conversationName, text: e.message!.text ?? '' };
    case 'note': return { title: e.note!.title || 'Untitled', text: e.note!.body || e.note!.bodyPreview };
    case 'voicemail': return { title: e.contactName ?? formatPhone(e.voicemail!.phoneNumber), text: e.voicemail!.transcript || `Voicemail · ${formatDuration(e.voicemail!.duration)}` };
    case 'call': return { title: e.contactName ?? '', text: `${e.call!.status === 'missed' ? 'Missed' : e.call!.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} call · ${formatDuration(e.call!.duration)}` };
    case 'photo': return { title: e.photo!.filename, text: e.photo!.kind.replace('_', ' ') };
    case 'browser': return { title: e.browser!.title || e.browser!.url, text: e.browser!.domain };
  }
}

/** The part of `text` around the first match, with every match marked. */
function Highlight({ text, query, around = 70 }: { text: string; query: string; around?: number }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  let shown = text;
  if (around > 0 && at > around) shown = '…' + text.slice(at - Math.floor(around / 2));
  const parts = shown.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => (
        part.toLowerCase() === q.toLowerCase()
          ? <mark key={i} className="bg-amber-200 text-inherit rounded px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      ))}
    </>
  );
}

/** Direction 4's results: every kind of record that matches, grouped, with a preview. */
export default function SearchResults({ ctx, timeline, query }: { ctx: ExploreContext; timeline: UseTimelineReturn; query: string }) {
  const [only, setOnly] = useState<TimelineEntryType | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return timeline.allContacts.filter(c => c.name.toLowerCase().includes(q)).slice(0, 4);
  }, [timeline.allContacts, query]);

  const groups = useMemo(() => {
    const by = new Map<TimelineEntryType, TimelineEntry[]>();
    for (const e of timeline.filteredEntries) {
      if (!by.has(e.type)) by.set(e.type, []);
      by.get(e.type)!.push(e);
    }
    return ORDER.filter(t => by.has(t)).map(t => ({ type: t, entries: by.get(t)! }));
  }, [timeline.filteredEntries]);

  useEffect(() => { setOnly(null); setSelectedId(null); }, [query]);

  const visible = groups.filter(g => !only || g.type === only);
  const firstEntry = visible[0]?.entries[0] ?? null;
  const selected = timeline.filteredEntries.find(e => e.id === selectedId) ?? firstEntry;
  const total = timeline.totalFiltered;

  function open(e: TimelineEntry) {
    const tab = KIND[e.type].tab;
    if (e.type === 'message') ctx.openTab(tab, { chatId: e.message!.chatId });
    else if (e.type === 'note') ctx.openTab(tab, { noteId: e.note!.noteId });
    else ctx.openTab(tab);
  }

  const chip = (label: string, n: number, on: boolean, onClick: () => void, color?: string) => (
    <button
      key={label}
      onClick={onClick}
      aria-pressed={on}
      className={`h-9 px-4 rounded-full border text-sm flex items-center gap-2 transition-colors whitespace-nowrap ${
        on ? 'border-text-primary bg-text-primary text-base font-medium' : 'border-rule text-text-secondary hover:bg-surface'
      }`}
      style={on ? { color: 'var(--bg-base)' } : undefined}
    >
      {color && <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />}
      {label}
      <span className={on ? 'opacity-80' : 'text-text-tertiary'}>{n.toLocaleString()}</span>
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-rule flex items-center gap-2 overflow-x-auto">
        {chip('All', total, only === null, () => setOnly(null))}
        {groups.map(g => chip(KIND[g.type].many, g.entries.length, only === g.type, () => setOnly(g.type), TYPE_COLORS[g.type]))}
        {timeline.loading && (
          <span className="ml-2 text-sm text-text-tertiary whitespace-nowrap">Still reading the backup, more may appear…</span>
        )}
      </div>

      {total === 0 && people.length === 0 ? (
        timeline.loading
          ? <div className="flex-1 flex items-center justify-center text-accent"><OrganicLoader size={72} /></div>
          : <EmptyState icon={SearchIcon} title={`Nothing matches "${query}"`} detail="Try fewer letters, or another word from the message, note or name." />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Results, grouped by kind */}
          <div className="w-[440px] flex-shrink-0 border-r border-rule overflow-y-auto py-2">
            {!only && people.length > 0 && (
              <section>
                <h2 className="font-mono text-[11.5px] tracking-[0.08em] uppercase text-text-tertiary px-5 pt-3 pb-1">People · {people.length}</h2>
                {people.map(p => (
                  <button
                    key={p.identifier}
                    onClick={() => ctx.openTab('timeline', { timeline: { contactIdentifier: p.identifier } })}
                    className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-surface"
                  >
                    <span className="w-9 h-9 rounded-full bg-sand flex items-center justify-center flex-shrink-0">
                      <ContactIcon size={18} className="text-text-secondary" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary truncate"><Highlight text={p.name} query={query} around={0} /></span>
                      <span className="block text-xs text-text-tertiary">Everything with them, in the Timeline</span>
                    </span>
                    <ChevronRightIcon size={18} className="text-text-tertiary" />
                  </button>
                ))}
              </section>
            )}
            {visible.map(g => {
              const I = iconFor(g.type);
              const list = only ? g.entries.slice(0, 100) : g.entries.slice(0, PER_GROUP);
              return (
                <section key={g.type}>
                  <h2 className="font-mono text-[11.5px] tracking-[0.08em] uppercase text-text-tertiary px-5 pt-4 pb-1">
                    {KIND[g.type].many} · {g.entries.length.toLocaleString()}
                  </h2>
                  {list.map(e => {
                    const d = describe(e);
                    const on = selected?.id === e.id;
                    return (
                      <button
                        key={e.id}
                        onClick={() => setSelectedId(e.id)}
                        onDoubleClick={() => open(e)}
                        aria-current={on ? 'true' : undefined}
                        className={`w-full px-5 py-2.5 flex gap-3 text-left transition-colors ${on ? 'bg-accent-wash' : 'hover:bg-surface'}`}
                      >
                        <span className="w-9 h-9 rounded-[10px] bg-sand flex items-center justify-center flex-shrink-0" style={{ color: TYPE_COLORS[g.type] }}>
                          <I size={18} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-text-primary truncate"><Highlight text={d.title} query={query} around={0} /></span>
                          <span className="block text-sm text-text-secondary truncate"><Highlight text={d.text} query={query} /></span>
                          <span className="block text-xs text-text-tertiary">{KIND[g.type].one} · {formatDate(e.timestamp)}</span>
                        </span>
                      </button>
                    );
                  })}
                  {!only && g.entries.length > PER_GROUP && (
                    <button onClick={() => setOnly(g.type)} className="pl-[68px] pr-5 py-1.5 text-sm text-accent font-medium hover:underline">
                      Show all {plural(g.entries.length, KIND[g.type].one.toLowerCase(), KIND[g.type].many.toLowerCase())}
                    </button>
                  )}
                </section>
              );
            })}
          </div>

          {/* Preview of the selected result */}
          <div className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
            {selected && (() => {
              const d = describe(selected);
              return (
                <div className="max-w-2xl flex flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-tertiary">{KIND[selected.type].one} · {formatDate(selected.timestamp)}</div>
                      <h2 className="text-2xl text-text-primary mt-1"><Highlight text={d.title} query={query} around={0} /></h2>
                    </div>
                    <button onClick={() => open(selected)} className="hearth-primary-btn flex-shrink-0">
                      Open in {DATA_SECTIONS.find(s => s.id === KIND[selected.type].tab)?.label === 'Web' ? 'Web history' : DATA_SECTIONS.find(s => s.id === KIND[selected.type].tab)?.label}
                      <ChevronRightIcon size={18} className="text-white" />
                    </button>
                  </div>
                  {(selected.type === 'note' || selected.type === 'message') && d.text && (
                    <div className="hearth-card p-5 text-[17px] leading-relaxed whitespace-pre-wrap text-text-primary">
                      <Highlight text={d.text} query={query} around={0} />
                    </div>
                  )}
                  <TimelineEntryCard entry={selected} udid={ctx.udid} />
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
