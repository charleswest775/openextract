#!/usr/bin/env python3
"""
OpenExtract Python Sidecar
JSON-RPC server communicating over stdin/stdout with the Electron main process.
"""

import sys
import json
import time


def _tlog(msg: str) -> None:
    """Append a timestamped line to python_log.txt."""
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

from backup import BackupManager  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from contacts import ContactResolver  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from voicemail import VoicemailExtractor  # noqa: E402
from calls import CallExtractor  # noqa: E402
from notes import NoteExtractor  # noqa: E402
from device_backup import DeviceBackupManager  # noqa: E402

# v1.0 extraction engine + new extractors
from pathlib import Path  # noqa: E402
from extraction_db import ExtractionDB  # noqa: E402
from extraction_engine import ExtractionEngine  # noqa: E402
from extractors.contacts_adapter import ContactsExtractor as ContactsExtractorV2  # noqa: E402
from extractors.messages_adapter import MessagesExtractor as MessagesExtractorV2  # noqa: E402
from extractors.calls_adapter import CallsExtractor as CallsExtractorV2  # noqa: E402
from extractors.photos_adapter import PhotosExtractor as PhotosExtractorV2  # noqa: E402
from extractors.voicemail_adapter import VoicemailExtractor as VoicemailExtractorV2  # noqa: E402
from extractors.notes_adapter import NotesExtractor as NotesExtractorV2  # noqa: E402
from extractors.locations import LocationExtractor  # noqa: E402
from extractors.safari import SafariExtractor  # noqa: E402
from extractors.calendar import CalendarExtractor  # noqa: E402
from extractors.screentime import ScreenTimeExtractor  # noqa: E402
from extractors.health import HealthExtractor  # noqa: E402
from extractors.power import PowerExtractor  # noqa: E402
from extractors.wifi import WiFiExtractor  # noqa: E402
from extractors.bluetooth import BluetoothExtractor  # noqa: E402
from extractors.notifications import NotificationExtractor  # noqa: E402
from extractors.apps import AppsExtractor  # noqa: E402
from extractors.wallet import WalletExtractor  # noqa: E402


