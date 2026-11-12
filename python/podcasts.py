"""
Podcasts adapter.

Delegates reading to ``ios_backup_core.extractors.podcasts``: the shows in the
Apple Podcasts library (MTLibrary.sqlite), their episodes with listening
history, and the OPML subscription list. Keeps what is openextract's own: the
saves.

  * ``opml``: "Podcasts.opml", the followed shows that have a feed address,
    which most podcast apps import. Titled after the iPhone when the backup
    says its name.
  * ``csv``: "Podcasts.csv" (every show) and "Podcast episodes.csv" (every
    episode), dates in local time, for a spreadsheet.

A save never overwrites a file: a second one is "Podcasts (2).opml". When
there is nothing to save, nothing is written and the answer is an error with
an ``empty_reason``, which the app shows as a calm notice.

Episode audio is never in an iPhone backup (the Podcasts app keeps downloads
in a folder backups leave out), so nothing here reads or fetches any: the
saves hold the addresses where each podcast publishes its episodes.
"""

import csv
import os
import sys
from datetime import datetime, timezone
from email.utils import format_datetime

try:
    from ios_backup_core.extractors.podcasts import (
        PodcastExtractor as _CorePodcastExtractor,
        podcasts_to_opml,
    )
except ImportError:
    # An ios-backup-core from before Podcasts support (ios-backup-core#25). The
    # engine must still start and every other section still work, so Podcasts
    # answers as if it weren't in the backup (see _NoPodcastSupport).
    _CorePodcastExtractor = None
    podcasts_to_opml = None

__all__ = ["PodcastExtractor", "NOTHING_TO_SAVE", "NO_FEEDS_TO_SAVE"]

# What the app is told, in words for people.
NOTHING_TO_SAVE = "There are no podcasts in this backup to save."
NO_FEEDS_TO_SAVE = "None of the podcasts in this backup have a feed address to save."

FORMATS = ("opml", "csv")

OPML_NAME = "Podcasts"
SHOWS_CSV_NAME = "Podcasts"
EPISODES_CSV_NAME = "Podcast episodes"

_SHOWS_HEADER = ["Title", "Author", "Followed", "Feed URL", "Website", "Added", "Last played",
                 "Episodes", "Listened"]
_EPISODES_HEADER = ["Podcast", "Title", "Published", "Duration (s)", "Listened", "Play count",
                    "Last played", "Position (s)", "State", "Saved", "Downloaded on iPhone",
                    "Audio URL", "Web page"]

# The State column, by the library's play_state.
_STATE_WORDS = {"played": "Played", "in_progress": "In progress", "unplayed": "Unplayed"}

# A cell starting with one of these is a formula to Excel and LibreOffice. A
# podcast's publisher writes its titles, so "=HYPERLINK(...)" would become a
# live link: such a cell gets a ' in front, which a spreadsheet takes as
# "this is text" (as WhatsApp's and Messages' CSVs do).
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")

# Said once per engine, however many extractors are made.
_told_no_support = False


class _NoPodcastSupport:
    """Stands in for the library's extractor when ios-backup-core has none."""

    def __init__(self):
        global _told_no_support
        if not _told_no_support:
            _told_no_support = True
            print("[podcasts] this ios-backup-core has no Podcasts extractor; Podcasts shows as not in the backup",
                  file=sys.stderr, flush=True)

    def list_podcasts(self, backup):
        return {"podcasts": [], "empty_reason": "not_in_backup"}

    def list_episodes(self, backup, podcast_id=None, listened_only=False, include_descriptions=False):
        return {"episodes": [], "empty_reason": "not_in_backup"}


def _csv_cell(value):
    """A CSV cell a spreadsheet won't take for a formula (see _FORMULA_START)."""
    if isinstance(value, str) and value.startswith(_FORMULA_START):
        return "'" + value
    return "" if value is None else value


def _yes_no(value) -> str:
    return "Yes" if value else "No"


def _seconds(value):
    """Whole seconds for a duration or position, or "" when there is none."""
    if value is None or value == "":
        return ""
    try:
        return int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return ""


def _unused_name(output_dir, base, ext) -> str:
    """"Podcasts.opml", or "Podcasts (2).opml" if that exists, so saving again
    never overwrites a file (as messages.py's exports do)."""
    name = f"{base}{ext}"
    n = 2
    while os.path.exists(os.path.join(output_dir, name)):
        name = f"{base} ({n}){ext}"
        n += 1
    return name


def _device_name(backup):
    """The iPhone's name from the backup's Info.plist, or None when it has none."""
    info = getattr(backup, "info", None) or {}
    name = info.get("device_name") if isinstance(info, dict) else None
    name = " ".join(str(name).split()) if name else ""
    return name if name and name != "Unknown" else None


