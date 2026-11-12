import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { UseTimelineReturn } from '../../hooks/useTimeline';
import type { TimelineEntry, TimelineEntryType } from '../../types/timeline';
import { formatDate, formatDuration } from '../../lib/dates';
import { formatPhone } from '../../lib/people';
import { plural } from '../../lib/saveData';
import { matches } from '../../lib/search';
import { whatsAppSender, whatsAppText } from '../../lib/timelineExport';
import EmptyState from '../shared/EmptyState';
import Highlight from '../shared/Highlight';
import OrganicLoader from '../shared/OrganicLoader';
import { ChevronRightIcon, ContactIcon, LinesIcon, PeopleIcon, SearchIcon } from '../shared/Icons';
import TimelineEntryCard from '../timeline/TimelineEntryCard';
import { TYPE_COLORS } from '../timeline/TimelineTypeChips';
import { gatherPeople, linkCards } from '../people/gather';
import { DATA_SECTIONS, type ExploreContext, type Icon, type Tab } from '../explore/sections';

// A kind missing here would be left out of the results while still counted under "All"
const ORDER: TimelineEntryType[] = ['note', 'message', 'whatsapp', 'voicemail', 'call', 'photo', 'browser'];
// `items` is how "Show all …" counts them, when lower case would get it wrong
const KIND: Record<TimelineEntryType, { one: string; many: string; tab: Tab; items?: [string, string] }> = {
  note: { one: 'Note', many: 'Notes', tab: 'notes' },
  message: { one: 'Message', many: 'Messages', tab: 'messages' },
  whatsapp: { one: 'WhatsApp message', many: 'WhatsApp', tab: 'whatsapp', items: ['WhatsApp message', 'WhatsApp messages'] },
  voicemail: { one: 'Voicemail', many: 'Voicemail', tab: 'voicemail' },
  call: { one: 'Call', many: 'Calls', tab: 'calls' },
  photo: { one: 'Photo', many: 'Photos', tab: 'photos' },
  browser: { one: 'Web page', many: 'Web history', tab: 'browser_history' },
};
const PER_GROUP = 5;
const PEOPLE_SHOWN = 4;

// Each kind wears its section's icon and name. A kind whose section isn't
// registered (yet) falls back to Messages' icon and its own name, rather than
// taking the whole results page down.
function iconFor(type: TimelineEntryType): Icon {
  return DATA_SECTIONS.find(s => s.id === KIND[type].tab)?.icon ?? LinesIcon;
}

function labelFor(type: TimelineEntryType): string {
  return DATA_SECTIONS.find(s => s.id === KIND[type].tab)?.label ?? KIND[type].many;
}

/** A title and the line that matched, for one result. */
function describe(e: TimelineEntry): { title: string; text: string } {
  switch (e.type) {
    case 'message': return { title: e.message!.conversationName, text: e.message!.text ?? '' };
    case 'whatsapp': {
      const w = e.whatsapp!;
      // In a group, who said it
      const by = whatsAppSender(w);
      return { title: w.conversationName, text: by ? `${by}: ${whatsAppText(w)}` : whatsAppText(w) };
    }
    case 'note': return { title: e.note!.title || 'Untitled', text: e.note!.body || e.note!.bodyPreview };
    case 'voicemail': return { title: e.contactName ?? formatPhone(e.voicemail!.phoneNumber), text: e.voicemail!.transcript || `Voicemail · ${formatDuration(e.voicemail!.duration)}` };
    case 'call': return { title: e.contactName ?? '', text: `${e.call!.status === 'missed' ? 'Missed' : e.call!.direction === 'outgoing' ? 'Outgoing' : 'Incoming'} call · ${formatDuration(e.call!.duration)}` };
    case 'photo': return { title: e.photo!.filename, text: e.photo!.kind.replace('_', ' ') };
    case 'browser': return { title: e.browser!.title || e.browser!.url, text: e.browser!.domain };
  }
}

