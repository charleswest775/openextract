from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class Note(BaseModel):
    id: int
    title: str | None = None
    body: str | None = None
    """Plain text content."""
    created_at: datetime | None = None
    modified_at: datetime | None = None
    folder: str | None = None
    is_pinned: bool = False
    has_attachments: bool = False
    word_count: int = 0
