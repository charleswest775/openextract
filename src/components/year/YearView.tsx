import { useMemo, useState, KeyboardEvent, FocusEvent, MouseEvent } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { DayCounts, useYearCounts, useYearPeople } from '../../hooks/useYearCounts';
import { TimelineEntryType, TimelineFilters } from '../../types/timeline';
import { identifiersForPerson } from '../../lib/people';
import { buildYearGrid, formatDay, shadeLevels } from '../../lib/yearGrid';
import TimelineTypeChips, { TYPE_CONFIG } from '../timeline/TimelineTypeChips';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import { CalendarIcon } from '../shared/Icons';
import { plural } from '../../lib/saveData';
import ContactPicker from '../timeline/ContactPicker';
import OrganicLoader from '../shared/OrganicLoader';

export interface YearSelection {
  year: number | null;                 // null = not chosen yet: the latest the backup holds
  types: Set<TimelineEntryType>;
  contactIdentifier: string;           // empty string = all
  identifiers: string[] | null;        // all of that person's phone numbers and emails
}

export const DEFAULT_YEAR_SELECTION: YearSelection = {
  year: null,
  types: new Set(['message', 'call', 'photo', 'voicemail', 'note', 'browser']),
  contactIdentifier: '',
  identifiers: null,
};

interface Props {
  udid: string;
  selection: YearSelection;
  onSelectionChange: React.Dispatch<React.SetStateAction<YearSelection>>;
  onOpenDay: (filters: Partial<TimelineFilters>) => void;
}

// Photos, notes and web visits aren't tied to anyone.
const PERSON_TYPES = new Set<TimelineEntryType>(['message', 'call', 'voicemail']);
const NOT_PERSON_TYPES = new Set<TimelineEntryType>(['photo', 'note', 'browser']);

const COUNT_WORDS: Record<TimelineEntryType, [string, string]> = {
  message:   ['message', 'messages'],
  whatsapp:  ['WhatsApp message', 'WhatsApp messages'],
  call:      ['call', 'calls'],
  photo:     ['photo', 'photos'],
  voicemail: ['voicemail', 'voicemails'],
  note:      ['note', 'notes'],
  browser:   ['web visit', 'web visits'],
};

const LABELS = Object.fromEntries(TYPE_CONFIG.map(t => [t.type, t.label])) as Record<TimelineEntryType, string>;

// One hue, darker the more happened. Index 0 is a day with nothing on it.
const SHADES = ['var(--bg-elevated)', '#efbfa2', '#e4977a', '#d0694a', '#99432a'];
const NOT_IN_BACKUP = 'repeating-linear-gradient(135deg, var(--border-strong) 0 1px, transparent 1px 3px)';

const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

function describeCounts(counts: DayCounts | undefined, types: Set<TimelineEntryType>): string[] {
  const parts: string[] = [];
  for (const { type } of TYPE_CONFIG) {
    const n = types.has(type) ? counts?.[type] ?? 0 : 0;
    if (n > 0) parts.push(`${n.toLocaleString()} ${COUNT_WORDS[type][n === 1 ? 0 : 1]}`);
  }
  return parts;
}

