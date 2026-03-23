from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class MessageType(str, Enum):
    TEXT = "text"
    LINK = "link"
    AUDIO = "audio"
    LOCATION = "location"
    PAYMENT = "payment"
    DIGITAL_TOUCH = "digital_touch"
    HANDWRITING = "handwriting"
    FITNESS = "fitness"
    GAME = "game"
    APP = "app"
    UNKNOWN = "unknown"


class Attachment(BaseModel):
    id: int
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    transfer_name: str | None = None


class Message(BaseModel):
    id: int
    chat_id: int
    guid: str | None = None
    text: str | None = None
    attributed_body: str | None = None
    sender: str
    """Phone number, email, or 'me'."""
    sender_name: str | None = None
    """Resolved contact display name, if available."""
    timestamp: datetime
    is_from_me: bool
    type: MessageType = MessageType.TEXT
    attachments: list[Attachment] = []
    thread_originator_guid: str | None = None
    reply_to_guid: str | None = None


class Conversation(BaseModel):
    id: int
    guid: str | None = None
    display_name: str | None = None
    participants: list[str]
    """Participant identifiers (phone/email)."""
    participant_names: list[str] = []
    """Resolved display names."""
    message_count: int = 0
    last_message_at: datetime | None = None
    last_message_text: str | None = None
    is_group: bool = False
