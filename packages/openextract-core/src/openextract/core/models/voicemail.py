from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class Voicemail(BaseModel):
    id: int
    sender: str
    """Phone number."""
    sender_name: str | None = None
    duration_seconds: float
    timestamp: datetime
    is_read: bool = False
    transcript: str | None = None
    """iOS 15+ on-device transcript, if available."""
    audio_codec: str | None = None
    """Typically 'amr' for older iOS, 'm4a' for newer."""
