"""
Call history extraction from CallHistory.storedata.
"""

import sqlite3
import csv
import os
from datetime import datetime, timezone
from messages import apple_date_to_iso

# Seconds between Unix epoch (1970-01-01) and Apple epoch (2001-01-01)
APPLE_EPOCH_OFFSET = 978307200


class CallExtractor:
    """Extracts call history from iOS backups."""

    CALL_HISTORY_PATH = "Library/CallHistoryDB/CallHistory.storedata"

    def _clean_phone_number(self, address: str) -> str:
        """Strip non-numeric characters for better matching, except +."""
        if not address:
            return ""
        return ''.join(c for c in address if c.isdigit() or c == '+')

    def _resolve_contact(self, address: str, contacts: dict) -> str:
        if not address:
            return "Unknown"
        
        # Exact match
        if address in contacts:
            return contacts[address]
        
        clean_address = self._clean_phone_number(address)
        if not clean_address:
            # Maybe it's an email (FaceTime)
            if "@" in address and address.lower() in contacts:
                return contacts[address.lower()]
            return address

        # Clean match
        if clean_address in contacts:
            return contacts[clean_address]
        
        # Try US country code variants
        if len(clean_address) == 10 and f"+1{clean_address}" in contacts:
            return contacts[f"+1{clean_address}"]
        if clean_address.startswith("+1") and clean_address[2:] in contacts:
            return contacts[clean_address[2:]]
        
        return address

    def _find_db_paths(self, backup) -> list:
        """
        Return all candidate call history DB paths by searching the manifest.
        Also extracts any accompanying WAL/SHM files so SQLite can read
        un-checkpointed records automatically.
        """
        candidates = []
        seen_hashes = set()

        entries = backup.list_files(path_like="%CallHistory%")
        for entry in entries:
            rel_path = entry.get("path", "")
            domain = entry.get("domain", "HomeDomain")
            file_hash = entry.get("hash", "")

            if not (rel_path.endswith(".storedata") or rel_path.endswith(".db")):
                # Still extract WAL/SHM so the main DB opener can find them
                if rel_path.endswith("-wal") or rel_path.endswith("-shm"):
                    backup.get_file(rel_path, domain=domain)
                continue

            if file_hash in seen_hashes:
                continue

            p = backup.get_file(rel_path, domain=domain)
            if p:
                seen_hashes.add(file_hash)
                candidates.append(p)
                # Pre-extract WAL and SHM so SQLite picks them up automatically
                backup.get_file(rel_path + "-wal", domain=domain)
                backup.get_file(rel_path + "-shm", domain=domain)

        return candidates

    def _read_db(self, db_path: str, seen_ids: set) -> list:
        """Read all call records from a single DB, skipping IDs already seen."""
        rows_out = []
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = TRUE")
        conn.execute("PRAGMA synchronous = OFF")
        conn.execute("PRAGMA cache_size = -10000")
        conn.execute("PRAGMA temp_store = MEMORY")
        cursor = conn.cursor()
        try:
            cursor.execute("PRAGMA table_info(ZCALLRECORD)")
            columns = [info[1] for info in cursor.fetchall()]
            service_col = "ZSERVICE_PROVIDER" if "ZSERVICE_PROVIDER" in columns else "NULL"
            video_col = "ZIS_VIDEO" if "ZIS_VIDEO" in columns else "NULL"
            rows = cursor.execute(f"""
                SELECT Z_PK, ZADDRESS AS address, ZDATE AS date, ZDURATION AS duration,
                       ZCALLTYPE AS call_type, ZORIGINATED AS originated,
                       ZANSWERED AS answered,
                       {service_col} AS service_provider,
                       {video_col} AS is_video
                FROM ZCALLRECORD ORDER BY ZDATE DESC
            """).fetchall()
        except sqlite3.Error:
            try:
                rows = cursor.execute("""
                    SELECT ROWID AS Z_PK, address, date, duration,
                           flags AS call_type, read AS answered,
                           NULL AS originated, NULL AS service_provider, NULL AS is_video
                    FROM call ORDER BY date DESC
                """).fetchall()
            except sqlite3.Error:
                conn.close()
                return rows_out
        conn.close()

        for row in rows:
            pk = row["Z_PK"]
            if pk in seen_ids:
                continue
            seen_ids.add(pk)
            rows_out.append(row)
        return rows_out

    def _read_facetime_from_sms(self, backup, contacts: dict) -> list:
        """
        Read FaceTime calls from sms.db (item_type 1=video, 2=audio).
        These are not stored in CallHistory.storedata so they supplement it.
        """
        db_path = backup.get_file("Library/SMS/sms.db", domain="HomeDomain")
        if not db_path:
            return []

        # Also extract WAL for sms.db
        backup.get_file("Library/SMS/sms.db-wal", domain="HomeDomain")
        backup.get_file("Library/SMS/sms.db-shm", domain="HomeDomain")

        rows_out = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only = TRUE")

            # Detect nanosecond timestamps
            sample = conn.execute("SELECT date FROM message WHERE item_type IN (1,2) LIMIT 1").fetchone()
            uses_ns = sample and float(sample[0]) > 1_000_000_000_000 if sample else False

            rows = conn.execute("""
                SELECT m.ROWID, m.date, m.is_from_me, m.item_type,
                       h.id AS address
                FROM message m
                LEFT JOIN handle h ON m.handle_id = h.ROWID
                WHERE m.item_type IN (1, 2)
                ORDER BY m.date DESC
            """).fetchall()
            conn.close()

            for row in rows:
                raw_ts = float(row["date"] or 0)
                if not raw_ts:
                    continue
                apple_ts = raw_ts / 1_000_000_000 if uses_ns else raw_ts
                unix_ts = apple_ts + APPLE_EPOCH_OFFSET
                iso_date = datetime.fromtimestamp(unix_ts, timezone.utc).isoformat()

                address = row["address"] or ""
                contact_name = self._resolve_contact(address, contacts)
                direction = "outgoing" if row["is_from_me"] else "incoming"
                app_name = "FaceTime Video" if row["item_type"] == 1 else "FaceTime Audio"

                rows_out.append({
                    "_unix_ts": unix_ts,
                    "call_id": f"ft_{row['ROWID']}",
                    "address": address,
                    "contact_name": contact_name,
                    "date": iso_date,
                    "duration": 0,
                    "direction": direction,
                    "status": "answered",
                    "app": app_name,
                })
        except Exception:
            pass
        return rows_out

    def _read_voicemails_as_calls(self, backup, contacts: dict) -> list:
        """
        Read voicemail.db and return each entry as a synthetic call record.
        Voicemails are missed incoming calls — they supplement the call history
        when the CallHistory DB has been pruned by iOS.
        Returns list of dicts with the same shape as the final call dicts,
        plus a '_unix_ts' key for deduplication sorting.
        """
        db_path = backup.get_file("Library/Voicemail/voicemail.db", domain="HomeDomain")
        if not db_path:
            return []

        rows_out = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only = TRUE")
            rows = conn.execute("""
                SELECT ROWID, sender, date, duration
                FROM voicemail
                WHERE (trashed_date = 0 OR trashed_date IS NULL)
            """).fetchall()
            conn.close()

            for row in rows:
                sender = row["sender"] or ""
                unix_ts = int(row["date"]) if row["date"] else 0
                if not unix_ts:
                    continue
                iso_date = datetime.fromtimestamp(unix_ts, timezone.utc).isoformat()
                contact_name = self._resolve_contact(sender, contacts)
                rows_out.append({
                    "_unix_ts": unix_ts,
                    "_apple_ts": unix_ts - APPLE_EPOCH_OFFSET,
                    "call_id": f"vm_{row['ROWID']}",
                    "address": sender,
                    "contact_name": contact_name,
                    "date": iso_date,
                    "duration": row["duration"] or 0,
                    "direction": "incoming",
                    "status": "missed",
                    "app": "Phone",
                })
        except Exception:
            pass
        return rows_out

    def list_calls(self, backup, contacts: dict,
                   offset: int = 0, limit: int = 200) -> dict:
        """List call history records, supplemented with voicemail records."""
        db_paths = self._find_db_paths(backup)

        all_rows = []
        seen_ids = set()
        errors = []
        for db_path in db_paths:
            try:
                all_rows.extend(self._read_db(db_path, seen_ids))
            except Exception as e:
                errors.append(str(e))

        # Build the structured call list from CallHistory rows
        call_records = []
        # Track (normalized_number, minute_bucket) to deduplicate against voicemails
        call_fingerprints = set()

        for row in all_rows:
            address = row["address"] or ""
            contact_name = self._resolve_contact(address, contacts)
            originated = row["originated"]
            answered = row["answered"]

            if originated is not None:
                direction = "outgoing" if originated else "incoming"
            else:
                direction = "outgoing" if row.get("call_type", 0) == 5 else "incoming"

            if answered is not None:
                status = "answered" if answered else "missed"
            else:
                if direction == "incoming":
                    status = "answered" if row.get("duration", 0) > 0 else "missed"
                else:
                    status = "answered"

            provider = row["service_provider"]
            app_name = "Phone"
            if provider:
                p_lower = provider.lower()
                if "facetime" in p_lower:
                    app_name = "FaceTime Video" if row["is_video"] else "FaceTime Audio"
                elif "whatsapp" in p_lower:
                    app_name = "WhatsApp"
                elif "skype" in p_lower:
                    app_name = "Skype"
                elif "messenger" in p_lower:
                    app_name = "Messenger"
                elif "telegram" in p_lower:
                    app_name = "Telegram"
                elif "viber" in p_lower:
                    app_name = "Viber"
                elif "signal" in p_lower:
                    app_name = "Signal"
                elif "instagram" in p_lower:
                    app_name = "Instagram"
                elif "telephony" not in p_lower:
                    app_name = provider

            apple_ts = row["date"] or 0
            unix_ts = apple_ts + APPLE_EPOCH_OFFSET
            clean_num = self._clean_phone_number(address)
            # Bucket by minute to allow slight timestamp drift
            call_fingerprints.add((clean_num or address.lower(), int(unix_ts) // 60))

            call_records.append({
                "_unix_ts": unix_ts,
                "call_id": row["Z_PK"],
                "address": address,
                "contact_name": contact_name,
                "date": apple_date_to_iso(apple_ts),
                "duration": row["duration"],
                "direction": direction,
                "status": status,
                "app": app_name,
            })

        # Merge supplementary sources for calls not already present
        def _merge(extra_records):
            for rec in extra_records:
                clean_num = self._clean_phone_number(rec["address"])
                key = (clean_num or rec["address"].lower(), int(rec["_unix_ts"]) // 60)
                if key not in call_fingerprints:
                    call_fingerprints.add(key)
                    call_records.append(rec)

        _merge(self._read_voicemails_as_calls(backup, contacts))
        _merge(self._read_facetime_from_sms(backup, contacts))

        if not call_records:
            msg = errors[0] if errors else "Call history not found. Apple requires backups to be encrypted to include call logs. Please enable 'Encrypt local backup' in iTunes/Finder and back up your device again."
            return {"calls": [], "error": msg}

        # Sort merged results newest-first, strip internal keys, apply offset/limit
        call_records.sort(key=lambda r: r["_unix_ts"] or 0, reverse=True)
        total = len(call_records)
        page = call_records[offset:offset + limit]

        calls = [{k: v for k, v in r.items() if not k.startswith("_")} for r in page]

        return {
            "calls": calls,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def export_calls_csv(self, backup, contacts: dict, output_dir: str) -> dict:
        """Export all calls to a CSV file."""
        # Get all calls by ignoring limit
        result = self.list_calls(backup, contacts, limit=999999)
        calls = result.get("calls", [])
        
        if not calls:
            return {"success": False, "error": "No calls found to export."}
        
        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "call_history.csv")
            
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Contact Name", "Phone/Email", "Direction", "Status", "Duration (s)", "App/Service"])
                for call in calls:
                    writer.writerow([
                        call["date"],
                        call["contact_name"],
                        call["address"],
                        call["direction"].capitalize(),
                        call["status"].capitalize(),
                        call["duration"],
                        call["app"]
                    ])
                    
            return {"success": True, "path": output_path, "count": len(calls)}
        except Exception as e:
            return {"success": False, "error": str(e)}
