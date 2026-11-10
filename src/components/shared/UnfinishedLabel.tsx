import { UNFINISHED_LABEL } from '../../lib/foundBackups';

/** "Didn't finish", beside the name of a backup that stopped partway. */
export default function UnfinishedLabel() {
  return (
    <span
      title="This backup stopped partway, so some things may be missing or won't open."
      className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-medium flex-shrink-0 whitespace-nowrap"
    >
      {UNFINISHED_LABEL}
    </span>
  );
}
