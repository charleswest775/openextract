import type { AddressCard } from '../../hooks/useTimeline';
import type { TimelineEntry } from '../../types/timeline';
import { normPhone } from '../../lib/people';

// People are who the backup shows you in touch with (messages, calls,
// voicemail); the address book is the cards saved on the phone. One person can
// have a card, and a card can belong to someone you were never in touch with.

export type PersonKind = 'message' | 'call' | 'voicemail';
export const PERSON_KINDS: PersonKind[] = ['message', 'call', 'voicemail'];

export interface Person {
  key: string;
  name: string;
  /** What the Timeline's person filter matches on. */
  identifier: string;
  /** Every number and address seen for them, as `idKey`s. */
  ids: Set<string>;
  counts: Record<PersonKind, number>;
  total: number;
  last: string;
  isGroup: boolean;
  chatId?: number;
}

/** One form of a number or address for comparing: the last 10 digits, or the address in lower case. */
export function idKey(identifier: string): string {
  const digits = normPhone(identifier);
  return digits.length >= 7 ? digits : identifier.trim().toLowerCase();
}

// "+14065550109" and "(406) 555-0109" are the same person; names compare without case.
function personKey(name: string): string {
  const digits = normPhone(name);
  return /^[+\d\s().-]+$/.test(name) && digits.length >= 7 ? digits : name.trim().toLowerCase();
}

/** Everyone the backup has messages, calls or voicemail with, most in touch first. */
export function gatherPeople(entries: TimelineEntry[]): Person[] {
  const byKey = new Map<string, Person>();
  for (const e of entries) {
    if (!PERSON_KINDS.includes(e.type as PersonKind) || !e.contactIdentifier) continue;
    const name = e.contactName || e.contactIdentifier;
    const key = personKey(name);
    let p = byKey.get(key);
    if (!p) {
      p = {
        key, name, identifier: e.contactIdentifier, ids: new Set(),
        counts: { message: 0, call: 0, voicemail: 0 }, total: 0, last: '',
        isGroup: false,
      };
      byKey.set(key, p);
    }
    p.ids.add(idKey(e.contactIdentifier));
    p.counts[e.type as PersonKind]++;
    p.total++;
    if (e.timestamp > p.last) p.last = e.timestamp;
    if (e.message?.isGroup) p.isGroup = true;
    if (e.message?.chatId != null && p.chatId == null) p.chatId = e.message.chatId;
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Which card belongs to which person, both ways, matched on numbers and addresses. */
export function linkCards(people: Person[], cards: AddressCard[]) {
  const personById = new Map<string, Person>();
  for (const p of people) {
    if (p.isGroup) continue;
    for (const id of p.ids) if (!personById.has(id)) personById.set(id, p);
  }
  const cardOf = new Map<string, AddressCard>();
  const personOf = new Map<number, Person>();
  for (const c of cards) {
    for (const id of [...c.phones, ...c.emails]) {
      const p = personById.get(idKey(id));
      if (!p) continue;
      if (!cardOf.has(p.key)) cardOf.set(p.key, c);
      if (!personOf.has(c.id)) personOf.set(c.id, p);
    }
  }
  return { cardOf, personOf };
}

export function initials(name: string): string {
  const words = name.split(/\s+/).filter(w => /^\p{L}/u.test(w));
  if (words.length === 0) return '#';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}
