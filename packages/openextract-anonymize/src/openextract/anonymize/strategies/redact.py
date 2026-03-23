"""Redaction strategy: replace PII with [REDACTED_<TYPE>] tokens."""
from __future__ import annotations

import re

from ..models import DiffEntry, EntityType

_PHONE_RE = re.compile(
    r"(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})"
)
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Z|a-z]{2,}\b")


def redact_text(
    text: str,
    known_names: set[str],
    field_path: str,
    diff: list[DiffEntry],
) -> str:
    """Replace all PII in `text` with redaction tokens. Records diffs."""
    if not text:
        return text

    result = text

    # Phone numbers
    for match in _PHONE_RE.finditer(text):
        original = match.group(0)
        token = "[REDACTED_PHONE]"
        if original != token:
            diff.append(DiffEntry(
                field_path=field_path,
                entity_type=EntityType.PHONE,
                original_value=original,
                anonymized_value=token,
            ))
            result = result.replace(original, token, 1)

    # Email addresses
    for match in _EMAIL_RE.finditer(result):
        original = match.group(0)
        token = "[REDACTED_EMAIL]"
        if original != token:
            diff.append(DiffEntry(
                field_path=field_path,
                entity_type=EntityType.EMAIL,
                original_value=original,
                anonymized_value=token,
            ))
            result = result.replace(original, token, 1)

    # Known names (word-boundary match, case-insensitive)
    for name in sorted(known_names, key=len, reverse=True):
        if not name or len(name) < 3:
            continue
        pattern = re.compile(r"\b" + re.escape(name) + r"\b", re.IGNORECASE)
        for match in pattern.finditer(result):
            original = match.group(0)
            token = "[REDACTED_NAME]"
            diff.append(DiffEntry(
                field_path=field_path,
                entity_type=EntityType.NAME,
                original_value=original,
                anonymized_value=token,
            ))
        result = pattern.sub("[REDACTED_NAME]", result)

    return result
