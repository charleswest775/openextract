"""
OpenExtract Bundle: a documented, versioned copy of a backup's data that any tool can read.

docs/BUNDLE.md describes the format, and docs/bundle/schema/<schema_version>/ has a JSON
Schema for each file. The format is experimental (schema_version "0.x"): it can still
change between versions, and manifest.json says which version a bundle is.

A bundle is a folder::

    manifest.json        what's in it: the backup, the app, and each kind of data
    conversations.json   Messages conversations
    messages.jsonl       one message per line, each conversation oldest first
    attachments/         message attachments, copied as they are in the backup
    calls.jsonl          call history
    voicemail.jsonl      every voicemail, in the Voicemail, Spam and Deleted lists
    voicemail/           voicemail audio (AMR)
    contacts.json        the address book
    photos.jsonl         photo and video details (the files only when asked for)
    albums.json          the albums those details refer to
    photos/              the photo and video files, when asked for
    people.json          who the backup shows you in touch with
    SHA256SUMS           a SHA-256 hash of every other file, in sha256sum's format

Every date is UTC, written like "2024-07-05T16:10:00Z". The hashes are an integrity
check: they show whether a file has changed since the bundle was made. They don't say
anything about how the backup was made or where it came from.

Nothing here touches the network. Reading one kind of data can fail without stopping
the others: manifest.json gives that kind an ``error`` and the bundle is still written.
A failure to write the bundle itself (no space, no permission) removes the half-written
folder and raises, so the caller gets an error rather than a bundle missing files.
"""

import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from typing import Callable, Optional

import build_info
import people_merge
from export_progress import ExportProgress

FORMAT = "openextract-bundle"
SCHEMA_VERSION = "0.1"
SPEC_URL = "https://github.com/charleswest775/openextract/blob/main/docs/BUNDLE.md"

TYPES = ("messages", "calls", "voicemail", "contacts", "photos", "people")
# The files each kind of data writes, besides copied files
_TYPE_FILES = {
    "messages": ["conversations.json", "messages.jsonl"],
    "calls": ["calls.jsonl"],
    "voicemail": ["voicemail.jsonl"],
    "contacts": ["contacts.json"],
    "photos": ["photos.jsonl", "albums.json"],
    "people": ["people.json"],
}
# Copied files: message attachments and voicemail audio by default, photos only when asked
DEFAULT_FILES = {"attachments": True, "voicemail_audio": True, "photos": False}

_CHUNK = 1024 * 1024
_PAGE = 500
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_SURROGATE = re.compile("[\ud800-\udfff]")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


class BundleError(Exception):
    """A request the bundle can't be made from (an unknown kind of data)."""


# ── Small helpers ─────────────────────────────────────────────────────────────

def utc(value) -> Optional[str]:
    """An ISO date as UTC, "2024-07-05T16:10:00Z" (fractions of a second kept), or None.

    A date without an offset is taken as UTC, as the engine's readers write them.
    """
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    text = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if dt.microsecond:
        text += f".{dt.microsecond:06d}".rstrip("0")
    return text + "Z"


def safe_name(name: str, limit: int = 80) -> str:
    """A file name that works on Windows, macOS and Linux, and isn't too long for Windows paths."""
    cleaned = _UNSAFE.sub("_", name or "").strip(" .")
    if len(cleaned) > limit:
        stem, ext = os.path.splitext(cleaned)
        ext = ext if len(ext) <= 12 else ""
        cleaned = stem[: limit - len(ext)].rstrip(" .") + ext
    return cleaned or "file"


