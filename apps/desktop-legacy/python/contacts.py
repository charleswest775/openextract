"""
Contact resolution from AddressBook.sqlitedb.
Maps phone numbers and email addresses to contact names.
"""

import sqlite3
import re
import time


def _tlog(msg: str) -> None:
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def resolve_contact(identifier: str, contacts: dict) -> str:
    """Look up a display name for a phone/email identifier with normalization fallback."""
    if identifier in contacts:
        return contacts[identifier]
    normalized = ContactResolver.normalize_phone(identifier)
    if normalized and normalized in contacts:
        return contacts[normalized]
    return ""


class ContactResolver:
    """Resolves phone numbers and emails to contact names."""

    ADDRESS_BOOK_PATH = "Library/AddressBook/AddressBook.sqlitedb"

    def __init__(self):
        self._cache: dict[str, dict] = {}  # keyed by backup udid

    def clear_cache(self, udid: str | None = None):
        """Clear cached contacts for a specific backup (or all)."""
        if udid:
            self._cache.pop(udid, None)
        else:
            self._cache.clear()

    @staticmethod
    def normalize_phone(phone: str) -> str:
        """Normalize a phone number for matching (strip everything but digits)."""
        digits = re.sub(r"[^\d]", "", phone)
        # For US numbers, compare last 10 digits
        if len(digits) >= 10:
            return digits[-10:]
        return digits

    def load_contacts(self, backup) -> dict:
        """
        Load contacts from the backup and return a lookup dict.
        Keys are phone numbers/emails, values are display names.
        """
        udid = backup.udid
        if udid in self._cache:
            return self._cache[udid]

        t0 = time.perf_counter()
        contacts = {}
        db_path = backup.get_file(self.ADDRESS_BOOK_PATH, domain="HomeDomain")
        if not db_path:
            self._cache[udid] = contacts
            return contacts

        try:
            t_open = time.perf_counter()
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            _tlog(f"contacts: sqlite3.connect={time.perf_counter()-t_open:.3f}s")

            # Get all person records
            persons = {}
            for row in conn.execute("""
                SELECT ROWID, First, Last, Organization
                FROM ABPerson
            """).fetchall():
                first = row["First"] or ""
                last = row["Last"] or ""
                org = row["Organization"] or ""
                name = f"{first} {last}".strip() or org
                if name:
                    persons[row["ROWID"]] = name

            # Map phone numbers to person names
            for row in conn.execute("""
                SELECT record_id, value
                FROM ABMultiValue
                WHERE property = 3
            """).fetchall():  # property 3 = phone numbers
                person_id = row["record_id"]
                if person_id in persons:
                    phone = row["value"]
                    # Store both raw and normalized versions
                    contacts[phone] = persons[person_id]
                    normalized = self.normalize_phone(phone)
                    if normalized:
                        contacts[normalized] = persons[person_id]
                        # Also store with +1 prefix for US numbers
                        contacts[f"+1{normalized}"] = persons[person_id]

            # Map email addresses to person names
            for row in conn.execute("""
                SELECT record_id, value
                FROM ABMultiValue
                WHERE property = 4
            """).fetchall():  # property 4 = email addresses
                person_id = row["record_id"]
                if person_id in persons:
                    email = row["value"]
                    contacts[email] = persons[person_id]
                    contacts[email.lower()] = persons[person_id]

            conn.close()
            _tlog(f"contacts: load_contacts total={time.perf_counter()-t0:.3f}s entries={len(contacts)}")
        except Exception:
            pass

        self._cache[udid] = contacts
        return contacts

    def list_contacts(self, backup) -> dict:
        """Get full contact list with all details."""
        db_path = backup.get_file(self.ADDRESS_BOOK_PATH, domain="HomeDomain")
        if not db_path:
            return {"contacts": []}

        contact_list = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            persons = conn.execute("""
                SELECT ROWID, First, Last, Organization, Department, Note
                FROM ABPerson
                ORDER BY First, Last
            """).fetchall()

            for person in persons:
                pid = person["ROWID"]
                first = person["First"] or ""
                last = person["Last"] or ""

                # Get phone numbers
                phones = [
                    row["value"]
                    for row in conn.execute(
                        "SELECT value FROM ABMultiValue WHERE record_id = ? AND property = 3",
                        (pid,)
                    ).fetchall()
                ]

                # Get emails
                emails = [
                    row["value"]
                    for row in conn.execute(
                        "SELECT value FROM ABMultiValue WHERE record_id = ? AND property = 4",
                        (pid,)
                    ).fetchall()
                ]

                contact_list.append({
                    "id": pid,
                    "first_name": first,
                    "last_name": last,
                    "display_name": f"{first} {last}".strip() or person["Organization"] or "Unknown",
                    "organization": person["Organization"],
                    "phones": phones,
                    "emails": emails,
                    "note": person["Note"],
                })

            conn.close()
        except Exception:
            pass

        return {"contacts": contact_list}
