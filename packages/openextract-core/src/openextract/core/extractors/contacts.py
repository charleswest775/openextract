"""Contact extraction from AddressBook.sqlitedb."""
from __future__ import annotations

import re
import sqlite3
import tempfile
from pathlib import Path

from ..backup import BackupReader
from ..models.contact import Contact, ContactAddress, ContactEmail, ContactPhone

_ADDRESSBOOK_PATHS = [
    "Library/AddressBook/AddressBook.sqlitedb",
    "HomeDomain/Library/AddressBook/AddressBook.sqlitedb",
]


def _normalize_phone(number: str) -> str:
    """Strip non-digits for comparison, keeping leading +."""
    digits = re.sub(r"[^\d+]", "", number)
    # US-style: compare last 10 digits
    return digits[-10:] if len(digits) > 10 else digits


class ContactExtractor:
    def __init__(self, reader: BackupReader):
        self._reader = reader
        self._db_path: Path | None = None
        self._contacts: list[Contact] | None = None
        self._phone_index: dict[str, Contact] = {}
        self._email_index: dict[str, Contact] = {}

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path
        for rel_path in _ADDRESSBOOK_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                return self._db_path
            except FileNotFoundError:
                continue
        raise FileNotFoundError("AddressBook.sqlitedb not found in backup")

    def list_contacts(self) -> list[Contact]:
        if self._contacts is not None:
            return self._contacts

        db_path = self._open_db()
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row

        contacts: list[Contact] = []
        rows = conn.execute(
            "SELECT ROWID, First, Last, Organization, Note FROM ABPerson ORDER BY Last, First"
        ).fetchall()

        for row in rows:
            person_id = row["ROWID"]
            phones = [
                ContactPhone(number=r["value"], label=r["label"])
                for r in conn.execute(
                    "SELECT value, label FROM ABMultiValue WHERE property=3 AND record_id=?",
                    (person_id,),
                ).fetchall()
            ]
            emails = [
                ContactEmail(address=r["value"], label=r["label"])
                for r in conn.execute(
                    "SELECT value, label FROM ABMultiValue WHERE property=4 AND record_id=?",
                    (person_id,),
                ).fetchall()
            ]
            addresses = []
            for addr_row in conn.execute(
                "SELECT key, value FROM ABMultiValueEntry "
                "JOIN ABMultiValue ON ABMultiValue.UID=ABMultiValueEntry.parent_id "
                "WHERE ABMultiValue.property=5 AND ABMultiValue.record_id=?",
                (person_id,),
            ).fetchall():
                # Address entries are key/value pairs; group into single object
                pass  # simplified — full address parsing handled separately

            contact = Contact(
                id=person_id,
                first_name=row["First"],
                last_name=row["Last"],
                organization=row["Organization"],
                phones=phones,
                emails=emails,
                note=row["Note"],
            )
            contacts.append(contact)

        conn.close()
        self._contacts = contacts
        self._build_index()
        return contacts

    def _build_index(self):
        for contact in (self._contacts or []):
            for phone in contact.phones:
                norm = _normalize_phone(phone.number)
                if norm:
                    self._phone_index[norm] = contact
            for email in contact.emails:
                self._email_index[email.address.lower()] = contact

    def resolve(self, identifier: str) -> Contact | None:
        """Look up a contact by phone number or email address."""
        if not self._contacts:
            self.list_contacts()
        if "@" in identifier:
            return self._email_index.get(identifier.lower())
        norm = _normalize_phone(identifier)
        return self._phone_index.get(norm)

    def display_name(self, identifier: str) -> str | None:
        contact = self.resolve(identifier)
        return contact.display_name if contact else None
