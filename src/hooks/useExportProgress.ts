import { useEffect, useState } from 'react';
import { exportProgressFor, type ExportProgress } from '../lib/exportProgress';

/**
 * How far along a save of this kind is, from the engine's export.progress
 * notifications, while `active` (the save is running). Null before the first
 * update and once the save is over.
 */
export function useExportProgress(kind: string, active: boolean): ExportProgress | null {
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!active || !window.openextract?.onNotification) return;
    return window.openextract.onNotification(notification => {
      const update = exportProgressFor(kind, notification);
      if (update) setProgress(update);
    });
  }, [kind, active]);

  return active ? progress : null;
}
