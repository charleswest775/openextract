from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class CallDirection(str, Enum):
    INCOMING = "incoming"
    OUTGOING = "outgoing"
    MISSED = "missed"
    BLOCKED = "blocked"


class Call(BaseModel):
    id: int
    address: str
    """Phone number or identifier."""
    contact_name: str | None = None
    """Resolved display name."""
    direction: CallDirection
    duration_seconds: float
    timestamp: datetime
    service: str | None = None
    """e.g. 'Phone', 'FaceTime', 'FaceTime Audio'."""
    country_code: str | None = None
