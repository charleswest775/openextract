"""
Calendar adapter.

Delegates listing to ``ios_backup_core.extractors.calendar_events.CalendarExtractor``.
Adds export: one iCalendar (.ics) file per calendar, which Apple Calendar,
Google Calendar and Outlook can import, plus a CSV of every event.

(Named calendar_events.py so it can't shadow the standard library's
``calendar`` module, since this folder is first on sys.path.)
"""

import csv
import os
from datetime import date, datetime, timedelta, timezone

from export_files import safe_filename, unique_path

try:
    from ios_backup_core.extractors.calendar_events import (
        CalendarExtractor as _CoreCalendarExtractor,
    )
except ImportError:  # an ios-backup-core checkout from before Calendar support
    _CoreCalendarExtractor = None

OUTDATED_CORE_MESSAGE = (
    "Calendar needs a newer version of ios-backup-core. "
    "Update it and restart OpenExtract."
)


class CalendarExtractor:
    """Adapter wrapping the ios-backup-core CalendarExtractor."""

    def __init__(self):
        self._inner = _CoreCalendarExtractor() if _CoreCalendarExtractor else None

    def list_events(self, backup, calendar_id=None) -> dict:
        if self._inner is None:
            return {"events": [], "calendars": [], "errors": [{"message": OUTDATED_CORE_MESSAGE}]}
        return self._inner.list_events(backup, calendar_id=calendar_id)

    # ── openextract-only: export to disk ─────────────────────────────────────

    def export_calendar(self, backup, output_dir: str) -> dict:
        """Write ``<Calendar name>.ics`` per calendar and ``events.csv`` into *output_dir*."""
        if self._inner is None:
            return {"success": False, "error": OUTDATED_CORE_MESSAGE}
        result = self.list_events(backup)
        events = result.get("events", [])
        if not events:
            return {"success": False, "error": "No calendar events found to export."}

        calendars = {c["id"]: c for c in result.get("calendars", [])}
        by_calendar: dict = {}
        for ev in events:
            by_calendar.setdefault(ev.get("calendar_id"), []).append(ev)

        try:
            os.makedirs(output_dir, exist_ok=True)
            files = []
            stamp = datetime.now(timezone.utc)
            for calendar_id, cal_events in by_calendar.items():
                cal = calendars.get(calendar_id) or {"title": "Other", "color": None}
                path = unique_path(output_dir, safe_filename(cal["title"]) + ".ics")
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(build_ics(cal["title"], cal.get("color"), cal_events, stamp))
                files.append(os.path.basename(path))

            with open(os.path.join(output_dir, "events.csv"), "w",
                      newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Start", "End", "All Day", "Title", "Calendar", "Account",
                                 "Location", "Address", "Notes", "URL", "Organizer",
                                 "Attendees", "Repeats", "Time Zone"])
                for ev in events:
                    writer.writerow([
                        ev["start"], ev.get("end") or "", "Yes" if ev["all_day"] else "",
                        ev["title"], ev.get("calendar") or "", ev.get("account") or "",
                        ev.get("location") or "", ev.get("address") or "", ev.get("notes") or "",
                        ev.get("url") or "", _person(ev.get("organizer")),
                        "; ".join(_person(a) for a in ev.get("attendees", [])),
                        "Yes" if ev.get("recurring") else "", ev.get("timezone") or "",
                    ])

            return {
                "success": True,
                "path": output_dir,
                "files": files,
                "count": len(events),
                "recurring": sum(1 for ev in events if ev.get("recurring")),
            }
        except OSError as e:
            return {"success": False, "error": f"Export failed: {e}"}


def _person(p) -> str:
    if not p:
        return ""
    name, email = p.get("name"), p.get("email")
    if name and email:
        return f"{name} <{email}>"
    return name or email or ""


# ── iCalendar (RFC 5545) ─────────────────────────────────────────────────────

