import type { TimelineEntry } from '../types/timeline';

// How the one search box matches: case and accents don't count ("cafe" finds
// "Café"), every word must appear but in any order, text in quotes must appear
// as written, and a phone number matches however it's punctuated, with or
// without its country code, wherever it's written.

const MARKS = /\p{M}/gu;

/** Lower case, without accents: "Café" → "cafe". */
export function fold(s: string): string {
  return s.normalize('NFD').replace(MARKS, '').toLowerCase();
}

/** One thing a query asks for, folded: a word, a phrase in quotes, or a number. */
export interface Term {
  text: string;
  /** A number's digits, as typed: "(503) 555" → "503555". */
  digits?: string;
  /** A number long enough to find however it's written: the digits to look for in a record's phone numbers. */
  forms?: string[];
  /** Number words typed in a row, each on its own, for when they aren't one number: "503-555-0123 2026". */
  words?: Term[];
}

/** What a search looks through for one record. */
export interface Haystack {
  /** The fields folded, then the bare digits of the phone numbers given. */
  text: string;
  /** Where the fields end in `text`. */
  fieldsEnd: number;
  /** The phone numbers given, as they are, one per line. */
  given: string;
  /** Every phone number in the record, given or written in the fields, as digits, one per line; worked out the first time a search needs it. */
  numbers: string | undefined;
}

// Shorter numbers ("2026", "555") match as written or inside a contact's number;
// from 6 digits on, a number also matches inside any phone number in the record,
// however that one is punctuated.
const LONG_NUMBER = 6;

// The spaces and dashes people and phones put inside numbers, besides the plain ones
const SPACES = ' \u00a0\u2007\u2009\u202f';
const DASHES = '\\-\u2010-\u2015\u2212';

// A query word that's a number: only digits and + ( ) . or a dash
const NUMBER_CHARS = new RegExp(`^[+\\d\\s().${DASHES}]+$`);

const digitCount = (s: string) => s.replace(/\D/g, '').length;

// Country codes are 1 to 3 digits, and their first digits say which:
// +1 and +7 are one digit, these are two, every other is three.
const TWO_DIGIT_CODE = /^(?:2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/;

/**
 * A phone number's digits and, when it's written with its country code, the
 * rest of it: "+44 (0)20 7946 0958" → 442079460958 and 2079460958,
 * "1-503-555-0123" → 15035550123 and 5035550123.
 */
function readNumber(n: string): { digits: string; rest: string | null } {
  const abroad = /^\s*(?:\+|00)/.test(n);
  let digits = (abroad ? n.replace('(0)', '') : n).replace(/\D/g, '');
  if (!abroad) {
    // North American numbers are often written with their 1 and no +
    return { digits, rest: digits.length === 11 && digits[0] === '1' ? digits.slice(1) : null };
  }
  if (digits.startsWith('00')) digits = digits.slice(2);
  const code = digits[0] === '1' || digits[0] === '7' ? 1 : TWO_DIGIT_CODE.test(digits) ? 2 : 3;
  return { digits, rest: digits.slice(code) };
}

// The same number saved with and without its country code should find each
// other, like the calls fix in ios-backup-core: at home most countries dial a 0
// in place of the country code (+33 6 12 34 56 78 is 06 12 34 56 78), and North
// America dials the rest as is (+1 503 555 0123 is 503-555-0123).

/** A saved number as kept for searching: its digits, and as dialled at home when that isn't already in them. */
function savedForms(n: string): string[] {
  const { digits, rest } = readNumber(n);
  return rest && rest[0] !== '0' && digits[0] !== '1' ? [digits, '0' + rest] : [digits];
}

/** What to look for to find a typed number: its digits, or with a country code, the rest with or without a 0 in front. */
function typedForms(n: string): string[] {
  const { digits, rest } = readNumber(n);
  if (!rest || rest.length < LONG_NUMBER) return [digits];
  return rest[0] === '0' ? [rest] : [rest, '0' + rest];
}

// A phone number written in text: digits with one space, dot, slash, dash or
// bracket between groups, and an area code in brackets only at the start or
// after the country code: "(503) 555-0123", "+1 (503) 555-0123", "030/1234567".
const SEP = `[./${SPACES}${DASHES}]`;
const NUMBER_IN_TEXT = new RegExp(`(?:\\+?\\d{1,3}${SEP}?)?\\(?\\d+(?:(?:\\)[${SPACES}]?|${SEP})\\d+)*`, 'g');
const SPACE = new RegExp(`[${SPACES}]`);

/** Where phone numbers (7 to 15 digits) are written in `text`, as [start, end) ranges. */
function numbersIn(text: string): [number, number][] {
  const found: [number, number][] = [];
  NUMBER_IN_TEXT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_IN_TEXT.exec(text))) {
    if (m[0].length < 7) continue;
    const count = digitCount(m[0]);
    if (count < 7) continue;
    if (count <= 15) {
      found.push([m.index, m.index + m[0].length]);
      continue;
    }
    // Longer than any phone number: several in a row, like "503-555-0123 503-555-0199"
    let at = m.index;
    for (const piece of m[0].split(SPACE)) {
      const n = digitCount(piece);
      if (n >= 7 && n <= 15) found.push([at, at + piece.length]);
      at += piece.length + 1;
    }
  }
  return found;
}

