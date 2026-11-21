import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTimeline } from '../../hooks/useTimeline';
import type { TimelineEntry } from '../../types/timeline';
import { formatPhone } from '../../lib/people';
import { matches } from '../../lib/search';
import { formatDate } from '../../lib/dates';
import { percentDone } from '../../lib/exportProgress';
import { personExportSpec, plural, savePerson, type RecordFormat } from '../../lib/saveData';
import { useSaveAction } from '../../hooks/useSaveAction';
import { useExportProgress } from '../../hooks/useExportProgress';
import Highlight from '../shared/Highlight';
import EmptyState from '../shared/EmptyState';
import OrganicLoader from '../shared/OrganicLoader';
import SaveDialog, { RECORD_FORMATS, SaveButton, SaveProgress } from '../shared/SaveDialog';
import DateRange from '../shared/DateRange';
import { SearchField } from '../shared/PageHeader';
import { CallIcon, CameraIcon, ChevronRightIcon, ContactIcon, NoteIcon, PeopleIcon, LinesIcon, VoicemailIcon, WhatsAppIcon } from '../shared/Icons';
import EventStream from '../timeline/EventStream';
import type { ExploreContext } from '../explore/sections';
import { gatherPeople, idKey, initials, linkCards, PERSON_KINDS, type Person } from './gather';
import { countOf, kindChips, nothingBetween, streamTypes, type StreamKind } from './stream';

const KIND_ICON: Record<StreamKind, typeof LinesIcon> = {
  message: LinesIcon, whatsapp: WhatsAppIcon, call: CallIcon, voicemail: VoicemailIcon, photo: CameraIcon, note: NoteIcon,
};

// What a group-like row is, under its name
function groupLine(p: Person): string {
  if (p.waChatType === 'broadcast') return 'WhatsApp broadcast list';
  if (p.waChatType === 'channel') return 'WhatsApp channel';
  return 'Group conversation';
}

function summary(p: Person): string {
  return PERSON_KINDS.filter(k => p.counts[k] > 0).map(k => countOf(k, p.counts[k])).join(' · ');
}

interface Props {
  ctx: ExploreContext;
  /** What the top search box holds; the list shows only people who match. */
  query: string;
  /** Who to open, by phone number or email. */
  person?: string;
  /** The dates to start from: a day opened from the Year view with someone picked. */
  days?: { from: string; to: string };
}

const ANY_DATE = { from: '', to: '' };

/**
 * Who you were in touch with, most first, and one page per person with
 * everything between you in one stream: messages, WhatsApp, calls, voicemail,
 * the photos sent in your chats and the notes you share. Saved cards are in the address book.
 */
