/**
 * Who a phone number or email belongs to, for the Timeline's and the Year view's
 * person picker. Both must agree, because a day in the Year view opens the Timeline.
 */
import type { ContactOption } from '../types/timeline';

// Anything with a contact on it: a Timeline entry, or a conversation, call or voicemail.
export interface PersonRow {
  contactName: string | null;
  contactIdentifier: string | null;
}

// ── Phone-number normalizer ────────────────────────────────────────────────────
// Strips all non-digits and returns the last 10 digits so that "+1 (555) 123-4567",
// "15551234567", "+15551234567", and "5551234567" all compare equal.
export function normPhone(s: string): string {
  const d = s.replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Returns true when two contact identifiers refer to the same entity.
// Falls back to normalised phone comparison when exact strings differ.
export function identifiersMatch(a: string, b: string): boolean {
  if (a === b) return true;
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
// checking raw, normalised, and +1-prefixed variants.
export function getContactGroup(id: string, idMap: IdentifierGroupMap): Set<string> | null {
  if (idMap.has(id)) return idMap.get(id)!;
  const np = normPhone(id);
  if (np && idMap.has(np)) return idMap.get(np)!;
  if (np && idMap.has(`+1${np}`)) return idMap.get(`+1${np}`)!;
  return null;
}

// The picker's list. Keyed by normalised phone / raw identifier so the same person
// isn't listed twice when calls use "+15551234567" and messages use "5551234567".
export function buildContactOptions(rows: PersonRow[]): ContactOption[] {
  const seen = new Map<string, ContactOption>();
  for (const e of rows) {
    if (e.contactIdentifier && e.contactName) {
      const np = normPhone(e.contactIdentifier);
      const key = np.length >= 7 ? np : e.contactIdentifier.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, { identifier: e.contactIdentifier, name: e.contactName });
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
export function rowsForPerson<T extends PersonRow>(
  contactIdentifier: string,
  rows: T[],
  options: ContactOption[],
  idMap: IdentifierGroupMap,
): T[] {
  const selectedContact = options.find(c => identifiersMatch(contactIdentifier, c.identifier));
  const selectedName = selectedContact?.name?.toLowerCase() ?? '';
  const abGroup = getContactGroup(contactIdentifier, idMap);

  return rows.filter(e => {
    if (!e.contactIdentifier) return false;
    if (identifiersMatch(contactIdentifier, e.contactIdentifier)) return true;
    if (abGroup != null && (
      abGroup.has(e.contactIdentifier)
      || abGroup.has(e.contactIdentifier.toLowerCase())
      || abGroup.has(normPhone(e.contactIdentifier))
    )) return true;
    return selectedName !== '' && e.contactName?.toLowerCase() === selectedName;
  });
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
