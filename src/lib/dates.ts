/**
 * Format ISO date strings for display.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A bare YYYY-MM-DD is a day on the local calendar; `new Date` would read it as UTC midnight,
// which is the day before west of UTC.
function parseDate(isoString: string): Date {
  const m = DATE_ONLY.exec(isoString);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(isoString);
}

export function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const date = parseDate(isoString);
    // toLocaleDateString doesn't throw on a bad date, it returns 'Invalid Date'
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return isoString;
  }
}

export function formatTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const date = parseDate(isoString);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return '';
  return `${formatDate(isoString)} ${formatTime(isoString)}`;
}

// Month names for saved files: English whatever the computer's language, as the
// engine writes them (python/local_dates.py).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Jul 5, 2024, 9:10 AM" on the local clock, for a date a saved file shows on its own.
 * The same words the engine writes in saved messages and notes (python/local_dates.py
 * readable_date), so a file saved here matches one the engine saves. A timestamp that
 * can't be read is written as it came; a missing one is "Unknown date".
 */
export function formatSavedDateTime(isoString: string | null | undefined): string {
  if (!isoString) return 'Unknown date';
  const date = parseDate(isoString);
  if (isNaN(date.getTime())) return isoString;
  const hours = date.getHours();
  const time = `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${time}`;
}

export function formatRelative(isoString: string | null | undefined): string {
  if (!isoString) return '';
  try {
    const date = parseDate(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(isoString);
  } catch {
    return '';
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
