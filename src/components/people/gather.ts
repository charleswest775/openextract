import type { AddressCard } from '../../hooks/useTimeline';
import type { TimelineEntry } from '../../types/timeline';
import type { WhatsAppChatType } from '../../types/whatsapp';
import { isWhatsAppAddress, namedByNumber, normPhone, personKey } from '../../lib/people';

// People are who the backup shows you in touch with (messages, WhatsApp, calls,
// voicemail); the address book is the cards saved on the phone. One person can
// have a card, and a card can belong to someone you were never in touch with.

export type PersonKind = 'message' | 'whatsapp' | 'call' | 'voicemail';
export const PERSON_KINDS: PersonKind[] = ['message', 'whatsapp', 'call', 'voicemail'];

export interface Person {
  key: string;
  name: string;
  /** What the Timeline's person filter matches on. */
  identifier: string;
  /** Every number and address seen for them, as `idKey`s. */
  ids: Set<string>;
  /** The same, as the backup has them, for searching: "+33612345678" keeps its country code. */
  numbers: Set<string>;
  counts: Record<PersonKind, number>;
  total: number;
  last: string;
  /** A group (or a WhatsApp broadcast list or channel), not one person. */
  isGroup: boolean;
  /** Their Messages conversation (an sms.db chat). */
  chatId?: number;
  /** Their WhatsApp chat. WhatsApp's ids overlap sms.db's, so it never goes in chatId. */
  waChatId?: number;
  /** What kind of WhatsApp chat it is, for saying "Broadcast list" rather than "Group". */
  waChatType?: WhatsAppChatType;
}

/**
 * One form of a number or address for comparing: the last 10 digits, or the
 * address in lower case. A WhatsApp chat's address ("120363…@g.us") is always
 * the address: its digits aren't a phone number.
 */
export function idKey(identifier: string): string {
  const digits = normPhone(identifier);
  return digits.length >= 7 ? digits : identifier.trim().toLowerCase();
}

function newPerson(key: string, e: TimelineEntry): Person {
  return {
    key, name: e.contactName || e.contactIdentifier!, identifier: e.contactIdentifier!, ids: new Set(), numbers: new Set(),
    counts: { message: 0, whatsapp: 0, call: 0, voicemail: 0 }, total: 0, last: '',
    isGroup: false,
  };
}

function tally(p: Person, e: TimelineEntry) {
  // A call with a name and no number adds no number
  if (e.contactIdentifier) {
    p.ids.add(idKey(e.contactIdentifier));
    // A WhatsApp group's address isn't a number to search by
    if (!isWhatsAppAddress(e.contactIdentifier)) p.numbers.add(e.contactIdentifier);
  }
  p.counts[e.type as PersonKind]++;
  p.total++;
  if (e.timestamp > p.last) p.last = e.timestamp;
  if (e.message?.isGroup) p.isGroup = true;
  if (e.message?.chatId != null && p.chatId == null) p.chatId = e.message.chatId;
  if (e.whatsapp) {
    // Broadcast lists and channels aren't a person either: they're listed with the groups
    if (e.whatsapp.chatType !== 'individual') p.isGroup = true;
    if (p.waChatId == null) {
      p.waChatId = e.whatsapp.chatId;
      p.waChatType = e.whatsapp.chatType;
    }
  }
}

