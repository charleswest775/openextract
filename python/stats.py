"""
Backup statistics computation.
Aggregates data across all backup databases into a single stats response.
"""

import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Optional

from messages import apple_date_to_iso, NANOSECOND_THRESHOLD


# Seconds between Unix epoch (1970) and Apple epoch (2001)
_APPLE_UNIX_DELTA = 978307200

_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _safe_connect(db_path: str) -> Optional[sqlite3.Connection]:
    """Open a SQLite DB in read-only mode with performance PRAGMAs."""
    if not db_path:
        return None
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = TRUE")
        conn.execute("PRAGMA synchronous = OFF")
        conn.execute("PRAGMA cache_size = -10000")
        conn.execute("PRAGMA temp_store = MEMORY")
        return conn
    except Exception:
        return None


def _apple_ts_to_iso(ts) -> Optional[str]:
    """Convert Apple CoreData timestamp (seconds since 2001-01-01) to ISO 8601."""
    if ts is None:
        return None
    try:
        dt = datetime(2001, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=float(ts))
        return dt.isoformat()
    except Exception:
        return None


class StatsComputer:
    """Computes comprehensive backup statistics in a single call."""

    def compute(self, backup, contacts: dict) -> dict:
        """Return all stats for a backup. Each section is independent — failures are isolated."""
        errors = []

        info = backup.info if hasattr(backup, "info") else {}
        overview = {
            "device_name": info.get("device_name", getattr(backup, "device_name", "Unknown")),
            "product_type": info.get("product_type", ""),
            "ios_version": info.get("product_version", ""),
            "last_backup": info.get("last_backup", ""),
            "encrypted": info.get("encrypted", False),
            "size_gb": info.get("size_gb", getattr(backup, "size_gb", 0)) or 0,
        }

        # Messages
        try:
            msg_stats = self._message_stats(backup, contacts)
        except Exception as e:
            msg_stats = self._empty_message_stats()
            errors.append(f"messages: {e}")

        # Photos
        try:
            photo_stats = self._photo_stats(backup)
        except Exception as e:
            photo_stats = self._empty_photo_stats()
            errors.append(f"photos: {e}")

        # Contacts
        try:
            contact_count = self._contact_count(backup)
        except Exception as e:
            contact_count = 0
            errors.append(f"contacts: {e}")

        # Calls
        try:
            call_stats = self._call_stats(backup, contacts)
        except Exception as e:
            call_stats = self._empty_call_stats()
            errors.append(f"calls: {e}")

        # Notes
        try:
            note_stats = self._note_stats(backup)
        except Exception as e:
            note_stats = {"total": 0, "avg_length_chars": 0, "longest_chars": 0}
            errors.append(f"notes: {e}")

        # Voicemails
        try:
            vm_stats = self._voicemail_stats(backup)
        except Exception as e:
            vm_stats = {"total": 0, "total_duration_seconds": 0, "read": 0, "unread": 0}
            errors.append(f"voicemails: {e}")

        overview["total_messages"] = msg_stats.get("total", 0)
        overview["total_conversations"] = msg_stats.get("total_conversations", 0)
        overview["total_photos"] = photo_stats.get("total_photos", 0)
        overview["total_videos"] = photo_stats.get("total_videos", 0)
        overview["total_contacts"] = contact_count
        overview["total_calls"] = call_stats.get("total", 0)
        overview["total_notes"] = note_stats.get("total", 0)
        overview["total_voicemails"] = vm_stats.get("total", 0)

        # Remove internal keys from sub-dicts
        msg_stats.pop("total", None)
        msg_stats.pop("total_conversations", None)
        call_stats.pop("total", None)

        return {
            "overview": overview,
            "messages": msg_stats,
            "photos": photo_stats,
            "calls": call_stats,
            "notes": note_stats,
            "voicemails": vm_stats,
            "errors": errors if errors else [],
        }

    # ── Messages ──────────────────────────────────────────────────────────────

    def _message_stats(self, backup, contacts: dict) -> dict:
        db_path = backup.get_file("Library/SMS/sms.db", "HomeDomain")
        conn = _safe_connect(db_path)
        if not conn:
            return self._empty_message_stats()

        try:
            c = conn.cursor()

            total = c.execute(
                "SELECT COUNT(DISTINCT message_id) FROM chat_message_join"
            ).fetchone()[0]
            sent = c.execute(
                "SELECT COUNT(DISTINCT m.ROWID) FROM message m "
                "JOIN chat_message_join cmj ON cmj.message_id = m.ROWID "
                "WHERE m.is_from_me = 1"
            ).fetchone()[0]
            received = total - sent

            # Attachment count
            try:
                total_attachments = c.execute("SELECT COUNT(*) FROM attachment").fetchone()[0]
            except Exception:
                total_attachments = 0

            # Date range — detect nanosecond vs second timestamps
            date_row = c.execute(
                "SELECT MIN(date), MAX(date) FROM message WHERE date > 0"
            ).fetchone()
            min_date_raw, max_date_raw = date_row[0], date_row[1]
            first_date = apple_date_to_iso(min_date_raw)
            last_date = apple_date_to_iso(max_date_raw)

            # Average messages per day
            avg_per_day = 0.0
            if first_date and last_date and total > 0:
                try:
                    d1 = datetime.fromisoformat(first_date.replace("Z", "+00:00"))
                    d2 = datetime.fromisoformat(last_date.replace("Z", "+00:00"))
                    span = (d2 - d1).days
                    if span > 0:
                        avg_per_day = round(total / span, 1)
                except Exception:
                    pass

            # iMessage vs SMS
            try:
                imessage_count = c.execute(
                    "SELECT COUNT(*) FROM message m JOIN chat_message_join cmj ON m.ROWID = cmj.message_id "
                    "JOIN chat ch ON ch.ROWID = cmj.chat_id WHERE ch.service_name = 'iMessage'"
                ).fetchone()[0]
                sms_count = total - imessage_count
            except Exception:
                imessage_count = 0
                sms_count = 0

            # Group vs 1-on-1 conversations
            try:
                group_convos = c.execute(
                    "SELECT COUNT(*) FROM chat WHERE group_id IS NOT NULL AND group_id != ''"
                ).fetchone()[0]
                total_convos = c.execute("SELECT COUNT(*) FROM chat").fetchone()[0]
                one_on_one = total_convos - group_convos
            except Exception:
                group_convos = 0
                total_convos = 0
                one_on_one = 0

            # Top 5 conversations
            top_conversations = []
            try:
                rows = c.execute("""
                    SELECT ch.ROWID, ch.chat_identifier, ch.display_name,
                           COUNT(cmj.message_id) AS msg_count
                    FROM chat ch
                    JOIN chat_message_join cmj ON ch.ROWID = cmj.chat_id
                    GROUP BY ch.ROWID
                    ORDER BY msg_count DESC
                    LIMIT 5
                """).fetchall()
                for row in rows:
                    name = row[2] or ""
                    if not name:
                        identifier = row[1] or ""
                        name = contacts.get(identifier, identifier)
                    top_conversations.append({
                        "display_name": name or "Unknown",
                        "message_count": row[3],
                    })
            except Exception:
                pass

            # Busiest day of week and hour
            # Need to handle both nanosecond and second Apple timestamps
            busiest_day = ""
            busiest_hour = -1
            try:
                is_nano = min_date_raw and float(min_date_raw) > NANOSECOND_THRESHOLD

                if is_nano:
                    date_expr = f"date / 1000000000 + {_APPLE_UNIX_DELTA}"
                else:
                    date_expr = f"date + {_APPLE_UNIX_DELTA}"

                # Busiest day of week (strftime %w: 0=Sunday, 6=Saturday)
                day_row = c.execute(f"""
                    SELECT strftime('%w', {date_expr}, 'unixepoch') AS dow, COUNT(*) AS c
                    FROM message WHERE date > 0
                    GROUP BY dow ORDER BY c DESC LIMIT 1
                """).fetchone()
                if day_row:
                    # strftime %w: 0=Sun, 1=Mon, ..., 6=Sat
                    day_idx = int(day_row[0])
                    # Convert to Python weekday naming (Monday=0)
                    py_idx = (day_idx - 1) % 7  # Sun(0)->6, Mon(1)->0, etc.
                    busiest_day = _DAY_NAMES[py_idx]

                # Busiest hour
                hour_row = c.execute(f"""
                    SELECT strftime('%H', {date_expr}, 'unixepoch') AS hr, COUNT(*) AS c
                    FROM message WHERE date > 0
                    GROUP BY hr ORDER BY c DESC LIMIT 1
                """).fetchone()
                if hour_row:
                    busiest_hour = int(hour_row[0])
            except Exception:
                pass

            return {
                "total": total,
                "total_conversations": total_convos,
                "sent": sent,
                "received": received,
                "imessage_count": imessage_count,
                "sms_count": sms_count,
                "group_conversations": group_convos,
                "one_on_one_conversations": one_on_one,
                "top_conversations": top_conversations,
                "busiest_day": busiest_day,
                "busiest_hour": busiest_hour,
                "avg_messages_per_day": avg_per_day,
                "total_attachments": total_attachments,
                "first_message_date": first_date,
                "last_message_date": last_date,
            }
        finally:
            conn.close()

    def _empty_message_stats(self) -> dict:
        return {
            "total": 0, "total_conversations": 0, "sent": 0, "received": 0,
            "imessage_count": 0, "sms_count": 0, "group_conversations": 0,
            "one_on_one_conversations": 0, "top_conversations": [],
            "busiest_day": "", "busiest_hour": -1, "avg_messages_per_day": 0,
            "total_attachments": 0, "first_message_date": None, "last_message_date": None,
        }

    # ── Photos ────────────────────────────────────────────────────────────────

    def _photo_stats(self, backup) -> dict:
        # Reuse the same DB open logic as PhotoExtractor
        db_path = backup.get_file("Media/PhotoData/Photos.sqlite", domain="CameraRollDomain")
        if not db_path:
            db_path = backup.get_file("PhotoData/Photos.sqlite", domain="CameraRollDomain")
        conn = _safe_connect(db_path)
        if not conn:
            return self._empty_photo_stats()

        try:
            c = conn.cursor()

            # Check which columns exist
            c.execute("PRAGMA table_info(ZASSET)")
            columns = {row[1] for row in c.fetchall()}

            has_trashed = "ZTRASHEDSTATE" in columns
            trash_filter = "WHERE ZTRASHEDSTATE = 0" if has_trashed else ""
            trash_and = "AND ZTRASHEDSTATE = 0" if has_trashed else ""

            # Kind breakdown
            kind_map = {0: "photo", 1: "video", 2: "live_photo", 3: "live_photo"}
            kind_rows = c.execute(
                f"SELECT ZKIND, COUNT(*) FROM ZASSET {trash_filter} GROUP BY ZKIND"
            ).fetchall()
            by_kind = {}
            total_photos = 0
            total_videos = 0
            for row in kind_rows:
                kind_int = row[0] if row[0] is not None else 0
                label = kind_map.get(kind_int, "other")
                by_kind[label] = by_kind.get(label, 0) + row[1]
                if label == "video":
                    total_videos += row[1]
                else:
                    total_photos += row[1]

            # Favorites
            fav_col = "ZFAVORITE" if "ZFAVORITE" in columns else None
            total_favorites = 0
            if fav_col:
                total_favorites = c.execute(
                    f"SELECT COUNT(*) FROM ZASSET WHERE {fav_col} = 1 {trash_and}"
                ).fetchone()[0]

            # Location data
            with_location = 0
            if "ZLATITUDE" in columns:
                with_location = c.execute(
                    f"SELECT COUNT(*) FROM ZASSET WHERE ZLATITUDE IS NOT NULL AND ZLATITUDE != 0 {trash_and}"
                ).fetchone()[0]

            # Date range
            date_col = "ZDATECREATED" if "ZDATECREATED" in columns else None
            earliest = None
            latest = None
            if date_col:
                date_row = c.execute(
                    f"SELECT MIN({date_col}), MAX({date_col}) FROM ZASSET {trash_filter}"
                ).fetchone()
                earliest = _apple_ts_to_iso(date_row[0])
                latest = _apple_ts_to_iso(date_row[1])

            # Total video duration
            total_video_duration = 0.0
            if "ZDURATION" in columns:
                dur_row = c.execute(
                    f"SELECT SUM(ZDURATION) FROM ZASSET WHERE ZKIND = 1 {trash_and}"
                ).fetchone()
                total_video_duration = float(dur_row[0] or 0)

            return {
                "by_kind": by_kind,
                "total_photos": total_photos,
                "total_videos": total_videos,
                "total_favorites": total_favorites,
                "with_location": with_location,
                "earliest_date": earliest,
                "latest_date": latest,
                "total_video_duration_seconds": total_video_duration,
            }
        finally:
            conn.close()

    def _empty_photo_stats(self) -> dict:
        return {
            "by_kind": {}, "total_photos": 0, "total_videos": 0,
            "total_favorites": 0, "with_location": 0,
            "earliest_date": None, "latest_date": None,
            "total_video_duration_seconds": 0,
        }

    # ── Contacts ──────────────────────────────────────────────────────────────

    def _contact_count(self, backup) -> int:
        db_path = backup.get_file("Library/AddressBook/AddressBook.sqlitedb", domain="HomeDomain")
        conn = _safe_connect(db_path)
        if not conn:
            return 0
        try:
            return conn.execute("SELECT COUNT(*) FROM ABPerson").fetchone()[0]
        finally:
            conn.close()

    # ── Calls ─────────────────────────────────────────────────────────────────

    def _call_stats(self, backup, contacts: dict) -> dict:
        from calls import CallExtractor
        extractor = CallExtractor()
        result = extractor.list_calls(backup, contacts, offset=0, limit=999999)
        calls = result.get("calls", [])
        if not calls:
            return self._empty_call_stats()

        total = result.get("total", len(calls))
        incoming = sum(1 for c in calls if c["direction"] == "incoming")
        outgoing = total - incoming
        answered = sum(1 for c in calls if c["status"] == "answered")
        missed = total - answered

        durations = [float(c["duration"] or 0) for c in calls if c.get("duration")]
        total_duration = sum(durations)
        avg_duration = total_duration / len(durations) if durations else 0.0
        longest = max(durations) if durations else 0.0

        facetime_count = sum(1 for c in calls if "facetime" in (c.get("app") or "").lower())

        from collections import Counter
        name_counts = Counter(c["contact_name"] for c in calls if c.get("contact_name"))
        top_contacts = [{"name": name, "count": cnt} for name, cnt in name_counts.most_common(5)]

        return {
            "total": total,
            "incoming": incoming,
            "outgoing": outgoing,
            "answered": answered,
            "missed": missed,
            "total_duration_seconds": total_duration,
            "avg_duration_seconds": round(avg_duration, 1),
            "longest_call_seconds": longest,
            "facetime_count": facetime_count,
            "regular_count": total - facetime_count,
            "top_contacts": top_contacts,
        }

    def _empty_call_stats(self) -> dict:
        return {
            "total": 0, "incoming": 0, "outgoing": 0, "answered": 0, "missed": 0,
            "total_duration_seconds": 0, "avg_duration_seconds": 0,
            "longest_call_seconds": 0, "facetime_count": 0, "regular_count": 0,
            "top_contacts": [],
        }

    # ── Notes ─────────────────────────────────────────────────────────────────

    def _note_stats(self, backup) -> dict:
        # Try NoteStore first (iOS 9+), then legacy
        from notes import NoteExtractor
        extractor = NoteExtractor()
        result = extractor.list_notes(backup)
        notes = result.get("notes", [])

        if not notes:
            return {"total": 0, "avg_length_chars": 0, "longest_chars": 0}

        lengths = [len(n.get("body", "") or "") for n in notes]
        return {
            "total": len(notes),
            "avg_length_chars": round(sum(lengths) / len(lengths)) if lengths else 0,
            "longest_chars": max(lengths) if lengths else 0,
        }

    # ── Voicemails ────────────────────────────────────────────────────────────

    def _voicemail_stats(self, backup) -> dict:
        db_path = backup.get_file("Library/Voicemail/voicemail.db", domain="HomeDomain")
        conn = _safe_connect(db_path)
        if not conn:
            return {"total": 0, "total_duration_seconds": 0, "read": 0, "unread": 0}

        try:
            c = conn.cursor()
            rows = c.execute("""
                SELECT duration, flags
                FROM voicemail
                WHERE trashed_date = 0 OR trashed_date IS NULL
            """).fetchall()

            total = len(rows)
            total_duration = sum(float(r[0] or 0) for r in rows)
            read_count = sum(1 for r in rows if r[1] and (r[1] & 1))
            unread = total - read_count

            return {
                "total": total,
                "total_duration_seconds": total_duration,
                "read": read_count,
                "unread": unread,
            }
        finally:
            conn.close()
