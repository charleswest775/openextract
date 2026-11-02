"""
Per-day activity counts for the Year view.

Counts what the Timeline shows, without loading it: the Timeline stops at
200,000 messages, so counting its items would undercount big backups.

Messages, Photos and Voicemail are grouped SQL queries. Calls, Notes and Web
count the same extractor output the Timeline lists, because what it shows is
decided in Python: Calls merges several databases, voicemail and FaceTime rows,
Notes picks between note stores, and Web consolidates repeat visits. A bare
GROUP BY on those tables would disagree with the day the grid opens.

Days are in the computer's local time zone, as on the Overview.
"""

import json
import re
import sqlite3
import weakref
from collections import Counter
from datetime import datetime
from typing import Iterable, Optional

from ios_backup_core.db import connect_readonly, get_database
from ios_backup_core.text import _type_from_bundle_id

from messages import NANOSECOND_THRESHOLD
from photos import asset_table

# The Timeline's entry types.
ALL_TYPES = ("message", "call", "photo", "voicemail", "note", "browser")
# The ones that belong to a person. The Timeline only guesses at the rest, by
# showing whatever falls between a person's first and last message.
PERSON_TYPES = ("message", "call", "voicemail")

# Seconds between the Unix epoch (1970) and the Apple epoch (2001)
_APPLE_UNIX_DELTA = 978307200

_SMS_DB = "Library/SMS/sms.db"
_VOICEMAIL_DB = "Library/Voicemail/voicemail.db"

# Bucket per row, like apple_date_to_iso: an upgraded phone's sms.db can hold both units.
_MESSAGE_SECONDS = (
    f"CASE WHEN m.date > {NANOSECOND_THRESHOLD} THEN m.date / 1000000000 ELSE m.date END"
    f" + {_APPLE_UNIX_DELTA}"
)
_MESSAGE_DAY = f"strftime('%Y-%m-%d', {_MESSAGE_SECONDS}, 'unixepoch', 'localtime')"

_PHONE_LIKE = re.compile(r"[+\d\s().\-]+")


def _phone_key(identifier: str) -> Optional[str]:
    """The last 10 digits of a phone number, like the Timeline's normPhone. None if it isn't one."""
    if not _PHONE_LIKE.fullmatch(identifier):
        return None
    digits = re.sub(r"\D", "", identifier)
    key = digits[-10:]
    return key if len(key) >= 7 else None


def _as_text(value) -> str:
    """CallHistory and voicemail addresses as text: they can be BLOBs or INTEGERs."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _local_day(iso: Optional[str]) -> Optional[str]:
    """The computer's local YYYY-MM-DD for an ISO 8601 timestamp."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def _by_year(day_counts: Iterable[tuple]) -> dict:
    """{year: {day: count}} from (day, count) pairs. SQLite gives NULL for dates it can't place."""
    years: dict = {}
    for day, count in day_counts:
        if day:
            year = years.setdefault(int(day[:4]), {})
            year[day] = year.get(day, 0) + count
    return years


class _Person:
    """A person's phone numbers and emails, matched the way the Timeline matches them."""

    def __init__(self, identifiers: Iterable[str]):
        self.key = frozenset(identifiers)
        self._exact = {i.lower() for i in self.key}
        self._phones = {k for k in map(_phone_key, self.key) if k}

    def matches(self, identifier: str) -> bool:
        if not identifier:
            return False
        if identifier.lower() in self._exact:
            return True
        return _phone_key(identifier) in self._phones