export default function YearView({ udid, selection, onSelectionChange, onOpenDay }: Props) {
  const { year, types, contactIdentifier, identifiers } = selection;
  const update = (patch: Partial<YearSelection>) => onSelectionChange(current => ({ ...current, ...patch }));

  const { counts, error, loading } = useYearCounts(udid, year, identifiers, chosen => update({ year: chosen }));
  const people = useYearPeople(udid);

  const [hover, setHover] = useState<{ day: string; left: number; top: number } | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);

  const person = contactIdentifier !== '';
  const shownTypes = useMemo(
    () => new Set([...types].filter(t => !person || PERSON_TYPES.has(t))),
    [types, person],
  );

  const grid = useMemo(() => (counts ? buildYearGrid(counts.year) : null), [counts?.year]);

  const totals = useMemo(() => {
    // The engine doesn't count WhatsApp by day yet, so its chip stays hidden here (and out of the selection above)
    const out: Record<TimelineEntryType, number> = { message: 0, whatsapp: 0, call: 0, photo: 0, voicemail: 0, note: 0, browser: 0 };
    for (const day of Object.values(counts?.days ?? {})) {
      for (const { type } of TYPE_CONFIG) out[type] += day[type] ?? 0;
    }
    return out;
  }, [counts]);

  const dayTotal = (day: string) => {
    let n = 0;
    for (const t of shownTypes) n += counts?.days[day]?.[t] ?? 0;
    return n;
  };

  const shade = useMemo(
    () => shadeLevels(grid ? grid.cells.map(c => dayTotal(c.day)) : []),
    [grid, counts, shownTypes],
  );
  const yearTotal = grid ? grid.cells.reduce((sum, c) => sum + dayTotal(c.day), 0) : 0;

  // Messages before this are "not in this backup", not quiet. Only says so with
  // Messages showing: the other types aren't bound by where messages start.
  const start = counts?.history_start && shownTypes.has('message') ? counts.history_start : null;
  const end = counts?.history_end ?? null;
  const beforeStart = (day: string) => start !== null && day < start;
  const afterEnd = (day: string) => end !== null && day > end;

  const shownYear = counts?.year ?? null;
  const startCell = start && grid?.cells.find(c => c.day === start);
  // Nothing to mark when the backup does reach Jan 1 of the year showing.
  const startMark = startCell && !start!.endsWith('-01-01') ? startCell : null;

  function describeDay(day: string): string {
    const label = formatDay(day);
    const parts = describeCounts(counts?.days[day], shownTypes);
    if (afterEnd(day) && parts.length === 0) return `${label}: after this backup was made`;
    if (beforeStart(day)) {
      return parts.length
        ? `${label}: ${parts.join(', ')}; messages not in this backup`
        : `${label}: not in this backup`;
    }
    return parts.length ? `${label}: ${parts.join(', ')}` : `${label}: nothing`;
  }

  function toggleType(type: TimelineEntryType) {
    const next = new Set(types);
    if (next.has(type)) {
      const showing = [...next].filter(t => !person || PERSON_TYPES.has(t));
      if (showing.length === 1 && showing[0] === type) return; // keep at least one active
      next.delete(type);
    } else {
      next.add(type);
    }
    update({ types: next });
  }

  function pickPerson(identifier: string) {
    if (!identifier) {
      update({ contactIdentifier: '', identifiers: null });
      return;
    }
    // With only Photos on, a person would show nothing at all.
    const hasPersonType = [...types].some(t => PERSON_TYPES.has(t));
    update({
      contactIdentifier: identifier,
      identifiers: identifiersForPerson(
        identifier, people?.rows ?? [], people?.options ?? [], people?.groups ?? new Map(),
      ),
      types: hasPersonType ? types : new Set([...types, ...PERSON_TYPES]),
    });
  }

  function openDay(day: string) {
    if (dayTotal(day) === 0) return;
    onOpenDay({
      dateFrom: day,
      dateTo: day,
      types: new Set(shownTypes),
      contactIdentifier,
    });
  }

  function showTip(e: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>, day: string) {
    const cell = e.currentTarget.getBoundingClientRect();
    const box = e.currentTarget.closest('[data-year-grid]')!.getBoundingClientRect();
    setHover({ day, left: cell.left + cell.width / 2 - box.left, top: cell.top - box.top });
  }

  // Arrow keys move between days, so the grid is one tab stop instead of 365.
  function moveFocus(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!step || !grid) return;
    e.preventDefault();
    const next = grid.cells[index + step];
    if (!next) return;
    setFocusDay(next.day);
    e.currentTarget.closest('[data-year-grid]')
      ?.querySelector<HTMLButtonElement>(`[data-day="${next.day}"]`)
      ?.focus();
  }

  const typeErrors = Object.entries(counts?.errors ?? {}) as [TimelineEntryType, string][];
  const noData = counts !== null && counts.years.length === 0 && typeErrors.length === 0;
  const tabStop = focusDay && grid?.cells.some(c => c.day === focusDay) ? focusDay : grid?.cells[0]?.day;
  const columns = grid?.columns ?? 53;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageHeader
        title="Year"
        count={counts && shownYear !== null ? `${shownYear} · ${plural(yearTotal, 'event')}` : undefined}
      />

      {/* Filters */}
      <div style={{
        borderBottom: '1px solid var(--border-default)',
        padding: '12px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        flexShrink: 0,
      }}>
        <FilterRow label="Year">
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {(counts?.years ?? []).map(y => (
              <button
                key={y}
                onClick={() => update({ year: y })}
                aria-pressed={y === year}
                style={{
                  height: 34,
                  padding: '0 14px',
                  borderRadius: 999,
                  border: `1.5px solid ${y === year ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: y === year ? 'var(--accent-wash)' : 'transparent',
                  color: y === year ? 'var(--text-accent)' : 'var(--text-secondary)',
                  fontWeight: y === year ? 600 : 400,
                  fontSize: 14,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {y}
              </button>
            ))}
            {loading && <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-tertiary)', marginLeft: 4 }} />}
          </div>
        </FilterRow>
        <FilterRow label="Type">
          <TimelineTypeChips
            active={types}
            counts={totals}
            onToggle={toggleType}
            unavailable={person ? NOT_PERSON_TYPES : undefined}
            unavailableReason="Photos, notes and web visits aren't tied to a person"
          />
        </FilterRow>
        <FilterRow label="Who">
          <ContactPicker value={contactIdentifier} options={people?.options ?? []} onChange={pickPerson} />
        </FilterRow>
      </div>

      {/* Errors */}
      {(error || typeErrors.length > 0) && (
        <div style={{ flexShrink: 0, padding: '6px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {error && <ErrorLine text={error} />}
          {typeErrors.map(([type, msg]) => <ErrorLine key={type} text={`${LABELS[type]}: ${msg}`} />)}
        </div>
      )}

      {/* First load */}
      {!counts && loading && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div className="text-accent"><OrganicLoader size={72} /></div>
          <div className="hearth-eyebrow">Counting your year</div>
        </div>
      )}

      {/* Nothing dated at all */}
      {noData && (
        <div style={{ flex: 1 }}>
          <EmptyState
            icon={CalendarIcon}
            title="No dated activity in this backup"
            detail="Messages, calls, photos, voicemail, notes and web visits would show here."
          />
        </div>
      )}

      {/* The grid */}
      {counts && grid && !noData && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
          <div style={{ overflowX: 'auto' }}>
            <div
              data-year-grid
              role="grid"
              aria-label={`Activity in ${counts.year}, one square per day`}
              onMouseLeave={() => setHover(null)}
              style={{
                position: 'relative',
                display: 'grid',
                gridTemplateColumns: `28px repeat(${columns}, minmax(9px, 1fr))`,
                columnGap: 2,
                rowGap: 2,
                maxWidth: 1200,
                minWidth: 28 + columns * 11,
                paddingBottom: 2,
              }}
            >
              {/* "History starts here" sits above the week it falls in */}
              <div style={{ gridRow: 1, gridColumn: `1 / ${columns + 2}`, height: 18, position: 'relative' }}>
                {startMark && (
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    ...(startMark.col < columns / 2
                      ? { left: `calc(28px + ${startMark.col} * (100% - 28px) / ${columns})` }
                      : { right: `calc((${columns - 1 - startMark.col}) * (100% - 28px) / ${columns})` }),
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap',
                  }}>
                    History starts here · {formatDay(start!)}
                  </div>
                )}
              </div>

              {grid.months.map(m => (
                <div key={m.col} style={{
                  gridRow: 2,
                  gridColumn: `${m.col + 2} / span 4`,
                  fontSize: 13,
                  color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                }}>
                  {m.label}
                </div>
              ))}

              {WEEKDAYS.map((label, row) => (
                <div key={row} style={{
                  gridRow: row + 3,
                  gridColumn: 1,
                  fontSize: 12,
                  lineHeight: 1,
                  color: 'var(--text-tertiary)',
                  alignSelf: 'center',
                }}>
                  {label}
                </div>
              ))}

              {grid.cells.map((cell, index) => {
                const total = dayTotal(cell.day);
                const missing = total === 0 && (beforeStart(cell.day) || afterEnd(cell.day));
                const label = describeDay(cell.day);
                const isStart = cell.day === startMark?.day;
                return (
                  <button
                    key={cell.day}
                    data-day={cell.day}
                    aria-label={label}
                    aria-disabled={total === 0}
                    tabIndex={cell.day === tabStop ? 0 : -1}
                    onClick={() => openDay(cell.day)}
                    onMouseEnter={e => showTip(e, cell.day)}
                    onFocus={e => { setFocusDay(cell.day); showTip(e, cell.day); }}
                    onBlur={() => setHover(null)}
                    onKeyDown={e => moveFocus(e, index)}
                    style={{
                      gridRow: cell.row + 3,
                      gridColumn: cell.col + 2,
                      aspectRatio: '1',
                      minWidth: 0,
                      padding: 0,
                      border: 'none',
                      borderRadius: 3,
                      backgroundColor: missing ? 'transparent' : SHADES[total > 0 ? shade(total) : 0],
                      backgroundImage: missing ? NOT_IN_BACKUP : undefined,
                      boxShadow: isStart ? '0 0 0 1.5px var(--text-primary)' : undefined,
                      zIndex: isStart ? 1 : undefined,
                      cursor: total > 0 ? 'pointer' : 'default',
                    }}
                  />
                );
              })}

              {hover && (
                <div
                  role="tooltip"
                  style={{
                    position: 'absolute',
                    left: `clamp(120px, ${hover.left}px, calc(100% - 120px))`,
                    top: hover.top - 6,
                    transform: 'translate(-50%, -100%)',
                    zIndex: 20,
                    padding: '5px 9px',
                    borderRadius: 6,
                    background: 'var(--text-primary)',
                    color: 'var(--bg-surface)',
                    fontSize: 14,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  {describeDay(hover.day)}
                </div>
              )}
            </div>
          </div>

          {/* Legend */}
          <div style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 18px',
            marginTop: 14, maxWidth: 1200, fontSize: 13, color: 'var(--text-secondary)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ marginRight: 3 }}>Less</span>
              {SHADES.map(color => <span key={color} style={{ ...swatch, backgroundColor: color }} />)}
              <span style={{ marginLeft: 3 }}>More</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ ...swatch, backgroundImage: NOT_IN_BACKUP }} />
              Not in this backup
            </div>
            <span style={{ color: 'var(--text-tertiary)' }}>Click a day to open it in the Timeline</span>
          </div>

          <HistoryNote year={counts.year} start={start} end={end} />
        </div>
      )}
    </div>
  );
}

// Says in words what the hatched squares mean for the year showing.
function HistoryNote({ year, start, end }: { year: number; start: string | null; end: string | null }) {
  const lines: string[] = [];
  if (start && start > `${year}-12-31`) {
    lines.push(`This backup has no messages from ${year}. Its messages start on ${formatDay(start, true)}; older ones may be kept only in iCloud.`);
  } else if (start && start.startsWith(String(year)) && !start.endsWith('-01-01')) {
    lines.push(`This backup's messages start on ${formatDay(start, true)}. Older ones may be kept only in iCloud, so earlier days aren't quiet, they're just not here.`);
  }
  if (end && end.startsWith(String(year)) && !end.endsWith('-12-31')) {
    lines.push(`This backup was made on ${formatDay(end, true)}, so it holds nothing later.`);
  }
  if (lines.length === 0) return null;
  return (
    <div style={{ marginTop: 12, maxWidth: 720, fontSize: 14, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
      {lines.map(line => <div key={line}>{line}</div>)}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ width: 48, flexShrink: 0 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', borderRadius: 6,
      background: 'rgba(255,59,48,0.08)', border: '0.5px solid rgba(255,59,48,0.2)',
      fontSize: 14, color: 'var(--text-secondary)',
    }}>
      <AlertTriangle size={16} style={{ color: 'var(--error)', flexShrink: 0 }} />
      {text}
    </div>
  );
}

const swatch: React.CSSProperties = { display: 'inline-block', width: 11, height: 11, borderRadius: 2 };
