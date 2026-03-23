"""Models for anonymization results and diff output."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel


class EntityType(str, Enum):
    NAME = "name"
    PHONE = "phone"
    EMAIL = "email"
    ADDRESS = "address"
    ORGANIZATION = "organization"
    UNKNOWN = "unknown"


class DiffEntry(BaseModel):
    """A single PII replacement recorded in the diff manifest."""
    field_path: str
    """Dot-notation path to the field, e.g. 'messages[3].text'."""
    entity_type: EntityType
    original_value: str
    anonymized_value: str
    approved: bool = False
    """Set to True when a human has approved this replacement."""


class AnonymizationResult(BaseModel):
    strategy: str
    """'redact' or 'pseudonymize'."""
    diff: list[DiffEntry]
    approved: bool = False
    """True when all diff entries are approved."""

    def approve_all(self):
        for entry in self.diff:
            entry.approved = True
        self.approved = True

    def approve(self, field_path: str):
        for entry in self.diff:
            if entry.field_path == field_path:
                entry.approved = True
        self.approved = all(e.approved for e in self.diff)

    def pending_review(self) -> list[DiffEntry]:
        return [e for e in self.diff if not e.approved]

    def summary(self) -> dict:
        by_type: dict[str, int] = {}
        for entry in self.diff:
            by_type[entry.entity_type] = by_type.get(entry.entity_type, 0) + 1
        return {
            "total_replacements": len(self.diff),
            "approved": sum(1 for e in self.diff if e.approved),
            "pending": len(self.pending_review()),
            "by_entity_type": by_type,
        }