// Most in touch first
const sorted = (byKey: Map<string, Person>) =>
  [...byKey.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

/**
 * Everyone the backup has messages, WhatsApp chats, calls or voicemail with,
 * most in touch first. Pass the address book so a number on someone's card
 * joins them.
 *
 * Each record counts for the person whose stream on the People page shows it
 * (useTimeline's person filter, on the person's identifier), so a person's total
 * is the length of their stream:
 *  - Texts, calls and voicemail are one person per name, as the address book
 *    names them.
 *  - One the address book had no name for (named only by its number: see
 *    namedByNumber) is whoever has that number, or else whoever has another
 *    number on its card. With no one, the numbers on one card are one person, and
 *    a number on no card is a person of its own.
 *  - WhatsApp's names can't be trusted either: an unsaved number is named by what
 *    its owner calls themselves, so two strangers can both be "Alex", and every
 *    unnamed group is "WhatsApp group". So a WhatsApp chat goes by its address:
 *    a group, broadcast list or channel is its own entry, and a one-to-one chat
 *    joins whoever already has its number (on their texts, calls, voicemail or
 *    card), whatever either is called, or else is a person of its own.
 *  - A call with a name but no number (an app's call, such as a WhatsApp or
 *    FaceTime call, which keeps an id in place of the number) is whoever has that
 *    name, if anyone does. A record with neither is no one's.
 */
export function gatherPeople(entries: TimelineEntry[], cards: AddressCard[] = []): Person[] {
  const byKey = new Map<string, Person>();
  const into = (key: string, e: TimelineEntry) => {
    let p = byKey.get(key);
    if (!p) {
      p = newPerson(key, e);
      byKey.set(key, p);
    }
    tally(p, e);
  };

  const byNumber: TimelineEntry[] = [];
  const whatsapp: TimelineEntry[] = [];
  const nameOnly: TimelineEntry[] = [];
  for (const e of entries) {
    if (!PERSON_KINDS.includes(e.type as PersonKind)) continue;
    if (!e.contactIdentifier) {
      // A WhatsApp chat with no number WhatsApp could tie it to isn't anyone's
      if (e.contactName && e.type !== 'whatsapp') nameOnly.push(e);
    } else if (e.type === 'whatsapp') whatsapp.push(e);
    else if (namedByNumber(e)) byNumber.push(e);
    else into(personKey(e.contactName || e.contactIdentifier), e);
  }
  // Everyone so far has the address book's name for them (a WhatsApp name doesn't
  // count): a call with only a name is the first of them by that name, compared as
  // the Timeline compares names
  const byName = new Map<string, Person>();
  for (const p of byKey.values()) {
    const name = p.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, p);
  }

  // Which card each number is on (the card read last, as the Timeline's matching has it)
  const cardOf = new Map<string, AddressCard>();
  for (const c of cards) for (const id of [...c.phones, ...c.emails]) cardOf.set(idKey(id), c);
  // Who has a number already, or else another number on its card (never a group)
  const holders = () => {
    const holder = new Map<string, Person>();
    for (const p of byKey.values()) {
      if (p.isGroup) continue;
      for (const id of p.ids) if (!holder.has(id)) holder.set(id, p);
    }
    return (id: string, card: AddressCard | undefined): Person | undefined => {
      const known = holder.get(id);
      if (known || !card) return known;
      for (const other of [...card.phones, ...card.emails]) {
        const p = holder.get(idKey(other));
        if (p) return p;
      }
      return undefined;
    };
  };

  if (byNumber.length > 0) {
    const holderOf = holders();
    for (const e of byNumber) {
      const id = idKey(e.contactIdentifier!);
      const card = cardOf.get(id);
      into(holderOf(id, card)?.key ?? (card ? `card:${card.id}` : personKey(e.contactIdentifier!)), e);
    }
  }

  if (whatsapp.length > 0) {
    const holderOf = holders();
    const whatsAppKey = (e: TimelineEntry): string => {
      const id = idKey(e.contactIdentifier!);
      if (isWhatsAppAddress(e.contactIdentifier) || (e.whatsapp && e.whatsapp.chatType !== 'individual')) return `wa:${id}`;
      const card = cardOf.get(id);
      const known = holderOf(id, card);
      if (known) return known.key;
      // Only on WhatsApp, with one card: its numbers are one person
      return card ? `wa-card:${card.id}` : `wa:${id}`;
    };
    for (const e of whatsapp) into(whatsAppKey(e), e);
  }

  for (const e of nameOnly) {
    const p = byName.get(e.contactName!.toLowerCase());
    if (p) tally(p, e);
  }
  return sorted(byKey);
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
