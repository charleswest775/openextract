import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { saveFolder } from '../../lib/ipc';
import { ExportIcon, SearchIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import NoticeBanners, { type ExportStatus } from '../shared/NoticeBanners';
import {
  eventDayKey,
  eventStart,
  formatEventWhen,
  formatPerson,
  type CalendarEvent,
  type CalendarInfo,
} from '../../lib/calendarEvents';

interface Props {
  udid: string;
}

const PAGE_SIZE = 400;
const FALLBACK_COLOR = '#94a3b8';

interface DayGroup {
  key: string;
  date: Date;
  events: CalendarEvent[];
}

interface MonthGroup {
  label: string;
  days: DayGroup[];
}

/** Events arrive newest first; group them by month, then by day. */
function groupEvents(events: CalendarEvent[]): MonthGroup[] {
  const months: MonthGroup[] = [];
  for (const ev of events) {
    const date = eventStart(ev);
    const monthLabel = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    let month = months[months.length - 1];
    if (!month || month.label !== monthLabel) {
      month = { label: monthLabel, days: [] };
      months.push(month);
    }
    const key = eventDayKey(ev);
    let day = month.days[month.days.length - 1];
    if (!day || day.key !== key) {
      day = { key, date, events: [] };
      month.days.push(day);
    }
    day.events.push(ev);
  }
  return months;
}

function matchesSearch(ev: CalendarEvent, q: string): boolean {
  if (!q) return true;
  return [
    ev.title, ev.location, ev.address, ev.notes, ev.calendar,
    ...ev.attendees.map(formatPerson),
    ev.organizer ? formatPerson(ev.organizer) : '',
  ].some(v => v?.toLowerCase().includes(q));
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <div className="w-20 flex-shrink-0 text-gray-400">{label}</div>
      <div className="flex-1 min-w-0 text-gray-700 break-words">{children}</div>
    </div>
  );
}

function EventDetails({ ev }: { ev: CalendarEvent }) {
  const fullDate = eventStart(ev).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const place = [ev.location, ev.address && ev.address !== ev.location ? ev.address : null]
    .filter(Boolean).join(', ');
  return (
    <div className="mt-2 mb-1 space-y-1.5 select-text">
      <Detail label="When">
        {fullDate} · {formatEventWhen(ev)}
        {ev.timezone && <span className="text-gray-400"> ({ev.timezone})</span>}
      </Detail>
      {ev.recurring && (
        <Detail label="Repeats">
          Shown on its first date. Later occurrences aren't listed yet.
        </Detail>
      )}
      <Detail label="Calendar">
        {[ev.calendar, ev.account].filter(Boolean).join(' · ') || '—'}
      </Detail>
      {place && <Detail label="Location">{place}</Detail>}
      {ev.organizer && <Detail label="Organizer">{formatPerson(ev.organizer)}</Detail>}
      {ev.attendees.length > 0 && (
        <Detail label="Invitees">{ev.attendees.map(formatPerson).join(', ')}</Detail>
      )}
      {ev.conference_url && <Detail label="Meeting">{ev.conference_url}</Detail>}
      {ev.url && <Detail label="URL">{ev.url}</Detail>}
      {ev.notes && (
        <Detail label="Notes"><div className="whitespace-pre-wrap">{ev.notes}</div></Detail>
      )}
    </div>
  );
}

