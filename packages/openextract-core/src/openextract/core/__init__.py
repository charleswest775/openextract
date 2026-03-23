"""openextract-core: iPhone backup reader and data extraction engine.

Quick start::

    from openextract.core import Backup

    with Backup.open("/path/to/backup", password="optional") as backup:
        messages = backup.messages.list_conversations()
        contacts = backup.contacts.list_contacts()
        calls    = backup.calls.list_calls()
        photos   = backup.photos.list_albums()
        vms      = backup.voicemail.list_voicemails()
        notes    = backup.notes.list_notes()
"""
from .backup import BackupInfo, BackupReader, discover_backups
from .extractors import (
    CallExtractor,
    ContactExtractor,
    MessageExtractor,
    NoteExtractor,
    PhotoExtractor,
    VoicemailExtractor,
)
from .models import (
    Album,
    Asset,
    AssetType,
    Attachment,
    Call,
    CallDirection,
    Contact,
    Conversation,
    Message,
    MessageType,
    Note,
    Voicemail,
)


class Backup:
    """High-level facade that opens a backup and wires all extractors.

    Usage::

        with Backup.open("/path/to/backup") as b:
            convos = b.messages.list_conversations()
    """

    def __init__(self, reader: BackupReader):
        self._reader = reader
        self.contacts = ContactExtractor(reader)
        self.messages = MessageExtractor(reader, contacts=self.contacts)
        self.calls = CallExtractor(reader, contacts=self.contacts)
        self.voicemail = VoicemailExtractor(reader, contacts=self.contacts)
        self.notes = NoteExtractor(reader)
        self.photos = PhotoExtractor(reader)

    @classmethod
    def open(cls, path: str, password: str | None = None) -> "Backup":
        reader = BackupReader.open(path, password=password)
        return cls(reader)

    def close(self):
        self._reader.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


__all__ = [
    "Album",
    "Asset",
    "AssetType",
    "Attachment",
    "Backup",
    "BackupInfo",
    "BackupReader",
    "Call",
    "CallDirection",
    "CallExtractor",
    "Contact",
    "ContactExtractor",
    "Conversation",
    "Message",
    "MessageExtractor",
    "MessageType",
    "Note",
    "NoteExtractor",
    "PhotoExtractor",
    "VoicemailExtractor",
    "Voicemail",
    "discover_backups",
]
