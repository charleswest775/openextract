import { TimelineEntryType, TimelineFilters } from '../../types/timeline';
import TimelineTypeChips from './TimelineTypeChips';
import DateRange from '../shared/DateRange';

interface Props {
  filters: TimelineFilters;
  /** Of each kind, how many the dates and search leave. */
  counts: Record<TimelineEntryType, number>;
  /** Of each kind, how many the whole backup has. */
  totals: Record<TimelineEntryType, number>;
  onFiltersChange: (patch: Partial<TimelineFilters>) => void;
}

// The page header holds the Timeline's search; this bar holds the kind and date filters.
export default function TimelineFilterBar({ filters, counts, totals, onFiltersChange }: Props) {
  function toggleType(type: TimelineEntryType) {
    const next = new Set(filters.types);
    if (next.has(type)) {
      if (next.size === 1) return; // keep at least one active
      next.delete(type);
    } else {
      next.add(type);
    }
    onFiltersChange({ types: next });
  }

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-default)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '10px 24px',
        flexShrink: 0,
      }}
    >
      <TimelineTypeChips active={filters.types} counts={counts} totals={totals} onToggle={toggleType} />
      <DateRange
        from={filters.dateFrom}
        to={filters.dateTo}
        onChange={({ from, to }) => onFiltersChange({ dateFrom: from, dateTo: to })}
      />
    </div>
  );
}