class PodcastExtractor:
    """Adapter wrapping the ios-backup-core PodcastExtractor."""

    # The time zone the CSVs' dates are written in; None is this computer's.
    local_tz = None

    def __init__(self):
        self._inner = _CorePodcastExtractor() if _CorePodcastExtractor is not None else _NoPodcastSupport()

    # ── Reading ──────────────────────────────────────────────────────────────

    def list_podcasts(self, backup) -> dict:
        """Every show in the library (the library's answer, unchanged)."""
        return self._inner.list_podcasts(backup)

    def list_episodes(self, backup, podcast_id=None, listened_only=False) -> dict:
        """Episodes, newest published first; one show's with ``podcast_id``, the
        listening history with ``listened_only``. No descriptions: the app
        doesn't show them, and they would make the answer much bigger."""
        return self._inner.list_episodes(backup, podcast_id=podcast_id, listened_only=listened_only)

    # ── Saving ───────────────────────────────────────────────────────────────

    def export_podcasts(self, backup, output_dir: str, fmt: str = "opml", now=None) -> dict:
        """Save the podcasts as OPML or CSV into ``output_dir``.

        Returns ``{"status": "success", "count", "path", "files"}``: count is
        the shows written, path the main file, files every file written.
        Nothing to save is an error with ``empty_reason`` and writes nothing;
        a library that can't be read passes its error through.
        """
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        listed = self.list_podcasts(backup)
        if listed.get("error"):
            return {"error": listed["error"]}
        podcasts = listed.get("podcasts") or []
        if not podcasts:
            return {"error": NOTHING_TO_SAVE, "empty_reason": listed.get("empty_reason") or "no_records"}
        try:
            if fmt == "opml":
                return self._write_opml(backup, podcasts, output_dir, now)
            return self._write_csv(backup, podcasts, output_dir)
        except OSError as e:
            return {"error": f"The podcasts couldn't be saved there: {e.strerror or e}"}

    def _write_opml(self, backup, podcasts, output_dir, now=None) -> dict:
        shows = [p for p in podcasts if p.get("followed") and p.get("feed_url")]
        if not shows:
            return {"error": NO_FEEDS_TO_SAVE, "empty_reason": "no_records"}
        device = _device_name(backup)
        title = f"Podcasts from {device}" if device else "Podcasts"
        created = format_datetime(now or datetime.now(timezone.utc), usegmt=True)
        text = podcasts_to_opml(shows, title=title, date_created=created)
        os.makedirs(output_dir, exist_ok=True)
        path = os.path.join(output_dir, _unused_name(output_dir, OPML_NAME, ".opml"))
        with open(path, "x", encoding="utf-8", errors="replace", newline="\n") as f:
            f.write(text)
        return {"status": "success", "count": len(shows), "path": path, "files": [path]}

    def _write_csv(self, backup, podcasts, output_dir) -> dict:
        # Read every episode before writing anything, so a library that fails
        # halfway leaves no half-saved pair of files behind.
        episodes_result = self.list_episodes(backup)
        if episodes_result.get("error"):
            return {"error": episodes_result["error"]}
        episodes = episodes_result.get("episodes") or []
        os.makedirs(output_dir, exist_ok=True)
        shows_path = os.path.join(output_dir, _unused_name(output_dir, SHOWS_CSV_NAME, ".csv"))
        self._write_rows(shows_path, _SHOWS_HEADER, (self._show_row(p) for p in podcasts))
        episodes_path = os.path.join(output_dir, _unused_name(output_dir, EPISODES_CSV_NAME, ".csv"))
        self._write_rows(episodes_path, _EPISODES_HEADER, (self._episode_row(e) for e in episodes))
        return {"status": "success", "count": len(podcasts), "path": shows_path,
                "files": [shows_path, episodes_path]}

    @staticmethod
    def _write_rows(path, header, rows) -> None:
        # utf-8-sig: Excel reads the file as UTF-8 only with the BOM in front.
        with open(path, "x", newline="", encoding="utf-8-sig", errors="replace") as f:
            writer = csv.writer(f)
            writer.writerow(header)
            for row in rows:
                writer.writerow([_csv_cell(cell) for cell in row])

    def _show_row(self, show) -> list:
        return [
            show.get("title") or "",
            show.get("author") or "",
            _yes_no(show.get("followed")),
            show.get("feed_url") or "",
            show.get("webpage_url") or "",
            self._csv_date(show.get("added_date")),
            self._csv_date(show.get("last_played_date")),
            show.get("episode_count") or 0,
            show.get("listened_count") or 0,
        ]

    def _episode_row(self, episode) -> list:
        return [
            episode.get("podcast_title") or "",
            episode.get("title") or "",
            self._csv_date(episode.get("published_date")),
            _seconds(episode.get("duration_seconds")),
            _yes_no(episode.get("listened")),
            episode.get("play_count") or 0,
            self._csv_date(episode.get("last_played_date")),
            _seconds(episode.get("playhead_seconds")),
            _STATE_WORDS.get(episode.get("play_state"), ""),
            _yes_no(episode.get("saved")),
            _yes_no(episode.get("downloaded_on_phone")),
            episode.get("enclosure_url") or "",
            episode.get("webpage_url") or "",
        ]

    def _csv_date(self, iso) -> str:
        """The date as ISO 8601 in local time with its offset, e.g.
        "2024-07-05T09:10:09-07:00": the same moment as the library's UTC
        value, and the clock time people expect (as messages.py's CSVs)."""
        if not iso:
            return ""
        try:
            return datetime.fromisoformat(iso).astimezone(self.local_tz).isoformat()
        except (TypeError, ValueError, OverflowError, OSError):
            return iso
