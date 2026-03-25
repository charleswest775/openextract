"""Adapter wrapping the existing v0.3.0 ContactResolver for the new extraction pipeline.

Extracts contacts from AddressBook.sqlitedb and converts to BaseArtifact format.
"""

import sqlite3
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class ContactsExtractor(ArtifactExtractor):
    """Extracts contacts from AddressBook.sqlitedb."""

    ARTIFACT_TYPE = "contact"
    SUPPORTED_IOS_VERSIONS = range(5, 19)

    AB_DOMAIN = "HomeDomain"
    AB_PATH = "Library/AddressBook/AddressBook.sqlitedb"

    # ABMultiValue property IDs
    PROP_PHONE = 3
    PROP_EMAIL = 4
    PROP_URL = 22
    PROP_ADDRESS = 5

    def extract(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.AB_DOMAIN, self.AB_PATH)
        if not db_path:
            self.log.info("AddressBook.sqlitedb not found — skipping contacts")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_contacts(conn)
        except Exception as e:
            self.log.warning("Contacts extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_contacts(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Get all people
        try:
            people = conn.execute("""
                SELECT ROWID, First, Last, Middle, Organization, Department,
                       Birthday, CreationDate, ModificationDate
                FROM ABPerson
            """).fetchall()
        except Exception as e:
            self.log.warning("Failed to query ABPerson: %s", e)
            return []

        for person in people:
            rowid = person["ROWID"]
            first = person["First"] or ""
            last = person["Last"] or ""
            org = person["Organization"] or ""
            name = f"{first} {last}".strip() or org or "Unknown"

            # Get phone numbers and emails
            phones = []
            emails = []
            try:
                multi = conn.execute("""
                    SELECT property, value, label
                    FROM ABMultiValue
                    WHERE record_id = ?
                """, (rowid,)).fetchall()

                for mv in multi:
                    prop = mv["property"]
                    val = mv["value"] or ""
                    if prop == self.PROP_PHONE and val:
                        phones.append(val)
                    elif prop == self.PROP_EMAIL and val:
                        emails.append(val)
            except Exception:
                pass

            data: dict[str, Any] = {
                "first_name": first,
                "last_name": last,
                "organization": org,
                "department": person["Department"] or "",
                "phones": phones,
                "emails": emails,
            }

            # Use first phone or email as contact_identifier
            identifier = phones[0] if phones else (emails[0] if emails else None)

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=from_cocoa(person["CreationDate"]),
                provenance=Provenance(
                    source_db="AddressBook.sqlitedb",
                    source_table="ABPerson",
                    source_row_id=rowid,
                ),
                contact_name=name,
                contact_identifier=identifier,
                text_content=name,
                data=data,
            ))

        return artifacts
