import { useState, useRef, useEffect, useCallback } from 'react';
import { Search } from 'lucide-react';
import { TimelineEntryType, TimelineFilters, ContactOption } from '../../types/timeline';

const TYPE_CONFIG: { type: TimelineEntryType; label: string; color: string }[] = [
  { type: 'message',   label: 'Messages',  color: '#007AFF' },
  { type: 'call',      label: 'Calls',     color: '#30d158' },
  { type: 'photo',     label: 'Photos',    color: '#AF52DE' },
  { type: 'voicemail', label: 'Voicemail', color: '#ff9f0a' },
  { type: 'note',      label: 'Notes',     color: '#5AC8FA' },
  { type: 'browser',   label: 'Web',       color: '#34C759' },
];

interface Props {
  filters: TimelineFilters;
  counts: Record<TimelineEntryType, number>;
  allContacts: ContactOption[];
  onFiltersChange: (patch: Partial<TimelineFilters>) => void;
}

export default function TimelineFilterBar({ filters, counts, allContacts, onFiltersChange }: Props) {
  const [contactSearch, setContactSearch] = useState('');
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);

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

  // Close contact dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (contactRef.current && !contactRef.current.contains(e.target as Node)) {
        setContactOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
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

  const filteredContacts = allContacts.filter(c =>
    c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
    c.identifier.includes(contactSearch)
  );

  const selectedContact = allContacts.find(c => c.identifier === filters.contactIdentifier);

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
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {TYPE_CONFIG.map(({ type, label, color }) => {
            const active = filters.types.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '3px 10px',
                  borderRadius: '20px',
                  border: `1px solid ${active ? 'transparent' : 'var(--border-strong)'}`,
                  background: active ? color : 'var(--bg-base)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                  fontSize: '12px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: active ? 'rgba(255,255,255,0.7)' : color,
                  flexShrink: 0,
                }} />
                {label}
                <span style={{ fontSize: 11, opacity: 0.75 }}>{counts[type].toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Row 2: Contact + Date range */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span className="text-caption font-semibold text-text-tertiary uppercase tracking-wide" style={{ width: '44px', flexShrink: 0 }}>
          Who
        </span>

        {/* Contact dropdown */}
        <div ref={contactRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setContactOpen(o => !o)}
            style={{
              height: 28,
              minWidth: 180,
              padding: '0 8px',
              border: '0.5px solid var(--border-strong)',
              borderRadius: 6,
              background: filters.contactIdentifier ? 'var(--accent-subtle)' : 'var(--bg-base)',
              color: filters.contactIdentifier ? 'var(--text-accent)' : 'var(--text-secondary)',
              fontSize: 12,
              fontFamily: 'inherit',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedContact ? selectedContact.name : 'All contacts'}
            </span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {contactOpen && (
            <div style={{
              position: 'absolute',
              top: 32,
              left: 0,
              zIndex: 50,
              background: 'var(--bg-elevated)',
              border: '0.5px solid var(--border-strong)',
              borderRadius: 8,
              boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              width: 240,
              overflow: 'hidden',
            }}>
              <div style={{ padding: '6px 8px', borderBottom: '0.5px solid var(--border-default)' }}>
                <input
                  autoFocus
                  type="search"
                  placeholder="Search contacts…"
                  value={contactSearch}
                  onChange={e => setContactSearch(e.target.value)}
                  style={{
                    width: '100%',
                    height: 26,
                    padding: '0 8px',
                    border: '0.5px solid var(--border-strong)',
                    borderRadius: 5,
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <button
                  onClick={() => { onFiltersChange({ contactIdentifier: '' }); setContactOpen(false); setContactSearch(''); }}
                  style={{
                    width: '100%',
                    padding: '6px 12px',
                    textAlign: 'left',
                    background: !filters.contactIdentifier ? 'var(--accent-subtle)' : 'transparent',
                    color: !filters.contactIdentifier ? 'var(--text-accent)' : 'var(--text-primary)',
                    border: 'none',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  All contacts
                </button>
                {filteredContacts.map(c => (
                  <button
                    key={c.identifier}
                    onClick={() => { onFiltersChange({ contactIdentifier: c.identifier }); setContactOpen(false); setContactSearch(''); }}
                    style={{
                      width: '100%',
                      padding: '6px 12px',
                      textAlign: 'left',
                      background: filters.contactIdentifier === c.identifier ? 'var(--accent-subtle)' : 'transparent',
                      color: filters.contactIdentifier === c.identifier ? 'var(--text-accent)' : 'var(--text-primary)',
                      border: 'none',
                      fontSize: 12,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                    }}
                  >
                    <span>{c.name}</span>
                    {c.name !== c.identifier && (
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.identifier}</span>
                    )}
                  </button>
                ))}
                {filteredContacts.length === 0 && (
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                    No contacts found
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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
