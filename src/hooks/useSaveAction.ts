import { useCallback, useState } from 'react';
import { useNotice } from '../components/shared/Notices';
import type { FeedbackArea } from '../lib/feedback';
import type { SaveResult } from '../lib/saveData';

/**
 * Runs a save and reports how it went with an in-app notice. The save resolves
 * to null when the person cancels the folder or file dialog.
 */
export function useSaveAction(area: FeedbackArea) {
  const notify = useNotice();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (save: () => Promise<SaveResult | null>) => {
    setBusy(true);
    try {
      const result = await save();
      if (!result) return;
      window.openextract.incrementExportCount(area);
      notify({ kind: 'success', ...result });
    } catch (err: any) {
      notify({ kind: 'error', title: "Couldn't save", detail: err?.message || String(err), area });
    } finally {
      setBusy(false);
    }
  }, [area, notify]);

  return { busy, run };
}