export default function PeopleView({ ctx, query, person, days }: Props) {
  const timeline = useTimeline(ctx.index);
  const cards = ctx.index.addressBook;
  const people = useMemo(() => gatherPeople(timeline.allEntries, cards ?? []), [timeline.allEntries, cards]);
  const { cardOf } = useMemo(() => linkCards(people, cards ?? []), [people, cards]);
  const asked = person ? people.find(p => p.ids.has(idKey(person))) : undefined;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // What of theirs to show: one kind or everything, which dates, and words to find
  const [kinds, setKinds] = useState<StreamKind | 'all'>('all');
  const [range, setRange] = useState(days ?? ANY_DATE);
  const [within, setWithin] = useState('');
  const searchWithin = useDeferredValue(within);
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('timeline');
  const saving = useExportProgress('person', busy);

  const shown = people.filter(p => p.key === asked?.key || matches(query, p.name, ...p.numbers, ...p.ids));
  const individuals = shown.filter(p => !p.isGroup);
  const groups = shown.filter(p => p.isGroup);
  const selected = people.find(p => p.key === (selectedKey ?? asked?.key))
    ?? individuals[0] ?? groups[0] ?? null;
  const card = selected ? cardOf.get(selected.key) : undefined;

  // The Timeline does the matching: one person across phone numbers, emails and their address-book card.
  // Their identifier can change while the backup loads (a newer call from a number they also text from
  // an email), so the filter follows it as well as who's picked: otherwise the page would wait for good.
  const { setFilters } = timeline;
  useEffect(() => {
    if (!selected) return;
    setFilters({
      contactIdentifier: selected.identifier,
      types: streamTypes(kinds),
      searchQuery: searchWithin, dateFrom: range.from, dateTo: range.to,
    });
  }, [selected?.key, selected?.identifier, kinds, searchWithin, range.from, range.to, setFilters]);
  // Until the filter has caught up with who's picked, the Timeline's numbers are the whole backup's
  const ready = selected != null && timeline.filters.contactIdentifier === selected.identifier;
  const dated = !!(range.from || range.to);
  const narrowed = kinds !== 'all' || dated || !!within.trim();

  function pick(p: Person) {
    setSelectedKey(p.key);
    showEverything();
  }

  function showEverything() {
    setKinds('all');
    setRange(ANY_DATE);
    setWithin('');
  }

  const name = selected ? formatPhone(selected.name) : '';

  // What's shown is what's saved: everything, or what the chips, dates and
  // search leave, with every photo, video, voice message, document and
  // recording copied beside the file
  function save(format: RecordFormat) {
    setChoosing(false);
    if (!selected || !ready) return;
    const entries = timeline.filteredEntries;
    const { dateFrom, dateTo, searchQuery } = timeline.filters;
    // Whole chats unless the dates, the search or Photos picked out some of their messages
    const onlyThese = !!(dateFrom || dateTo || searchQuery.trim()) || kinds === 'photo';
    const spec = personExportSpec(name, entries, { onlyThese });
    const title = narrowed ? `Saved ${plural(entries.length, 'event')} with ${name}` : `Saved everything with ${name}`;
    run(() => savePerson(ctx.udid, spec, format, title));
  }

  const listRow = (p: Person) => {
    const on = selected?.key === p.key;
    return (
      <button
        key={p.key}
        onClick={() => pick(p)}
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

  // A message opens in its own thread, at that message (the same functions every render, so cards don't redraw)
  const { openTab } = ctx;
  const openWhatsApp = useCallback((entry: TimelineEntry) => openTab('whatsapp', { select: entry }), [openTab]);
  const openMessage = useCallback((entry: TimelineEntry) => openTab('messages', { select: entry }), [openTab]);

  return (
    <div className="h-full flex min-h-0">
      {/* People */}
      <div className="w-[300px] flex-shrink-0 border-r border-rule flex flex-col">
        <div className="px-4 pt-4 pb-3 flex flex-col gap-3 border-b border-rule">
          <div className="flex items-baseline justify-between">
            <h1 className="text-2xl text-text-primary">People</h1>
            <span className="text-xs text-text-tertiary">Most in touch first</span>
          </div>
          <p className="text-sm text-text-secondary">
            Pick anyone to see everything between you in one stream: messages, WhatsApp, calls, voicemail, the photos you sent each other and the notes you share.
          </p>
          <p className="text-xs text-text-tertiary">Saved cards are in the address book.</p>
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
              {query ? `No one matches "${query}"` : 'No messages, WhatsApp chats, calls or voicemail in this backup'}
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
            <div className="px-7 pt-5 pb-4 border-b border-rule flex flex-col gap-3">
              {/* Who it is, with the buttons beside them when there's room and on their own row when there isn't: nothing is cut short */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <div className="flex items-center gap-4 flex-[1_1_18rem] min-w-0">
                  <span
                    aria-hidden="true"
                    data-initials={initials(selected.name)}
                    className="w-14 h-14 rounded-full bg-accent-wash flex items-center justify-center flex-shrink-0 text-lg font-medium text-accent before:content-[attr(data-initials)]"
                  />
                  <div className="min-w-0">
                    <div className="hearth-eyebrow">{selected.isGroup ? 'Everything in' : 'Everything between you and'}</div>
                    <h2 className="text-2xl text-text-primary break-words">{name}</h2>
                    <div className="text-sm text-text-secondary">
                      <span className="whitespace-nowrap">{selected.isGroup ? groupLine(selected) : formatPhone(selected.identifier)}</span>
                      {selected.last && <> · <span className="whitespace-nowrap">last in touch {formatDate(selected.last)}</span></>}
                    </div>
                    {card && (
                      <button
                        onClick={() => ctx.openTab('contacts', { contactId: card.id })}
                        className="mt-1 inline-flex flex-wrap items-center gap-x-1.5 text-sm text-accent font-medium hover:underline text-left"
                      >
                        <ContactIcon size={16} />
                        {card.organization ? (
                          <>
                            <span className="whitespace-nowrap">In your address book</span>
                            {/* The arrow stays with the last word, never alone on a line */}
                            <span>· {card.organization.replace(/\s*\S+$/, '')} <span className="whitespace-nowrap">{card.organization.match(/\S+$/)?.[0]}<ChevronRightIcon size={16} className="inline align-[-3px]" /></span></span>
                          </>
                        ) : (
                          <span className="whitespace-nowrap">In your address book<ChevronRightIcon size={16} className="inline align-[-3px]" /></span>
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {selected.chatId != null && selected.counts.message > 0 && (
                    <button onClick={() => ctx.openTab('messages', { chatId: selected.chatId })} className="hearth-ghost-btn">
                      <LinesIcon size={18} />
                      Open conversation
                    </button>
                  )}
                  {selected.waChatId != null && selected.counts.whatsapp > 0 && (
                    <button onClick={() => ctx.openTab('whatsapp', { waChatId: selected.waChatId })} className="hearth-ghost-btn">
                      <WhatsAppIcon size={18} />
                      Open WhatsApp chat
                    </button>
                  )}
                  <SaveButton
                    primary
                    onClick={() => setChoosing(true)}
                    busy={busy}
                    disabled={timeline.loading || !ready || timeline.totalFiltered === 0}
                    label={narrowed ? 'Save these' : 'Save everything'}
                  />
                </div>
              </div>
              {saving && (
                <SaveProgress
                  text={`Saving ${saving.done.toLocaleString()} of ${plural(saving.total, 'message, call or file', 'messages, calls and files')}…`}
                  percent={percentDone(saving)}
                />
              )}
              <div className="flex flex-col gap-3">
                <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-2">
                  {ready && kindChips(timeline.counts, kinds).map(({ kind, label }) => {
                    const on = kinds === kind;
                    const Icon = kind === 'all' ? null : KIND_ICON[kind];
                    return (
                      <button
                        key={kind}
                        role="radio"
                        aria-checked={on}
                        onClick={() => setKinds(kind)}
                        title={kind === 'photo' ? 'Photos sent in your messages and WhatsApp chats' : kind === 'note' ? 'Notes you share over iCloud' : undefined}
                        className={`h-9 px-4 rounded-full border text-sm flex items-center gap-2 transition-colors ${
                          on ? 'border-accent bg-accent-wash text-text-primary font-medium' : 'border-rule text-text-secondary hover:bg-surface'
                        }`}
                      >
                        {Icon && <Icon size={18} />}
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <SearchField
                    value={within}
                    onChange={setWithin}
                    placeholder={selected.isGroup ? 'Search this group' : 'Search everything between you'}
                    className="w-80 max-w-full"
                  />
                  <DateRange from={range.from} to={range.to} onChange={setRange} />
                </div>
              </div>
            </div>

            {/* Until the filter has caught up, the list is the whole backup's: show nothing of it */}
            {!ready || (timeline.loading && timeline.filteredEntries.length === 0) ? (
              <div className="flex justify-center py-12 text-accent"><OrganicLoader size={64} /></div>
            ) : timeline.filteredEntries.length === 0 ? (
              <EmptyState
                icon={PeopleIcon}
                title={nothingBetween(name, { kind: kinds, dates: dated, within: searchWithin })}
                action={<button onClick={showEverything} className="hearth-ghost-btn">Show everything</button>}
              />
            ) : (
              <EventStream
                entries={timeline.filteredEntries}
                resetKey={`${selected.key}|${kinds}|${range.from}|${range.to}|${searchWithin}`}
                udid={ctx.udid}
                variant="people"
                loading={timeline.loading}
                className="px-7 pb-6"
                onOpenWhatsApp={openWhatsApp}
                onOpenMessage={openMessage}
              />
            )}
          </>
        )}
      </div>

      {choosing && selected && (
        <SaveDialog
          title={narrowed ? `Save ${plural(timeline.totalFiltered, 'event')} with ${name}` : `Save everything with ${name}`}
          formats={RECORD_FORMATS}
          onSave={save}
          onCancel={() => setChoosing(false)}
        >
          <p className="text-xs text-text-secondary">
            Photos, videos, voice messages, documents and voicemail recordings are copied into a folder beside it.
          </p>
        </SaveDialog>
      )}
    </div>
  );
}
