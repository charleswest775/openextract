import { useState, useRef, useEffect } from 'react';
import { ContactOption } from '../../types/timeline';
import { identifiersMatch } from '../../lib/people';

interface Props {
  value: string;                       // empty string = all contacts
  options: ContactOption[];
  onChange: (identifier: string) => void;
}

export default function ContactPicker({ value, options, onChange }: Props) {
  const [contactSearch, setContactSearch] = useState('');
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);

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

  const filteredContacts = options.filter(c =>
    c.name.toLowerCase().includes(contactSearch.toLowerCase()) ||
    c.identifier.includes(contactSearch)
  );

  const isSelected = (c: ContactOption) => value !== '' && identifiersMatch(value, c.identifier);
  const selectedContact = options.find(isSelected);

  function pick(identifier: string) {
    onChange(identifier);
    setContactOpen(false);
    setContactSearch('');
  }

  return (
    <div ref={contactRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setContactOpen(o => !o)}
        style={{
          height: 36,
          minWidth: 200,
          padding: '0 12px',
          border: `1px solid ${value ? 'var(--accent)' : 'var(--border-default)'}`,
          borderRadius: 999,
          background: value ? 'var(--accent-wash)' : 'var(--bg-surface)',
          color: value ? 'var(--text-accent)' : 'var(--text-primary)',
          fontSize: 14,
          fontFamily: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedContact ? selectedContact.name : value || 'Everyone'}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {contactOpen && (
        <div style={{
          position: 'absolute',
          top: 40,
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
                fontSize: 14,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <button
              onClick={() => pick('')}
              style={{
                width: '100%',
                padding: '6px 12px',
                textAlign: 'left',
                background: !value ? 'var(--accent-subtle)' : 'transparent',
                color: !value ? 'var(--text-accent)' : 'var(--text-primary)',
                border: 'none',
                fontSize: 14,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              Everyone
            </button>
            {filteredContacts.map(c => (
              <button
                key={c.identifier}
                onClick={() => pick(c.identifier)}
                style={{
                  width: '100%',
                  padding: '6px 12px',
                  textAlign: 'left',
                  background: isSelected(c) ? 'var(--accent-subtle)' : 'transparent',
                  color: isSelected(c) ? 'var(--text-accent)' : 'var(--text-primary)',
                  border: 'none',
                  fontSize: 14,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <span>{c.name}</span>
                {c.name !== c.identifier && (
                  <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{c.identifier}</span>
                )}
              </button>
            ))}
            {filteredContacts.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 14, color: 'var(--text-tertiary)' }}>
                No contacts found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
