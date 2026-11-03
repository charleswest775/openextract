import { TimelineEntryType, TimelineFilters, ContactOption } from '../../types/timeline';
import TimelineTypeChips from './TimelineTypeChips';
import ContactPicker from './ContactPicker';

interface Props {
  filters: TimelineFilters;
  counts: Record<TimelineEntryType, number>;
  allContacts: ContactOption[];
  onFiltersChange: (patch: Partial<TimelineFilters>) => void;
}

// The page header holds the Timeline's search; this bar holds the kind, person and date filters.
export default function TimelineFilterBar({ filters, counts, allContacts, onFiltersChange }: Props) {
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
        flexDirection: 'column',
        gap: '10px',
        flexShrink: 0,
      }}
    >
      <TimelineTypeChips active={filters.types} counts={counts} onToggle={toggleType} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <ContactPicker
          value={filters.contactIdentifier}
          options={allContacts}
          onChange={contactIdentifier => onFiltersChange({ contactIdentifier })}
        />
        <span style={{ width: 8 }} />
        <label style={labelStyle}>
          From
          <input
            type="date"
            value={filters.dateFrom}
            onChange={e => onFiltersChange({ dateFrom: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          to
          <input
            type="date"
            value={filters.dateTo}
            onChange={e => onFiltersChange({ dateTo: e.target.value })}
            style={inputStyle}
          />
        </label>
        {(filters.dateFrom || filters.dateTo) && (
          <button
            onClick={() => onFiltersChange({ dateFrom: '', dateTo: '' })}
            className="text-sm text-accent hover:underline"
          >
            Any date
          </button>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 14,
  color: 'var(--text-secondary)',
};

const inputStyle: React.CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid var(--border-default)',
  borderRadius: 10,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
