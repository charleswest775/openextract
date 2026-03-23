"""Pseudonymization strategy: replace PII with consistent synthetic substitutes.

The same real value always maps to the same pseudonym within a session,
preserving relational structure while removing identifiability.
"""
from __future__ import annotations

import hashlib
import re
from itertools import count

from ..models import DiffEntry, EntityType

# Deterministic name pool derived from a hash seed
_NAME_POOL = [
    "Alex", "Blake", "Casey", "Dana", "Eden", "Finley", "Grey", "Harper",
    "Indigo", "Jordan", "Kai", "Lane", "Morgan", "Nova", "Oakley", "Parker",
    "Quinn", "River", "Sage", "Taylor", "Uma", "Vale", "Winter", "Xen",
    "Yael", "Zara",
]

_PHONE_RE = re.compile(
    r"(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})"
)
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Z|a-z]{2,}\b")


class PseudonymMap:
    """Maintains a consistent real→pseudonym mapping for one anonymization session."""

    def __init__(self, seed: str = "openextract"):
        self._seed = seed
        self._name_map: dict[str, str] = {}
        self._phone_map: dict[str, str] = {}
        self._email_map: dict[str, str] = {}
        self._name_counter = count(1)
        self._phone_counter = count(1)
        self._email_counter = count(1)

    def _hash_idx(self, value: str, pool_size: int) -> int:
        digest = hashlib.sha256(f"{self._seed}:{value}".encode()).digest()
        return int.from_bytes(digest[:4], "big") % pool_size

    def pseudonym_for_name(self, real: str) -> str:
        key = real.lower().strip()
        if key not in self._name_map:
            idx = self._hash_idx(key, len(_NAME_POOL))
            base = _NAME_POOL[idx]
            n = next(self._name_counter)
            self._name_map[key] = f"{base}_{n:02d}"
        return self._name_map[key]

    def pseudonym_for_phone(self, real: str) -> str:
        digits = re.sub(r"\D", "", real)
        if digits not in self._phone_map:
            n = next(self._phone_counter)
            # Fake but structurally valid US number
            self._phone_map[digits] = f"+1-555-{(1000 + n):04d}"
        return self._phone_map[digits]

    def pseudonym_for_email(self, real: str) -> str:
        key = real.lower().strip()
        if key not in self._email_map:
            n = next(self._email_counter)
            self._email_map[key] = f"person{n:03d}@example.com"
        return self._email_map[key]


def pseudonymize_text(
    text: str,
    known_names: set[str],
    field_path: str,
    diff: list[DiffEntry],
    pmap: PseudonymMap,
) -> str:
    """Replace all PII in `text` with consistent pseudonyms."""
    if not text:
        return text

    result = text

    # Phone numbers
    for match in _PHONE_RE.finditer(text):
        original = match.group(0)
        pseudo = pmap.pseudonym_for_phone(original)
        diff.append(DiffEntry(
            field_path=field_path,
            entity_type=EntityType.PHONE,
            original_value=original,
            anonymized_value=pseudo,
        ))
        result = result.replace(original, pseudo, 1)

    # Email addresses
    for match in _EMAIL_RE.finditer(result):
        original = match.group(0)
        pseudo = pmap.pseudonym_for_email(original)
        diff.append(DiffEntry(
            field_path=field_path,
            entity_type=EntityType.EMAIL,
            original_value=original,
            anonymized_value=pseudo,
        ))
        result = result.replace(original, pseudo, 1)

    # Known names
    for name in sorted(known_names, key=len, reverse=True):
        if not name or len(name) < 3:
            continue
        pattern = re.compile(r"\b" + re.escape(name) + r"\b", re.IGNORECASE)
        for match in pattern.finditer(result):
            original = match.group(0)
            pseudo = pmap.pseudonym_for_name(original)
            diff.append(DiffEntry(
                field_path=field_path,
                entity_type=EntityType.NAME,
                original_value=original,
                anonymized_value=pseudo,
            ))
        pseudo = pmap.pseudonym_for_name(name)
        result = pattern.sub(pseudo, result)

    return result
