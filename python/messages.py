"""
Message extraction from sms.db.
Handles iMessage, SMS, MMS conversations with contact resolution.
"""

import sqlite3
import base64
import os
import plistlib
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Optional


def _tlog(msg: str) -> None:
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass

# Apple Cocoa epoch: Jan 1, 2001
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
NANOSECOND_THRESHOLD = 1_000_000_000_000  # Dates above this are in nanoseconds

# Cache of sms.db column sets, keyed by db_path. Schema never changes for a given backup.
_pragma_cache: dict[str, dict] = {}
# Set of db_paths for which we've already created performance indexes.
_indexed_dbs: set[str] = set()

# Direct balloon_bundle_id column value → message_type (checked before attributedBody parsing)
_BUNDLE_ID_MAP: list[tuple[str, str]] = [
    ('URLBalloonProvider',              'link'),
    ('Maps',                            'location'),
    ('maps.iMessage',                   'location'),
    ('LocationShare',                   'location'),
    ('findmy',                          'location'),
    ('FindMy',                          'location'),
    ('com.apple.pay',                   'payment'),
    ('PassbookUI',                      'payment'),
    ('DigitalTouch',                    'digital_touch'),
    ('Handwriting',                     'handwriting'),
    ('Fitness',                         'fitness'),
    ('GameCenter',                      'game'),
    ('GameKit',                         'game'),
    # Generic iMessage extension balloon — unknown app share
    ('MSMessageExtensionBalloonPlugin', 'app'),
]

def _type_from_bundle_id(bundle_id: Optional[str]) -> Optional[str]:
    """Map a balloon_bundle_id to a message_type, or None if not recognised."""
    if not bundle_id:
        return None
    for fragment, msg_type in _BUNDLE_ID_MAP:
        if fragment in bundle_id:
            return msg_type
    return None

# Fragments found in attributedBody $objects → message_type (fallback)
_BALLOON_TYPE_MAP: list[tuple[str, str]] = [
    ('Maps',                    'location'),
    ('maps.iMessage',           'location'),
    ('LocationShare',           'location'),
    ('__kIMLocationShare',      'location'),
    ('com.apple.pay',           'payment'),
    ('PassbookUI',              'payment'),
    ('DigitalTouch',            'digital_touch'),
    ('Handwriting',             'handwriting'),
    ('Fitness',                 'fitness'),
    ('GameCenter',              'game'),
    ('GameKit',                 'game'),
    ('com.apple.audio',         'audio'),
    ('AudioMessage',            'audio'),
]

_NS_CLASS_NAMES = frozenset([
    "NSString", "NSMutableString", "NSAttributedString",
    "NSMutableAttributedString", "NSObject",
    "NSDictionary", "NSMutableDictionary",
])


def _detect_type_from_objects(objects: list) -> str:
    """Scan bplist $objects for known Apple balloon/system message identifiers."""
    for obj in objects:
        if not isinstance(obj, str):
            continue
        for fragment, msg_type in _BALLOON_TYPE_MAP:
            if fragment in obj:
                return msg_type
    return "text"