/** One word or number of a query as a term. */
function term(word: string): Term {
  const text = fold(word);
  if (!NUMBER_CHARS.test(word)) return { text };
  const digits = word.replace(/\D/g, '');
  if (digits.length < 3) return { text };
  if (digits.length < LONG_NUMBER) return { text, digits };
  return { text, digits, forms: typedForms(word) };
}

/**
 * The words of a query, folded; text in quotes stays one phrase, and a phone
 * number typed with spaces stays one number ("+1 503 555 0123").
 */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  // Words in a row made only of digits and + ( ) . or a dash
  let run: string[] = [];
  const endRun = () => {
    const joined = run.join(' ');
    const count = digitCount(joined);
    // One number when it starts like one, or is too long to be a couple of years or codes
    if (run.length > 1 && count <= 15 && (/^[+(]/.test(joined) || count >= 9)) {
      const t = term(joined);
      // Unless it starts with +, it may be numbers side by side instead ("97201 97202"), which match one by one
      if (joined[0] !== '+') t.words = run.map(term);
      terms.push(t);
    } else for (const word of run) terms.push(term(word));
    run = [];
  };
  const re = /"([^"]*)"?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const word = m[2];
    if (word !== undefined && NUMBER_CHARS.test(word)) {
      if (word.startsWith('+')) endRun();
      run.push(word);
      continue;
    }
    endRun();
    if (word !== undefined) terms.push(term(word));
    else {
      const text = fold((m[1] ?? '').trim());
      if (text) terms.push({ text });
    }
  }
  endRun();
  return terms;
}

/**
 * What a search looks through, built once per record: the fields folded, then
 * the phone numbers given as bare digits. Every phone number in it, given or
 * written in the fields, is worked out only when a search asks for one.
 */
export function haystack(fields: (string | null | undefined)[], numbers: (string | null | undefined)[] = []): Haystack {
  const fieldText = fold(fields.filter(Boolean).join('\n'));
  let text = fieldText;
  let given = '';
  for (const n of numbers) {
    if (!n || digitCount(n) < 3) continue;
    given = given ? `${given}\n${n}` : n;
    text += '\n' + n.replace(/\D/g, '');
  }
  return { text, fieldsEnd: fieldText.length, given, numbers: undefined };
}

/** The record's phone numbers, worked out the first time a search asks for them. */
function numbersOf(hay: Haystack): string {
  if (hay.numbers === undefined) {
    const written = hay.text.slice(0, hay.fieldsEnd);
    const forms: string[] = [];
    for (const [start, end] of numbersIn(written)) forms.push(...savedForms(written.slice(start, end)));
    if (hay.given) for (const n of hay.given.split('\n')) forms.push(...savedForms(n));
    hay.numbers = forms.join('\n');
  }
  return hay.numbers;
}

function hasTerm(hay: Haystack, t: Term): boolean {
  if (hay.text.includes(t.text)) return true;
  if (t.digits !== undefined) {
    if (t.digits !== t.text && hay.text.includes(t.digits)) return true;
    if (t.forms !== undefined) {
      const numbers = numbersOf(hay);
      if (numbers !== '' && t.forms.some(f => numbers.includes(f))) return true;
    }
  }
  // Not one number here: each of the numbers typed side by side
  return t.words !== undefined && t.words.every(w => hasTerm(hay, w));
}

/** Whether every term appears in the haystack. No terms matches everything. */
export function matchesTerms(hay: Haystack, terms: Term[]): boolean {
  return terms.every(t => hasTerm(hay, t));
}

// A field that's one phone number, like a contact's "+1 (503) 555-0123" or "030/1234567": on one line, 3 to 15 digits
const NUMBER_FIELD = new RegExp(`^[+\\d()./${SPACES}${DASHES}]+$`);
const isNumber = (f: string | null | undefined) => {
  if (!f || !NUMBER_FIELD.test(f)) return false;
  const count = digitCount(f);
  return count >= 3 && count <= 15;
};

/** Whether a query matches these fields: `matches('bread', note.title, note.body)`. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = parseQuery(query);
  return terms.length === 0 || matchesTerms(haystack(fields, fields.filter(isNumber)), terms);
}

const entryText = new WeakMap<TimelineEntry, Haystack>();

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
export function searchText(e: TimelineEntry): Haystack {
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
export function highlightRanges(text: string, terms: Term[]): [number, number][] {
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
  const mark = (s: string) => {
    let at = folded.indexOf(s);
    while (at !== -1) {
      ranges.push([from[at], from[at + s.length]]);
      at = folded.indexOf(s, at + s.length);
    }
  };
  let written: [number, number][] | undefined;
  const markTerm = (t: Term) => {
    const before = ranges.length;
    mark(t.text);
    if (t.digits !== undefined && t.digits !== t.text) mark(t.digits);
    // A number written another way: mark the digits typed, or all of it when it matched without its country code
    if (t.forms) {
      if (!written) written = numbersIn(folded);
      for (const [start, end] of written) {
        const at: number[] = [];
        for (let k = start; k < end; k++) if (folded[k] >= '0' && folded[k] <= '9') at.push(k);
        const d = at.map(k => folded[k]).join('').indexOf(t.digits!);
        if (d !== -1) ranges.push([from[at[d]], from[at[d + t.digits!.length - 1] + 1]]);
        else if (savedForms(folded.slice(start, end)).some(f => t.forms!.some(q => f.includes(q)))) ranges.push([from[start], from[end]]);
      }
    }
    // Not one number here: each of its words
    if (t.words && ranges.length === before) t.words.forEach(markTerm);
  };
  terms.forEach(markTerm);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
