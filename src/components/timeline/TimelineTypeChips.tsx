import { TimelineEntryType } from '../../types/timeline';

// One color per kind of event, from the Hearth chart palette (index.css --series-*).
// Timeline cards, these chips and the Year view all use it.
export const TYPE_COLORS: Record<TimelineEntryType, string> = {
  message: '#c0603e',
  call: '#6f8f6f',
  photo: '#9a6a8a',
  voicemail: '#c89a3a',
  note: '#5f86a0',
  browser: '#8a7f72',
};

export const TYPE_CONFIG: { type: TimelineEntryType; label: string; color: string }[] = [
  { type: 'message',   label: 'Messages',  color: TYPE_COLORS.message },
  { type: 'call',      label: 'Calls',     color: TYPE_COLORS.call },
  { type: 'photo',     label: 'Photos',    color: TYPE_COLORS.photo },
  { type: 'voicemail', label: 'Voicemail', color: TYPE_COLORS.voicemail },
  { type: 'note',      label: 'Notes',     color: TYPE_COLORS.note },
  { type: 'browser',   label: 'Web',       color: TYPE_COLORS.browser },
];

interface Props {
  active: Set<TimelineEntryType>;
  counts: Record<TimelineEntryType, number>;
  onToggle: (type: TimelineEntryType) => void;
  // Types that can't be chosen right now, with the reason shown on hover.
  unavailable?: Set<TimelineEntryType>;
  unavailableReason?: string;
}

export default function TimelineTypeChips({ active, counts, onToggle, unavailable, unavailableReason }: Props) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {/* Kinds the backup has none of are left out */}
      {TYPE_CONFIG.filter(({ type }) => counts[type] > 0).map(({ type, label, color }) => {
        const off = unavailable?.has(type) ?? false;
        const on = active.has(type) && !off;
        return (
          <button
            key={type}
            onClick={() => onToggle(type)}
            disabled={off}
            aria-pressed={on}
            title={off ? unavailableReason : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              height: 34,
              padding: '0 14px',
              borderRadius: '999px',
              border: `1.5px solid ${on ? color : 'var(--border-default)'}`,
              background: on ? `color-mix(in srgb, ${color} 14%, var(--bg-surface))` : 'transparent',
              color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: '14px',
              fontWeight: on ? 500 : 400,
              cursor: off ? 'not-allowed' : 'pointer',
              opacity: off ? 0.45 : 1,
              transition: 'all 0.15s',
              fontFamily: 'inherit',
            }}
          >
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: on ? color : 'transparent',
              border: `2px solid ${color}`,
              flexShrink: 0,
            }} />
            {label}
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{counts[type].toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}