class YearCounter:
    """Answers get_year_counts, caching per open backup and year."""

    def __init__(self, message_extractor, photo_extractor, call_extractor,
                 note_extractor, browser_history_extractor):
        self._messages = message_extractor
        self._photos = photo_extractor
        self._calls = call_extractor
        self._notes = note_extractor
        self._browser = browser_history_extractor
        # backup -> (type, person key or None) -> {year: {day: count}}. Reopening
        # a backup makes a new object, so its counts are read afresh.
        self._cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # backup -> type -> Counter of (address, day), for calls and voicemail
        self._addresses: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()

    def year_counts(self, backup, contacts: dict, year: int,
                    types: Optional[list] = None,
                    identifiers: Optional[list] = None) -> dict:
        """Counts per day per type for one year, for everyone or for one person.

        ``years``, ``history_start`` and ``history_end`` describe the whole
        backup, whichever types and person were asked for. ``history_start`` is
        the first day with a message. Older messages are often kept only in
        iCloud, so a day before it is "not in this backup", not a quiet day.
        ``errors`` says which types couldn't be read: each fails on its own.
        """
        requested = list(ALL_TYPES) if types is None else list(types)
        unknown = [t for t in requested if t not in ALL_TYPES]
        if unknown:
            raise ValueError(f"Unknown data types: {unknown}")
        person = None if identifiers is None else _Person(identifiers)

        errors: dict = {}
        everyone: dict = {}
        for entry_type in ALL_TYPES:
            try:
                everyone[entry_type] = self._counts(backup, contacts, entry_type, None)
            except Exception as e:
                errors[entry_type] = str(e)
                everyone[entry_type] = {}

        days: dict = {}
        for entry_type in requested:
            if entry_type in errors:
                continue
            if person is None:
                by_year = everyone[entry_type]
            elif entry_type not in PERSON_TYPES:
                continue
            else:
                try:
                    by_year = self._counts(backup, contacts, entry_type, person)
                except Exception as e:
                    errors[entry_type] = str(e)
                    continue
            for day, count in by_year.get(year, {}).items():
                days.setdefault(day, {})[entry_type] = count

        message_days = [min(d) for d in everyone["message"].values()]
        return {
            "year": year,
            "years": sorted({y for by_year in everyone.values() for y in by_year}),
            "days": days,
            "history_start": min(message_days) if message_days else None,
            "history_end": self._history_end(backup, everyone),
            "errors": errors,
        }

    def messages_on_day(self, backup, contacts: dict, day: str) -> dict:
        """Every message on one local day, for the Timeline to open on it.

        The Timeline's own load stops at 200,000 messages, so an old day of a
        big backup may not be in it. Not get_messages' date filter: its LIMIT
        counts the whole chat, not the dates asked for.
        """
        db_path = get_database(backup, _SMS_DB, "HomeDomain")
        if not db_path:
            return {"conversations": []}
        conn = connect_readonly(db_path, backup)
        try:
            spans = conn.execute(
                f"""SELECT cmj.chat_id, MIN(cmj.message_id), MAX(cmj.message_id)
                    FROM chat_message_join cmj
                    JOIN message m ON m.ROWID = cmj.message_id
                    WHERE m.date > 0 AND {_MESSAGE_DAY} = ?
                    GROUP BY cmj.chat_id""",
                (day,),
            ).fetchall()
            # get_messages pages by message id, newest first. Find the page
            # holding the day's ids, then keep what is really on the day.
            pages = []
            for chat_id, first_id, last_id in spans:
                newer = conn.execute(
                    "SELECT COUNT(DISTINCT message_id) FROM chat_message_join"
                    " WHERE chat_id = ? AND message_id > ?",
                    (chat_id, last_id),
                ).fetchone()[0]
                within = conn.execute(
                    "SELECT COUNT(DISTINCT message_id) FROM chat_message_join"
                    " WHERE chat_id = ? AND message_id BETWEEN ? AND ?",
                    (chat_id, first_id, last_id),
                ).fetchone()[0]
                pages.append((chat_id, newer, within))
        finally:
            conn.close()

        conversations = []
        for chat_id, offset, limit in pages:
            page = self._messages.get_messages(backup, chat_id, contacts, offset, limit)
            on_day = [m for m in page["messages"] if _local_day(m.get("date")) == day]
            if on_day:
                conversations.append({"chat_id": chat_id, "messages": on_day})
        return {"conversations": conversations}

    # ── Counting ──────────────────────────────────────────────────────────────

    def _counts(self, backup, contacts: dict, entry_type: str, person: Optional[_Person]) -> dict:
        """{year: {day: count}} for one type, read once per backup."""
        cache = self._cache.setdefault(backup, {})
        key = (entry_type, person.key if person else None)
        if key not in cache:
            cache[key] = self._read_counts(backup, contacts, entry_type, person)
        return cache[key]

    def _read_counts(self, backup, contacts: dict, entry_type: str, person: Optional[_Person]) -> dict:
        if entry_type == "message":
            return self._message_counts(backup, person)
        if entry_type == "photo":
            return self._photo_counts(backup)
        if entry_type == "note":
            notes = self._notes.list_notes(backup).get("notes", [])
            return _by_year((_local_day(n.get("created") or n.get("modified")), 1) for n in notes)
        if entry_type == "browser":
            visits = self._browser.list_browser_history(backup, "all", 0, 0).get("visits", [])
            return _by_year((_local_day(v.get("visit_date")), 1) for v in visits)
        # Calls and voicemail have the address on each row.
        rows = self._address_counts(backup, contacts, entry_type)
        return _by_year(
            (day, count) for (address, day), count in rows.items()
            if person is None or person.matches(address)
        )

    def _message_counts(self, backup, person: Optional[_Person]) -> dict:
        db_path = get_database(backup, _SMS_DB, "HomeDomain")
        if not db_path:
            return {}
        conn = connect_readonly(db_path, backup)
        try:
            columns = {r[1] for r in conn.execute("PRAGMA table_info(message)")}
            # The Timeline leaves out tapbacks, and get_messages leaves out
            # location balloons. A message joined to two chats is one message.
            where = ["m.date > 0"]
            params: list = []
            if "associated_message_type" in columns:
                where.append("COALESCE(m.associated_message_type, 0) = 0")
            if "balloon_bundle_id" in columns:
                hidden = [
                    bundle for (bundle,) in conn.execute(
                        "SELECT DISTINCT balloon_bundle_id FROM message WHERE balloon_bundle_id IS NOT NULL"
                    )
                    if _type_from_bundle_id(bundle) == "location"
                ]
                where.append(
                    "(m.balloon_bundle_id IS NULL OR m.balloon_bundle_id NOT IN"
                    " (SELECT value FROM json_each(?)))"
                )
                params.append(json.dumps(hidden))
            if person is not None:
                # Only chats the identifiers name: a group chat counts when the
                # caller lists its chat_identifier, not because this person is in it.
                chats = [
                    chat_id for chat_id, identifier in
                    conn.execute("SELECT ROWID, chat_identifier FROM chat")
                    if person.matches(identifier or "")
                ]
                where.append("cmj.chat_id IN (SELECT value FROM json_each(?))")
                params.append(json.dumps(chats))
            return _by_year(conn.execute(
                f"""SELECT {_MESSAGE_DAY} AS day, COUNT(DISTINCT m.ROWID)
                    FROM message m
                    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                    JOIN chat c ON c.ROWID = cmj.chat_id
                    WHERE {' AND '.join(where)}
                    GROUP BY day""",
                params,
            ))
        finally:
            conn.close()

    def _photo_counts(self, backup) -> dict:
        # The rows list_photos lists with a date: not trashed, original in the backup.
        conn = self._photos._inner._open_photos_db(backup)
        if conn is None:
            return {}
        try:
            assets = asset_table(conn)
            columns = {r[1] for r in conn.execute(f"PRAGMA table_info('{assets}')")}
            where = ["ZDATECREATED IS NOT NULL"]
            params: list = []
            if "ZTRASHEDSTATE" in columns:
                where.append("ZTRASHEDSTATE = 0")
            present = self._photos.ids_in_backup(backup)
            if present is not None:
                where.append("Z_PK IN (SELECT value FROM json_each(?))")
                params.append(json.dumps(sorted(present)))
            return _by_year(conn.execute(
                f"""SELECT strftime('%Y-%m-%d', ZDATECREATED + {_APPLE_UNIX_DELTA}, 'unixepoch', 'localtime') AS day,
                           COUNT(*)
                    FROM {assets}
                    WHERE {' AND '.join(where)}
                    GROUP BY day""",
                params,
            ))
        finally:
            conn.close()

    def _address_counts(self, backup, contacts: dict, entry_type: str) -> Counter:
        """Counter of (address, day) for calls or voicemail, read once per backup."""
        cache = self._addresses.setdefault(backup, {})
        if entry_type not in cache:
            read = self._call_rows if entry_type == "call" else self._voicemail_rows
            cache[entry_type] = read(backup, contacts)
        return cache[entry_type]

    def _call_rows(self, backup, contacts: dict) -> Counter:
        result = self._calls.list_calls(backup, contacts, 0, 999999)
        # An unencrypted backup has no call history and says so in "error" too,
        # with an empty_reason. Only a database it couldn't read is a failure.
        if result.get("error") and not result.get("empty_reason"):
            raise RuntimeError(result["error"])
        rows: Counter = Counter()
        for call in result.get("calls", []):
            day = _local_day(call.get("date"))
            if day:
                rows[(call.get("address") or "", day)] += 1
        return rows

    def _voicemail_rows(self, backup, contacts: dict) -> Counter:
        db_path = get_database(backup, _VOICEMAIL_DB, "HomeDomain")
        if not db_path:
            return Counter()
        conn = connect_readonly(db_path, backup)
        try:
            rows: Counter = Counter()
            for sender, day, count in conn.execute(
                """SELECT sender, strftime('%Y-%m-%d', date, 'unixepoch', 'localtime') AS day, COUNT(*)
                   FROM voicemail
                   WHERE (trashed_date = 0 OR trashed_date IS NULL) AND date > 0
                   GROUP BY sender, day"""
            ):
                if day:
                    rows[(_as_text(sender), day)] += count
            return rows
        except sqlite3.OperationalError as e:
            raise RuntimeError(f"Voicemail could not be read: {e}") from e
        finally:
            conn.close()

    @staticmethod
    def _history_end(backup, everyone: dict) -> Optional[str]:
        """The last day this backup can hold: the day it was made, or else its latest item."""
        info = getattr(backup, "info", None) or {}
        made = _local_day(info.get("last_backup") if isinstance(info, dict) else None)
        if made:
            return made
        latest = [max(days) for by_year in everyone.values() for days in by_year.values()]
        return max(latest) if latest else None
