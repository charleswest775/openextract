"""
Dates in saved files, in the computer's own time zone.

ios-backup-core gives every date in UTC ("2024-07-05T16:10:09+00:00"). Saves
people read show it in local time instead, as the app does (src/lib/dates.ts),
so a call made or a page visited on a Friday evening in California doesn't land
on Saturday. Messages, WhatsApp, podcasts, call history, web history and notes
use these. The data bundle's JSON stays UTC on purpose: it's a documented
machine format.

Each function takes ``tz``, the time zone to show: None is this computer's,
which the app uses; tests pass a fixed one.
"""

from datetime import datetime, tzinfo
from typing import Optional

# Month names written out, so the computer's language settings can't change
# them (strftime's %b follows the locale).
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def local_datetime(iso, tz: Optional[tzinfo] = None) -> Optional[datetime]:
    """The date in local time, or None if there is none we can read."""
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).astimezone(tz)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def format_day(dt: datetime) -> str:
    """"Jul 5, 2024"."""
    return f"{MONTHS[dt.month - 1]} {dt.day}, {dt.year}"


def format_time(dt: datetime) -> str:
    """"9:10 AM"."""
    return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def readable_date(iso, tz: Optional[tzinfo] = None) -> str:
    """"Jul 5, 2024, 9:10 AM", for text that reads on its own. A date we can't
    read is written as it came; a missing one is "Unknown date". The app's own
    saves write the same words (formatSavedDateTime in src/lib/dates.ts)."""
    dt = local_datetime(iso, tz)
    if dt is None:
        return iso or "Unknown date"
    return f"{format_day(dt)}, {format_time(dt)}"


def csv_date(iso, tz: Optional[tzinfo] = None) -> str:
    """The date as ISO 8601 in local time with its offset, e.g.
    "2024-07-05T09:10:09-07:00": the same moment as the UTC value, so programs
    read it exactly, and the clock time people expect. A date we can't read is
    written as it came; a missing one is empty."""
    dt = local_datetime(iso, tz)
    return dt.isoformat() if dt is not None else (iso or "")
