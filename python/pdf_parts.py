"""
Splitting a long PDF save into one file per year, only when it needs it.

A PDF holds its photos whole, so it grows with them: 3,000 photos made a 1 GB,
1,500-page PDF that took 2.4 GB of memory to print (measured 2026-11-20). A file
like that can't be emailed, is hard to share and print, and if anything fails
near the end the whole save is lost. So a PDF save is planned first:

- If everything fits in one file of a sensible size, it's one file, however many
  years it covers. Three texts sent over three years stay together.
- If not, it's split by year: each year gets its own file, except that quiet
  years next to each other share one. A year too big for one file on its own is
  split into runs of months of about the same size.

electron/pdfExport.ts then saves each part as its own PDF, one engine call each,
and the app says why there are several files. Years and months are the
computer's own (local_dates.py), as the PDF shows its dates.
"""

from datetime import datetime, timedelta, timezone, tzinfo
from typing import Callable, Iterable, Optional

from local_dates import MONTHS

# One PDF holds up to about this much: 1,000 photos (photos are copied in whole,
# about 0.5 MB each at the PDF's 1600 px, messages.PDF_IMAGE_MAX_PX, so about a
# 500 MB file) or 2,000 pages. Measured 2026-11-20 by saving a 60,000-message
# chat with real photos: about 11 messages to a page, a photo takes 0.4 of one,
# and a year of 15,000 messages and 500 photos made a 1,540-page, 260 MB PDF.
MAX_IMAGES = 1000
MAX_PAGES = 2000
MESSAGES_PER_PAGE = 11
PAGES_PER_IMAGE = 0.43
MB_PER_IMAGE = 0.5
MB_PER_MESSAGE = 0.0007

# Once a save has to be split, every year gets its own file, except that years
# with little in them share one, up to this much of a file between them.
SHARE_UP_TO = 0.5


def estimate(messages: int, images: int) -> dict:
    """Roughly how big one PDF of this would be: {"pages", "megabytes"}."""
    return {
        "pages": round(messages / MESSAGES_PER_PAGE + images * PAGES_PER_IMAGE),
        "megabytes": round(images * MB_PER_IMAGE + messages * MB_PER_MESSAGE),
    }


def _weight(tallies: Iterable[list]) -> float:
    """How full one PDF of these months would be: 1.0 is as much as a file should hold."""
    messages = images = 0
    for t in tallies:
        messages += t[0]
        images += t[1]
    pages = messages / MESSAGES_PER_PAGE + images * PAGES_PER_IMAGE
    return max(images / MAX_IMAGES, pages / MAX_PAGES)


def month_key(dt: datetime) -> str:
    """"2024-07"."""
    return f"{dt.year:04d}-{dt.month:02d}"


def count_by_month(messages: Iterable[dict], local_dt: Callable[[object], Optional[datetime]],
                   images_in: Callable[[dict], int], counts: Optional[dict] = None) -> dict:
    """Add each message to ``counts``: {"2024-07": [messages, images]}, and
    messages without a readable date under None. Returns ``counts``."""
    counts = {} if counts is None else counts
    for msg in messages:
        dt = local_dt(msg.get("date"))
        key = month_key(dt) if dt is not None else None
        tally = counts.setdefault(key, [0, 0])
        tally[0] += 1
        tally[1] += images_in(msg)
    return counts


def _part(first: str, last: str, label: Optional[str], tallies: list) -> dict:
    return {
        "from": first,
        "to": last,
        "label": label,
        "undated": False,
        "messages": sum(t[0] for t in tallies),
        "images": sum(t[1] for t in tallies),
    }


def _year_label(first: str, last: str) -> str:
    return first if first == last else f"{first}–{last}"


def _month_label(first: str, last: str) -> str:
    """"Mar 2024", or "Jan–Jun 2024" (always within one year)."""
    year = first[:4]
    a, b = MONTHS[int(first[5:]) - 1], MONTHS[int(last[5:]) - 1]
    return f"{a} {year}" if first == last else f"{a}–{b} {year}"


