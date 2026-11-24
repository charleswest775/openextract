import { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { CalendarIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import Highlight from '../shared/Highlight';
import { useSaveAction } from '../../hooks/useSaveAction';
import { plural, saveCalendar } from '../../lib/saveData';
import { matches } from '../../lib/search';
import {
  agenda, agendaEmptyText, alertText, answerText, calendarColor, calendarFacts, calendarLine, calendarName, changedText,
  defaultView, emptyCopy, eventChips, eventMatchFields, eventName, groupCalendars, isOwnCalendar, matchCount, noMatchCopy,
  organizerText, personName, placeLine, placeLines, repeatText, skippedText, splitEvents, splitNote, splitPoint,
  timeText, webAddress, whenText, zoneNote, type AgendaDay, type AgendaView,
} from '../../lib/calendar';
import type {
  Calendar, CalendarEvent, CalendarEventsResult, CalendarSaveFormat, CalendarsResult,
} from '../../types/calendar';

interface Props {
  udid: string;
  /** What the top search box holds; the agenda shows only events that match. */
  query: string;
  /** When the backup was made (the overview's last_backup): where Upcoming and Past divide. */
  backupDate?: string | null;
}

/** The left list's first entry: every event in the person's own calendars. */
const ALL = 'all';
type Selection = typeof ALL | number;

/** The events as the engine answered them; null until they're read. */
interface EventList {
  events: CalendarEvent[];
  error: string | null;
}

// A long agenda is shown a page at a time
const PAGE = 300;

/**
 * The Calendar app's events (Calendar.sqlitedb): the person's own calendars,
 * grouped by account, and, quietly below them, calendars that come from
 * elsewhere (holidays, birthdays, Found in Mail, subscriptions) that have events,
 * which are opened one at a time and never mixed into All calendars. The agenda splits
 * at the backup's date into Upcoming and Past, a day at a time; a repeating
 * event is listed once, at its first start, with how it repeats.
 */
export default function CalendarExplorer({ udid, query, backupDate }: Props) {
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [list, setList] = useState<EventList | null>(null);
  const asked = useRef(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  // The Upcoming / Past choice, per calendar
  const [views, setViews] = useState<Record<string, AgendaView>>({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('calendar');

  useEffect(() => {
    loadCalendars();
  }, [udid]);

  async function loadCalendars() {
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    try {
      const res = await window.openextract.call('list_calendars', { udid });
      if (!res.success) {
        setCalendars([]);
        setError(res.error || "The calendar couldn't be read.");
      } else if (res.data) {
        const data = res.data as CalendarsResult;
        const cals = Array.isArray(data.calendars) ? data.calendars : [];
        setCalendars(cals);
        // Calendars without a single event: nothing to show, and calmly so
        setEmptyReason(data.empty_reason ?? (cals.length > 0 && !cals.some(c => c.event_count > 0) ? 'no_records' : null));
        if (data.error) setError(data.error);
      }
    } finally {
      setLoading(false);
    }
  }

  const hasEvents = calendars.some(c => c.event_count > 0);
  const groups = useMemo(() => groupCalendars(calendars), [calendars]);
  const ownIds = useMemo(() => new Set(calendars.filter(isOwnCalendar).map(c => c.id)), [calendars]);
  const ownCount = calendars.filter(isOwnCalendar).reduce((n, c) => n + c.event_count, 0);
  // Opens on the person's own calendars; with no events of their own, on the first other calendar with some
  const fallback: Selection = ownCount > 0 ? ALL : groups.others.find(c => c.event_count > 0)?.id ?? ALL;
  const selection: Selection = selected ?? fallback;
  const calendar = typeof selection === 'number' ? calendars.find(c => c.id === selection) ?? null : null;
  const key = calendar ? String(calendar.id) : ALL;

  // Every event is read once, the first time it's needed; a list that couldn't be read is asked
  // for again when another calendar is opened
  useEffect(() => {
    if (!hasEvents || asked.current) return;
    asked.current = true;
    loadEvents();
  }, [hasEvents, key]);

  async function loadEvents() {
    let result: EventList;
    try {
      const res = await window.openextract.call('list_calendar_events', { udid });
      const data = res.data as CalendarEventsResult | undefined;
      result = !res.success
        ? { events: [], error: res.error || "The events couldn't be read." }
        : {
          events: Array.isArray(data?.events) ? data!.events : [],
          // An empty list is calm; only a list that couldn't be read is an error
          error: data?.error && !data.empty_reason ? data.error : null,
        };
    } catch (err: any) {
      result = { events: [], error: err?.message || String(err) };
    }
    if (result.error) asked.current = false;
    setList(result);
  }

  // Without the backup's date the split is now, taken once, so the agenda isn't rebuilt on every render
  const split = useMemo(() => splitPoint(backupDate), [backupDate]);
  const events = list?.events ?? [];
  const inView = useMemo(
    () => events.filter(e => (calendar ? e.calendar_id === calendar.id : ownIds.has(e.calendar_id))),
    [events, calendar, ownIds],
  );
  const matching = useMemo(() => (query ? inView.filter(e => matches(query, ...eventMatchFields(e))) : inView), [inView, query]);
  const parts = useMemo(() => splitEvents(matching, split.at), [matching, split]);
  const view: AgendaView = views[key] ?? defaultView(inView, split.at);
  const days = useMemo(() => agenda(view === 'upcoming' ? parts.upcoming : parts.past, view), [parts, view]);
  const total = list && !list.error ? inView.length : calendar ? calendar.event_count : ownCount;
  const names = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);

  // While searching, each calendar's line says how many of its events match
  const searching = !!query && !!list && !list.error;
  const matchCounts = useMemo(() => {
    const counts = new Map<number, number>();
    if (searching) {
      for (const e of events) if (matches(query, ...eventMatchFields(e))) counts.set(e.calendar_id, (counts.get(e.calendar_id) ?? 0) + 1);
    }
    return counts;
  }, [events, query, searching]);
  const matchesIn = (ids: (id: number) => boolean) => [...matchCounts].reduce((n, [id, c]) => n + (ids(id) ? c : 0), 0);
  const anyMatch = matchCounts.size > 0;

  useEffect(() => { setLimit(PAGE); setExpanded(null); }, [key, view]);

  function choose(next: Selection) {
    setSelected(next);
  }

  function chooseView(v: AgendaView) {
    setViews(prev => ({ ...prev, [key]: v }));
  }

  function save(format: CalendarSaveFormat) {
    setChoosing(false);
    run(() => saveCalendar(udid, format, calendar ? { calendarId: calendar.id } : {}));
  }

  // The page of days shown: the first `limit` events, whole days where they fit
  const shownDays: AgendaDay[] = [];
  let budget = limit;
  for (const d of days) {
    if (budget <= 0) break;
    shownDays.push(budget >= d.events.length ? d : { ...d, events: d.events.slice(0, budget) });
    budget -= d.events.length;
  }
  const listed = days.reduce((n, d) => n + d.events.length, 0);

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Calendar"
        count={hasEvents
          ? (searching ? `${matching.length} of ${plural(total, 'event')}` : plural(total, 'event'))
          : undefined}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={!hasEvents} label="Save" />}
      />
      {loading && (
        <div className="flex justify-center py-12 text-accent">
          <OrganicLoader size={72} />
        </div>
      )}
      {!loading && !hasEvents && (
        <div className="flex-1 overflow-y-auto">
          <CalendarEmpty emptyReason={emptyReason} error={error} />
        </div>
      )}
      {!loading && hasEvents && (
        <div className="flex-1 flex min-h-0">
          <nav aria-label="Calendars" className="w-[300px] flex-shrink-0 border-r border-rule overflow-y-auto">
            <ListButton
              current={!calendar}
              onClick={() => choose(ALL)}
              dot={null}
              title="All calendars"
              line={searching ? matchCount(matchesIn(id => ownIds.has(id))) : `${plural(ownCount, 'event')} in your calendars`}
            />
            {groups.mine.map(g => (
              <div key={g.key}>
                <div className="hearth-eyebrow px-4 pt-4 pb-1.5">{g.label}</div>
                {g.calendars.map(c => (
                  <ListButton
                    key={c.id}
                    current={calendar?.id === c.id}
                    onClick={() => choose(c.id)}
                    dot={calendarColor(c)}
                    title={calendarName(c)}
                    line={calendarLine(c, searching ? matchesIn(id => id === c.id) : c.event_count, searching)}
                  />
                ))}
              </div>
            ))}
            {groups.others.length > 0 && <div className="hearth-eyebrow px-4 pt-4 pb-1.5">Other calendars</div>}
            {groups.others.map(c => (
              <ListButton
                key={c.id}
                quiet
                current={calendar?.id === c.id}
                onClick={() => choose(c.id)}
                dot={calendarColor(c)}
                title={calendarName(c)}
                line={calendarLine(c, searching ? matchesIn(id => id === c.id) : c.event_count, searching)}
              />
            ))}
          </nav>

          <section aria-label={calendar ? calendarName(calendar) : 'All calendars'} className="flex-1 min-w-0 overflow-y-auto">
            <CalendarHeader
              calendar={calendar}
              ownCalendars={calendars.filter(c => isOwnCalendar(c) && c.event_count > 0).length}
              ownCount={ownCount}
              view={view}
              upcoming={parts.upcoming.length}
              past={parts.past.length}
              counted={!!list && !list.error}
              onView={chooseView}
            />
            <p className="px-8 py-3 text-xs text-text-tertiary border-b border-rule">
              {splitNote(split, inView.some(e => e.recurrence))}
            </p>
            {!list && (
              <div className="flex justify-center py-8 text-accent">
                <OrganicLoader size={56} />
              </div>
            )}
            {list?.error && (
              <EmptyState
                icon={CalendarIcon}
                title="Couldn't read the events"
                detail={<>{list.error}<div><ReportProblemButton error={list.error} area="calendar" className="mt-2" /></div></>}
              />
            )}
            {list && !list.error && listed === 0 && (
              searching && !anyMatch ? (
                <div className="text-center px-8 py-8">
                  <div className="text-sm text-text-primary">{noMatchCopy(query).title}</div>
                  <div className="text-xs text-text-secondary mt-1">{noMatchCopy(query).detail}</div>
                </div>
              ) : (
                <div className="px-8 py-8 text-sm text-text-secondary">{agendaEmptyText(view, searching ? query : '')}</div>
              )
            )}
            {list && !list.error && shownDays.map(d => (
              <div key={d.key}>
                <div className="sticky top-0 z-10 bg-base px-8 py-2 border-b border-rule text-sm font-medium text-text-secondary">
                  {d.label}
                </div>
                <ul>
                  {d.events.map(e => (
                    <EventRow
                      key={e.id}
                      event={e}
                      query={query}
                      open={expanded === e.id}
                      calendar={names.get(e.calendar_id) ?? null}
                      showCalendar={!calendar}
                      onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {list && !list.error && listed > limit && (
              <div className="px-8 py-4">
                <button type="button" className="hearth-ghost-btn" onClick={() => setLimit(n => n + PAGE)}>
                  Show {Math.min(PAGE, listed - limit).toLocaleString()} more of {plural(listed, 'event')}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {choosing && (
        <SaveDialog
          title={calendar ? `Save "${calendarName(calendar)}"` : 'Save every calendar'}
          formats={[FORMATS.ics, FORMATS.csv]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** Why the screen has no events: calm when there are none, the error and a Report button when they can't be read. */
function CalendarEmpty({ emptyReason, error }: { emptyReason: string | null; error: string | null }) {
  const copy = emptyCopy(emptyReason, error);
  const report = copy.kind !== 'empty';
  return (
    <EmptyState
      icon={CalendarIcon}
      title={copy.title}
      detail={copy.detail || report ? (
        <>
          {copy.detail}
          {report && <div><ReportProblemButton error={error || copy.title} area="calendar" className="mt-2" /></div>}
        </>
      ) : undefined}
    />
  );
}

function ListButton({ current, onClick, dot, title, line, quiet = false }: {
  current: boolean;
  onClick: () => void;
  /** The calendar's colour; null for All calendars, which gets the Calendar icon. */
  dot: string | null;
  title: string;
  line?: string;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      className={`w-full px-4 py-3 flex items-center gap-3 text-left border-b border-rule transition-colors ${
        current ? 'bg-accent-wash' : 'hover:bg-surface'
      }`}
    >
      {dot === null ? (
        <span className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-accent-wash text-accent">
          <CalendarIcon size={18} />
        </span>
      ) : (
        <span className="w-9 h-9 flex items-center justify-center flex-shrink-0">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: dot }} />
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-medium truncate ${quiet ? 'text-text-secondary' : 'text-text-primary'}`}>{title}</span>
        {line && <span className="block text-xs text-text-tertiary truncate mt-0.5">{line}</span>}
      </span>
    </button>
  );
}

function CalendarHeader({ calendar, ownCalendars, ownCount, view, upcoming, past, counted, onView }: {
  calendar: Calendar | null;
  ownCalendars: number;
  ownCount: number;
  view: AgendaView;
  upcoming: number;
  past: number;
  /** The events have been read, so the Upcoming and Past counts are known. */
  counted: boolean;
  onView: (view: AgendaView) => void;
}) {
  // As the home tile counts them: only calendars with events (every iPhone has an empty Default)
  const facts = calendar ? calendarFacts(calendar) : [ownCount ? `${plural(ownCount, 'event')} in ${plural(ownCalendars, 'calendar')}` : 'No events in your calendars'];
  return (
    <div className="px-8 pt-6 pb-4 border-b border-rule">
      <div className="flex items-start gap-4">
        <span className="w-14 h-14 rounded-xl bg-accent-wash text-accent flex items-center justify-center flex-shrink-0">
          {calendar ? <span className="w-5 h-5 rounded-full" style={{ backgroundColor: calendarColor(calendar) }} /> : <CalendarIcon size={28} />}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl text-text-primary">{calendar ? calendarName(calendar) : 'All calendars'}</h2>
          <div className="text-sm text-text-tertiary mt-1">{facts.join(' · ')}</div>
        </div>
      </div>
      {calendar?.subscription_url && (
        <div className="mt-4">
          <div className="text-xs text-text-tertiary">Subscription address</div>
          <div className="text-sm text-text-secondary break-all select-all">{calendar.subscription_url}</div>
        </div>
      )}
      <div role="group" aria-label="Which events" className="mt-4 inline-flex rounded-full border border-rule bg-surface p-0.5">
        {(['upcoming', 'past'] as const).map(v => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={`px-3.5 py-1 rounded-full text-sm transition-colors ${
              view === v ? 'bg-accent-wash text-accent font-medium' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {v === 'upcoming' ? 'Upcoming' : 'Past'}
            {counted && <> <span className="tabular-nums">{(v === 'upcoming' ? upcoming : past).toLocaleString()}</span></>}
          </button>
        ))}
      </div>
    </div>
  );
}

function EventRow({ event, query, open, calendar, showCalendar, onToggle }: {
  event: CalendarEvent;
  query: string;
  open: boolean;
  calendar: Calendar | null;
  /** In All calendars, each row shows its calendar's colour. */
  showCalendar: boolean;
  onToggle: () => void;
}) {
  const chips = eventChips(event, open);
  const place = placeLine(event);
  const cancelled = event.status === 'cancelled';
  return (
    <li className="border-b border-rule">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full px-8 py-3.5 flex items-start gap-4 text-left hover:bg-surface transition-colors"
      >
        <span className="w-[150px] flex-shrink-0 text-sm text-text-secondary tabular-nums pt-0.5">{timeText(event)}</span>
        {showCalendar && (
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-2"
            style={{ backgroundColor: calendarColor(calendar) }}
            title={calendarName(calendar)}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className={`text-[16px] font-medium ${cancelled ? 'text-text-tertiary line-through' : 'text-text-primary'}`}>
            <Highlight text={eventName(event)} query={query} />
          </div>
          {place && <div className="text-sm text-text-secondary truncate"><Highlight text={place} query={query} /></div>}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {chips.map(c => (
                <span key={c} className="px-2 py-0.5 rounded-full bg-sand text-xs text-text-secondary">{c}</span>
              ))}
            </div>
          )}
        </div>
        <ChevronDown size={20} className={`text-text-tertiary transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <EventDetails event={event} query={query} calendar={calendar} />}
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-text-tertiary">{label}</div>
      <div className="text-sm text-text-primary">{children}</div>
    </div>
  );
}

function EventDetails({ event, query, calendar }: { event: CalendarEvent; query: string; calendar: Calendar | null }) {
  const zone = zoneNote(event);
  const repeats = repeatText(event);
  const skipped = skippedText(event);
  const changed = changedText(event);
  const place = placeLines(event);
  const link = webAddress(event.url);
  const meeting = webAddress(event.conference_url);
  const organizer = organizerText(event.organizer);
  // An all-day event's alerts are a time of day ("On the day at 9:00 AM")
  const alerts = (event.alarms ?? []).map(a => alertText(a, event.all_day));
  return (
    <div className="pl-[198px] pr-8 pb-5 flex flex-col gap-3 max-w-4xl">
      <Fact label="When">
        {whenText(event)}
        {zone && <div className="text-xs text-text-tertiary mt-0.5">{zone}</div>}
      </Fact>
      {(repeats || skipped || changed) && (
        <Fact label="Repeats">
          {[repeats, changed, skipped].filter(Boolean).map(t => <div key={t!}>{t}</div>)}
        </Fact>
      )}
      {place.length > 0 && (
        <Fact label="Where">
          {place.map(p => <div key={p}><Highlight text={p} query={query} /></div>)}
        </Fact>
      )}
      {(link || meeting) && (
        <div className="flex flex-wrap gap-2">
          {meeting && (
            <button type="button" className="hearth-ghost-btn !px-3 !py-1.5" onClick={() => window.openextract.openExternal(meeting)}>
              Open the meeting link
            </button>
          )}
          {link && link !== meeting && (
            <button type="button" className="hearth-ghost-btn !px-3 !py-1.5" onClick={() => window.openextract.openExternal(link)}>
              Open the event's link
            </button>
          )}
        </div>
      )}
      {(organizer || event.attendees.length > 0) && (
        <Fact label="People">
          {organizer && <div className="text-text-secondary">{organizer}</div>}
          {event.attendees.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {event.attendees.map((a, i) => (
                <li key={`${a.email ?? a.name ?? ''}-${i}`} className="flex flex-wrap gap-x-2">
                  <span><Highlight text={personName(a)} query={query} />{a.is_me ? ' (you)' : ''}</span>
                  {a.name && a.email && <span className="text-text-tertiary"><Highlight text={a.email} query={query} /></span>}
                  {answerText(a.status) && <span className="text-text-secondary">· {answerText(a.status)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Fact>
      )}
      {alerts.length > 0 && <Fact label={alerts.length === 1 ? 'Alert' : 'Alerts'}>{alerts.join(', ')}</Fact>}
      {event.availability === 'free' && <Fact label="Show as">Free</Fact>}
      {event.notes?.trim() && (
        <Fact label="Notes">
          <div className="whitespace-pre-wrap"><Highlight text={event.notes.trim()} query={query} /></div>
        </Fact>
      )}
      <Fact label="Calendar">
        <span className="inline-flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: calendarColor(calendar) }} />
          {calendarName(calendar)}
        </span>
      </Fact>
    </div>
  );
}
