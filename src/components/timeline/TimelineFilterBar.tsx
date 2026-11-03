import { useRef, useEffect, useCallback } from 'react';
import { Search } from 'lucide-react';
import { TimelineEntryType, TimelineFilters, ContactOption } from '../../types/timeline';
import TimelineTypeChips from './TimelineTypeChips';
import ContactPicker from './ContactPicker';

interface Props {
  filters: TimelineFilters;
  counts: Record<TimelineEntryType, number>;
  allContacts: ContactOption[];
  onFiltersChange: (patch: Partial<TimelineFilters>) => void;
}

export default function TimelineFilterBar({ filters, counts, allContacts, onFiltersChange }: Props) {
  // Debounced search
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((val: string) => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      onFiltersChange({ searchQuery: val });
    }, 300);
  }, [onFiltersChange]);

  useEffect(() => {
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, []);

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
        background: 'var(--bg-surface)',
        borderBottom: '0.5px solid var(--border-default)',
        padding: '10px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        flexShrink: 0,
      }}
    >
      {/* Row 1: Type toggles */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ width: '44px', flexShrink: 0 }}>
          Type
        </span>
        <TimelineTypeChips active={filters.types} counts={counts} onToggle={toggleType} />
      </div>

      {/* Row 2: Contact + Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ width: '44px', flexShrink: 0 }}>
          Who
        </span>

        <ContactPicker
          value={filters.contactIdentifier}
          options={allContacts}
          onChange={contactIdentifier => onFiltersChange({ contactIdentifier })}
        />

        <span style={{ width: 16 }} />
        <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ flexShrink: 0 }}>
          Date
        </span>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={e => onFiltersChange({ dateFrom: e.target.value })}
          style={inputStyle}
        />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>to</span>
        <input
          type="date"
          value={filters.dateTo}
          onChange={e => onFiltersChange({ dateTo: e.target.value })}
          style={inputStyle}
        />
      </div>

      {/* Row 3: Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ width: '44px', flexShrink: 0 }}>
          Search
        </span>
        <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }} />
          <input
            type="search"
            placeholder="Search timeline…"
            defaultValue={filters.searchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 28, width: '100%' }}
          />
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 28,
  padding: '0 8px',
  border: '0.5px solid var(--border-strong)',
  borderRadius: 6,
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'inherit',
  outline: 'none',
};