def _split_year(months: list, counts: dict) -> list:
    """A year too big for one file, as runs of months of about the same size:
    two halves for a year a bit too big, not nine months and three."""
    total = _weight(counts[m] for m in months)
    pieces = -(-total // 1)  # how many files it needs, at least
    target = total / pieces
    groups, group = [], []
    for m in months:
        w_group = _weight(counts[g] for g in group)
        w_month = _weight([counts[m]])
        full = group and (w_group + w_month > 1 or
                          (w_group + w_month / 2 > target and len(groups) < pieces - 1))
        if full:
            groups.append(group)
            group = []
        group.append(m)
    groups.append(group)
    return groups


def plan(counts: dict) -> dict:
    """The files a PDF save should be, from count_by_month's counts.

    Returns {"split", "messages", "images", "estimate", "parts"}. Each part is
    {"from", "to", "label", "undated", "messages", "images"}: months "2024-01"
    and "2024-12" (inclusive) and a label like "2024", "2019–2021" or
    "Jan–Jun 2024". When nothing needs splitting there is one part with from,
    to and label None: everything, as before. ``estimate`` is how big a single
    PDF of everything would be (estimate()), for saying why it was split.
    """
    total_messages = sum(t[0] for t in counts.values())
    total_images = sum(t[1] for t in counts.values())
    summary = {"messages": total_messages, "images": total_images,
               "estimate": estimate(total_messages, total_images)}
    months = sorted(k for k in counts if k is not None)
    if _weight(counts.values()) <= 1 or not months:
        whole = {"from": None, "to": None, "label": None, "undated": True,
                 "messages": total_messages, "images": total_images}
        return {"split": False, **summary, "parts": [whole]}

    parts = []
    shared: list = []  # light years waiting to share a file
    for year in sorted({m[:4] for m in months}):
        in_year = [m for m in months if m[:4] == year]
        tallies = [counts[m] for m in in_year]
        if shared and _weight([counts[m] for m in shared] + tallies) <= SHARE_UP_TO:
            shared += in_year
            continue
        if shared:
            parts.append(_part(f"{shared[0][:4]}-01", f"{shared[-1][:4]}-12",
                               _year_label(shared[0][:4], shared[-1][:4]), [counts[m] for m in shared]))
            shared = []
        if _weight(tallies) <= SHARE_UP_TO:
            shared = in_year
        elif _weight(tallies) <= 1:
            parts.append(_part(f"{year}-01", f"{year}-12", year, tallies))
        else:
            for group in _split_year(in_year, counts):
                parts.append(_part(group[0], group[-1], _month_label(group[0], group[-1]),
                                   [counts[m] for m in group]))
    if shared:
        parts.append(_part(f"{shared[0][:4]}-01", f"{shared[-1][:4]}-12",
                           _year_label(shared[0][:4], shared[-1][:4]), [counts[m] for m in shared]))

    # Messages without a readable date go with the first part.
    if None in counts:
        parts[0]["undated"] = True
        parts[0]["messages"] += counts[None][0]
        parts[0]["images"] += counts[None][1]
    return {"split": True, **summary, "parts": parts}


def in_part(dt: Optional[datetime], part: Optional[dict]) -> bool:
    """Whether a message with local date ``dt`` belongs in ``part``."""
    if not part:
        return True
    if dt is None:
        return bool(part.get("undated"))
    key = month_key(dt)
    first, last = part.get("from"), part.get("to")
    return (first is None or key >= first) and (last is None or key <= last)


def _local_month_start(key: str, tz: Optional[tzinfo]) -> datetime:
    year, month = int(key[:4]), int(key[5:7])
    if tz is None:
        return datetime(year, month, 1).astimezone()  # this computer's time zone
    return datetime(year, month, 1, tzinfo=tz)


def query_window(part: Optional[dict], tz: Optional[tzinfo]) -> tuple:
    """(date_from, date_to) in UTC for the engine's date filter, a day wider than
    the part on each side so a time-zone change can't cut a message off; in_part
    then keeps exactly the part's messages. (None, None) when the whole store has
    to be read: no part, an open end, or messages without a date to include."""
    if not part or part.get("undated") or not part.get("from") or not part.get("to"):
        return None, None
    start = _local_month_start(part["from"], tz)
    last = _local_month_start(part["to"], tz)
    end = _local_month_start(f"{last.year + (last.month == 12):04d}-{last.month % 12 + 1:02d}", tz)
    return ((start - timedelta(days=1)).astimezone(timezone.utc).isoformat(),
            (end + timedelta(days=1)).astimezone(timezone.utc).isoformat())


def file_label(part: Optional[dict]) -> str:
    """The part's label for a file name: "2019-2021", "Jan-Jun 2024" (plain
    hyphens, which every file system and email program handles)."""
    return ((part or {}).get("label") or "").replace("–", "-")
