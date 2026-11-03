import { useEffect, useMemo, useState } from 'react';
import { useTimeline } from '../../hooks/useTimeline';
import type { TimelineEntryType } from '../../types/timeline';
import { formatPhone } from '../../lib/people';
import { matches } from '../../lib/search';
import { formatDate } from '../../lib/dates';
import { saveFolder } from '../../lib/ipc';
import { formatTimeline, FORMAT_FILTERS, type ExportFormat } from '../../lib/timelineExport';
import { plural } from '../../lib/saveData';
import { useSaveAction } from '../../hooks/useSaveAction';
import Highlight from '../shared/Highlight';
import EmptyState from '../shared/EmptyState';
import OrganicLoader from '../shared/OrganicLoader';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { CallIcon, ChevronRightIcon, ContactIcon, PeopleIcon, LinesIcon, VoicemailIcon } from '../shared/Icons';
import TimelineEntryCard from '../timeline/TimelineEntryCard';
import { groupByDay } from '../timeline/TimelineView';
import type { ExploreContext } from '../explore/sections';
import { gatherPeople, idKey, initials, linkCards, PERSON_KINDS, type Person, type PersonKind } from './gather';

const KIND_LABEL: Record<PersonKind, [string, string]> = {
  message: ['message', 'messages'],
  call: ['call', 'calls'],
  voicemail: ['voicemail', 'voicemails'],
};

function summary(p: Person): string {
  return PERSON_KINDS.filter(k => p.counts[k] > 0)
    .map(k => plural(p.counts[k], KIND_LABEL[k][0], KIND_LABEL[k][1]))
    .join(' · ');
}

interface Props {
  ctx: ExploreContext;
  /** What the top search box holds; the list shows only people who match. */
  query: string;
  /** Who to open, by phone number or email. */
  person?: string;
}

/**
 * Who you were in touch with, most first, and one page per person with their
 * messages, calls and voicemail in one stream. Saved cards are in the address book.
 */
