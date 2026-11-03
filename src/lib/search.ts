import type { TimelineEntry } from '../types/timeline';

// How the one search box matches: case and accents don't count ("cafe" finds
// "Café"), every word must appear but in any order, text in quotes must appear
// as written, and a phone number matches however it's punctuated.

const MARKS = /\p{M}/gu;

/** Lower case, without accents: "Café" → "cafe". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(MARKS, '').toLowerCase();
}

/** The words of a query, folded; text in quotes stays one phrase. */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const term = fold((m[1] ?? m[2] ?? '').trim());
    if (term) terms.push(term);
  }
  return terms;
}

// "(503) 555-0142" → "5035550142"; null when the term isn't a number
function phoneDigits(term: string): string | null {
  if (!/^[+\d\s().-]+$/.test(term)) return null;
  const digits = term.replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}

/**
 * The text a search looks through, built once per record: the fields folded,
 * then the phone numbers and addresses as bare digits.
 */
export function haystack(fields: (string | null | undefined)[], numbers: (string | null | undefined)[] = []): string {
  const text = fold(fields.filter(Boolean).join('\n'));
  const digits = numbers.map(n => (n ?? '').replace(/\D/g, '')).filter(d => d.length >= 3);
  return digits.length ? `${text}\n${digits.join('\n')}` : text;
}

/** Whether every term appears in the haystack. No terms matches everything. */
export function matchesTerms(hay: string, terms: string[]): boolean {
  return terms.every(term => {
    if (hay.includes(term)) return true;
    const digits = phoneDigits(term);
    return digits !== null && hay.includes(digits);
  });
}

/** Whether a query matches these fields: `matches('bread', note.title, note.body)`. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = parseQuery(query);
  return terms.length === 0 || matchesTerms(haystack(fields, fields), terms);
}

const entryText = new WeakMap<TimelineEntry, string>();

// Words for what kind of record it is, so "missed", "voicemail" or "screenshot" find them
function kindWords(e: TimelineEntry): string {
  switch (e.type) {
    case 'call': {
      const c = e.call!;
      return `${c.status === 'missed' ? 'missed' : c.direction} call`;
    }
    case 'voicemail': return 'voicemail';
    case 'photo': return e.photo!.duration > 0 || e.photo!.kind === 'video' ? 'video' : `${e.photo!.kind.replace('_', ' ')} photo`;
    default: return '';
  }
}

/** Everything about one timeline record that a search can find, cached. */
export function searchText(e: TimelineEntry): string {
  let hay = entryText.get(e);
  if (hay === undefined) {
    hay = haystack(
      [
        e.contactName,
        e.message?.text, e.message?.conversationName,
        kindWords(e),
        e.call?.app,
        e.photo?.filename,
        e.voicemail?.transcript,
        e.note?.title, e.note?.body,
        e.browser?.title, e.browser?.domain, e.browser?.url,
      ],
      [e.contactIdentifier, e.voicemail?.phoneNumber],
    );
    entryText.set(e, hay);
  }
  return hay;
}

/** Where the terms appear in `text`, as sorted, non-overlapping [start, end) ranges. */
export function highlightRanges(text: string, terms: string[]): [number, number][] {
  if (!text || terms.length === 0) return [];
  // Fold one character at a time, remembering where each folded character came from
  let folded = '';
  const from: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      from.push(i);
    }
    i += ch.length;
  }
  from.push(text.length);

  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at !== -1) {
      ranges.push([from[at], from[at + term.length]]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
