#!/usr/bin/env python3
"""
OpenExtract Python Sidecar
JSON-RPC server communicating over stdin/stdout with the Electron main process.
"""

import sys
import json
import traceback
import time


def _tlog(msg: str) -> None:
    """Append a timestamped line to python_log.txt."""
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

from backup import BackupManager
from messages import MessageExtractor
from contacts import ContactResolver
from photos import PhotoExtractor
from voicemail import VoicemailExtractor
from calls import CallExtractor
from notes import NoteExtractor


class SidecarServer:
    def __init__(self):
        self.backup_manager = BackupManager()
        self.message_extractor = MessageExtractor()
        self.contact_resolver = ContactResolver()
        self.photo_extractor = PhotoExtractor()
        self.voicemail_extractor = VoicemailExtractor()
        self.call_extractor = CallExtractor()
        self.note_extractor = NoteExtractor()

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
            "search_messages": self.search_messages,
            "list_albums": self.list_albums,
            "list_photos": self.list_photos,
            "get_photo_thumbnail": self.get_photo_thumbnail,
            "get_photo": self.get_photo,
            "get_photo_metadata": self.get_photo_metadata,
            "list_voicemails": self.list_voicemails,
            "get_voicemail_audio": self.get_voicemail_audio,
            "list_calls": self.list_calls,
            "list_contacts": self.list_contacts,
            "list_notes": self.list_notes,
            "export_conversation": self.export_conversation,
            "export_photos": self.export_photos,
            "export_voicemails": self.export_voicemails,
            "export_calls": self.export_calls,
            "export_notes": self.export_notes,
        }

    def ping(self, params):
        return {"status": "ok", "version": "0.1.0"}

    def list_backups(self, params):
        custom_path = params.get("path")
        return self.backup_manager.list_backups(custom_path=custom_path)

    def open_backup(self, params):
        udid = params["udid"]
        password = params.get("password")
        backup_dir = params.get("backup_dir")
        return self.backup_manager.open_backup(udid, password=password, backup_dir=backup_dir)

    def validate_password(self, params):
        udid = params["udid"]
        password = params["password"]
        return self.backup_manager.validate_password(udid, password)

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

    def search_messages(self, params):
        udid = params["udid"]
        query = params["query"]
        chat_id = params.get("chat_id")
        date_from = params.get("date_from")
        date_to = params.get("date_to")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.search_messages(
            backup, query, contacts, chat_id, date_from=date_from, date_to=date_to
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
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.export_conversation(
            backup, chat_id, contacts, fmt, output_dir,
            date_from=date_from, date_to=date_to, query=query
        )

    def export_photos(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        options = params.get("options", {})
        # Backwards-compat: honour flat include_videos param if no options dict
        if not options and "include_videos" in params:
            options = {"include_videos": params["include_videos"]}
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.export_photos(backup, output_dir, options)

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
    def handle_request(self, request):
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})

        if method not in self.methods:
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
                with open("python_log.txt", "a", encoding="utf-8") as f:
                    f.write(f"[RPC ERROR] {method}: {err_str}\n")
            except:
                pass
            traceback.print_exc(file=sys.stderr)
            return {
                "id": req_id,
                "error": {"code": -32000, "message": str(e)},
            }

    def run(self):
        """Main loop: read JSON-RPC requests from stdin, write responses to stdout."""
        print('{"status":"ready"}', flush=True)  # Signal to Electron that we're alive

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
                print(json.dumps(response), flush=True)
                continue

            response = self.handle_request(request)
            print(json.dumps(response), flush=True)


if __name__ == "__main__":
    import sys
    if "--debug" in sys.argv:
        try:
            import debugpy
            debugpy.listen(("0.0.0.0", 5678))
            print('{"status":"info", "message":"debugpy listening on port 5678. Debugger can attach at any time!"}', file=sys.stderr)
        except Exception as e:
            print(f'{{"status":"error", "message":"Failed to start debugger: {e}"}}', file=sys.stderr)

    server = SidecarServer()
    server.run()
