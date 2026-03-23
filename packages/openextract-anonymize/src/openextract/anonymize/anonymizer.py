"""Main Anonymizer: applies PII removal to typed record sets from openextract-core.

Usage::

    from openextract.anonymize import Anonymizer
    from openextract.core import Backup

    with Backup.open("/path/to/backup") as b:
        contacts = b.contacts.list_contacts()
        messages = b.messages.get_messages(chat_id=1, limit=500)

    anon = Anonymizer(strategy="pseudonymize", contacts=contacts)
    result = anon.process_messages(messages)

    result.anonymized     # list[Message] with PII replaced
    result.diff           # list[DiffEntry]
    result.summary()      # {"total_replacements": 42, ...}

    # Side-by-side approval
    for entry in result.pending_review():
        print(entry.original_value, "→", entry.anonymized_value)
    result.approve_all()
"""
from __future__ import annotations

import copy
from typing import Literal

from openextract.core.models import Contact, Conversation, Message, Note

from .models import AnonymizationResult, DiffEntry
from .strategies.pseudonymize import PseudonymMap, pseudonymize_text
from .strategies.redact import redact_text

Strategy = Literal["redact", "pseudonymize"]


class Anonymizer:
    """Applies a chosen anonymization strategy to core data models."""

    def __init__(
        self,
        strategy: Strategy = "pseudonymize",
        contacts: list[Contact] | None = None,
        seed: str = "openextract",
    ):
        self._strategy = strategy
        self._known_names: set[str] = set()
        self._pmap = PseudonymMap(seed=seed) if strategy == "pseudonymize" else None

        if contacts:
            self._load_names_from_contacts(contacts)

    def _load_names_from_contacts(self, contacts: list[Contact]):
        for c in contacts:
            if c.first_name:
                self._known_names.add(c.first_name)
            if c.last_name:
                self._known_names.add(c.last_name)
            if c.organization:
                self._known_names.add(c.organization)

    def _anonymize_str(
        self, text: str | None, field_path: str, diff: list[DiffEntry]
    ) -> str | None:
        if text is None:
            return None
        if self._strategy == "pseudonymize" and self._pmap:
            return pseudonymize_text(text, self._known_names, field_path, diff, self._pmap)
        return redact_text(text, self._known_names, field_path, diff)

    # ------------------------------------------------------------------
    # Per-type processors
    # ------------------------------------------------------------------

    def process_messages(
        self, messages: list[Message]
    ) -> "AnonymizationResult":
        """Return anonymized messages and a diff manifest."""
        diff: list[DiffEntry] = []
        anon_messages: list[Message] = []

        for i, msg in enumerate(messages):
            m = msg.model_copy(deep=True)
            m.text = self._anonymize_str(msg.text, f"messages[{i}].text", diff)
            m.sender = self._anonymize_str(msg.sender, f"messages[{i}].sender", diff) or ""
            m.sender_name = self._anonymize_str(msg.sender_name, f"messages[{i}].sender_name", diff)
            anon_messages.append(m)

        result = AnonymizationResult(strategy=self._strategy, diff=diff)
        result._anonymized = anon_messages  # type: ignore[attr-defined]
        return result

    def process_contacts(
        self, contacts: list[Contact]
    ) -> "AnonymizationResult":
        diff: list[DiffEntry] = []
        anon_contacts: list[Contact] = []

        for i, contact in enumerate(contacts):
            c = contact.model_copy(deep=True)
            if c.first_name:
                c.first_name = self._anonymize_str(
                    contact.first_name, f"contacts[{i}].first_name", diff
                )
            if c.last_name:
                c.last_name = self._anonymize_str(
                    contact.last_name, f"contacts[{i}].last_name", diff
                )
            if c.organization:
                c.organization = self._anonymize_str(
                    contact.organization, f"contacts[{i}].organization", diff
                )
            for j, phone in enumerate(c.phones):
                phone.number = self._anonymize_str(
                    contact.phones[j].number, f"contacts[{i}].phones[{j}]", diff
                ) or ""
            for j, email in enumerate(c.emails):
                email.address = self._anonymize_str(
                    contact.emails[j].address, f"contacts[{i}].emails[{j}]", diff
                ) or ""
            anon_contacts.append(c)

        result = AnonymizationResult(strategy=self._strategy, diff=diff)
        result._anonymized = anon_contacts  # type: ignore[attr-defined]
        return result

    def process_notes(self, notes: list[Note]) -> "AnonymizationResult":
        diff: list[DiffEntry] = []
        anon_notes: list[Note] = []

        for i, note in enumerate(notes):
            n = note.model_copy(deep=True)
            n.title = self._anonymize_str(note.title, f"notes[{i}].title", diff)
            n.body = self._anonymize_str(note.body, f"notes[{i}].body", diff)
            anon_notes.append(n)

        result = AnonymizationResult(strategy=self._strategy, diff=diff)
        result._anonymized = anon_notes  # type: ignore[attr-defined]
        return result

    def process_conversations(
        self, conversations: list[Conversation]
    ) -> "AnonymizationResult":
        diff: list[DiffEntry] = []
        anon: list[Conversation] = []

        for i, convo in enumerate(conversations):
            c = convo.model_copy(deep=True)
            c.display_name = self._anonymize_str(
                convo.display_name, f"conversations[{i}].display_name", diff
            )
            c.participants = [
                self._anonymize_str(p, f"conversations[{i}].participants[{j}]", diff) or p
                for j, p in enumerate(convo.participants)
            ]
            c.participant_names = [
                self._anonymize_str(p, f"conversations[{i}].participant_names[{j}]", diff) or p
                for j, p in enumerate(convo.participant_names)
            ]
            anon.append(c)

        result = AnonymizationResult(strategy=self._strategy, diff=diff)
        result._anonymized = anon  # type: ignore[attr-defined]
        return result
