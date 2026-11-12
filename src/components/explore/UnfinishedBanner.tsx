import { useState } from 'react';
import { UNFINISHED_MESSAGE } from '../../lib/foundBackups';

/**
 * A strip above every screen of a backup that stopped partway (OE-31), so a
 * section that won't load isn't a surprise. It can be hidden until the backup
 * is opened again.
 */
export default function UnfinishedBanner({ onNewBackup }: { onNewBackup?: () => void }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <div
      role="status"
      className="flex-shrink-0 px-6 py-2.5 border-b border-amber-200 bg-amber-50 flex items-center gap-3 text-sm text-amber-800"
    >
      <span
        aria-hidden="true"
        className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-semibold"
        style={{ background: 'var(--warning)' }}
      >!</span>
      <span className="flex-1 min-w-0">{UNFINISHED_MESSAGE}</span>
      {onNewBackup && (
        <button onClick={onNewBackup} className="font-medium text-amber-900 hover:underline flex-shrink-0">
          Make a new backup
        </button>
      )}
      <button
        onClick={() => setHidden(true)}
        className="text-amber-700 hover:text-amber-900 flex-shrink-0 text-lg leading-none px-1"
        aria-label="Hide this message"
      >×</button>
    </div>
  );
}
