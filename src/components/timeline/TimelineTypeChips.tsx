import { TimelineEntryType } from '../../types/timeline';

export const TYPE_CONFIG: { type: TimelineEntryType; label: string; color: string }[] = [
  { type: 'message',   label: 'Messages',  color: '#007AFF' },
  { type: 'call',      label: 'Calls',     color: '#30d158' },
  { type: 'photo',     label: 'Photos',    color: '#AF52DE' },
  { type: 'voicemail', label: 'Voicemail', color: '#ff9f0a' },
  { type: 'note',      label: 'Notes',     color: '#5AC8FA' },
  { type: 'browser',   label: 'Web',       color: '#34C759' },
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
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {TYPE_CONFIG.map(({ type, label, color }) => {
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
              gap: '5px',
              padding: '3px 10px',
              borderRadius: '20px',
              border: `1px solid ${on ? 'transparent' : 'var(--border-strong)'}`,
              background: on ? color : 'var(--bg-base)',
              color: on ? '#fff' : 'var(--text-secondary)',
              fontSize: '12px',
              cursor: off ? 'not-allowed' : 'pointer',
              opacity: off ? 0.45 : 1,
              transition: 'all 0.15s',
              fontFamily: 'inherit',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: on ? 'rgba(255,255,255,0.7)' : color,
              flexShrink: 0,
            }} />
            {label}
            <span style={{ fontSize: 11, opacity: 0.75 }}>{counts[type].toLocaleString()}</span>
          </button>
        );
      })}
    </div>
  );
}
