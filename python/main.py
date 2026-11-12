#!/usr/bin/env python3
"""
OpenExtract Python Sidecar
JSON-RPC server communicating over stdin/stdout with the Electron main process.
"""

import os
import sys
import json
import time
import tempfile

# ── UTF-8 on the pipes ────────────────────────────────────────────────────────
# Electron writes and reads UTF-8.  On Windows, Python opens a pipe with the
# ANSI code page (cp1252) unless PYTHONUTF8 or PYTHONIOENCODING is set, and the
# PyInstaller-built engine can't count on those, so non-ASCII text in a request
# (a backup under C:\Users\José, a conversation named with an emoji) arrived
# garbled.  Set the encoding here, before anything is read or written.  A byte
# that isn't UTF-8 becomes U+FFFD rather than ending the engine.  (Tests that
# import this module may have swapped the streams for ones without reconfigure.)
for _stream, _errors in ((sys.stdin, "replace"), (sys.stdout, "strict"), (sys.stderr, "backslashreplace")):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors=_errors)

# ── Stdout guard ──────────────────────────────────────────────────────────────
# JSON-RPC uses stdout as its transport channel.  Any non-JSON text printed to
# stdout by third-party libraries (e.g. "WARN: decrypted N bytes…" from
# iphone_backup_decrypt) corrupts the protocol and causes Electron to fail to
# parse responses.  Fix: save the real stdout, then replace sys.stdout with
# stderr so that all incidental library output is harmlessly redirected.  The
# four places in this file that legitimately emit JSON-RPC write directly to
# _rpc_out instead of relying on print().
_rpc_out = sys.stdout
sys.stdout = sys.stderr


_LOG_PATH = os.environ.get('OPENEXTRACT_LOG_PATH') or os.path.join(tempfile.gettempdir(), 'python_log.txt')


def _tlog(msg: str) -> None:
    """Append a timestamped line to the log file."""
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def _log_rpc_error(method, message: str) -> None:
    """Note a failed call in the log as "[RPC ERROR] ...", the entries feedback reports include."""
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[RPC ERROR] {method}: {message}\n")
    except Exception:
        pass
    print(f"[RPC ERROR] {method}: {message}", file=sys.stderr, flush=True)


# ── Sending a result ──────────────────────────────────────────────────────────
# A result that json can't write used to end the engine: json.dumps raised outside
# handle_request's try, so the process exited and took every call waiting
# behind it along (in-app reports OE-26 to OE-28: an iOS 6 backup's photos
# came back with their UUIDs as raw bytes). Now raw bytes go as text, and a
# result that still can't be written becomes an error naming the method.

def _bytes_as_text(raw: bytes) -> str:
    """Raw bytes for JSON: the text they hold when they are UTF-8 text, else hex."""
    try:
        text = raw.decode("utf-8").rstrip("\x00")
    except UnicodeDecodeError:
        return raw.hex()
    if any(ch < " " and ch not in "\t\n\r" for ch in text):
        return raw.hex()  # binary that happens to be valid UTF-8
    return text


def _without_bytes(value, path: str, found: dict):
    """``value`` with every bytes object in it turned into text.

    Counts each place one was found in ``found``, by a path like
    ``result.photos[].uuid`` (list positions left out, so a list is one place).
    """
    if isinstance(value, (bytes, bytearray, memoryview)):
        found[path] = found.get(path, 0) + 1
        return _bytes_as_text(bytes(value))
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if isinstance(key, (bytes, bytearray, memoryview)):
                key = _bytes_as_text(bytes(key))
            out[key] = _without_bytes(item, f"{path}.{key}" if path else str(key), found)
        return out
    if isinstance(value, (list, tuple)):
        return [_without_bytes(item, f"{path}[]", found) for item in value]
    return value


def encode_response(response: dict, method=None) -> str:
    """One JSON-RPC response as a line of JSON. Never raises.

    A result holding raw bytes is sent with them as text, and the log says
    where they were so the reader that returned them can be fixed. A result
    that still can't be written (an object json doesn't know) is replaced by
    a JSON-RPC error that names the method, and the engine carries on.
    """
    try:
        return json.dumps(response)
    except (TypeError, ValueError, RecursionError):
        pass
    found: dict = {}
    try:
        return_line = json.dumps(_without_bytes(response, "", found))
        failure = None
    except Exception as e:  # noqa: BLE001  anything at all: the engine must answer
        return_line, failure = None, e
    if found:
        places = ", ".join(p + (f" ({n} values)" if n > 1 else "") for p, n in found.items())
        _log_rpc_error(method, f"sent raw bytes as text at {places}")
    if failure is None:
        return return_line
    _log_rpc_error(method, f"couldn't send the result: {type(failure).__name__}: {failure}")
    error = {
        "code": -32603,
        "message": f"OpenExtract couldn't send the result of {method}: {type(failure).__name__}: {failure}",
    }
    try:
        return json.dumps({"id": response.get("id"), "error": error})
    except (TypeError, ValueError):
        return json.dumps({"id": None, "error": error})