def parse_attributed_body(data: bytes) -> tuple[str, str]:
    """Extract plain text and message type from an NSAttributedString BLOB.

    Returns (text, message_type) where message_type is one of:
      'text', 'location', 'payment', 'audio', 'fitness',
      'game', 'digital_touch', 'handwriting', 'system'
    """
    if not data:
        return "", "text"

    # 1. Try NSKeyedArchiver (bplist00)
    if data.startswith(b'bplist00'):
        try:
            plist = plistlib.loads(data)
            objects = plist.get("$objects", [])

            # Detect system/service message type first
            msg_type = _detect_type_from_objects(objects)
            if msg_type != "text":
                return "", msg_type

            def _resolve(val):
                if isinstance(val, plistlib.UID):
                    idx = val.data
                    return objects[idx] if idx < len(objects) else None
                return val

            # Primary: follow NSKeyedArchiver structure to the actual NS.string value.
            # $top.root → root NSAttributedString dict → NS.string UID → plain text.
            top = plist.get("$top", {})
            root_ref = top.get("root")
            if root_ref is not None:
                root_obj = _resolve(root_ref)
                if isinstance(root_obj, dict):
                    ns_string_val = _resolve(root_obj.get("NS.string"))
                    if isinstance(ns_string_val, str) and ns_string_val:
                        return ns_string_val, "text"

            # Fallback: longest clean string in $objects (skips internal keys / class names)
            candidate = ""
            for obj in objects:
                if not isinstance(obj, str):
                    continue
                if obj in _NS_CLASS_NAMES:
                    continue
                # Skip NSKeyedArchiver structural strings
                if obj.startswith('$') or obj == '$null':
                    continue
                # Skip NS/CF class name strings (e.g. "NSFont", "WNSValue", "CFString")
                if re.match(r'^W?(NS|CF)[A-Z]', obj):
                    continue
                # Skip GUIDs and file attachment references
                if "kIMFileTransferGUID" in obj or "kIMMessagePart" in obj:
                    continue
                if re.match(r'^\$?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$', obj, re.IGNORECASE):
                    continue
                if re.search(r'[\d_A-Fa-f\-]+(\.fullsizerender)*\.(jpeg|jpg|heic|heif|png|gif|mov|mp4|m4a|caf|pdf|doc|docx)', obj, re.IGNORECASE):
                    continue
                if len(obj) > len(candidate):
                    candidate = obj
            if candidate:
                return candidate, "text"
        except Exception:
            pass
        # bplist00 data that couldn't be parsed shouldn't be raw-decoded (produces garbage)
        return "", "text"

    # 2. TypedStream / raw binary fallback — also check for system message clues
    try:
        raw = data.decode('utf-8', errors='replace')

        # Quick system-type scan on raw text before cleaning
        for fragment, msg_type in _BALLOON_TYPE_MAP:
            if fragment in raw:
                return "", msg_type

        text = raw
        # Strip TypedStream / NSKeyedArchiver structural noise.
        # ORDER MATTERS: remove full GUIDs and __kIM keys BEFORE $\w+ cleanup,
        # because $\w+ would consume the first GUID segment (e.g. "$19129343")
        # leaving an unrecognisable "-A4D6-…" fragment behind.
        text = re.sub(r'streamtyped', '', text)              # TypedStream magic word
        text = re.sub(r'__kIM\w+', '', text)                 # __kIMFileTransferGUIDAttributeName …
        text = re.sub(r'at_\d+_', '', text)                  # attachment ref prefix "at_0_"
        # Full GUIDs (with or without leading $)
        text = re.sub(r'\$?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', '', text, flags=re.IGNORECASE)
        # Partial GUIDs (tail segments left after splitting on control chars)
        text = re.sub(r'(?<![.\w])[0-9A-Fa-f]{4,}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{8,}', '', text, flags=re.IGNORECASE)
        text = re.sub(r'\$\w+', '', text)                    # $classname, $classes, $top …
        text = re.sub(r'W?(NS|CF)[A-Z][A-Za-z]*', '', text) # NSFont, CFString, WNSValue …
        text = re.sub(r'Z?(NS|CF)\.\w+', '', text)          # NS.rangeval, ZNS.special …
        text = re.sub(r'\b[A-Z][a-z]{3,}/', '', text)       # TypedStream class tags: Email/ DateTime/
        text = re.sub(r'mailto:', '', text, flags=re.IGNORECASE)
        text = re.sub(r'[\d_A-Fa-f\-]+(\.fullsizerender)*\.(jpeg|jpg|heic|heif|png|gif|mov|mp4|m4a|caf|pdf|doc|docx)', '', text, flags=re.IGNORECASE)
        for c in _NS_CLASS_NAMES:
            text = text.replace(c, "")

        parts = re.split(r'[\x00-\x08\x0b\x0c\x0e-\x1f]+', text)
        candidate = ""
        for p in parts:
            p = p.strip().replace('\ufffc', '').replace('\ufffd', '').strip()
            # Strip TypedStream string length-prefix artifact: '+' followed by one
            # printable byte that encodes the declared length (e.g. "+I"=73, "+ "=32).
            # Only strip when the declared length closely matches the remaining text.
            m_prefix = re.match(r'^\+([\x20-\x7e])(.*)', p, re.DOTALL)
            if m_prefix:
                declared = ord(m_prefix.group(1))
                remainder = m_prefix.group(2)
                if abs(len(remainder.rstrip()) - declared) <= 3:
                    p = remainder.lstrip()
            # For strings containing an email address, use a regex to extract just
            # the address and discard surrounding TypedStream noise (UEmail/, type bytes).
            # Use lowercase-only TLD ([a-z]{2,}) so uppercase TypedStream type bytes
            # (e.g. the 'U' in 'comUEmail') are not consumed as part of the TLD.
            if '@' in p:
                m_email = re.search(r'[\w._%+\-]+@[\w.\-]+\.[a-z]{2,}', p)
                p = m_email.group(0) if m_email else ''
            if p and len(p) > len(candidate) and len(p) > 3:
                candidate = p

        return candidate, "text"
    except Exception:
        pass

    return "", "text"


