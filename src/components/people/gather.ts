import type { AddressCard } from '../../hooks/useTimeline';
import type { TimelineEntry } from '../../types/timeline';
import type { WhatsAppChatType } from '../../types/whatsapp';
import { isWhatsAppAddress, normPhone } from '../../lib/people';

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

// "+14065550109" and "(406) 555-0109" are the same person; names compare without case.
function personKey(name: string): string {
  const digits = normPhone(name);
  return /^[+\d\s().-]+$/.test(name) && digits.length >= 7 ? digits : name.trim().toLowerCase();
}

function newPerson(key: string, e: TimelineEntry): Person {
  return {
    key, name: e.contactName || e.contactIdentifier!, identifier: e.contactIdentifier!, ids: new Set(), numbers: new Set(),
    counts: { message: 0, whatsapp: 0, call: 0, voicemail: 0 }, total: 0, last: '',
    isGroup: false,
  };
}

function tally(p: Person, e: TimelineEntry) {
  p.ids.add(idKey(e.contactIdentifier!));
  // A WhatsApp group's address isn't a number to search by
  if (!isWhatsAppAddress(e.contactIdentifier)) p.numbers.add(e.contactIdentifier!);
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
 * most in touch first. Pass the address book so a WhatsApp number on someone's
 * card joins them.
 *
 * Texts, calls and voicemail are one person per name, as the address book names
 * them. WhatsApp's names can't be trusted that way: an unsaved number is named by
 * what its owner calls themselves, so two strangers can both be "Alex", and every
 * unnamed group is "WhatsApp group". So a WhatsApp chat goes by its address:
 * a group, broadcast list or channel is its own entry, and a one-to-one chat joins
 * whoever already has its number (on their texts, calls, voicemail or card),
 * whatever either is called, or else is a person of its own.
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

  const whatsapp: TimelineEntry[] = [];
  for (const e of entries) {
    if (!PERSON_KINDS.includes(e.type as PersonKind) || !e.contactIdentifier) continue;
    if (e.type === 'whatsapp') whatsapp.push(e);
    else into(personKey(e.contactName || e.contactIdentifier), e);
  }
  if (whatsapp.length === 0) return sorted(byKey);

  // Who has each number already, and which card each number is on (the card
  // read last, as the Timeline's matching has it)
  const holder = new Map<string, Person>();
  for (const p of byKey.values()) {
    if (p.isGroup) continue;
    for (const id of p.ids) if (!holder.has(id)) holder.set(id, p);
  }
  const cardOf = new Map<string, AddressCard>();
  for (const c of cards) for (const id of [...c.phones, ...c.emails]) cardOf.set(idKey(id), c);

  const whatsAppKey = (e: TimelineEntry): string => {
    const id = idKey(e.contactIdentifier!);
    if (isWhatsAppAddress(e.contactIdentifier) || (e.whatsapp && e.whatsapp.chatType !== 'individual')) return `wa:${id}`;
    const known = holder.get(id);
    if (known) return known.key;
    const card = cardOf.get(id);
    if (!card) return `wa:${id}`;
    for (const other of [...card.phones, ...card.emails]) {
      const p = holder.get(idKey(other));
      if (p) return p.key;
    }
    // Only on WhatsApp, with one card: its numbers are one person
    return `wa-card:${card.id}`;
  };
  for (const e of whatsapp) into(whatsAppKey(e), e);
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
