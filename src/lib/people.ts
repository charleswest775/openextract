/**
 * Who a phone number or email belongs to, for the Timeline's and the Year view's
 * person picker. Both must agree, because a day in the Year view opens the Timeline.
 */
import type { ContactOption } from '../types/timeline';

// Anything with a contact on it: a Timeline entry, or a conversation, call or voicemail.
export interface PersonRow {
  contactName: string | null;
  contactIdentifier: string | null;
  /** What kind of record it is, when it's a Timeline entry: WhatsApp's names are matched differently. */
  type?: string;
}

// WhatsApp names a chat from WhatsApp's own copy of the address book, or else from
// the name the other person picked for themselves, which can be anyone's ("Alex").
// So a WhatsApp row is someone's by its number, or their address-book card, never
// by its name alone; texts, calls and voicemail are named by the address book.
const isWhatsApp = (e: PersonRow) => e.type === 'whatsapp';

// A WhatsApp chat's own address, e.g. "120363…@g.us" for a group: how People and
// the Timeline tell a WhatsApp group, broadcast list or channel apart. It isn't a
// number or an email, so it's never shown to anyone. (search.ts has the same test.)
const WHATSAPP_ADDRESS = /@(?:s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/i;
export function isWhatsAppAddress(id: string | null | undefined): boolean {
  return !!id && WHATSAPP_ADDRESS.test(id.trim());
}

// ── Phone-number normalizer ────────────────────────────────────────────────────
// Strips all non-digits and returns the last 10 digits so that "+1 (555) 123-4567",
// "15551234567", "+15551234567", and "5551234567" all compare equal.
// A WhatsApp chat's address has none: "120363025246125486@g.us" ends in ten digits
// that aren't anyone's phone number, and mustn't match one that happens to share them.
export function normPhone(s: string): string {
  if (isWhatsAppAddress(s)) return '';
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Returns true when two contact identifiers refer to the same entity.
// Emails match whatever their case, as the picker merges them; then falls back
// to normalised phone comparison.
export function identifiersMatch(a: string, b: string): boolean {
  if (a === b || a.toLowerCase() === b.toLowerCase()) return true;
  const na = normPhone(a);
  const nb = normPhone(b);
  return na.length >= 7 && nb.length >= 7 && na === nb;
}

// Maps any identifier (phone / email) to the set of ALL identifiers
// belonging to the same address-book contact.  Built from list_contacts.
export type IdentifierGroupMap = Map<string, Set<string>>;

export function buildIdentifierGroupMap(
  contacts: { phones: string[]; emails: string[] }[]
): IdentifierGroupMap {
  const map: IdentifierGroupMap = new Map();
  for (const c of contacts) {
    // Collect every raw and normalised form of this contact's identifiers
    const group = new Set<string>();
    for (const p of c.phones) {
      group.add(p);
      const np = normPhone(p);
      if (np) group.add(np);
    }
    for (const e of c.emails) {
      group.add(e);
      group.add(e.toLowerCase());
    }
    // Point every form back to the full group
    for (const id of group) {
      map.set(id, group);
    }
  }
  return map;
}

// Return all identifiers belonging to the same contact as `id`,
// checking raw, lower-cased, normalised, and +1-prefixed variants.
export function getContactGroup(id: string, idMap: IdentifierGroupMap): Set<string> | null {
  if (idMap.has(id)) return idMap.get(id)!;
  const lower = id.toLowerCase();
  if (idMap.has(lower)) return idMap.get(lower)!;
  const np = normPhone(id);
  if (np && idMap.has(np)) return idMap.get(np)!;
  if (np && idMap.has(`+1${np}`)) return idMap.get(`+1${np}`)!;
  return null;
}

// The picker's list. Keyed by normalised phone / raw identifier so the same person
// isn't listed twice when calls use "+15551234567" and messages use "5551234567".
// The first name seen is the one listed, except that the address book's name (on
// texts, calls or voicemail) wins over WhatsApp's for the same number.
export function buildContactOptions(rows: PersonRow[]): ContactOption[] {
  const seen = new Map<string, ContactOption>();
  const fromWhatsApp = new Set<string>();
  for (const e of rows) {
    if (e.contactIdentifier && e.contactName) {
      const np = normPhone(e.contactIdentifier);
      const key = np.length >= 7 ? np : e.contactIdentifier.toLowerCase();
      if (!seen.has(key) || (fromWhatsApp.has(key) && !isWhatsApp(e))) {
        seen.set(key, { identifier: e.contactIdentifier, name: e.contactName });
        if (isWhatsApp(e)) fromWhatsApp.add(key);
        else fromWhatsApp.delete(key);
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The rows that belong to the picked person, matched three ways:
//  1. Identifier match (exact or normalised phone)
//  2. Address-book group (phone ↔ email for same person)
//  3. Display-name match (bridges identifiers the address book doesn't link).
//     A group chat is under a person only this way, when it carries their name.
// `name` is the name that matched rows by (3), in lower case, or '' when none did.
// Only texts, calls and voicemail match by name, and only by a name on one of the
// person's own: a WhatsApp chat is theirs by its number or card, never its name.
export function matchPerson<T extends PersonRow>(
  contactIdentifier: string,
  rows: T[],
  options: ContactOption[],
  idMap: IdentifierGroupMap,
): { rows: T[]; name: string } {
  const selectedContact = options.find(c => identifiersMatch(contactIdentifier, c.identifier));
  const selectedName = selectedContact?.name?.toLowerCase() ?? '';
  const abGroup = getContactGroup(contactIdentifier, idMap);

  const isTheirs = (id: string) => identifiersMatch(contactIdentifier, id) || (abGroup != null && (
    abGroup.has(id) || abGroup.has(id.toLowerCase()) || abGroup.has(normPhone(id))
  ));
  const named = (e: T) => !isWhatsApp(e) && e.contactName?.toLowerCase() === selectedName;
  const name = selectedName !== '' && rows.some(e => e.contactIdentifier && isTheirs(e.contactIdentifier) && named(e))
    ? selectedName
    : '';

  return {
    rows: rows.filter(e => !!e.contactIdentifier && (isTheirs(e.contactIdentifier) || (name !== '' && named(e)))),
    name,
  };
}

export function rowsForPerson<T extends PersonRow>(
  contactIdentifier: string,
  rows: T[],
  options: ContactOption[],
  idMap: IdentifierGroupMap,
): T[] {
  return matchPerson(contactIdentifier, rows, options, idMap).rows;
}

// Everything the engine needs to count one person: the identifiers on their rows,
// plus the rest of their address-book card.
export function identifiersForPerson(
  contactIdentifier: string,
  rows: PersonRow[],
  options: ContactOption[],
  idMap: IdentifierGroupMap,
): string[] {
  const ids = new Set<string>([contactIdentifier]);
  for (const e of rowsForPerson(contactIdentifier, rows, options, idMap)) {
    ids.add(e.contactIdentifier!);
  }
  for (const id of getContactGroup(contactIdentifier, idMap) ?? []) {
    ids.add(id);
  }
  return Array.from(ids);
}

// ── Display ────────────────────────────────────────────────────────────────────
// Call and voicemail records carry raw numbers ("+14065550109"); Contacts shows
// them grouped ("+1 406 555 0109"). Format North American numbers the same way
// and leave everything else (other countries, emails, short codes) as it is.
export function formatPhone(s: string): string {
  if (!s) return s;
  const nanp = s.match(/^\+?1(\d{3})(\d{3})(\d{4})$/);
  if (nanp) return `+1 ${nanp[1]} ${nanp[2]} ${nanp[3]}`;
  const local = s.match(/^(\d{3})(\d{3})(\d{4})$/);
  if (local) return `${local[1]} ${local[2]} ${local[3]}`;
  return s;
}

/** A record's name for display: the contact name, or the formatted number when there's none. */
export function displayName(name: string | null | undefined, number: string): string {
  if (!name || normPhone(name) === normPhone(number) && /^[+\d\s().-]+$/.test(name)) return formatPhone(number);
  return name;
}
