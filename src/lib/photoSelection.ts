// Picking photos on the Photos screen and narrowing it to some dates, so Save saves only
// those (OE-193, OE-195: Photos could save every photo or a whole album, nothing less).
// What a click picks, what the screen and the Save button say, and the dates as the
// engine takes them. Picks are keyed by file_hash, the key each tile already has.

export interface PickablePhoto {
  file_hash: string;
  kind: string;
  duration: number;
}

/** Whether a tile is a video: the grid shows a play triangle and a length on these. */
export function isVideo(photo: { kind: string; duration: number }): boolean {
  return photo.kind === 'video' || photo.duration > 0;
}

/**
 * The picks after a click on the photo `key`. With Shift, every photo from the last one
 * clicked (`anchor`) to this one is picked, as in Finder and File Explorer; otherwise this
 * one is picked, or unpicked if it was. `order` is the keys in the grid's order.
 */
export function pickPhoto(
  picked: ReadonlySet<string>, order: readonly string[], key: string, anchor: string | null, shift: boolean,
): Set<string> {
  const next = new Set(picked);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(key);
  if (shift && from >= 0 && to >= 0) {
    const [first, last] = from < to ? [from, to] : [to, from];
    for (let i = first; i <= last; i++) next.add(order[i]);
    return next;
  }
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "3 photos", "1 video", "2 photos and 1 video": what's picked, for the bar and the notice. */
export function pickedWords(photos: readonly { kind: string; duration: number }[]): string {
  const videos = photos.filter(isVideo).length;
  const stills = photos.length - videos;
  if (videos > 0 && stills > 0) return `${count(stills, 'photo')} and ${count(videos, 'video')}`;
  return videos > 0 ? count(videos, 'video') : count(stills, 'photo');
}

/** Under the header while picking: what's picked, or how to pick. */
export function pickingHint(photos: readonly { kind: string; duration: number }[]): string {
  return photos.length > 0
    ? `${pickedWords(photos)} selected`
    : 'Click the photos and videos to save. Shift-click selects every one in between.';
}

/** A local day 'YYYY-MM-DD' as a Date at its start, or null for '' or a day that doesn't exist. */
function dayStart(day: string, after = 0): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(2000, 0, 1);
  date.setFullYear(y, mo, d); // not new Date(y, ...), which reads a year before 100 as 19xx
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  if (after) date.setDate(date.getDate() + after);
  return date;
}

export interface PhotoDates {
  /** Unix seconds: the start of From, in this computer's time zone. */
  date_from?: number;
  /** Unix seconds: the start of the day after To, which is left out. */
  date_to?: number;
}

/**
 * From and To ('YYYY-MM-DD', or '' for no limit) as list_photos and export_photos take
 * them: each whole local day, both included. Days given the wrong way round are swapped.
 */
export function photoDates(from: string, to: string): PhotoDates {
  let [first, last] = [from, to];
  if (dayStart(first) && dayStart(last) && first > last) [first, last] = [last, first];
  const start = dayStart(first);
  const end = dayStart(last, 1);
  const out: PhotoDates = {};
  if (start) out.date_from = start.getTime() / 1000;
  if (end) out.date_to = end.getTime() / 1000;
  return out;
}

export function hasDates(dates: PhotoDates): boolean {
  return dates.date_from !== undefined || dates.date_to !== undefined;
}

function longDay(day: string): string {
  return dayStart(day)!.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** " from July 1, 2024 to July 31, 2024", " on July 4, 2024", " from July 1, 2024 on", " up to July 31, 2024", or "". */
export function datesWords(from: string, to: string): string {
  let [first, last] = [dayStart(from) ? from : '', dayStart(to) ? to : ''];
  if (first && last && first > last) [first, last] = [last, first];
  if (first && last) return first === last ? ` on ${longDay(first)}` : ` from ${longDay(first)} to ${longDay(last)}`;
  if (first) return ` from ${longDay(first)} on`;
  return last ? ` up to ${longDay(last)}` : '';
}

/** The Photos screen's kinds (its "All types" menu), as said in a sentence. */
const KIND_WORDS: Record<string, string> = {
  photo: 'photos', video: 'videos', live_photo: 'Live Photos', screenshot: 'screenshots',
};

/**
 * The "saved" notice's title when the dates or a kind narrowed what was saved:
 * "Saved videos in Trip from July 1, 2024 to July 31, 2024". `album` is the album's
 * title, or null for All Photos.
 */
export function savedNarrowedTitle(album: string | null, kind: string, from: string, to: string): string {
  const what = KIND_WORDS[kind] ?? 'photos and videos';
  return `Saved ${what}${album ? ` in ${album}` : ''}${datesWords(from, to)}`;
}