class SidecarServer:
    def __init__(self):
        self.backup_manager = BackupManager()
        self.message_extractor = MessageExtractor()
        self.contact_resolver = ContactResolver()
        self.photo_extractor = PhotoExtractor()
        self.voicemail_extractor = VoicemailExtractor()
        self.call_extractor = CallExtractor()
        self.note_extractor = NoteExtractor()
        self.device_backup_manager = DeviceBackupManager()

        # v1.0 extraction engine — registered in priority order
        self._extraction_engine: ExtractionEngine | None = None
        self._extraction_dbs: dict[str, ExtractionDB] = {}  # keyed by UDID

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
            # Live device backup
            "backup.list_devices": self.backup_list_devices,
            "backup.start": self.backup_start,
            # v1.0 extraction engine
            "extraction.start": self.extraction_start,
            "extraction.status": self.extraction_status,
            "extraction.query": self.extraction_query,
            "extraction.search": self.extraction_search,
            # v1.0 bulk export + quick analysis
            "export.start": self.export_start,
            "analyze.quick": self.analyze_quick,
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
        the backup RPC call is still in progress.
        """
        notification = {"jsonrpc": "2.0", "method": method, "params": params}
        print(json.dumps(notification), flush=True)

    # ── RPC method handlers ───────────────────────────────────────────────────

    def ping(self, params):
        return {"status": "ok", "version": "1.0.0"}

    def list_backups(self, params):
        custom_path = params.get("path")
        return self.backup_manager.list_backups(custom_path=custom_path)

    def open_backup(self, params):
        udid = params["udid"]
        password = params.get("password")
        backup_dir = params.get("backup_dir")
        # Clear cached contacts so they are reloaded from the (re)opened backup
        self.contact_resolver.clear_cache(udid)
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

    # ── Live-device backup ────────────────────────────────────────────────────

    def backup_list_devices(self, params):
        """
        Return all iPhone/iPad devices currently reachable via USB or Wi-Fi.
        Each entry: { udid, name, ios_version, connection_type: "usb"|"wifi" }.
        """
        return self.device_backup_manager.list_devices()

    def backup_start(self, params):
        """
        Initiate a full backup of the device identified by params["udid"].

        Progress is streamed to Electron as JSON-RPC notifications:
            { "jsonrpc":"2.0", "method":"backup.progress",
              "params": { "phase": str, "percent": int,
                          "files_done": int, "files_total": int } }

        Phases: "negotiating" → "backing_up" → "finalizing"

        Returns on completion: { "success": true, "backup_path": "..." }
        """
        udid = params["udid"]
        output_dir = params["output_dir"]
        encrypted = params.get("encrypted", False)
        password = params.get("password")

        def _notify(phase: str, percent: int, files_done: int, files_total: int) -> None:
            self.send_notification("backup.progress", {
                "phase": phase,
                "percent": percent,
                "files_done": files_done,
                "files_total": files_total,
            })

        return self.device_backup_manager.start_backup(
            udid=udid,
            output_dir=output_dir,
            encrypted=encrypted,
            password=password,
            notify=_notify,
        )

    # ── v1.0 Extraction Engine ─────────────────────────────────────────────

    def _get_extraction_engine(self, udid: str) -> ExtractionEngine:
        """Get or create an ExtractionEngine for the given UDID."""
        if udid not in self._extraction_dbs:
            home = Path.home() / ".openextract" / "extractions" / udid
            home.mkdir(parents=True, exist_ok=True)
            self._extraction_dbs[udid] = ExtractionDB(home / "extraction.db")

        db = self._extraction_dbs[udid]
        engine = ExtractionEngine(db)

        # Register all extractors in priority order (P0 → P3)
        engine.register_extractor("contacts", ContactsExtractorV2)
        engine.register_extractor("messages", MessagesExtractorV2)
        engine.register_extractor("calls", CallsExtractorV2)
        engine.register_extractor("locations", LocationExtractor)

        engine.register_extractor("photos", PhotosExtractorV2)
        engine.register_extractor("safari", SafariExtractor)
        engine.register_extractor("notes", NotesExtractorV2)
        engine.register_extractor("calendar", CalendarExtractor)

        engine.register_extractor("screentime", ScreenTimeExtractor)
        engine.register_extractor("health", HealthExtractor)
        engine.register_extractor("power", PowerExtractor)
        engine.register_extractor("wifi", WiFiExtractor)

        engine.register_extractor("bluetooth", BluetoothExtractor)
        engine.register_extractor("notifications", NotificationExtractor)
        engine.register_extractor("apps", AppsExtractor)
        engine.register_extractor("voicemail", VoicemailExtractorV2)
        engine.register_extractor("wallet", WalletExtractor)

        return engine

    def extraction_start(self, params):
        """Run the full extraction pipeline against an open backup.

        params: { udid: str, backup_dir?: str }
        Returns: { total_artifacts: int, status: str }
        """
        udid = params["udid"]
        backup = self.backup_manager.get_open_backup(udid)
        backup_dir = Path(params.get("backup_dir", backup.backup_dir))
        ios_version = backup.info.get("ios_version") if backup.info else None
        backup_date = backup.info.get("last_backup_date", "") if backup.info else ""

        engine = self._get_extraction_engine(udid)

        def _notify(method: str, data: dict) -> None:
            self.send_notification(method, data)

        total = engine.extract_all(
            backup_path=backup_dir,
            backup_udid=udid,
            backup_date=backup_date,
            ios_version=ios_version,
            notify=_notify,
        )

        return {"total_artifacts": total, "status": "completed"}

    def extraction_status(self, params):
        """Return the latest extraction run status for a device.

        params: { udid: str }
        """
        udid = params.get("udid", "")
        if udid not in self._extraction_dbs:
            return {"status": "no_extractions", "runs": []}

        db = self._extraction_dbs[udid]
        rows = db.conn.execute(
            "SELECT * FROM extraction_runs ORDER BY id DESC LIMIT 5"
        ).fetchall()
        return {
            "status": "ok",
            "runs": [dict(r) for r in rows],
        }

    def extraction_query(self, params):
        """Query extracted artifacts.

        params: { udid: str, artifact_type?: str, start?: str, end?: str, limit?: int }
        """
        udid = params["udid"]
        if udid not in self._extraction_dbs:
            return {"artifacts": [], "error": "No extraction data for this device"}

        db = self._extraction_dbs[udid]
        artifacts = db.query_artifacts(
            artifact_type=params.get("artifact_type"),
            start=params.get("start"),
            end=params.get("end"),
            limit=params.get("limit", 1000),
        )
        return {"artifacts": artifacts, "count": len(artifacts)}

    def extraction_search(self, params):
        """Full-text search across extracted artifacts.

        params: { udid: str, query: str, artifact_type?: str, limit?: int }
        """
        udid = params["udid"]
        if udid not in self._extraction_dbs:
            return {"artifacts": [], "error": "No extraction data for this device"}

        db = self._extraction_dbs[udid]
        artifacts = db.search(
            query=params["query"],
            artifact_type=params.get("artifact_type"),
            limit=params.get("limit", 100),
        )
        return {"artifacts": artifacts, "count": len(artifacts)}

    # ── Bulk Export ─────────────────────────────────────────────────────

    def export_start(self, params):
        """Export extracted artifacts to a directory as JSON/CSV files.

        params: { output_dir: str, udid?: str, artifact_type?: str, format?: str }
        Returns: { exported_files: list[str], total_artifacts: int }
        """
        import csv
        import os

        output_dir = Path(params["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        fmt = params.get("format", "json")
        artifact_type = params.get("artifact_type")

        # Find a UDID to export — use explicit param or first available
        udid = params.get("udid")
        if not udid and self._extraction_dbs:
            udid = next(iter(self._extraction_dbs))
        if not udid:
            return {"error": "No extraction data available. Run an extraction first."}

        if udid not in self._extraction_dbs:
            return {"error": f"No extraction data for device {udid}"}

        db = self._extraction_dbs[udid]
        artifacts = db.query_artifacts(artifact_type=artifact_type, limit=100_000)

        if not artifacts:
            return {"exported_files": [], "total_artifacts": 0}

        exported_files: list[str] = []

        if fmt == "csv":
            # Group by artifact_type for separate CSV files
            by_type: dict[str, list[dict]] = {}
            for a in artifacts:
                by_type.setdefault(a["artifact_type"], []).append(a)

            for atype, items in by_type.items():
                filename = f"{atype}.csv"
                filepath = output_dir / filename
                keys = list(items[0].keys())
                with open(filepath, "w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=keys)
                    writer.writeheader()
                    writer.writerows(items)
                exported_files.append(str(filepath))
        else:
            # JSON export — single file
            filepath = output_dir / "extraction.json"
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(artifacts, f, indent=2, default=str)
            exported_files.append(str(filepath))

        return {"exported_files": exported_files, "total_artifacts": len(artifacts)}

    # ── Quick Analysis ────────────────────────────────────────────────

    def analyze_quick(self, params):
        """Run a quick analysis on extracted data.

        params: { objective: str, udid?: str }
        Returns: { summary: str, artifact_count: int }
        """
        objective = params.get("objective", "summary")

        # Find a UDID — use explicit param or first available
        udid = params.get("udid")
        if not udid and self._extraction_dbs:
            udid = next(iter(self._extraction_dbs))
        if not udid or udid not in self._extraction_dbs:
            return {"summary": "No extraction data available. Run an extraction first.", "artifact_count": 0}

        db = self._extraction_dbs[udid]

        if objective == "messages_today":
            from datetime import datetime, timezone
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            artifacts = db.query_artifacts(artifact_type="message", start=today, limit=500)
            return {
                "summary": f"Found {len(artifacts)} messages from today.",
                "artifact_count": len(artifacts),
                "artifacts": artifacts[:50],  # Return a sample
            }
        elif objective == "locations_recent":
            artifacts = db.query_artifacts(artifact_type="location", limit=100)
            return {
                "summary": f"Found {len(artifacts)} recent location records.",
                "artifact_count": len(artifacts),
                "artifacts": artifacts[:50],
            }
        elif objective == "identity_profile":
            # Aggregate contacts and message stats
            contacts = db.query_artifacts(artifact_type="contact", limit=1000)
            messages = db.query_artifacts(artifact_type="message", limit=1)
            calls = db.query_artifacts(artifact_type="call", limit=1)
            return {
                "summary": f"Profile: {len(contacts)} contacts extracted.",
                "artifact_count": len(contacts),
                "contacts_count": len(contacts),
            }
        else:
            # Generic summary
            row = db.conn.execute("SELECT COUNT(*) as cnt FROM artifacts").fetchone()
            total = row["cnt"] if row else 0
            type_counts = {}
            for r in db.conn.execute("SELECT artifact_type, COUNT(*) as cnt FROM artifacts GROUP BY artifact_type"):
                type_counts[r["artifact_type"]] = r["cnt"]
            return {
                "summary": f"Total artifacts: {total}",
                "artifact_count": total,
                "type_counts": type_counts,
            }

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
            except Exception:
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