def ics_escape(text: str) -> str:
    """Escape a TEXT value."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
        .replace("\r", "\\n")
    )


def ics_fold(line: str, limit: int = 75) -> str:
    """Fold a content line at *limit* octets without splitting a UTF-8 character."""
    parts, current, length = [], "", 0
    for ch in line:
        size = len(ch.encode("utf-8"))
        if length + size > limit:
            parts.append(current)
            current, length = " " + ch, 1 + size
        else:
            current += ch
            length += size
    parts.append(current)
    return "\r\n".join(parts)


def _param(value: str) -> str:
    """Quote a parameter value (e.g. CN) — DQUOTE isn't allowed inside."""
    return '"' + value.replace('"', "'") + '"'


def _ics_datetime(value: str) -> str:
    """ISO string → iCalendar DATE-TIME: UTC with Z, or floating (no offset) as-is."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        return dt.strftime("%Y%m%dT%H%M%S")
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_ics(calendar_name: str, color, events: list, stamp: datetime) -> str:
    """Return a VCALENDAR document for *events* (dicts from CalendarExtractor)."""
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//OpenExtract//Calendar Export//EN",
        "CALSCALE:GREGORIAN",
        f"X-WR-CALNAME:{ics_escape(calendar_name)}",
    ]
    if color:
        lines.append(f"X-APPLE-CALENDAR-COLOR:{color}")

    dtstamp = stamp.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    seen_uids = set()
    for ev in events:
        uid = ev.get("uid") or f"{ev['id']}@openextract"
        if uid in seen_uids:  # e.g. an edited occurrence sharing its series' UID
            uid = f"{uid}-{ev['id']}"
        seen_uids.add(uid)

        lines += ["BEGIN:VEVENT", f"UID:{ics_escape(uid)}", f"DTSTAMP:{dtstamp}"]
        if ev["all_day"]:
            first = date.fromisoformat(ev["start"])
            last = date.fromisoformat(ev.get("end") or ev["start"])
            lines.append(f"DTSTART;VALUE=DATE:{first.strftime('%Y%m%d')}")
            # DTEND is exclusive for all-day events.
            lines.append(f"DTEND;VALUE=DATE:{(last + timedelta(days=1)).strftime('%Y%m%d')}")
        else:
            lines.append(f"DTSTART:{_ics_datetime(ev['start'])}")
            if ev.get("end"):
                lines.append(f"DTEND:{_ics_datetime(ev['end'])}")
        lines.append(f"SUMMARY:{ics_escape(ev.get('title') or '')}")

        location = ev.get("location") or ""
        address = ev.get("address") or ""
        if address and address != location:
            location = f"{location}, {address}" if location else address
        if location:
            lines.append(f"LOCATION:{ics_escape(location)}")
        if ev.get("latitude") is not None and ev.get("longitude") is not None:
            lines.append(f"GEO:{ev['latitude']};{ev['longitude']}")
        if ev.get("notes"):
            lines.append(f"DESCRIPTION:{ics_escape(ev['notes'])}")
        url = ev.get("url") or ev.get("conference_url")
        if url:
            lines.append(f"URL:{url}")
        for field, key in (("CREATED", "created"), ("LAST-MODIFIED", "modified")):
            if ev.get(key):
                lines.append(f"{field}:{_ics_datetime(ev[key])}")

        organizer = ev.get("organizer") or {}
        if organizer.get("email"):
            cn = f";CN={_param(organizer['name'])}" if organizer.get("name") else ""
            lines.append(f"ORGANIZER{cn}:mailto:{organizer['email']}")
        for attendee in ev.get("attendees", []):
            if attendee.get("email"):
                cn = f";CN={_param(attendee['name'])}" if attendee.get("name") else ""
                lines.append(f"ATTENDEE{cn}:mailto:{attendee['email']}")
        lines.append("END:VEVENT")

    lines.append("END:VCALENDAR")
    return "\r\n".join(ics_fold(line) for line in lines) + "\r\n"