def parse_link_payload(data: bytes) -> dict:
    """Extract URL, title, summary and site name from a URLBalloonProvider payload_data blob."""
    if not data:
        return {}
    try:
        plist = plistlib.loads(bytes(data))
        objs = plist.get("$objects", [])

        def resolve(val):
            if isinstance(val, plistlib.UID):
                return objs[val.data]
            return val

        root = resolve(objs[1])
        if not isinstance(root, dict) or "richLinkMetadata" not in root:
            return {}

        meta = resolve(root["richLinkMetadata"])
        if not isinstance(meta, dict):
            return {}

        result: dict = {}

        # Resolve NSURL → string via NS.relative
        for key in ("originalURL", "URL"):
            if key in meta:
                url_obj = resolve(meta[key])
                if isinstance(url_obj, dict):
                    rel = resolve(url_obj.get("NS.relative", ""))
                    if rel and isinstance(rel, str):
                        result["url"] = rel
                        break
                elif isinstance(url_obj, str):
                    result["url"] = url_obj
                    break

        for key in ("title", "summary", "siteName"):
            val = resolve(meta.get(key, ""))
            if val and isinstance(val, str):
                result[key.replace("N", "n").replace("S", "s") if key == "siteName" else key] = val

        return result
    except Exception:
        return {}


def apple_date_to_iso(apple_timestamp) -> Optional[str]:
    """Convert Apple Cocoa timestamp to ISO 8601 string."""
    if apple_timestamp is None or apple_timestamp == 0:
        return None
    try:
        ts = float(apple_timestamp)
        # Detect nanosecond timestamps (iOS 14+)
        if ts > NANOSECOND_THRESHOLD:
            ts = ts / 1_000_000_000
        dt = APPLE_EPOCH + timedelta(seconds=ts)
        return dt.isoformat()
    except (ValueError, OverflowError):
        return None


def iso_to_apple_date(iso_str: str, nanoseconds: bool = False) -> Optional[float]:
    """Convert ISO 8601 string to Apple Cocoa epoch timestamp.

    Pass nanoseconds=True when the target DB stores timestamps as nanoseconds
    (iOS 14+), which is detected by sampling a row before calling this.
    """
    if not iso_str:
        return None
    try:
        from datetime import timezone
        # Accept date-only strings like "2023-01-01"
        if len(iso_str) == 10:
            iso_str += "T00:00:00"
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        delta = dt - APPLE_EPOCH.replace(tzinfo=timezone.utc)
        seconds = delta.total_seconds()
        return seconds * 1_000_000_000 if nanoseconds else seconds
    except (ValueError, TypeError):
        return None


def _db_uses_nanoseconds(conn) -> bool:
    """Return True if the message table stores timestamps in nanoseconds (iOS 14+)."""
    row = conn.execute("SELECT date FROM message WHERE date > 0 LIMIT 1").fetchone()
    if row and row[0] is not None:
        return float(row[0]) > NANOSECOND_THRESHOLD
    return False