from backup import BackupManager  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from contacts import ContactResolver  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from voicemail import VoicemailExtractor  # noqa: E402
from calls import CallExtractor  # noqa: E402
from notes import NoteExtractor  # noqa: E402
from browser_history import BrowserHistoryExtractor  # noqa: E402
from whatsapp import WhatsAppExtractor  # noqa: E402
from podcasts import PodcastExtractor  # noqa: E402
from message_recovery import MessageRecoveryExtractor  # noqa: E402
from device_backup import DeviceBackupManager  # noqa: E402
from stats import StatsComputer  # noqa: E402
from year_counts import YearCounter  # noqa: E402


class SidecarServer:
    def __init__(self):
        self.backup_manager = BackupManager()
        self.message_extractor = MessageExtractor()
        self.contact_resolver = ContactResolver()
        self.photo_extractor = PhotoExtractor()
        self.voicemail_extractor = VoicemailExtractor()
        self.call_extractor = CallExtractor()
        self.note_extractor = NoteExtractor()
        self.browser_history_extractor = BrowserHistoryExtractor()
        self.whatsapp_extractor = WhatsAppExtractor()
        self.podcast_extractor = PodcastExtractor()
        self.message_recovery_extractor = MessageRecoveryExtractor()
        self.device_backup_manager = DeviceBackupManager()
        self.stats_computer = StatsComputer(self.photo_extractor, self.whatsapp_extractor, self.podcast_extractor)
        self.year_counter = YearCounter(
            self.message_extractor, self.photo_extractor, self.call_extractor,
            self.note_extractor, self.browser_history_extractor,
        )

        # Method dispatch table
        self.methods = {
            "ping": self.ping,
            "list_backups": self.list_backups,
            "open_backup": self.open_backup,
            "validate_password": self.validate_password,
            "get_backup_size": self.get_backup_size,
            "list_conversations": self.list_conversations,
            "get_messages": self.get_messages,
            "get_attachment": self.get_attachment,
            "get_message_offset": self.get_message_offset,
            "search_messages": self.search_messages,
            "list_albums": self.list_albums,
            "list_photos": self.list_photos,
            "get_photo_thumbnail": self.get_photo_thumbnail,
            "get_photo": self.get_photo,
            "get_photo_path": self.get_photo_path,
            "get_photo_metadata": self.get_photo_metadata,
            "list_voicemails": self.list_voicemails,
            "get_voicemail_audio": self.get_voicemail_audio,
            "list_calls": self.list_calls,
            "list_contacts": self.list_contacts,
            "list_notes": self.list_notes,
            "export_conversation": self.export_conversation,
            "export_conversations": self.export_conversations,
            "export_photos": self.export_photos,
            "export_voicemails": self.export_voicemails,
            "export_calls": self.export_calls,
            "export_notes": self.export_notes,
            # Browser history
            "has_browser_history": self.has_browser_history,
            "list_browser_history": self.list_browser_history,
            "export_browser_history": self.export_browser_history,
            # WhatsApp: its own methods, because its ids overlap with Messages'
            "list_whatsapp_chats": self.list_whatsapp_chats,
            "get_whatsapp_messages": self.get_whatsapp_messages,
            "get_whatsapp_message_offset": self.get_whatsapp_message_offset,
            "search_whatsapp_messages": self.search_whatsapp_messages,
            "get_whatsapp_attachment": self.get_whatsapp_attachment,
            "export_whatsapp_chat": self.export_whatsapp_chat,
            "export_whatsapp_chats": self.export_whatsapp_chats,
            # Podcasts
            "list_podcasts": self.list_podcasts,
            "list_podcast_episodes": self.list_podcast_episodes,
            "export_podcasts": self.export_podcasts,
            # Record recovery
            "recover_messages": self.recover_messages,
            "export_recovered_messages": self.export_recovered_messages,
            # Utility
            "write_file": self.write_file,
            # Aggregate stats
            "get_aggregate_stats": self.get_aggregate_stats,
            "get_backup_stats": self.get_backup_stats,
            # Year view
            "get_year_counts": self.get_year_counts,
            "get_messages_on_day": self.get_messages_on_day,
            # Live device backup
            "backup.list_devices": self.backup_list_devices,
            "backup.install_device_support": self.backup_install_device_support,
            "backup.pair_device": self.backup_pair_device,
            "backup.start": self.backup_start,
        }

    # ── Notification helpers ──────────────────────────────────────────────────

    def send_notification(self, method: str, params: dict) -> None:
        """
        Write a JSON-RPC *notification* (no id field) directly to stdout.

        Notifications are one-way messages pushed from the sidecar to Electron
        *during* a long-running request.  Unlike responses they carry no id and
        are never matched against a pending request — Electron's sidecar.ts
        routes them to a separate notificationHandler callback instead.

        This is used by backup.start to stream real-time progress events while
        the backup RPC call is still in progress, and by saves (export.progress).
        """
        notification = {"jsonrpc": "2.0", "method": method, "params": params}
        _rpc_out.write(json.dumps(notification) + "\n")
        _rpc_out.flush()

    def _export_progress(self, kind: str):
        """
        A progress callback for a save that streams it to Electron:
            { "jsonrpc":"2.0", "method":"export.progress",
              "params": { "kind": "photos", "done": int, "total": int, "failed": int } }

        kind says which save it is, so the screen showing it can ignore others.
        """
        def notify(done: int, total: int, failed: int) -> None:
            self.send_notification("export.progress", {
                "kind": kind, "done": done, "total": total, "failed": failed,
            })
        return notify

    # ── RPC method handlers ───────────────────────────────────────────────────

    def ping(self, params):
        return {"status": "ok", "version": "0.1.0"}

    def write_file(self, params):
        """Write text content to a file path. Used by timeline export."""
        import os
        file_path = params["path"]
        content = params["content"]
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"status": "ok", "path": file_path}

    def list_backups(self, params):
        custom_path = params.get("path")
        return self.backup_manager.list_backups(custom_path=custom_path)

    def open_backup(self, params):
        udid = params["udid"]
        password = params.get("password")
        backup_dir = params.get("backup_dir")
        # Clear cached contacts so they are reloaded from the (re)opened backup
        self.contact_resolver.clear_cache(udid)
        # WhatsApp's names and file list too (a reopened backup is a new
        # accessor anyway; this keeps a backup made again in place honest)
        self.whatsapp_extractor.clear_cache()
        return self.backup_manager.open_backup(udid, password=password, backup_dir=backup_dir)

    def validate_password(self, params):
        udid = params["udid"]
        password = params["password"]
        backup_dir = params.get("backup_dir")
        return self.backup_manager.validate_password(udid, password, backup_dir=backup_dir)

    def get_backup_size(self, params):
        backup_dir = params["backup_dir"]
        return self.backup_manager.get_backup_size(backup_dir)

    def list_conversations(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.list_conversations(backup, contacts)

    def get_messages(self, params):
        udid = params["udid"]
        chat_id = params["chat_id"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 50)
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.get_messages(
            backup, chat_id, contacts, offset, limit, date_from, date_to
        )

    def get_attachment(self, params):
        udid = params["udid"]
        attachment_id = params["attachment_id"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.message_extractor.get_attachment(backup, attachment_id)

    def get_message_offset(self, params):
        """Where one message sits in its conversation, for opening the conversation at it."""
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.message_extractor.get_message_offset(backup, params["chat_id"], params["message_id"])

    def search_messages(self, params):
        udid = params["udid"]
        query = params["query"]
        chat_id = params.get("chat_id")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        limit = params.get("limit", 5000)
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.search_messages(
            backup, query, contacts, chat_id, date_from=date_from, date_to=date_to, limit=limit
        )

    def list_albums(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.list_albums(backup)

    def list_photos(self, params):
        udid = params["udid"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 100)
        album_id = params.get("album_id")
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.list_photos(backup, offset, limit, album_id)

    def get_photo_metadata(self, params):
        udid = params["udid"]
        asset_uuid = params["asset_uuid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.get_photo_metadata(backup, asset_uuid)

    def get_photo_thumbnail(self, params):
        udid = params["udid"]
        file_hash = params["file_hash"]
        size = params.get("size", 200)
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.get_thumbnail(backup, file_hash, size)

    def get_photo(self, params):
        udid = params["udid"]
        file_hash = params["file_hash"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.get_photo(backup, file_hash)

    def get_photo_path(self, params):
        """Return the on-disk file path for a photo/video (no base64 encoding)."""
        udid = params["udid"]
        file_hash = params["file_hash"]
        backup = self.backup_manager.get_open_backup(udid)
        path = self.photo_extractor._resolve_file(backup, file_hash)
        if not path:
            return {"error": "File not found"}
        return {"path": path}

    def list_voicemails(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.voicemail_extractor.list_voicemails(backup, contacts)

    def get_voicemail_audio(self, params):
        udid = params["udid"]
        voicemail_id = params["voicemail_id"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.voicemail_extractor.get_audio(backup, voicemail_id)

    def list_calls(self, params):
        udid = params["udid"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 100)
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.call_extractor.list_calls(backup, contacts, offset, limit)

    def list_contacts(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.contact_resolver.list_contacts(backup)

    def list_notes(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.note_extractor.list_notes(backup)

    def export_conversation(self, params):
        udid = params["udid"]
        chat_id = params["chat_id"]
        fmt = params.get("format", "txt")
        output_dir = params.get("output_dir", ".")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        query = params.get("query")
        display_name = params.get("display_name")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.export_conversation(
            backup, chat_id, contacts, fmt, output_dir,
            date_from=date_from, date_to=date_to, query=query,
            display_name=display_name
        )

    def export_conversations(self, params):
        udid = params["udid"]
        chat_ids = params["chat_ids"]
        conversation_names = params.get("conversation_names", {})
        fmt = params.get("format", "txt")
        output_dir = params.get("output_dir", ".")
        mode = params.get("mode", "separate")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        query = params.get("query")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        # conversation_names comes as JSON object with string keys; convert to int keys
        conv_names = {int(k): v for k, v in conversation_names.items()}
        return self.message_extractor.export_conversations(
            backup, chat_ids, conv_names, contacts, fmt, output_dir,
            mode=mode, date_from=date_from, date_to=date_to, query=query
        )

    def export_photos(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        options = params.get("options", {})
        # Backwards-compat: honour flat include_videos param if no options dict
        if not options and "include_videos" in params:
            options = {"include_videos": params["include_videos"]}
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.export_photos(
            backup, output_dir, options, on_progress=self._export_progress("photos")
        )

    def export_voicemails(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.voicemail_extractor.export_voicemails(backup, contacts, output_dir)

    def export_calls(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.call_extractor.export_calls_csv(backup, contacts, output_dir)

    def export_notes(self, params):
        udid = params["udid"]
        note_ids = params["note_ids"]
        fmt = params.get("format", "pdf")
        output_dir = params["output_dir"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.note_extractor.export_notes(backup, note_ids, fmt, output_dir)

    # ── Browser history ──────────────────────────────────────────────────────

    def has_browser_history(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.browser_history_extractor.has_browser_history(backup)

    def list_browser_history(self, params):
        udid = params["udid"]
        browser = params.get("browser", "all")
        offset = params.get("offset", 0)
        limit = params.get("limit", 0)
        backup = self.backup_manager.get_open_backup(udid)
        return self.browser_history_extractor.list_browser_history(
            backup, browser, offset, limit
        )

    def export_browser_history(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        browser = params.get("browser", "all")
        backup = self.backup_manager.get_open_backup(udid)
        return self.browser_history_extractor.export_browser_history_csv(
            backup, output_dir, browser
        )

    # ── WhatsApp ─────────────────────────────────────────────────────────────
    # ChatStorage.sqlite's ids overlap with sms.db's, so none of these may be
    # handed a Messages id, and no Messages method a WhatsApp one.

    def list_whatsapp_chats(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.whatsapp_extractor.list_conversations(backup, contacts)

    def get_whatsapp_messages(self, params):
        """One page of a chat, in arrival order (each message's ``sort``), newest page first."""
        udid = params["udid"]
        chat_id = params["chat_id"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 50)
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.whatsapp_extractor.get_messages(
            backup, chat_id, contacts, offset, limit, date_from, date_to
        )

    def get_whatsapp_message_offset(self, params):
        """Where one message sits in its chat, for opening the chat at it."""
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.whatsapp_extractor.get_message_offset(backup, params["chat_id"], params["message_id"])

    def search_whatsapp_messages(self, params):
        udid = params["udid"]
        query = params["query"]
        chat_id = params.get("chat_id")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        limit = params.get("limit", 5000)
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.whatsapp_extractor.search_messages(
            backup, query, contacts, chat_id, date_from=date_from, date_to=date_to, limit=limit
        )

    def get_whatsapp_attachment(self, params):
        """A media file as base64, or (as_file) a copy on disk to open in another app."""
        udid = params["udid"]
        attachment_id = params["attachment_id"]
        thumbnail = bool(params.get("thumbnail", False))
        as_file = bool(params.get("as_file", False))
        backup = self.backup_manager.get_open_backup(udid)
        return self.whatsapp_extractor.get_attachment(backup, attachment_id, thumbnail=thumbnail, as_file=as_file)

    def export_whatsapp_chat(self, params):
        udid = params["udid"]
        chat_id = params["chat_id"]
        fmt = params.get("format", "txt")
        output_dir = params.get("output_dir", ".")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        query = params.get("query")
        display_name = params.get("display_name")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.whatsapp_extractor.export_conversation(
            backup, chat_id, contacts, fmt, output_dir,
            date_from=date_from, date_to=date_to, query=query, display_name=display_name
        )

    def export_whatsapp_chats(self, params):
        udid = params["udid"]
        chat_ids = params["chat_ids"]
        conversation_names = params.get("conversation_names", {})
        fmt = params.get("format", "txt")
        output_dir = params.get("output_dir", ".")
        mode = params.get("mode", "separate")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        query = params.get("query")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        # conversation_names comes as a JSON object with string keys
        names = {int(k): v for k, v in conversation_names.items()}
        return self.whatsapp_extractor.export_conversations(
            backup, chat_ids, names, contacts, fmt, output_dir,
            mode=mode, date_from=date_from, date_to=date_to, query=query
        )

    # ── Podcasts ─────────────────────────────────────────────────────────────
    # The Apple Podcasts library (MTLibrary.sqlite). Episode audio is never in
    # a backup, so nothing here reads any: only shows, listening history and
    # the feed addresses.

    def list_podcasts(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.podcast_extractor.list_podcasts(backup)

    def list_podcast_episodes(self, params):
        """Episodes, newest published first: one show's (podcast_id), or every
        show's; only those listened to with listened_only."""
        udid = params["udid"]
        podcast_id = params.get("podcast_id")
        if podcast_id is not None:
            podcast_id = int(podcast_id)
        listened_only = bool(params.get("listened_only", False))
        backup = self.backup_manager.get_open_backup(udid)
        return self.podcast_extractor.list_episodes(backup, podcast_id=podcast_id, listened_only=listened_only)

    def export_podcasts(self, params):
        """Save as OPML (the followed shows, for another podcast app) or CSV (every show and episode)."""
        udid = params["udid"]
        output_dir = params["output_dir"]
        fmt = params.get("format", "opml")
        backup = self.backup_manager.get_open_backup(udid)
        return self.podcast_extractor.export_podcasts(backup, output_dir, fmt)

    # ── Record recovery ──────────────────────────────────────────────────────

    def recover_messages(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_recovery_extractor.recover_messages(backup, contacts)

    def export_recovered_messages(self, params):
        udid = params["udid"]
        fmt = params.get("format", "html")
        output_dir = params["output_dir"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_recovery_extractor.export_recovered_messages(
            backup, contacts, fmt, output_dir
        )

    # ── Backup stats dashboard ─────────────────────────────────────────────

    def get_backup_stats(self, params):
        """Return comprehensive statistics for a single backup."""
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.stats_computer.compute(backup, contacts)

    # ── Year view ────────────────────────────────────────────────────────────

    def get_year_counts(self, params):
        """Return counts per day per type for one year, plus the years the backup holds."""
        udid = params["udid"]
        year = int(params["year"])
        types = params.get("types")
        identifiers = params.get("identifiers")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.year_counter.year_counts(backup, contacts, year, types, identifiers)

    def get_messages_on_day(self, params):
        """Return every message on one local day (YYYY-MM-DD), by conversation."""
        udid = params["udid"]
        day = params["day"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.year_counter.messages_on_day(backup, contacts, day)

    # ── Aggregate stats ──────────────────────────────────────────────────────

    def get_aggregate_stats(self, params):
        """Return aggregate statistics across all opened backups."""
        from ios_backup_core.db import connect_readonly, get_database
        stats = {
            "total_devices": 0,
            "total_size_gb": 0.0,
            "total_messages": 0,
        }
        for udid, backup in self.backup_manager._open_backups.items():
            stats["total_devices"] += 1
            stats["total_size_gb"] += getattr(backup, "size_gb", 0) or 0
            try:
                sms_path = get_database(backup, "Library/SMS/sms.db", "HomeDomain")
                if sms_path:
                    conn = connect_readonly(sms_path, backup)
                    count = conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
                    stats["total_messages"] += count
                    conn.close()
            except Exception:
                pass
        return stats

    # ── Live-device backup ────────────────────────────────────────────────────

    def backup_list_devices(self, params):
        """
        Return all iPhone/iPad devices currently reachable via USB or Wi-Fi.
        Each entry: { udid, name, ios_version, connection_type: "usb"|"wifi" }.
        """
        return self.device_backup_manager.list_devices()

    def backup_install_device_support(self, params):
        """
        Windows: install and start Apple Devices, which Windows needs to talk to an
        iPhone. Returns { installed: true }; takes a minute or more.
        """
        return self.device_backup_manager.install_device_support()

    def backup_pair_device(self, params):
        """
        Ask the iPhone with params["udid"] to trust this computer, without waiting.
        Returns { state: "trusted" | "waiting" | "locked" | "denied" }; the app calls
        it again every couple of seconds until "trusted" or "denied".
        """
        return self.device_backup_manager.pair_device(params["udid"])

    def backup_start(self, params):
        """
        Initiate a full backup of the device identified by params["udid"].

        Progress is streamed to Electron as JSON-RPC notifications:
            { "jsonrpc":"2.0", "method":"backup.progress",
              "params": { "phase": str, "percent": int,
                          "files_done": int, "files_total": int,
                          "bytes_done": int (received from the iPhone so far,
                                             also sent once a second while it grows) } }

        Phases: "negotiating" → "waiting" (for the iPhone; still 0%) → "passcode"
        (if it asks for its passcode to allow the backup) → "backing_up" → "finalizing"

        Returns on completion: { "success": true, "backup_path": "..." }
        """
        udid = params["udid"]
        output_dir = params["output_dir"]
        encrypted = params.get("encrypted", False)
        password = params.get("password")

        def _notify(phase: str, percent: int, files_done: int, files_total: int, bytes_done: int = 0) -> None:
            self.send_notification("backup.progress", {
                "phase": phase,
                "percent": percent,
                "files_done": files_done,
                "files_total": files_total,
                "bytes_done": bytes_done,
            })

        return self.device_backup_manager.start_backup(
            udid=udid,
            output_dir=output_dir,
            encrypted=encrypted,
            password=password,
            notify=_notify,
        )

    def handle_request(self, request):
        if not isinstance(request, dict):
            # A batch array, a string, a number or null: answer instead of crashing on .get().
            return {
                "id": None,
                "error": {"code": -32600, "message": "Invalid Request: expected a JSON object"},
            }
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})

        if not isinstance(method, str) or method not in self.methods:
            return {
                "id": req_id,
                "error": {"code": -32601, "message": f"Unknown method: {method}"},
            }

        try:
            t0 = time.perf_counter()
            result = self.methods[method](params)
            _tlog(f"{method} total={time.perf_counter()-t0:.3f}s")
            return {"id": req_id, "result": result}
        except Exception as e:
            import traceback
            err_str = traceback.format_exc()
            try:
                with open(_LOG_PATH, "a", encoding="utf-8") as f:
                    f.write(f"[RPC ERROR] {method}: {err_str}\n")
            except Exception:
                pass
            traceback.print_exc(file=sys.stderr)
            return {
                "id": req_id,
                "error": {"code": -32000, "message": str(e)},
            }

    def run(self):
        """Main loop: read JSON-RPC requests from stdin, write responses to stdout."""
        _rpc_out.write('{"status":"ready"}\n')  # Signal to Electron that we're alive
        _rpc_out.flush()

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                response = {
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {e}"},
                }
                _rpc_out.write(json.dumps(response) + "\n")
                _rpc_out.flush()
                continue

            response = self.handle_request(request)
            method = request.get("method") if isinstance(request, dict) else None
            _rpc_out.write(encode_response(response, method) + "\n")
            _rpc_out.flush()


if __name__ == "__main__":
    import sys
    if "--debug" in sys.argv:
        try:
            import debugpy
            # Loopback only: debugpy is unauthenticated and allows arbitrary code execution.
            debugpy.listen(("127.0.0.1", 5678))
            print('{"status":"info", "message":"debugpy listening on port 5678. Debugger can attach at any time!"}', file=sys.stderr)
        except Exception as e:
            print(f'{{"status":"error", "message":"Failed to start debugger: {e}"}}', file=sys.stderr)

    server = SidecarServer()
    server.run()
