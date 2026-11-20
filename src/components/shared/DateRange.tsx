interface Props {
  /** 'YYYY-MM-DD', or '' for no limit. */
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}

/** From and to dates, and "Any date" to clear them: the Timeline's and People's date filter. */
export default function DateRange({ from, to, onChange }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
      <label style={labelStyle}>
        From
        <input type="date" value={from} onChange={e => onChange({ from: e.target.value, to })} style={inputStyle} />
      </label>
      <label style={labelStyle}>
        to
        <input type="date" value={to} onChange={e => onChange({ from, to: e.target.value })} style={inputStyle} />
      </label>
      {(from || to) && (
        <button onClick={() => onChange({ from: '', to: '' })} className="text-sm text-accent hover:underline">
          Any date
        </button>
      )}
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