export default function PeopleView({ ctx, query, person }: Props) {
  const timeline = useTimeline(ctx.index);
  const people = useMemo(() => gatherPeople(timeline.allEntries), [timeline.allEntries]);
  const { cardOf } = useMemo(() => linkCards(people, ctx.index.addressBook ?? []), [people, ctx.index.addressBook]);
  const asked = person ? people.find(p => p.ids.has(idKey(person))) : undefined;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [kinds, setKinds] = useState<PersonKind | 'all'>('all');
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('timeline');

  const shown = people.filter(p => p.key === asked?.key || matches(query, p.name, ...p.ids));
  const individuals = shown.filter(p => !p.isGroup);
  const groups = shown.filter(p => p.isGroup);
  const selected = people.find(p => p.key === (selectedKey ?? asked?.key))
    ?? individuals[0] ?? groups[0] ?? null;
  const card = selected ? cardOf.get(selected.key) : undefined;

  // The Timeline does the matching: one person across phone numbers, emails and their address-book card
  const { setFilters } = timeline;
  useEffect(() => {
    if (!selected) return;
    setFilters({
      contactIdentifier: selected.identifier,
      types: new Set<TimelineEntryType>(kinds === 'all' ? PERSON_KINDS : [kinds]),
      searchQuery: '', dateFrom: '', dateTo: '',
    });
  }, [selected?.key, kinds, setFilters]);

  function save(format: ExportFormat) {
    setChoosing(false);
    if (!selected) return;
    const entries = timeline.filteredEntries;
    run(async () => {
      const folder = await saveFolder();
      if (!folder) return null;
      const safe = selected.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'person';
      const path = `${folder}/${safe}.${FORMAT_FILTERS[format].extensions[0]}`;
      await window.openextract.writeFile(path, formatTimeline(entries, format));
      return { title: `Saved everything with ${selected.name}`, detail: plural(entries.length, 'event'), path };
    });
  }

  const listRow = (p: Person) => {
    const on = selected?.key === p.key;
    return (
      <button
        key={p.key}
        onClick={() => { setSelectedKey(p.key); setKinds('all'); }}
        aria-current={on ? 'true' : undefined}
        className={`w-full px-4 py-2.5 flex items-center gap-3 text-left transition-colors ${on ? 'bg-accent-wash' : 'hover:bg-surface'}`}
      >
        <span
          aria-hidden="true"
          data-initials={initials(p.name)}
          className="w-10 h-10 rounded-full bg-sand flex items-center justify-center flex-shrink-0 text-sm font-medium text-text-secondary before:content-[attr(data-initials)]"
        />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-text-primary truncate"><Highlight text={formatPhone(p.name)} query={query} /></span>
          <span className="block text-xs text-text-secondary truncate">{summary(p)}</span>
        </span>
      </button>
    );
  };

  const groupsOfDays = groupByDay(timeline.entries);
  const totalPages = Math.ceil(timeline.totalFiltered / timeline.pageSize);

  return (
    <div className="h-full flex min-h-0">
      {/* People */}
      <div className="w-[300px] flex-shrink-0 border-r border-rule flex flex-col">
        <div className="px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-rule">
          <div className="flex items-baseline justify-between">
            <h1 className="text-2xl text-text-primary">People</h1>
            <span className="text-xs text-text-tertiary">Most in touch first</span>
          </div>
          <p className="text-xs text-text-secondary">Everyone you messaged, called or got voicemail from. Saved cards are in the address book.</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {timeline.loading && people.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-10 text-accent">
              <OrganicLoader size={56} />
              <span className="text-sm text-text-secondary">Gathering everyone…</span>
            </div>
          )}
          {individuals.map(listRow)}
          {groups.length > 0 && (
            <>
              <div className="font-mono text-[11.5px] tracking-[0.08em] uppercase text-text-tertiary px-4 pt-4 pb-1">Groups</div>
              {groups.map(listRow)}
            </>
          )}
          {!timeline.loading && shown.length === 0 && (
            <div className="px-4 py-6 text-sm text-text-secondary text-center">
              {query ? `No one matches "${query}"` : 'No messages, calls or voicemail in this backup'}
            </div>
          )}
        </div>
      </div>

      {/* One person */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          !timeline.loading && <EmptyState icon={PeopleIcon} title="Pick someone to see everything with them" />
        ) : (
          <>
            <div className="px-7 pt-6 pb-4 border-b border-rule flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <span
                  aria-hidden="true"
                  data-initials={initials(selected.name)}
                  className="w-16 h-16 rounded-full bg-accent-wash flex items-center justify-center flex-shrink-0 text-xl font-medium text-accent before:content-[attr(data-initials)]"
                />
                <div className="flex-1 min-w-0">
                  <h2 className="text-3xl text-text-primary truncate">{formatPhone(selected.name)}</h2>
                  <div className="text-sm text-text-secondary truncate">
                    {selected.isGroup ? 'Group conversation' : formatPhone(selected.identifier)}
                    {selected.last && ` · last in touch ${formatDate(selected.last)}`}
                  </div>
                  {card && (
                    <button
                      onClick={() => ctx.openTab('contacts', { contactId: card.id })}
                      className="mt-1 flex items-center gap-1.5 text-sm text-accent font-medium hover:underline"
                    >
                      <ContactIcon size={16} />
                      In your address book{card.organization ? ` · ${card.organization}` : ''}
                      <ChevronRightIcon size={16} />
                    </button>
                  )}
                </div>
                {selected.chatId != null && selected.counts.message > 0 && (
                  <button onClick={() => ctx.openTab('messages', { chatId: selected.chatId })} className="hearth-ghost-btn">
                    <LinesIcon size={18} />
                    Open conversation
                  </button>
                )}
                <SaveButton primary onClick={() => setChoosing(true)} busy={busy} disabled={timeline.loading} label="Save everything" />
              </div>
              <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-2">
                {(['all', ...PERSON_KINDS] as const).map(k => {
                  const on = kinds === k;
                  const n = k === 'all' ? selected.total : selected.counts[k];
                  if (k !== 'all' && n === 0) return null;
                  const Icon = k === 'message' ? LinesIcon : k === 'call' ? CallIcon : k === 'voicemail' ? VoicemailIcon : null;
                  return (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setKinds(k)}
                      className={`h-9 px-4 rounded-full border text-sm flex items-center gap-2 transition-colors ${
                        on ? 'border-accent bg-accent-wash text-text-primary font-medium' : 'border-rule text-text-secondary hover:bg-surface'
                      }`}
                    >
                      {Icon && <Icon size={18} />}
                      {k === 'all' ? `Everything · ${n.toLocaleString()}` : plural(n, KIND_LABEL[k][0], KIND_LABEL[k][1])}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-7 pb-6">
              {timeline.loading && timeline.entries.length === 0 && (
                <div className="flex justify-center py-12 text-accent"><OrganicLoader size={64} /></div>
              )}
              {groupsOfDays.map(group => (
                <div key={group.date}>
                  <div className="sticky top-0 bg-base z-10 pt-4 pb-2 text-sm font-semibold text-text-primary">{group.date}</div>
                  <div className="flex flex-col gap-1.5">
                    {group.entries.map(entry => <TimelineEntryCard key={entry.id} entry={entry} udid={ctx.udid} />)}
                  </div>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="px-7 py-2.5 border-t border-rule flex items-center justify-between">
                <span className="text-sm text-text-secondary">
                  {plural(timeline.totalFiltered, 'event')} · page {timeline.page + 1} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <button className="hearth-ghost-btn" disabled={timeline.page === 0} onClick={() => timeline.setPage(timeline.page - 1)}>← Newer</button>
                  <button className="hearth-ghost-btn" disabled={timeline.page >= totalPages - 1} onClick={() => timeline.setPage(timeline.page + 1)}>Older →</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {choosing && selected && (
        <SaveDialog
          title={`Save everything with ${formatPhone(selected.name)}`}
          formats={[FORMATS.html, FORMATS.csv, { id: 'md', label: 'Markdown', detail: 'MD, for notes apps and text editors' }]}
          onSave={id => save(id as ExportFormat)}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