class MessageExtractor:
    """Extracts messages and conversations from iOS sms.db."""

    SMS_DB_PATH = "Library/SMS/sms.db"

    def __init__(self):
        # Persistent SQLite connections keyed by db_path.
        # The sidecar processes one request at a time, so reuse is safe.
        self._connections: dict[str, sqlite3.Connection] = {}

    def _get_sms_db(self, backup) -> Optional[str]:
        """Get path to the sms.db file from the backup."""
        return backup.get_file(self.SMS_DB_PATH, domain="HomeDomain")

    def _get_conn(self, db_path: str) -> sqlite3.Connection:
        """Return a cached SQLite connection for db_path, creating it if needed."""
        if db_path not in self._connections:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            self._ensure_indexes(conn, db_path)
            self._connections[db_path] = conn
        return self._connections[db_path]

    def _ensure_indexes(self, conn, db_path: str) -> None:
        """Create performance indexes on sms.db the first time it is opened.

        Uses IF NOT EXISTS so this is idempotent — SQLite skips creation if the
        index already exists (either from iOS or a prior run).  Errors are
        silently ignored so a read-only filesystem won't break anything.
        """
        if db_path in _indexed_dbs:
            return
        try:
            conn.executescript("""
                CREATE INDEX IF NOT EXISTS _oe_cmj_chat
                    ON chat_message_join (chat_id, message_id);
                CREATE INDEX IF NOT EXISTS _oe_msg_date
                    ON message (date);
            """)
            conn.commit()
        except Exception:
            pass  # Read-only filesystem or locked db — non-fatal
        _indexed_dbs.add(db_path)

    def list_conversations(self, backup, contacts: dict) -> dict:
        """List all conversations with preview info."""
        db_path = self._get_sms_db(backup)
        if not db_path:
            return {"conversations": [], "error": "sms.db not found"}

        t0 = time.perf_counter()
        conn = self._get_conn(db_path)
        _tlog(f"list_conversations: _get_conn={time.perf_counter()-t0:.3f}s")

        conversations = []
        try:
            t1 = time.perf_counter()
            # CTE avoids a correlated subquery per-row for last message preview.
            # ranked_msgs assigns ROW_NUMBER per chat ordered by date DESC so rn=1
            # is the latest message; msg_counts aggregates totals separately.
            rows = conn.execute("""
                WITH ranked_msgs AS (
                    SELECT
                        cmj.chat_id,
                        COALESCE(m.text, '[Message contents hidden]') AS text,
                        m.date,
                        ROW_NUMBER() OVER (
                            PARTITION BY cmj.chat_id ORDER BY m.date DESC
                        ) AS rn
                    FROM chat_message_join cmj
                    JOIN message m ON m.ROWID = cmj.message_id
                ),
                last_msg AS (
                    SELECT chat_id, text, date FROM ranked_msgs WHERE rn = 1
                ),
                msg_counts AS (
                    SELECT chat_id, COUNT(*) AS message_count
                    FROM chat_message_join
                    GROUP BY chat_id
                )
                SELECT
                    c.ROWID          AS chat_id,
                    c.chat_identifier,
                    c.display_name,
                    c.service_name,
                    mc.message_count,
                    lm.date          AS last_message_date,
                    lm.text          AS last_message_text
                FROM chat c
                JOIN last_msg   lm ON lm.chat_id = c.ROWID
                JOIN msg_counts mc ON mc.chat_id = c.ROWID
                ORDER BY lm.date DESC
            """).fetchall()
            _tlog(f"list_conversations: CTE query={time.perf_counter()-t1:.3f}s rows={len(rows)}")

            t2 = time.perf_counter()
            for row in rows:
                chat_identifier = row["chat_identifier"] or ""
                display_name = row["display_name"] or ""

                # Resolve contact name
                if not display_name and chat_identifier in contacts:
                    display_name = contacts[chat_identifier]

                conversations.append({
                    "chat_id": row["chat_id"],
                    "chat_identifier": chat_identifier,
                    "display_name": display_name or chat_identifier,
                    "service": row["service_name"] or "iMessage",
                    "message_count": row["message_count"],
                    "last_message_date": apple_date_to_iso(row["last_message_date"]),
                    "last_message_preview": (row["last_message_text"] or "")[:100],
                    "is_group": "chat" in chat_identifier.lower(),
                })
            _tlog(f"list_conversations: contact-resolve loop={time.perf_counter()-t2:.3f}s convs={len(conversations)}")
        except Exception:
            raise

        return {"conversations": conversations}

    def get_messages(self, backup, chat_id: int, contacts: dict,
                     offset: int = 0, limit: int = 100,
                     date_from: Optional[str] = None,
                     date_to: Optional[str] = None) -> dict:
        """Get paginated messages from a conversation."""
        db_path = self._get_sms_db(backup)
        if not db_path:
            return {"messages": [], "error": "sms.db not found"}

        t0 = time.perf_counter()
        conn = self._get_conn(db_path)
        _tlog(f"get_messages(chat={chat_id}): _get_conn={time.perf_counter()-t0:.3f}s")

        messages = []
        try:
            # Probe which optional columns actually exist so we never query a
            # missing column (which would crash both query tiers).
            # Results are cached by db_path since schema never changes for a given backup.
            if db_path not in _pragma_cache:
                msg_cols = {r[1] for r in conn.execute("PRAGMA table_info(message)").fetchall()}
                handle_cols = {r[1] for r in conn.execute("PRAGMA table_info(handle)").fetchall()}
                _pragma_cache[db_path] = {
                    'has_attributed_body':   'attributedBody'     in msg_cols,
                    'has_payload_data':      'payload_data'       in msg_cols,
                    'has_balloon_bundle_id': 'balloon_bundle_id'  in msg_cols,
                    'has_audio_message':     'is_audio_message'   in msg_cols,
                    'has_item_type':         'item_type'          in msg_cols,
                    'has_share_status':      'share_status'       in msg_cols,
                    'has_share_direction':   'share_direction'    in msg_cols,
                    'has_uncanonicalized':   'uncanonicalized_id' in handle_cols,
                    'uses_nanoseconds':      _db_uses_nanoseconds(conn),
                }
            schema = _pragma_cache[db_path]
            has_attributed_body   = schema['has_attributed_body']
            has_payload_data      = schema['has_payload_data']
            has_balloon_bundle_id = schema['has_balloon_bundle_id']
            has_audio_message     = schema['has_audio_message']
            has_item_type         = schema['has_item_type']
            has_share_status      = schema['has_share_status']
            has_share_direction   = schema['has_share_direction']
            has_uncanonicalized   = schema['has_uncanonicalized']

            # Build SELECT list from confirmed-present columns only
            select_parts = [
                'm.ROWID AS message_id',
                'm.text',
                'm.date',
                'm.is_from_me',
                'm.cache_has_attachments',
                'm.associated_message_type',
                'h.id AS handle_id_str',
            ]
            if has_attributed_body:   select_parts.append('m.attributedBody')
            if has_payload_data:      select_parts.append('m.payload_data')
            if has_balloon_bundle_id: select_parts.append('m.balloon_bundle_id')
            if has_audio_message:     select_parts.append('m.is_audio_message')
            if has_item_type:         select_parts.append('m.item_type')
            if has_share_status:      select_parts.append('m.share_status')
            if has_share_direction:   select_parts.append('m.share_direction')
            if has_uncanonicalized:   select_parts.append('h.uncanonicalized_id')

            date_clauses = []
            date_params: list = [chat_id]
            if date_from or date_to:
                ns = _pragma_cache[db_path]['uses_nanoseconds']
                apple_from = iso_to_apple_date(date_from, nanoseconds=ns) if date_from else None
                apple_to = iso_to_apple_date(date_to, nanoseconds=ns) if date_to else None
                if apple_from is not None:
                    date_clauses.append("m.date >= ?")
                    date_params.append(apple_from)
                if apple_to is not None:
                    date_clauses.append("m.date <= ?")
                    date_params.append(apple_to)
            where_extra = (" AND " + " AND ".join(date_clauses)) if date_clauses else ""

            t_q = time.perf_counter()
            rows = conn.execute(f"""
                SELECT {', '.join(select_parts)}
                FROM message m
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                WHERE cmj.chat_id = ?{where_extra}
                ORDER BY m.date DESC
                LIMIT ? OFFSET ?
            """, (*date_params, limit, offset)).fetchall()
            _tlog(f"get_messages: main query={time.perf_counter()-t_q:.3f}s rows={len(rows)}")

            # Reverse so messages render top-to-bottom in chronological order
            rows = list(rows)[::-1]

            # Batch-fetch all attachment metadata for this page in a single query
            # instead of one query per message (N+1 → 1).
            t_att = time.perf_counter()
            attachment_ids_needed = [
                row["message_id"] for row in rows if bool(row["cache_has_attachments"])
            ]
            attachments_by_msg: dict[int, list] = {}
            if attachment_ids_needed:
                placeholders = ','.join('?' * len(attachment_ids_needed))
                for att in conn.execute(f"""
                    SELECT
                        maj.message_id,
                        a.ROWID AS attachment_id,
                        a.filename,
                        a.mime_type,
                        a.transfer_name,
                        a.total_bytes
                    FROM attachment a
                    JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                    WHERE maj.message_id IN ({placeholders})
                """, attachment_ids_needed).fetchall():
                    transfer_name = att["transfer_name"] or ""
                    filename = att["filename"] or ""
                    if transfer_name.endswith('.pluginPayloadAttachment'):
                        continue
                    if filename.endswith('.pluginPayloadAttachment'):
                        continue
                    mid = att["message_id"]
                    attachments_by_msg.setdefault(mid, []).append({
                        "attachment_id": att["attachment_id"],
                        "filename": filename,
                        "mime_type": att["mime_type"],
                        "transfer_name": transfer_name,
                        "total_bytes": att["total_bytes"],
                    })

            _tlog(f"get_messages: attachment batch={time.perf_counter()-t_att:.3f}s msgs_with_att={len(attachment_ids_needed)}")

            # Pre-fetch the primary contact name for this chat — used as fallback for
            # system notification messages that have no handle_id (e.g. location sharing)
            chat_contact_name = ""
            chat_handle_row = conn.execute("""
                SELECT h.id FROM handle h
                INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
                WHERE chj.chat_id = ?
                LIMIT 1
            """, (chat_id,)).fetchone()
            if chat_handle_row:
                chat_contact_name = contacts.get(chat_handle_row[0], chat_handle_row[0])

            t_loop = time.perf_counter()
            for row in rows:
                handle = row["handle_id_str"] or ""
                sender_name = handle
                if handle in contacts:
                    sender_name = contacts[handle]
                elif has_uncanonicalized and row["uncanonicalized_id"] and row["uncanonicalized_id"] in contacts:
                    sender_name = contacts[row["uncanonicalized_id"]]
                # Fall back to the chat's primary contact for handle-less system messages
                if not sender_name:
                    sender_name = chat_contact_name

                # Determine message type — balloon_bundle_id column is authoritative
                bundle_type = _type_from_bundle_id(row["balloon_bundle_id"] if has_balloon_bundle_id else None)
                is_audio    = bool(row["is_audio_message"]) if has_audio_message else False
                item_type   = (row["item_type"]      or 0)  if has_item_type     else 0
                share_status    = (row["share_status"]    or 0) if has_share_status    else 0
                share_direction = (row["share_direction"] or 0) if has_share_direction else 0

                msg_text = row["text"]
                if bundle_type == "location":
                    # FindMy map balloon — redundant with the text notifications that follow; skip it
                    msg_type = "hidden"
                elif bundle_type:
                    msg_type = bundle_type
                elif is_audio:
                    msg_type = "audio"
                elif item_type in (3, 4):
                    # item_type 3/4 = location sharing events
                    # share_direction: 0 = outgoing (you), 1 = incoming (them)
                    # share_status:    0 = started,        1 = stopped
                    if item_type == 4 and share_direction == 0 and share_status == 1:
                        msg_type = "location_stopped_by_me"
                    elif item_type == 4 and share_direction == 0:
                        msg_type = "location_started_by_me"
                    elif item_type == 4 and share_direction == 1 and share_status == 1:
                        msg_type = "location_stopped_by_them"
                    elif item_type == 4 and share_direction == 1:
                        msg_type = "location_started_by_them"
                    else:
                        msg_type = "location"
                else:
                    msg_type = "text"

                # Fall back to attributedBody for text content when text column is empty
                if not msg_text and has_attributed_body and msg_type == "text":
                    msg_text, msg_type = parse_attributed_body(row["attributedBody"])

                if msg_text:
                    # Clean up Apple object replacement characters and attachment identifiers
                    msg_text = msg_text.replace('\ufffc', '').replace('\ufffd', '').strip()
                    msg_text = re.sub(r'__kIM\w+', '', msg_text)
                    msg_text = re.sub(r'\$?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', '', msg_text, flags=re.IGNORECASE)
                    msg_text = re.sub(r'[\d_A-Fa-f\-]+(\.fullsizerender)*\.(jpeg|jpg|heic|heif|png|gif|mov|mp4|m4a|caf|pdf|doc|docx)', '', msg_text, flags=re.IGNORECASE)

                    # Remove junk wrapper quotes, spaces, or newlines left from stripping
                    msg_text = re.sub(r'^[ \n"\uFFFD\uFFFC]+', '', msg_text)
                    msg_text = re.sub(r'[ \n"\uFFFD\uFFFC]+$', '', msg_text)
                    msg_text = msg_text.strip()

                # Skip messages that are redundant or have no displayable content
                if msg_type == "hidden":
                    continue

                if not msg_text and msg_type == "text":
                    if bool(row["cache_has_attachments"]):
                        msg_type = "attachment"
                    else:
                        msg_type = "system"
                    msg_text = ""

                link_preview = None
                if msg_type == "link" and has_payload_data and row["payload_data"]:
                    link_preview = parse_link_payload(row["payload_data"]) or None

                # Look up pre-fetched attachments (batched above, no per-message query)
                real_attachments = attachments_by_msg.get(row["message_id"], [])

                msg = {
                    "message_id": row["message_id"],
                    "text": msg_text,
                    "message_type": msg_type,
                    "link_preview": link_preview,
                    "date": apple_date_to_iso(row["date"]),
                    "is_from_me": bool(row["is_from_me"]),
                    "sender": "me" if row["is_from_me"] else sender_name,
                    "sender_handle": handle,
                    "has_attachments": bool(real_attachments),
                    "attachments": real_attachments,
                    "is_reaction": row["associated_message_type"] is not None and row["associated_message_type"] != 0,
                }

                messages.append(msg)

            _tlog(f"get_messages: message loop={time.perf_counter()-t_loop:.3f}s out={len(messages)}")

            # Get total count (respects date filters)
            t_cnt = time.perf_counter()
            total = conn.execute(
                f"""SELECT COUNT(*) FROM message m
                    INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                    WHERE cmj.chat_id = ?{where_extra}""",
                tuple(date_params)
            ).fetchone()[0]
            _tlog(f"get_messages: count query={time.perf_counter()-t_cnt:.3f}s total={total}")

        except Exception:
            raise

        return {
            "messages": messages,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def _get_message_attachments(self, conn, message_id: int) -> list:
        """Get attachment metadata for a message, excluding iMessage plugin payloads."""
        attachments = []
        try:
            rows = conn.execute("""
                SELECT
                    a.ROWID AS attachment_id,
                    a.filename,
                    a.mime_type,
                    a.transfer_name,
                    a.total_bytes
                FROM attachment a
                JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                WHERE maj.message_id = ?
            """, (message_id,)).fetchall()

            for row in rows:
                # Skip iMessage app/link plugin payload blobs — they are internal
                # data containers (e.g. URLBalloonProvider payload), not real files.
                transfer_name = row["transfer_name"] or ""
                if transfer_name.endswith('.pluginPayloadAttachment'):
                    continue
                filename = row["filename"] or ""
                if filename.endswith('.pluginPayloadAttachment'):
                    continue

                attachments.append({
                    "attachment_id": row["attachment_id"],
                    "filename": filename,
                    "mime_type": row["mime_type"],
                    "transfer_name": transfer_name,
                    "total_bytes": row["total_bytes"],
                })
        except Exception:
            pass

        return attachments

    def get_attachment(self, backup, attachment_id: int) -> dict:
        """Extract and return an attachment file as base64."""
        db_path = self._get_sms_db(backup)
        if not db_path:
            return {"error": "sms.db not found"}

        conn = self._get_conn(db_path)

        try:
            row = conn.execute(
                "SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?",
                (attachment_id,)
            ).fetchone()

            if not row or not row["filename"]:
                return {"error": "Attachment not found"}

            # The filename in sms.db starts with ~/
            # e.g. "~/Library/SMS/Attachments/ab/12/IMG_1234.jpeg"
            relative_path = row["filename"]
            if relative_path.startswith("~/"):
                relative_path = relative_path[2:]

            # Try to extract from backup
            # Attachments are in MediaDomain
            file_path = backup.get_file(relative_path, domain="MediaDomain")
            if not file_path:
                # Also try HomeDomain
                file_path = backup.get_file(relative_path, domain="HomeDomain")

            if not file_path or not os.path.exists(file_path):
                return {"error": "Attachment file not found in backup"}

            with open(file_path, "rb") as f:
                raw_data = f.read()

            mime_type = row["mime_type"]
            filename_lower = (row["filename"] or "").lower()
            if mime_type in ("image/heic", "image/heif") or filename_lower.endswith(".heic") or filename_lower.endswith(".heif"):
                try:
                    import io
                    import pillow_heif
                    from PIL import Image
                    pillow_heif.register_heif_opener()
                    img = Image.open(io.BytesIO(raw_data))
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG")
                    raw_data = buf.getvalue()
                    mime_type = "image/jpeg"
                except Exception as e:
                    pass

            data = base64.b64encode(raw_data).decode("ascii")

            return {
                "data": data,
                "mime_type": mime_type,
                "filename": row["transfer_name"] or os.path.basename(row["filename"]),
            }
        except Exception:
            raise

    def search_messages(self, backup, query: str, contacts: dict,
                        chat_id: Optional[int] = None,
                        date_from: Optional[str] = None,
                        date_to: Optional[str] = None,
                        limit: int = 500) -> dict:
        """Search messages by text content, optionally filtered by chat and date range."""
        db_path = self._get_sms_db(backup)
        if not db_path:
            return {"results": []}

        conn = self._get_conn(db_path)

        results = []
        try:
            sql = """
                SELECT
                    m.ROWID AS message_id,
                    m.text,
                    m.date,
                    m.is_from_me,
                    h.id AS handle_id_str,
                    cmj.chat_id
                FROM message m
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                WHERE m.text LIKE ?
            """
            params: list = [f"%{query}%"]

            if chat_id:
                sql += " AND cmj.chat_id = ?"
                params.append(chat_id)

            if date_from or date_to:
                ns = _db_uses_nanoseconds(conn)
                apple_from = iso_to_apple_date(date_from, nanoseconds=ns) if date_from else None
                apple_to = iso_to_apple_date(date_to, nanoseconds=ns) if date_to else None
                if apple_from is not None:
                    sql += " AND m.date >= ?"
                    params.append(apple_from)
                if apple_to is not None:
                    sql += " AND m.date <= ?"
                    params.append(apple_to)

            sql += f" ORDER BY m.date ASC LIMIT {int(limit)}"

            rows = conn.execute(sql, params).fetchall()
            for row in rows:
                handle = row["handle_id_str"] or ""
                results.append({
                    "message_id": row["message_id"],
                    "text": row["text"],
                    "date": apple_date_to_iso(row["date"]),
                    "is_from_me": bool(row["is_from_me"]),
                    "sender": "me" if row["is_from_me"] else contacts.get(handle, handle),
                    "chat_id": row["chat_id"],
                })
        except Exception:
            raise

        return {"results": results, "query": query}

    def export_conversation(self, backup, chat_id: int, contacts: dict,
                            fmt: str, output_dir: str,
                            date_from: Optional[str] = None,
                            date_to: Optional[str] = None,
                            query: Optional[str] = None) -> dict:
        """Export a conversation to the specified format, with optional date/search filters."""
        if query:
            # Search-filtered export — fetch matching messages directly
            result = self.search_messages(
                backup, query, contacts, chat_id,
                date_from=date_from, date_to=date_to, limit=100000
            )
            all_messages = result["results"]
        else:
            # Date-range or full export via paginated get_messages
            all_messages = []
            offset = 0
            while True:
                batch = self.get_messages(
                    backup, chat_id, contacts, offset, 500,
                    date_from=date_from, date_to=date_to
                )
                all_messages.extend(batch["messages"])
                if offset + 500 >= batch["total"]:
                    break
                offset += 500

        if fmt == "txt":
            return self._export_txt(all_messages, chat_id, output_dir)
        elif fmt == "csv":
            return self._export_csv(all_messages, chat_id, output_dir)
        elif fmt == "html":
            return self._export_html(all_messages, chat_id, output_dir)
        else:
            return {"error": f"Unsupported format: {fmt}"}

    def _attachment_label(self, msg) -> str:
        """Return a clean text label for a message's attachments."""
        attachments = msg.get("attachments") or []
        if not attachments:
            return "[Attachment]"
        parts = []
        for a in attachments:
            name = a.get("transfer_name") or a.get("filename") or ""
            mime = a.get("mime_type") or ""
            if mime.startswith("image/"):
                kind = "Image"
            elif mime.startswith("video/"):
                kind = "Video"
            elif mime.startswith("audio/"):
                kind = "Audio"
            else:
                kind = "File"
            label = f"[{kind}: {name}]" if name else f"[{kind}]"
            parts.append(label)
        return " ".join(parts)

    def _message_text(self, msg) -> str:
        """Return the display text for a message, replacing binary attachment data with labels."""
        if msg.get("has_attachments"):
            label = self._attachment_label(msg)
            # Append any real accompanying text (e.g. a caption sent with an image)
            text = (msg.get("text") or "").strip()
            return f"{text} {label}".strip() if text else label
        return msg.get("text") or ""

    def _export_txt(self, messages, chat_id, output_dir):
        filename = f"conversation_{chat_id}.txt"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8-sig") as f:
            for msg in messages:
                date = msg["date"] or "Unknown date"
                sender = msg["sender"]
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] {sender}: {text}\n")
        return {"file": filepath, "message_count": len(messages)}

    def _export_csv(self, messages, chat_id, output_dir):
        import csv
        filename = f"conversation_{chat_id}.csv"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["Date", "Sender", "Text", "Is From Me", "Has Attachments"])
            for msg in messages:
                writer.writerow([
                    msg["date"], msg["sender"], self._message_text(msg),
                    msg["is_from_me"], msg["has_attachments"]
                ])
        return {"file": filepath, "message_count": len(messages)}

    def _export_html(self, messages, chat_id, output_dir):
        filename = f"conversation_{chat_id}.html"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Conversation Export</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
.msg { margin: 8px 0; padding: 10px 14px; border-radius: 18px; max-width: 75%; clear: both; }
.sent { background: #007AFF; color: white; float: right; border-bottom-right-radius: 4px; }
.received { background: #E9E9EB; color: black; float: left; border-bottom-left-radius: 4px; }
.meta { font-size: 11px; color: #888; clear: both; text-align: center; margin: 12px 0 4px; }
.sender { font-size: 11px; color: #666; margin-bottom: 2px; }
</style></head><body>
""")
            for msg in messages:
                css_class = "sent" if msg["is_from_me"] else "received"
                text = msg["text"] or "[Attachment]"
                date = msg["date"] or ""
                f.write(f'<div class="meta">{date}</div>\n')
                if not msg["is_from_me"]:
                    f.write(f'<div class="sender">{msg["sender"]}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
            f.write("</body></html>")
        return {"file": filepath, "message_count": len(messages)}