export default function CalendarExplorer({ udid }: Props) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useState<Set<number | null>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<ExportStatus | null>(null);

  useEffect(() => {
    loadEvents();
  }, [udid]);

  async function loadEvents() {
    setLoading(true);
    setHidden(new Set());
    setExpanded(null);
    try {
      const res = await window.openextract.call('list_calendar_events', { udid });
      if (res.success && res.data) {
        setEvents(res.data.events || []);
        setCalendars(res.data.calendars || []);
        setErrors((res.data.errors || []).map((e: { message: string }) => e.message));
      } else {
        setErrors([res.error || "Couldn't load calendar events."]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    const outputDir = await saveFolder();
    if (!outputDir) return;
    setExporting(true);
    setStatus(null);
    try {
      const res = await window.openextract.call('export_calendar', {
        udid,
        output_dir: `${outputDir}/Calendar`,
      });
      const data = res.success ? res.data : null;
      if (data?.success) {
        window.openextract.incrementExportCount();
        const files = data.files.length;
        const repeats = data.recurring
          ? ` ${data.recurring} repeating event${data.recurring === 1 ? ' was' : 's were'} exported as a single event — OpenExtract can't read repeat rules yet.`
          : '';
        setStatus({
          ok: true,
          text: `Exported ${data.count} events to ${files} calendar file${files === 1 ? '' : 's'} in ${data.path}.${repeats}`,
        });
      } else {
        setStatus({ ok: false, text: data?.error || res.error || 'Export failed.' });
      }
    } finally {
      setExporting(false);
    }
  }

  function toggleCalendar(id: number) {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setLimit(PAGE_SIZE);
  }

  const calendarsWithEvents = calendars.filter(c => c.event_count > 0);
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () => events.filter(ev => !hidden.has(ev.calendar_id) && matchesSearch(ev, q)),
    [events, hidden, q],
  );
  const groups = useMemo(() => groupEvents(filtered.slice(0, limit)), [filtered, limit]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 bg-base" style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
        <div>
          <div className="hearth-eyebrow mb-1.5">
            Calendar{events.length > 0 && ` · ${events.length.toLocaleString()} events`}
          </div>
          <h1 className="hearth-title text-3xl">
            Days you <span className="font-serif-italic text-accent">planned.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search events..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setLimit(PAGE_SIZE); }}
              className="pl-8 pr-3 py-1.5 text-sm bg-gray-50 rounded-md border border-gray-200 focus:outline-none focus:border-emerald-400 w-48"
            />
          </div>
          <button onClick={handleExport} disabled={exporting || events.length === 0} className="hearth-ghost-btn" title="Export as iCalendar (.ics) and CSV">
            <ExportIcon size={13} />
            {exporting ? 'Exporting…' : 'Export .ics'}
          </button>
        </div>
      </div>

      {calendarsWithEvents.length > 1 && (
        <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-1.5 flex-shrink-0">
          {calendarsWithEvents.map(cal => {
            const off = hidden.has(cal.id);
            return (
              <button
                key={cal.id}
                onClick={() => toggleCalendar(cal.id)}
                title={[cal.title, cal.account].filter(Boolean).join(' · ')}
                className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border transition-opacity ${
                  off ? 'opacity-40 border-gray-200' : 'border-gray-200 bg-white'
                }`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: cal.color ?? FALLBACK_COLOR }} />
                <span className="text-gray-700">{cal.title}</span>
                <span className="text-gray-400">{cal.event_count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      )}

      <NoticeBanners errors={errors} status={status} />

      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && events.length === 0 && errors.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No calendar events found in this backup</div>
        )}
        {!loading && events.length > 0 && filtered.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No events match your filters</div>
        )}
        {!loading && groups.map(month => (
          <section key={month.label}>
            <h2 className="sticky top-0 z-10 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100">
              {month.label}
            </h2>
            {month.days.map(day => (
              <div key={day.key} className="flex border-b border-gray-100">
                <div className="w-16 flex-shrink-0 px-4 py-3 text-center">
                  <div className="text-[10px] uppercase text-gray-400">
                    {day.date.toLocaleDateString(undefined, { weekday: 'short' })}
                  </div>
                  <div className="text-lg font-medium text-gray-800 leading-tight">{day.date.getDate()}</div>
                </div>
                <div className="flex-1 min-w-0 py-1.5 pr-4">
                  {day.events.map(ev => {
                    const isOpen = expanded === ev.id;
                    return (
                      <div key={ev.id} className="py-1">
                        <button
                          onClick={() => setExpanded(isOpen ? null : ev.id)}
                          className="w-full flex items-start gap-2.5 text-left rounded-md px-2 py-1.5 hover:bg-gray-50 transition-colors"
                        >
                          <span className="w-1 self-stretch rounded-full flex-shrink-0" style={{ background: ev.calendar_color ?? FALLBACK_COLOR }} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900 truncate">{ev.title || 'Untitled event'}</span>
                              {ev.recurring && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 flex-shrink-0">Repeats</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 truncate">
                              {formatEventWhen(ev)}
                              {ev.location && ` · ${ev.location}`}
                            </div>
                          </div>
                        </button>
                        {isOpen && <div className="pl-5"><EventDetails ev={ev} /></div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        ))}
        {!loading && filtered.length > limit && (
          <div className="flex justify-center py-4">
            <button onClick={() => setLimit(l => l + PAGE_SIZE)} className="hearth-ghost-btn">
              Show more ({(filtered.length - limit).toLocaleString()} older)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