def _json_default(value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.hex()
    if isinstance(value, datetime):
        return utc(value.isoformat())
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    return str(value)


def _finite(value):
    """``value`` with NaN and infinities as None: JSON has neither."""
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def to_json(value, pretty: bool = False) -> str:
    """JSON text that is valid UTF-8 whatever the backup held (lone surrogates become U+FFFD)."""
    kwargs = {"ensure_ascii": False, "default": _json_default, "allow_nan": False}
    if pretty:
        kwargs.update(indent=2)
    else:
        kwargs.update(separators=(",", ":"))
    try:
        text = json.dumps(value, **kwargs)
    except ValueError:
        text = json.dumps(_finite(value), **kwargs)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        text = _SURROGATE.sub("�", text)
    return text


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


class _DateRange:
    """The earliest and latest of the dates it's shown."""

    def __init__(self):
        self.first: Optional[str] = None
        self.last: Optional[str] = None

    def see(self, date: Optional[str]) -> None:
        if not date:
            return
        if self.first is None or date < self.first:
            self.first = date
        if self.last is None or date > self.last:
            self.last = date


class _Writer:
    """Files in the bundle folder, each hashed as it's written."""

    def __init__(self, root: str):
        self.root = root
        self.hashes: dict = {}  # relative path (with /) → sha256

    def path(self, rel: str) -> str:
        return os.path.join(self.root, *rel.split("/"))

    def write_text(self, rel: str, text: str) -> None:
        data = text.encode("utf-8")
        target = self.path(rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as f:
            f.write(data)
        self.hashes[rel] = hashlib.sha256(data).hexdigest()

    def write_json(self, rel: str, value) -> None:
        self.write_text(rel, to_json(value, pretty=True) + "\n")

    def lines(self, rel: str) -> "_LineFile":
        return _LineFile(self, rel)

    def copy(self, source: str, rel: str) -> tuple:
        """Copy a file in, hashing it on the way. Returns (sha256, size)."""
        target = self.path(rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        h, size = hashlib.sha256(), 0
        with open(source, "rb") as src, open(target, "wb") as dst:
            for chunk in iter(lambda: src.read(_CHUNK), b""):
                h.update(chunk)
                dst.write(chunk)
                size += len(chunk)
        try:
            shutil.copystat(source, target)  # keep the backup's modified time
        except OSError:
            pass
        self.hashes[rel] = h.hexdigest()
        return self.hashes[rel], size

    def unused(self, rel: str) -> str:
        """``rel``, or "name (2).ext" and so on if a file of that name was already written."""
        if rel not in self.hashes and not os.path.exists(self.path(rel)):
            return rel
        stem, ext = os.path.splitext(rel)
        n = 2
        while f"{stem} ({n}){ext}" in self.hashes or os.path.exists(self.path(f"{stem} ({n}){ext}")):
            n += 1
        return f"{stem} ({n}){ext}"


class _LineFile:
    """A JSON Lines file, one record per line, streamed to disk and hashed as it goes."""

    def __init__(self, writer: _Writer, rel: str):
        self._writer, self._rel = writer, rel
        target = writer.path(rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        self._file = open(target, "wb")
        self._hash = hashlib.sha256()
        self.count = 0

    def write(self, record: dict) -> None:
        data = (to_json(record) + "\n").encode("utf-8")
        self._file.write(data)
        self._hash.update(data)
        self.count += 1

    def close(self) -> None:
        if self._file.closed:
            return
        self._file.close()
        self._writer.hashes[self._rel] = self._hash.hexdigest()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# ── The export ────────────────────────────────────────────────────────────────

class BundleExporter:
    """Writes an OpenExtract Bundle from an open backup, using the engine's readers."""

    def __init__(self, message_extractor, call_extractor, voicemail_extractor, photo_extractor):
        self.messages = message_extractor
        self.calls = call_extractor
        self.voicemail = voicemail_extractor
        self.photos = photo_extractor

    def export(self, backup, contacts: dict, read_cards: Callable[[], dict], output_dir: str,
               types=None, files: Optional[dict] = None, time_zone: Optional[str] = None,
               on_progress: Optional[Callable[[int, int, int], None]] = None) -> dict:
        """Write a bundle into a new folder in ``output_dir``. Returns where, and what's in it.

        ``types``: which kinds of data (TYPES; all of them by default). ``files``: which
        files to copy in ({"attachments", "voicemail_audio", "photos"}, DEFAULT_FILES by
        default). ``time_zone``: the computer's time zone (an IANA name like
        "America/Los_Angeles"), recorded in the manifest for readers that show local
        times; every date in the bundle is UTC either way. ``contacts`` is the engine's
        name lookup, ``read_cards`` returns list_contacts' result.
        """
        chosen = self._chosen_types(types)
        copy = {**DEFAULT_FILES, **{k: bool(v) for k, v in (files or {}).items() if k in DEFAULT_FILES}}
        info = dict(getattr(backup, "info", None) or {})
        created = datetime.now(timezone.utc)

        root = self._new_folder(output_dir, info, created)
        writer = _Writer(root)
        try:
            return self._write(backup, contacts, read_cards, writer, chosen, copy, info, created, time_zone, on_progress)
        except BaseException:
            shutil.rmtree(root, ignore_errors=True)
            raise

    @staticmethod
    def _chosen_types(types) -> list:
        if types is None:
            return list(TYPES)
        if not isinstance(types, (list, tuple)):
            raise BundleError("types must be a list, e.g. [\"messages\", \"calls\"]")
        unknown = [t for t in types if t not in TYPES]
        if unknown:
            raise BundleError(f"Unknown kind of data for a bundle: {', '.join(map(str, unknown))}. "
                              f"Choose from {', '.join(TYPES)}.")
        if not types:
            raise BundleError("Choose at least one kind of data for the bundle.")
        return [t for t in TYPES if t in types]

    @staticmethod
    def _new_folder(output_dir: str, info: dict, created: datetime) -> str:
        if not output_dir:
            raise BundleError("No folder to save the bundle in.")
        os.makedirs(output_dir, exist_ok=True)
        device = (info.get("device_name") or "").strip()
        if device in ("", "Unknown"):
            device = "iPhone"
        base = safe_name(f"OpenExtract Bundle - {device} - {created.strftime('%Y-%m-%d')}", limit=100)
        name, n = base, 2
        while os.path.exists(os.path.join(output_dir, name)):
            name = f"{base} ({n})"
            n += 1
        root = os.path.join(output_dir, name)
        os.makedirs(root)
        return root

    def _write(self, backup, contacts, read_cards, writer, chosen, copy, info, created, time_zone, on_progress) -> dict:
        sections = {t: {"included": t in chosen} for t in TYPES}
        state = _State()
        run = lambda name, step: self._run(sections, name, step, writer.root)  # noqa: E731

        # Read the lists first, so progress has a total from the start
        conversations = self._read(sections, "messages", lambda: self.messages.list_conversations(backup, contacts),
                                   "conversations") if "messages" in chosen or "people" in chosen else None
        calls = self._read(sections, "calls", lambda: self.calls.list_calls(backup, contacts, 0, 10_000_000),
                           "calls") if "calls" in chosen or "people" in chosen else None
        voicemails = self._read(sections, "voicemail", lambda: self.voicemail.list_voicemails(
            backup, contacts, include_deleted=True), "voicemails") if "voicemail" in chosen or "people" in chosen else None
        photos = self._read_photos(backup, sections) if "photos" in chosen else None
        # People link to address-book cards, so the cards are read for them too
        listed_cards = self._read(sections, "contacts", read_cards, "contacts") \
            if "contacts" in chosen or "people" in chosen else None
        cards = listed_cards["contacts"] if listed_cards else []

        total = 0
        if conversations:
            total += sum(int(c.get("message_count") or 0) for c in conversations["conversations"])
        total += len(calls["calls"]) if calls else 0
        total += len(voicemails["voicemails"]) if voicemails else 0
        total += len(cards) if listed_cards and "contacts" in chosen else 0
        total += len(photos["photos"]) if photos else 0
        state.progress = ExportProgress(on_progress, max(total, 1))
        state.report()

        people_entries: list = []
        want_people = "people" in chosen

        steps = (
            ("messages", conversations, lambda: self._write_messages(
                backup, contacts, writer, conversations, copy["attachments"], state,
                people_entries if want_people else None, write="messages" in chosen)),
            ("calls", calls, lambda: self._write_calls(
                writer, calls, state, people_entries if want_people else None, write="calls" in chosen)),
            ("voicemail", voicemails, lambda: self._write_voicemail(
                backup, contacts, writer, voicemails, copy["voicemail_audio"], state,
                people_entries if want_people else None, write="voicemail" in chosen)),
        )
        for name, listed, step in steps:
            if listed is None or "error" in sections[name]:
                continue
            run(name, step)

        if listed_cards is not None and "contacts" in chosen:
            run("contacts", lambda: self._write_contacts(writer, cards, state))
        if photos is not None and "error" not in sections["photos"]:
            run("photos", lambda: self._write_photos(backup, writer, photos, copy["photos"], state))
        if want_people:
            # Card ids only when the cards are in the bundle to look them up in
            run("people", lambda: self._write_people(
                writer, people_entries, cards if "contacts" in chosen else [], sections))

        for name in TYPES:
            section = sections[name]
            if not section["included"]:
                # Read only to work out people: not part of this bundle
                sections[name] = {"included": False}
                continue
            section.setdefault("files", [f for f in _TYPE_FILES[name] if f in writer.hashes])
            section.setdefault("count", 0)
            section.setdefault("first_utc", None)
            section.setdefault("last_utc", None)
            if "error" in section:
                section["empty_reason"] = None
            elif section["count"] == 0:
                section["empty_reason"] = section.get("empty_reason") or "no_records"
            else:
                section["empty_reason"] = None

        state.done = state.progress.total
        state.report()

        manifest = self._manifest(backup, info, created, time_zone, copy, sections)
        writer.write_json("manifest.json", manifest)
        sums = "".join(f"{writer.hashes[rel]}  {rel}\n" for rel in sorted(writer.hashes))
        writer.write_text("SHA256SUMS", sums)

        return {
            "path": writer.root,
            "schema_version": SCHEMA_VERSION,
            "files": sorted(writer.hashes),
            "counts": {t: sections[t]["count"] for t in TYPES if sections[t]["included"]},
            "errors": {t: sections[t]["error"] for t in TYPES if sections[t].get("error")},
            "failed_files": state.failed,
        }

    # ── Reading ──────────────────────────────────────────────────────────────

    @staticmethod
    def _read(sections: dict, name: str, read: Callable[[], dict], key: str) -> Optional[dict]:
        """One reader's result, or None with the section's error set when it fails."""
        try:
            result = read() or {}
        except Exception as e:  # noqa: BLE001  one kind of data failing mustn't stop the rest
            _log(f"reading {name} failed: {type(e).__name__}: {e}")
            sections[name]["error"] = f"{type(e).__name__}: {e}"
            return None
        # A reader can say why it found nothing with a message too ("Call history not found…");
        # with an empty_reason that's an empty backup, not a failure.
        if result.get("empty_reason") and not result.get(key):
            sections[name]["empty_reason"] = result["empty_reason"]
        elif result.get("error") and not result.get(key):
            sections[name]["error"] = str(result["error"])
            return None
        result.setdefault(key, [])
        return result

    def _read_photos(self, backup, sections: dict) -> Optional[dict]:
        def read():
            from photos import LIBRARY  # every photo, hidden ones too
            out, offset, last = [], 0, {}
            while True:
                last = self.photos.list_photos(backup, offset=offset, limit=_PAGE, album_id=LIBRARY)
                out.extend(last.get("photos") or [])
                if last.get("error") or offset + _PAGE >= int(last.get("total") or 0):
                    break
                offset += _PAGE
            result = {"photos": out}
            if last.get("error"):
                result["error"] = last["error"]
            if last.get("not_in_backup") is not None:
                result["not_in_backup"] = last["not_in_backup"]
            if last.get("fallback_reason"):
                result["fallback_reason"] = last["fallback_reason"]
            return result
        return self._read(sections, "photos", read, "photos")

    @staticmethod
    def _run(sections: dict, name: str, step: Callable[[], dict], root: str) -> None:
        """Write one kind of data; a failure is the section's error, and the rest go on.

        A failure to write into the bundle (no space, no permission) is the bundle
        failing, not the data, so it stops everything.
        """
        try:
            sections[name].update(step() or {})
        except OSError as e:
            if _writing_failed(e, root):
                raise
            _log(f"reading {name} failed: {type(e).__name__}: {e}")
            sections[name]["error"] = f"{type(e).__name__}: {e}"
        except Exception as e:  # noqa: BLE001
            _log(f"writing {name} failed: {type(e).__name__}: {e}")
            sections[name]["error"] = f"{type(e).__name__}: {e}"

    # ── Messages ─────────────────────────────────────────────────────────────

    def _write_messages(self, backup, contacts, writer, conversations, copy_attachments, state, people, write) -> dict:
        dates, records = _DateRange(), []
        attachments = {"copied": 0, "not_in_backup": 0, "failed": 0}
        out = writer.lines("messages.jsonl") if write else None
        try:
            for conv in conversations["conversations"]:
                chat_id = conv["chat_id"]
                messages = self._all_messages(backup, contacts, chat_id, state)
                conv_dates, handles = _DateRange(), set()
                if conv.get("chat_identifier") and not conv.get("is_group"):
                    handles.add(conv["chat_identifier"])
                dated = 0
                for msg in messages:
                    date = utc(msg.get("date"))
                    conv_dates.see(date)
                    dated += 1 if date else 0
                    if not write:
                        continue
                    dates.see(date)
                    from_me = bool(msg.get("is_from_me"))
                    handle = (msg.get("sender_handle") or None) if not from_me else None
                    if handle:
                        handles.add(handle)
                    out.write({
                        "id": msg.get("message_id"),
                        "chat_id": chat_id,
                        "date_utc": date,
                        "is_from_me": from_me,
                        "sender_handle": handle,
                        "sender_name": None if from_me else (msg.get("sender") or None),
                        "service": msg.get("service") or conv.get("service") or None,
                        "type": msg.get("message_type") or "text",
                        "text": msg.get("text") or None,
                        "event_text": msg.get("event_text") or None,
                        "is_reaction": bool(msg.get("is_reaction")),
                        "attachments": [
                            self._attachment(backup, writer, att, copy_attachments, attachments, state)
                            for att in msg.get("attachments") or []
                        ],
                    })
                if people is not None and dated:
                    # One entry for the whole conversation, counted once per dated message
                    people.append({**people_merge.message_entry(conv, conv_dates.last), "count": dated})
                if write:
                    records.append({
                        "chat_id": chat_id,
                        "chat_identifier": conv.get("chat_identifier"),
                        "display_name": conv.get("display_name") or None,
                        "service": conv.get("service") or None,
                        "is_group": bool(conv.get("is_group")),
                        "message_count": len(messages),
                        "first_utc": conv_dates.first,
                        "last_utc": conv_dates.last,
                        "handles": sorted(handles),
                    })
        finally:
            if out is not None:
                out.close()
        if not write:
            return {}
        writer.write_json("conversations.json", {"schema_version": SCHEMA_VERSION, "conversations": records})
        return {
            "count": out.count, "first_utc": dates.first, "last_utc": dates.last,
            "conversations": len(records), "attachments": attachments,
        }

    def _all_messages(self, backup, contacts, chat_id, state) -> list:
        """Every message in a conversation, oldest first."""
        messages, offset = [], 0
        while True:
            page = self.messages.get_messages(backup, chat_id, contacts, offset, _PAGE)
            if page.get("error") and not page.get("messages"):
                raise RuntimeError(f"conversation {chat_id}: {page['error']}")
            messages.extend(page.get("messages") or [])
            next_offset = int(page.get("next_offset") or offset)
            state.done += max(next_offset - offset, 0)
            state.report()
            if next_offset <= offset or next_offset >= int(page.get("total") or 0):
                break
            offset = next_offset
        messages.sort(key=lambda m: (m.get("date") or "", m.get("message_id") or 0))
        return messages

    def _attachment(self, backup, writer, att, copy, tally, state) -> dict:
        backup_path = att.get("filename") or None
        name = att.get("transfer_name") or (os.path.basename(backup_path) if backup_path else "") or None
        record = {
            "id": att.get("attachment_id"),
            "filename": name,
            "mime": att.get("mime_type") or None,
            "size": att.get("total_bytes"),
            "backup_path": backup_path,
            "path": None,
            "sha256": None,
            "in_backup": None,
        }
        if not copy:
            return record
        source = self.messages._attachment_file_path(backup, backup_path) if backup_path else None
        if not source:
            record["in_backup"] = False
            tally["not_in_backup"] += 1
            return record
        record["in_backup"] = True
        label = f"{record['id']}-{name or 'attachment'}"
        rel = writer.unused("attachments/" + safe_name(label))
        try:
            record["sha256"], record["size"] = writer.copy(source, rel)
            record["path"] = rel
            tally["copied"] += 1
        except OSError as e:
            if _writing_failed(e, writer.root):
                raise
            _log(f"couldn't copy attachment {record['id']}: {e}")
            tally["failed"] += 1
            state.failed += 1
        return record

    # ── Calls ────────────────────────────────────────────────────────────────

    def _write_calls(self, writer, calls, state, people, write) -> dict:
        dates = _DateRange()
        out = writer.lines("calls.jsonl") if write else None
        try:
            for call in calls["calls"]:
                date = utc(call.get("date"))
                if people is not None and date:
                    people.append(people_merge.call_entry(call, date))
                state.done += 1
                state.report()
                if not write:
                    continue
                dates.see(date)
                call_id = str(call.get("call_id"))
                address = call.get("address") or None
                out.write({
                    "id": call_id,
                    "date_utc": date,
                    "address": address,
                    "contact_name": _name_or_none(call.get("contact_name"), address),
                    "direction": call.get("direction") or None,
                    "status": call.get("status") or None,
                    "duration": call.get("duration") or 0,
                    "app": call.get("app") or None,
                    "source": _call_source(call_id),
                })
        finally:
            if out is not None:
                out.close()
        if not write:
            return {}
        return {"count": out.count, "first_utc": dates.first, "last_utc": dates.last}

    # ── Voicemail ────────────────────────────────────────────────────────────

    def _write_voicemail(self, backup, contacts, writer, voicemails, copy_audio, state, people, write) -> dict:
        dates = _DateRange()
        lists = {"voicemail": 0, "spam": 0, "deleted": 0}
        audio = {"copied": 0, "not_in_backup": 0, "failed": 0}
        out = writer.lines("voicemail.jsonl") if write else None
        try:
            for vm in voicemails["voicemails"]:
                date = utc(vm.get("date_received"))
                # People counts the Voicemail and Spam lists, as the app's People screen does, not Deleted
                deleted = bool(vm.get("is_deleted", vm.get("folder") == "deleted"))
                if people is not None and date and not deleted:
                    people.append(people_merge.voicemail_entry(vm, date))
                state.done += 1
                state.report()
                if not write:
                    continue
                dates.see(date)
                folder = vm.get("folder") or "voicemail"
                lists[folder] = lists.get(folder, 0) + 1
                number = vm.get("phone_number") or None
                record = {
                    "id": str(vm.get("id")),
                    "date_utc": date,
                    "phone_number": number,
                    "contact_name": _name_or_none(vm.get("contact_name"), number),
                    "duration": vm.get("duration") or 0,
                    "is_read": bool(vm.get("is_read")),
                    "folder": folder,
                    # An older ios-backup-core has neither: then only the list is known
                    "is_spam": bool(vm.get("is_spam", folder == "spam")),
                    "is_deleted": bool(vm.get("is_deleted", folder == "deleted")),
                    "transcript": vm.get("transcript") or None,
                    "audio_path": None,
                    "audio_sha256": None,
                }
                if copy_audio:
                    self._voicemail_audio(backup, writer, vm, record, audio, state)
                out.write(record)
        finally:
            if out is not None:
                out.close()
        if not write:
            return {}
        return {"count": out.count, "first_utc": dates.first, "last_utc": dates.last, "lists": lists, "audio": audio}

    def _voicemail_audio(self, backup, writer, vm, record, tally, state) -> None:
        source = self.voicemail._inner.get_audio_path(backup, vm.get("id"))
        if not source:
            tally["not_in_backup"] += 1
            return
        rel = writer.unused(f"voicemail/{safe_name(str(vm.get('id')))}.amr")
        try:
            record["audio_sha256"], _ = writer.copy(source, rel)
            record["audio_path"] = rel
            tally["copied"] += 1
        except OSError as e:
            if _writing_failed(e, writer.root):
                raise
            _log(f"couldn't copy voicemail {vm.get('id')}: {e}")
            tally["failed"] += 1
            state.failed += 1

    # ── Contacts ─────────────────────────────────────────────────────────────

    @staticmethod
    def _write_contacts(writer, cards, state) -> dict:
        records = [{
            "id": c.get("id"),
            "first_name": c.get("first_name") or None,
            "last_name": c.get("last_name") or None,
            "display_name": c.get("display_name") or None,
            "organization": c.get("organization") or None,
            "phones": list(c.get("phones") or []),
            "emails": list(c.get("emails") or []),
            "note": c.get("note") or None,
        } for c in cards]
        writer.write_json("contacts.json", {"schema_version": SCHEMA_VERSION, "contacts": records})
        state.done += len(records)
        state.report()
        return {"count": len(records)}

    # ── Photos ───────────────────────────────────────────────────────────────

    def _write_photos(self, backup, writer, photos, copy_files, state) -> dict:
        dates = _DateRange()
        files = {"copied": 0, "failed": 0}
        album_names = {}
        try:
            albums = self.photos.list_albums(backup).get("albums") or []
        except Exception as e:  # noqa: BLE001  photos without album names beat no photos
            _log(f"listing albums failed: {e}")
            albums = []
        writer.write_json("albums.json", {"schema_version": SCHEMA_VERSION, "albums": [{
            "id": str(a.get("id")),
            "title": a.get("title") or a.get("name") or None,
            "kind": a.get("kind") or None,
            "parent_id": str(a["parent_id"]) if a.get("parent_id") is not None else None,
            "count": a.get("in_backup", a.get("asset_count")),
        } for a in albums]})
        for a in albums:
            album_names[str(a.get("id"))] = True

        with writer.lines("photos.jsonl") as out:
            for photo in photos["photos"]:
                date = utc(photo.get("date_created"))
                dates.see(date)
                record = {
                    "id": photo.get("uuid") or None,
                    "filename": photo.get("filename") or None,
                    "kind": photo.get("kind") or None,
                    "date_created_utc": date,
                    "date_modified_utc": utc(photo.get("date_modified")),
                    "width": photo.get("width") or 0,
                    "height": photo.get("height") or 0,
                    "duration": photo.get("duration") or 0,
                    "favorite": bool(photo.get("favorite")),
                    "hidden": bool(photo.get("hidden")),
                    "latitude": photo.get("latitude"),
                    "longitude": photo.get("longitude"),
                    "album_ids": [str(a) for a in photo.get("album_ids") or []],
                    "path": None,
                    "sha256": None,
                }
                if copy_files:
                    self._photo_file(backup, writer, photo, record, files, state)
                out.write(record)
                state.done += 1
                state.report()
        result = {"count": out.count, "first_utc": dates.first, "last_utc": dates.last, "albums": len(albums)}
        if photos.get("not_in_backup") is not None:
            result["not_in_backup"] = photos["not_in_backup"]
        if copy_files:
            result["photo_files"] = files
        return result

    def _photo_file(self, backup, writer, photo, record, tally, state) -> None:
        file_hash = photo.get("file_hash")
        source = self.photos._resolve_file(backup, file_hash) if file_hash else None
        if not source or not os.path.exists(source):
            tally["failed"] += 1
            state.failed += 1
            return
        name = photo.get("filename") or os.path.basename(source)
        label = f"{record['id'] or 'photo'}-{name}"
        rel = writer.unused("photos/" + safe_name(label, limit=100))
        try:
            record["sha256"], _ = writer.copy(source, rel)
            record["path"] = rel
            tally["copied"] += 1
        except OSError as e:
            if _writing_failed(e, writer.root):
                raise
            _log(f"couldn't copy photo {record['id']}: {e}")
            tally["failed"] += 1
            state.failed += 1

    # ── People ───────────────────────────────────────────────────────────────

    @staticmethod
    def _write_people(writer, entries, cards, sections) -> dict:
        people = people_merge.gather_people(entries, cards)
        card_of = people_merge.link_cards(people, cards)
        records = [{
            "key": p["key"],
            "name": p["name"],
            "identifier": p["identifier"],
            "identifiers": sorted(p["ids"]),
            "numbers": sorted(p["numbers"]),
            "counts": {"messages": p["counts"]["message"], "calls": p["counts"]["call"],
                       "voicemail": p["counts"]["voicemail"]},
            "total": p["total"],
            "last_utc": p["last"] or None,
            "is_group": p["isGroup"],
            "chat_id": p.get("chatId"),
            "contact_id": card_of.get(p["key"]),
        } for p in people]
        # What people were worked out from: a kind that failed to read isn't in them
        sources = [t for t in ("messages", "calls", "voicemail") if "error" not in sections[t]]
        writer.write_json("people.json", {"schema_version": SCHEMA_VERSION, "sources": sources, "people": records})
        return {"count": len(records), "sources": sources}

    # ── Manifest ─────────────────────────────────────────────────────────────

    @staticmethod
    def _manifest(backup, info, created, time_zone, copy, sections) -> dict:
        udid = str(info.get("udid") or getattr(backup, "udid", "") or "")
        product_version = info.get("product_version")
        return {
            "format": FORMAT,
            "schema_version": SCHEMA_VERSION,
            "experimental": True,
            "spec": SPEC_URL,
            "created_utc": utc(created.isoformat()),
            "app": {
                "name": "OpenExtract",
                "version": build_info.app_version(),
                "ios_backup_core_commit": build_info.ios_backup_core_commit(),
            },
            "time_zone_used": "UTC",
            "computer_time_zone": time_zone if isinstance(time_zone, str) and time_zone else None,
            "backup": {
                "device_name": _known(info.get("device_name")),
                "product_type": _known(info.get("product_type")),
                "ios_version": _known(product_version),
                "backup_date_utc": utc(info.get("last_backup")),
                "encrypted": bool(info.get("encrypted")),
                "udid_sha256": hashlib.sha256(udid.encode("utf-8")).hexdigest() if udid else None,
            },
            "files_copied": dict(copy),
            "types": sections,
            "integrity": {
                "algorithm": "SHA-256",
                "file": "SHA256SUMS",
                "covers": "every file in the bundle except SHA256SUMS itself",
                "meaning": "An integrity check: the hashes show whether a file has changed since the bundle "
                           "was made. They say nothing about how the backup itself was made.",
            },
        }


class _State:
    """How far the export has got, for export.progress."""

    def __init__(self):
        self.done = 0
        self.failed = 0
        self.progress: Optional[ExportProgress] = None

    def report(self) -> None:
        if self.progress is not None:
            self.progress.update(self.done, self.failed)


def _known(value) -> Optional[str]:
    return value if isinstance(value, str) and value and value != "Unknown" else None


def _name_or_none(name, number) -> Optional[str]:
    """The address book's name, or None when the reader only echoed the number (or a FaceTime UUID), or
    named a caller with no number "Unknown" (the address book can't name someone with no number)."""
    if not name or name == number or _UUID.match(str(name)) or (not number and name == "Unknown"):
        return None
    return name


def _call_source(call_id: str) -> str:
    """Where a call record came from: the call history, a voicemail with no call, or a FaceTime row in Messages."""
    if call_id.startswith("vm_"):
        return "voicemail"
    if call_id.startswith("ft_"):
        return "messages"
    return "call_history"


def _writing_failed(error: OSError, root: str) -> bool:
    """True when an OSError is the bundle failing to be written (out of space, or a
    file in the bundle folder that can't be made), not one file of the backup's."""
    import errno
    if getattr(error, "errno", None) in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)):
        return True
    for name in (getattr(error, "filename", None), getattr(error, "filename2", None)):
        if not name:
            continue
        try:
            if os.path.commonpath([os.path.abspath(str(name)), os.path.abspath(root)]) == os.path.abspath(root):
                return True
        except ValueError:  # another drive on Windows
            pass
    return False


def _log(message: str) -> None:
    print(f"[bundle] {message}", file=sys.stderr, flush=True)
