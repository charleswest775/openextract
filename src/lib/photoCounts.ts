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

// Photos the backup lists but whose files aren't in its folder (OE-102): the engine
// leaves them out of the grid too, and the banner above the backup says what to do.

/** Under the Photos title, when some of the photos in view are missing from the folder. */
export function moreMissingFromFolder(count: number): string {
  return count === 1
    ? "1 more is missing from the backup's folder, though the backup lists it."
    : `${count.toLocaleString()} more are missing from the backup's folder, though the backup lists them.`;
}

/**
 * In place of the grid, when none of the photos in view can be shown: why, for the ones
 * missing from the folder and the ones only in iCloud. Undefined when there are neither.
 */
export function noPhotosHere(missingFromFolder: number, onlyInIcloud: number): string | undefined {
  if (missingFromFolder > 0 && onlyInIcloud > 0) {
    const missing = missingFromFolder === 1
      ? '1 is missing from it, though the backup lists it'
      : `${missingFromFolder.toLocaleString()} are missing from it, though the backup lists them`;
    const icloud = onlyInIcloud === 1 ? '1 is only in iCloud' : `${onlyInIcloud.toLocaleString()} are only in iCloud`;
    return `None of the photos here are in the backup's folder: ${missing}, and ${icloud}.`;
  }
  if (missingFromFolder > 0) {
    return missingFromFolder === 1
      ? "The 1 photo here is missing from the backup's folder, though the backup lists it."
      : `All ${missingFromFolder.toLocaleString()} photos here are missing from the backup's folder, though the backup lists them.`;
  }
  return onlyInIcloud > 0 ? allOnlyInIcloud(onlyInIcloud) : undefined;
}

export interface PhotoExportResult {
  exported: number;
  errors: number;
  not_in_backup?: number;
  missing_from_folder?: number;
}

/** "300 exported · 5,700 only in iCloud, not in this backup · 12 missing from the backup's folder · 3 couldn't be copied" */
export function photoExportSummary(result: PhotoExportResult): string {
  const parts = [`${result.exported.toLocaleString()} exported`];
  if (result.not_in_backup) {
    parts.push(`${result.not_in_backup.toLocaleString()} only in iCloud, not in this backup`);
  }
  if (result.missing_from_folder) {
    parts.push(`${result.missing_from_folder.toLocaleString()} missing from the backup's folder`);
  }
  if (result.errors) {
    parts.push(`${result.errors.toLocaleString()} couldn't be copied`);
  }
  return parts.join(' · ');
}

/** "Saving 1,234 of 5,678 photos and videos…", counting the file it's on. */
export function photoSaveProgress(done: number, total: number): string {
  const current = Math.min(done + 1, total);
  const what = total === 1 ? 'photo or video' : 'photos and videos';
  return `Saving ${current.toLocaleString()} of ${total.toLocaleString()} ${what}…`;
}

/** Under that, once any have failed: "3 couldn't be copied". Matches photoExportSummary. */
export function photoSaveFailures(failed: number): string {
  return failed > 0 ? `${failed.toLocaleString()} couldn't be copied` : '';
}
