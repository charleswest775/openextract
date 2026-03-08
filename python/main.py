#!/usr/bin/env python3
"""
OpenExtract Python Sidecar
JSON-RPC server communicating over stdin/stdout with the Electron main process.
"""

import sys
import json
import traceback

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
            "list_conversations": self.list_conversations,
            "get_messages": self.get_messages,
            "get_attachment": self.get_attachment,
            "search_messages": self.search_messages,
            "list_photos": self.list_photos,
            "get_photo_thumbnail": self.get_photo_thumbnail,
            "get_photo": self.get_photo,
            "list_voicemails": self.list_voicemails,
            "get_voicemail_audio": self.get_voicemail_audio,
            "list_calls": self.list_calls,
            "list_contacts": self.list_contacts,
            "list_notes": self.list_notes,
            "export_conversation": self.export_conversation,
            "export_photos": self.export_photos,
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

    def list_conversations(self, params):
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.list_conversations(backup, contacts)

    def get_messages(self, params):
        udid = params["udid"]
        chat_id = params["chat_id"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 100)
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.get_messages(backup, chat_id, contacts, offset, limit)

    def get_attachment(self, params):
        udid = params["udid"]
        attachment_id = params["attachment_id"]
        backup = self.backup_manager.get_open_backup(udid)
        return self.message_extractor.get_attachment(backup, attachment_id)

    def search_messages(self, params):
        udid = params["udid"]
        query = params["query"]
        chat_id = params.get("chat_id")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.search_messages(backup, query, contacts, chat_id)

    def list_photos(self, params):
        udid = params["udid"]
        offset = params.get("offset", 0)
        limit = params.get("limit", 50)
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.list_photos(backup, offset, limit)

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
        fmt = params.get("format", "pdf")
        output_dir = params.get("output_dir", ".")
        backup = self.backup_manager.get_open_backup(udid)
        contacts = self.contact_resolver.load_contacts(backup)
        return self.message_extractor.export_conversation(
            backup, chat_id, contacts, fmt, output_dir
        )

    def export_photos(self, params):
        udid = params["udid"]
        output_dir = params["output_dir"]
        include_videos = params.get("include_videos", True)
        backup = self.backup_manager.get_open_backup(udid)
        return self.photo_extractor.export_photos(backup, output_dir, include_videos)

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
            result = self.methods[method](params)
            return {"id": req_id, "result": result}
        except Exception as e:
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
    server = SidecarServer()
    server.run()
