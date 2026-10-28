// Wording for photos the Photos library lists but the backup has no file for:
// with iCloud Photos and "Optimize iPhone Storage" most originals can be in
// iCloud only, and Shared Album items always are (#106).

/** Under the Photos title, when some of the photos in view aren't in the backup. */
export function moreOnlyInIcloud(count: number): string {
  return count === 1
    ? "1 more is only in iCloud, so this backup doesn't have it."
    : `${count.toLocaleString()} more are only in iCloud, so this backup doesn't have them.`;
}

/** In place of the grid, when none of the photos in view are in the backup. */
export function allOnlyInIcloud(count: number): string {
  return count === 1
    ? "The 1 photo here is only in iCloud, so this backup doesn't have it."
    : `All ${count.toLocaleString()} photos here are only in iCloud, so this backup doesn't have them.`;
}

export interface PhotoExportResult {
  exported: number;
  errors: number;
  not_in_backup?: number;
}

/** "300 exported · 5,700 only in iCloud, not in this backup · 3 couldn't be copied" */
export function photoExportSummary(result: PhotoExportResult): string {
  const parts = [`${result.exported.toLocaleString()} exported`];
  if (result.not_in_backup) {
    parts.push(`${result.not_in_backup.toLocaleString()} only in iCloud, not in this backup`);
  }
  if (result.errors) {
    parts.push(`${result.errors.toLocaleString()} couldn't be copied`);
  }
  return parts.join(' · ');
}
