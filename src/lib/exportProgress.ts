// How far along a long save is (OE-14). While it saves, the engine sends
// export.progress notifications, a few a second at most (python/export_progress.py):
//   { kind: 'photos', done, total, failed }
// done counts files handled so far, saved or not; failed is how many of those weren't.

export interface ExportProgress {
  kind: string;
  done: number;
  total: number;
  failed: number;
}

/** The progress in an engine notification, if it's export.progress for this kind of save. */
export function exportProgressFor(
  kind: string,
  notification: { method?: string; params?: Record<string, any> } | null | undefined,
): ExportProgress | null {
  if (notification?.method !== 'export.progress') return null;
  const p = notification.params;
  if (p?.kind !== kind || !Number.isFinite(p.done) || !Number.isFinite(p.total) || p.total <= 0) return null;
  return { kind, done: p.done, total: p.total, failed: Number.isFinite(p.failed) ? p.failed : 0 };
}

/** How much of the bar to fill, 0 to 100. */
export function percentDone(p: ExportProgress): number {
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}