/** One person or saved card that matches, opening their page or their card. */
interface PersonHit {
  key: string;
  name: string;
  line: string;
  open: () => void;
  saved: boolean;
}

interface Props {
  ctx: ExploreContext;
  timeline: UseTimelineReturn;
  query: string;
  /** The search box hands its arrow keys and Enter to the results. */
  keyRef: MutableRefObject<((e: React.KeyboardEvent<HTMLInputElement>) => void) | null>;
}

/** Every kind of record that matches, grouped, with a preview of the one picked. */
export default function SearchResults({ ctx, timeline, query, keyRef }: Props) {
  const [only, setOnly] = useState<TimelineEntryType | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 999px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 999px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // People you were in touch with, then saved cards that aren't one of them
  const cards = ctx.index.addressBook;
  const allPeople = useMemo(() => gatherPeople(ctx.index.entries, cards ?? []), [ctx.index.entries, cards]);
  const { personOf } = useMemo(() => linkCards(allPeople, cards ?? []), [allPeople, cards]);
  const { openTab } = ctx;
  const people = useMemo((): PersonHit[] => {
    const found = new Set(allPeople.filter(p => !p.isGroup && matches(query, p.name, ...p.numbers, ...p.ids)));
    const saved: PersonHit[] = [];
    for (const c of cards ?? []) {
      if (!matches(query, c.display_name, c.organization, ...c.phones, ...c.emails)) continue;
      // A card that's someone you were in touch with finds them, even by a number only the card has
      const p = personOf.get(c.id);
      if (p) found.add(p);
      else saved.push({
        key: `c:${c.id}`, name: c.display_name, saved: true,
        line: ['Address book', c.organization, c.phones[0] ?? c.emails[0]].filter(Boolean).join(' · '),
        open: () => openTab('contacts', { contactId: c.id }),
      });
    }
    const hits: PersonHit[] = allPeople.filter(p => found.has(p)).map(p => ({
      key: `p:${p.key}`, name: formatPhone(p.name), saved: false,
      line: `${plural(p.total, 'event')} · messages, WhatsApp, calls and voicemail`,
      open: () => openTab('people', { person: p.identifier }),
    }));
    return [...hits, ...saved];
  }, [allPeople, cards, personOf, query, openTab]);

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
  const listed = visible.flatMap(g => (only ? g.entries.slice(0, 100) : g.entries.slice(0, PER_GROUP)));
  const selected = listed.find(e => e.id === selectedId) ?? listed[0] ?? null;
  const total = timeline.totalFiltered;

  function open(e: TimelineEntry) {
    // The screen opens filtered to the same words, on the record that was picked
    openTab(KIND[e.type].tab, { select: e, keepQuery: true });
  }

  // ↑ and ↓ in the search box move through the results; Enter opens the one picked
  keyRef.current = (e) => {
    if (listed.length === 0) return;
    const at = selected ? listed.indexOf(selected) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = listed[Math.max(0, Math.min(listed.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      setSelectedId(next.id);
      document.getElementById(`result-${next.id}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      open(selected);
    }
  };
  useEffect(() => () => { keyRef.current = null; }, [keyRef]);

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
        {chip('All', total + people.length, only === null, () => setOnly(null))}
        {groups.map(g => chip(KIND[g.type].many, g.entries.length, only === g.type, () => setOnly(g.type), TYPE_COLORS[g.type]))}
        {timeline.loading && (
          <span className="ml-2 text-sm text-text-tertiary whitespace-nowrap">Still reading the backup, more may appear…</span>
        )}
      </div>

      {total === 0 && people.length === 0 ? (
        timeline.loading
          ? <div className="flex-1 flex items-center justify-center text-accent"><OrganicLoader size={72} /></div>
          : <EmptyState icon={SearchIcon} title={`Nothing matches "${query}"`} detail="Try fewer words, or another word from the message, note or name." />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Results, grouped by kind */}
          <div className={`${narrow ? 'flex-1' : 'w-[440px] flex-shrink-0 border-r border-rule'} overflow-y-auto py-2`}>
            {!only && people.length > 0 && (
              <section>
                <h2 className="font-mono text-[11.5px] tracking-[0.08em] uppercase text-text-tertiary px-5 pt-3 pb-1">People · {people.length}</h2>
                {people.slice(0, PEOPLE_SHOWN).map(p => {
                  const I = p.saved ? ContactIcon : PeopleIcon;
                  return (
                    <button key={p.key} onClick={p.open} className="w-full px-5 py-2.5 flex items-center gap-3 text-left hover:bg-surface">
                      <span className="w-9 h-9 rounded-full bg-sand flex items-center justify-center flex-shrink-0">
                        <I size={18} className="text-text-secondary" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-text-primary truncate"><Highlight text={p.name} query={query} /></span>
                        <span className="block text-xs text-text-tertiary truncate">{p.line}</span>
                      </span>
                      <ChevronRightIcon size={18} className="text-text-tertiary" />
                    </button>
                  );
                })}
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
                        id={`result-${e.id}`}
                        onClick={() => (narrow ? open(e) : setSelectedId(e.id))}
                        onDoubleClick={() => open(e)}
                        aria-current={on ? 'true' : undefined}
                        className={`w-full px-5 py-2.5 flex gap-3 text-left transition-colors ${on ? 'bg-accent-wash' : 'hover:bg-surface'}`}
                      >
                        <span className="w-9 h-9 rounded-[10px] bg-sand flex items-center justify-center flex-shrink-0" style={{ color: TYPE_COLORS[g.type] }}>
                          <I size={18} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-text-primary truncate"><Highlight text={d.title} query={query} /></span>
                          <span className="block text-sm text-text-secondary truncate"><Highlight text={d.text} query={query} around={30} /></span>
                          <span className="block text-xs text-text-tertiary">{KIND[g.type].one} · {formatDate(e.timestamp)}</span>
                        </span>
                      </button>
                    );
                  })}
                  {!only && g.entries.length > PER_GROUP && (
                    <button onClick={() => setOnly(g.type)} className="pl-[68px] pr-5 py-1.5 text-sm text-accent font-medium hover:underline">
                      Show all {plural(g.entries.length, ...(KIND[g.type].items ?? [KIND[g.type].one.toLowerCase(), KIND[g.type].many.toLowerCase()]))}
                    </button>
                  )}
                </section>
              );
            })}
            {!only && people.length > PEOPLE_SHOWN && (
              <p className="px-5 pt-4 text-sm text-text-tertiary">
                {plural(people.length - PEOPLE_SHOWN, 'more person', 'more people')} match. Add a word to narrow it down.
              </p>
            )}
          </div>

          {/* Preview of the selected result */}
          {!narrow && (
            <div className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
              {selected && (() => {
                const d = describe(selected);
                return (
                  <div className="max-w-2xl flex flex-col gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-text-tertiary">{KIND[selected.type].one} · {formatDate(selected.timestamp)}</div>
                        <h2 className="text-2xl text-text-primary mt-1"><Highlight text={d.title} query={query} /></h2>
                      </div>
                      <button onClick={() => open(selected)} className="hearth-primary-btn flex-shrink-0">
                        Open in {labelFor(selected.type)}
                        <ChevronRightIcon size={18} className="text-white" />
                      </button>
                    </div>
                    {(selected.type === 'note' || selected.type === 'message' || selected.type === 'whatsapp') && d.text && (
                      <div className="hearth-card p-5 text-[17px] leading-relaxed whitespace-pre-wrap text-text-primary">
                        <Highlight text={d.text} query={query} />
                      </div>
                    )}
                    <TimelineEntryCard entry={selected} udid={ctx.udid} onOpenWhatsApp={open} />
                    <p className="text-xs text-text-tertiary">↑ ↓ to move through results · Enter to open</p>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
