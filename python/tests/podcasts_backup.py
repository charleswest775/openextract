"""A backup with Apple Podcasts in it, for the engine's tests and for screenshots.

backupgen writes no Podcasts library, so the tests build MTLibrary.sqlite
here, with the column sets of real libraries (as ios-backup-core's own
tests/test_podcasts.py does): an iOS 13 one (no implicit follows, no
bookmarks) and an iOS 16+ one. Only the columns the extractor reads are made,
plus a few it ignores. Every show and episode is invented, with example.com
addresses.

The test library holds the cases that matter:

  * a title with ``&`` and ``<`` (OPML must escape it) and one starting with
    ``=`` (CSV must not let a spreadsheet run it);
  * a followed show with no feed address (left out of the OPML);
  * an implicitly followed show (iOS 16+: played, not chosen; not "followed",
    so not in the OPML; on the iOS 13 layout it reads as followed);
  * a show that was unfollowed, but listened to;
  * a back-catalogue episode the app marked played though nobody listened,
    an episode in progress, a saved one and a downloaded one.

``Scenario`` says what the engine should read back from it.

Two ways to get a backup out of it, reusing whatsapp_backup.py:

  * ``make_minimal``: a bare plain backup holding only the library;
  * ``make_einstein_copy``: a copy of the generated Einstein backup (Messages
    and Contacts) with the library added.

For screenshots of the dev app, a plain demo backup (Einstein's copy plus
eight fictional shows and a couple of years of listening):

    python python/tests/podcasts_backup.py demo DEST_DIR

It prints the backup's folder and UDID.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import random
import sqlite3
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import whatsapp_backup as wb  # noqa: E402

DOMAIN = "AppDomainGroup-243LU875E5.groups.com.apple.podcasts"
DB_PATH = "Documents/MTLibrary.sqlite"
LIBRARY = (DOMAIN, DB_PATH)

PLAIN_UDID = "00008120-0000000000C0DCA5"
ENCRYPTED_UDID = "00008030-0000000000C0DCA6"
DEMO_UDID = "00008120-0000000000DE30CA"
PASSWORD = "test"
DEVICE_NAME = "Podcasts test iPhone"
DEMO_DEVICE_NAME = "Podcasts demo iPhone"

_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

# Column sets copied from real MTLibrary.sqlite files (names only).
IOS13_PODCAST = (
    "Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSUBSCRIBED INTEGER, ZHIDDEN INTEGER,"
    " ZSORTORDER INTEGER, ZSTORECOLLECTIONID INTEGER, ZADDEDDATE TIMESTAMP,"
    " ZLASTDATEPLAYED TIMESTAMP, ZAUTHOR VARCHAR, ZCATEGORY VARCHAR, ZFEEDURL VARCHAR,"
    " ZIMAGEURL VARCHAR, ZITEMDESCRIPTION VARCHAR, ZPROVIDER VARCHAR,"
    " ZSHOWTYPEINFEED VARCHAR, ZSTORECLEANURL VARCHAR, ZTITLE VARCHAR,"
    " ZUPDATEDFEEDURL VARCHAR, ZUUID VARCHAR, ZWEBPAGEURL VARCHAR"
)
IOS16_PODCAST = IOS13_PODCAST + (
    ", ZISIMPLICITLYFOLLOWED INTEGER, ZISHIDDENORIMPLICITLYFOLLOWED INTEGER,"
    " ZLASTUNFOLLOWEDDATE TIMESTAMP"
)
IOS13_EPISODE = (
    "Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPODCAST INTEGER, ZPLAYCOUNT INTEGER,"
    " ZPLAYSTATE INTEGER, ZSAVED INTEGER, ZVIDEO INTEGER, ZFEEDDELETED INTEGER,"
    " ZUSERDELETED INTEGER, ZSEASONNUMBER INTEGER, ZEPISODENUMBER INTEGER,"
    " ZDURATION FLOAT, ZLASTDATEPLAYED TIMESTAMP, ZPLAYHEAD FLOAT, ZPUBDATE TIMESTAMP,"
    " ZASSETURL VARCHAR, ZAUTHOR VARCHAR, ZENCLOSUREURL VARCHAR, ZEPISODETYPE VARCHAR,"
    " ZGUID VARCHAR, ZITEMDESCRIPTIONWITHOUTHTML VARCHAR, ZPODCASTUUID VARCHAR,"
    " ZTITLE VARCHAR, ZUUID VARCHAR, ZWEBPAGEURL VARCHAR"
)
IOS16_EPISODE = IOS13_EPISODE + ", ZISBOOKMARKED INTEGER, ZISHIDDEN INTEGER"
_SCHEMAS = {"ios13": (IOS13_PODCAST, IOS13_EPISODE), "ios16": (IOS16_PODCAST, IOS16_EPISODE)}
_IOS16_ONLY = {"ZISIMPLICITLYFOLLOWED", "ZISHIDDENORIMPLICITLYFOLLOWED", "ZLASTUNFOLLOWEDDATE",
               "ZISBOOKMARKED", "ZISHIDDEN"}

# Where the Podcasts app keeps a downloaded episode: never in a backup.
_DOWNLOADED = "file:///private/var/mobile/Media/Podcasts/{}.mp3"


def apple(dt: datetime) -> float:
    """Seconds since 2001-01-01 UTC, as Core Data stores a date."""
    return (dt - _APPLE_EPOCH).total_seconds()


def iso(dt: datetime) -> str:
    """The date the way the library returns it (UTC ISO 8601)."""
    return dt.astimezone(timezone.utc).isoformat()


def _at(year, month, day, hour=12, minute=0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# ── The test library ─────────────────────────────────────────────────────────

AMPERSAND_TITLE = "Field Notes & <Margins>"
FORMULA_TITLE = "=1+1 Radio"
FORMULA_EPISODE = "-30 Degrees and Falling"
NO_FEED_TITLE = "Studio Archive"
IMPLICIT_TITLE = "Morning Tidepool"
UNFOLLOWED_TITLE = "Old Habits Hour"

SHOW_FIELD_NOTES, SHOW_FORMULA, SHOW_IMPLICIT, SHOW_NO_FEED, SHOW_UNFOLLOWED = 1, 2, 3, 4, 5

EP_DOWNLOADED = 101      # listened twice, downloaded on the phone
EP_IN_PROGRESS = 102     # 12:34 in, saved
EP_BACK_CATALOGUE = 103  # marked played when the show was followed; never listened
EP_FORMULA = 201         # listened once; its title starts with "-"
EP_UNPLAYED = 202
EP_IMPLICIT = 301        # last played date only
EP_NO_FEED = 401
EP_UNFOLLOWED = 501      # listened once, before the show was unfollowed

ADDED = _at(2024, 2, 3, 18, 30)
IN_PROGRESS_AT = 754.0


@dataclass
class Scenario:
    schema: str                                      # "ios13" or "ios16"
    shows: dict = field(default_factory=dict)        # id -> what list_podcasts returns for it
    episodes: dict = field(default_factory=dict)     # id -> what list_episodes returns for it
    files: dict = field(default_factory=dict)        # (domain, relative path) -> bytes

    @property
    def followed(self) -> set:
        return {i for i, s in self.shows.items() if s["followed"]}

    @property
    def opml_feeds(self) -> dict:
        """title -> feed URL for every show the OPML should hold (followed, with a feed)."""
        return {s["title"]: s["feed_url"] for s in self.shows.values() if s["followed"] and s["feed_url"]}

    @property
    def listened(self) -> set:
        return {i for i, e in self.episodes.items() if e["listened"]}

    def episodes_of(self, podcast_id: int) -> set:
        return {i for i, e in self.episodes.items() if e["podcast_id"] == podcast_id}

    def newest_first(self, ids) -> list:
        return sorted(ids, key=lambda i: (self.episodes[i]["published_date"], i), reverse=True)


def _show_rows():
    return [
        {"Z_PK": SHOW_FIELD_NOTES, "ZSORTORDER": 1, "ZTITLE": AMPERSAND_TITLE, "ZAUTHOR": "Ines Calloway",
         "ZSUBSCRIBED": 1, "ZISIMPLICITLYFOLLOWED": 0, "ZHIDDEN": 0,
         "ZFEEDURL": "http://feeds.example.com/field-notes?a=1&b=2",
         "ZUPDATEDFEEDURL": "https://feeds.example.com/field-notes?a=1&b=2",
         "ZWEBPAGEURL": "https://example.com/field-notes", "ZADDEDDATE": apple(ADDED),
         "ZLASTDATEPLAYED": apple(_at(2025, 6, 2, 7, 45)), "ZUUID": "podcast-uuid-1",
         "ZCATEGORY": "Science", "ZSHOWTYPEINFEED": "episodic"},
        {"Z_PK": SHOW_FORMULA, "ZSORTORDER": 2, "ZTITLE": FORMULA_TITLE, "ZPROVIDER": "Formula Works",
         "ZSUBSCRIBED": 1, "ZISIMPLICITLYFOLLOWED": 0,
         "ZFEEDURL": "https://feeds.example.com/one-plus-one.xml",
         "ZWEBPAGEURL": "https://example.com/one-plus-one", "ZADDEDDATE": apple(ADDED + timedelta(days=9))},
        {"Z_PK": SHOW_IMPLICIT, "ZSORTORDER": 3, "ZTITLE": IMPLICIT_TITLE, "ZAUTHOR": "Tidepool Audio",
         "ZSUBSCRIBED": 1, "ZISIMPLICITLYFOLLOWED": 1, "ZISHIDDENORIMPLICITLYFOLLOWED": 1,
         "ZFEEDURL": "https://feeds.example.com/tidepool.xml"},
        {"Z_PK": SHOW_NO_FEED, "ZSORTORDER": 4, "ZTITLE": NO_FEED_TITLE, "ZPROVIDER": "Example Studios",
         "ZSUBSCRIBED": 1, "ZISIMPLICITLYFOLLOWED": 0, "ZFEEDURL": None,
         "ZWEBPAGEURL": "https://example.com/studio-archive"},
        {"Z_PK": SHOW_UNFOLLOWED, "ZSORTORDER": 5, "ZTITLE": UNFOLLOWED_TITLE, "ZAUTHOR": "Rowan Pike",
         "ZSUBSCRIBED": 0, "ZISIMPLICITLYFOLLOWED": 0, "ZFEEDURL": "https://feeds.example.com/old-habits.xml",
         "ZLASTUNFOLLOWEDDATE": apple(_at(2025, 9, 1))},
    ]


def _episode_rows():
    return [
        {"Z_PK": EP_DOWNLOADED, "ZPODCAST": SHOW_FIELD_NOTES, "ZTITLE": "Moss, measured",
         "ZPUBDATE": apple(_at(2025, 5, 30, 4)), "ZDURATION": 1834.6, "ZPLAYCOUNT": 2,
         "ZLASTDATEPLAYED": apple(_at(2025, 6, 2, 7, 45)), "ZPLAYSTATE": 0,
         "ZASSETURL": _DOWNLOADED.format("moss"), "ZENCLOSUREURL": "https://cdn.example.com/field-notes/12.mp3",
         "ZWEBPAGEURL": "https://example.com/field-notes/12", "ZEPISODENUMBER": 12, "ZGUID": "fn-12"},
        {"Z_PK": EP_IN_PROGRESS, "ZPODCAST": SHOW_FIELD_NOTES, "ZTITLE": "Lichen & the long wait",
         "ZPUBDATE": apple(_at(2025, 5, 16, 4)), "ZDURATION": 2410.0, "ZPLAYCOUNT": 0,
         "ZPLAYHEAD": IN_PROGRESS_AT, "ZPLAYSTATE": 1, "ZSAVED": 1,
         "ZENCLOSUREURL": "https://cdn.example.com/field-notes/11.mp3", "ZEPISODENUMBER": 11},
        {"Z_PK": EP_BACK_CATALOGUE, "ZPODCAST": SHOW_FIELD_NOTES, "ZTITLE": "Pilot",
         "ZPUBDATE": apple(_at(2023, 1, 9, 4)), "ZDURATION": 1200.0, "ZPLAYCOUNT": 0, "ZPLAYHEAD": 0.0,
         "ZPLAYSTATE": 0, "ZENCLOSUREURL": "https://cdn.example.com/field-notes/1.mp3", "ZEPISODENUMBER": 1},
        {"Z_PK": EP_FORMULA, "ZPODCAST": SHOW_FORMULA, "ZTITLE": FORMULA_EPISODE,
         "ZPUBDATE": apple(_at(2025, 7, 1, 9)), "ZDURATION": 960.0, "ZPLAYCOUNT": 1,
         "ZLASTDATEPLAYED": apple(_at(2025, 7, 3, 21, 5)), "ZPLAYSTATE": 0,
         "ZENCLOSUREURL": "https://cdn.example.com/one-plus-one/30.mp3"},
        # Some libraries hold text as a BLOB; it must come back as text, never raw bytes.
        {"Z_PK": EP_UNPLAYED, "ZPODCAST": SHOW_FORMULA, "ZTITLE": "Rounding errors".encode("utf-8"),
         "ZPUBDATE": apple(_at(2025, 7, 15, 9)), "ZDURATION": 1010.0, "ZPLAYSTATE": 2,
         "ZENCLOSUREURL": "https://cdn.example.com/one-plus-one/31.mp3"},
        {"Z_PK": EP_IMPLICIT, "ZPODCAST": SHOW_IMPLICIT, "ZTITLE": "Low tide at six",
         "ZPUBDATE": apple(_at(2025, 3, 3, 6)), "ZDURATION": 1500.0,
         "ZLASTDATEPLAYED": apple(_at(2025, 3, 4, 6, 30)), "ZPLAYSTATE": 0,
         "ZENCLOSUREURL": "https://cdn.example.com/tidepool/7.mp3"},
        {"Z_PK": EP_NO_FEED, "ZPODCAST": SHOW_NO_FEED, "ZTITLE": "Reel one",
         "ZPUBDATE": apple(_at(2024, 11, 20, 10)), "ZPLAYSTATE": 2},
        {"Z_PK": EP_UNFOLLOWED, "ZPODCAST": SHOW_UNFOLLOWED, "ZTITLE": "Breaking the snooze button",
         "ZPUBDATE": apple(_at(2024, 8, 5, 5)), "ZDURATION": 2100.0, "ZPLAYCOUNT": 1,
         "ZLASTDATEPLAYED": apple(_at(2024, 8, 6, 8)), "ZPLAYSTATE": 0,
         "ZENCLOSUREURL": "https://cdn.example.com/old-habits/40.mp3"},
    ]


def _expected(schema: str) -> tuple[dict, dict]:
    implicit_column = schema == "ios16"
    shows = {
        SHOW_FIELD_NOTES: {"title": AMPERSAND_TITLE, "author": "Ines Calloway",
                           "feed_url": "https://feeds.example.com/field-notes?a=1&b=2",
                           "original_feed_url": "http://feeds.example.com/field-notes?a=1&b=2",
                           "webpage_url": "https://example.com/field-notes", "followed": True,
                           "implicitly_followed": False, "added_date": iso(ADDED),
                           "episode_count": 3, "listened_count": 2},
        SHOW_FORMULA: {"title": FORMULA_TITLE, "author": "Formula Works",
                       "feed_url": "https://feeds.example.com/one-plus-one.xml", "original_feed_url": None,
                       "webpage_url": "https://example.com/one-plus-one", "followed": True,
                       "implicitly_followed": False, "added_date": iso(ADDED + timedelta(days=9)),
                       "episode_count": 2, "listened_count": 1},
        # On the iOS 13 layout there is no implicit follow: subscribed is followed.
        SHOW_IMPLICIT: {"title": IMPLICIT_TITLE, "author": "Tidepool Audio",
                        "feed_url": "https://feeds.example.com/tidepool.xml", "original_feed_url": None,
                        "webpage_url": None, "followed": not implicit_column,
                        "implicitly_followed": implicit_column, "added_date": None,
                        "episode_count": 1, "listened_count": 1},
        SHOW_NO_FEED: {"title": NO_FEED_TITLE, "author": "Example Studios", "feed_url": None,
                       "original_feed_url": None, "webpage_url": "https://example.com/studio-archive",
                       "followed": True, "implicitly_followed": False, "added_date": None,
                       "episode_count": 1, "listened_count": 0},
        SHOW_UNFOLLOWED: {"title": UNFOLLOWED_TITLE, "author": "Rowan Pike",
                          "feed_url": "https://feeds.example.com/old-habits.xml", "original_feed_url": None,
                          "webpage_url": None, "followed": False, "implicitly_followed": False,
                          "added_date": None, "episode_count": 1, "listened_count": 1},
    }
    episodes = {}
    for row in _episode_rows():
        play_count = row.get("ZPLAYCOUNT") or 0
        playhead = row.get("ZPLAYHEAD") or 0.0
        last_played = row.get("ZLASTDATEPLAYED")
        episodes[row["Z_PK"]] = {
            "podcast_id": row["ZPODCAST"],
            "podcast_title": shows[row["ZPODCAST"]]["title"],
            "title": row["ZTITLE"].decode("utf-8") if isinstance(row["ZTITLE"], bytes) else row["ZTITLE"],
            "published_date": iso(_APPLE_EPOCH + timedelta(seconds=row["ZPUBDATE"])),
            "duration_seconds": row.get("ZDURATION"),
            "play_count": play_count,
            "playhead_seconds": playhead or None,
            "last_played_date": iso(_APPLE_EPOCH + timedelta(seconds=last_played)) if last_played else None,
            "play_state": {0: "played", 1: "in_progress", 2: "unplayed"}[row["ZPLAYSTATE"]],
            "listened": bool(play_count or playhead or last_played),
            "saved": bool(row.get("ZSAVED")),
            "downloaded_on_phone": bool(row.get("ZASSETURL")),
            "enclosure_url": row.get("ZENCLOSUREURL"),
        }
    return shows, episodes


def write_library(path: Path, schema: str = "ios16", shows=None, episodes=None) -> bytes:
    """Write MTLibrary.sqlite at ``path`` (the given rows, or the test library's) and return its bytes."""
    podcast_cols, episode_cols = _SCHEMAS[schema]
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(f"CREATE TABLE ZMTPODCAST ({podcast_cols})")
        conn.execute(f"CREATE TABLE ZMTEPISODE ({episode_cols})")
        for table, rows in (("ZMTPODCAST", _show_rows() if shows is None else shows),
                            ("ZMTEPISODE", _episode_rows() if episodes is None else episodes)):
            for row in rows:
                if schema == "ios13":
                    row = {k: v for k, v in row.items() if k not in _IOS16_ONLY}
                names = ", ".join(row)
                conn.execute(f"INSERT INTO {table} ({names}) VALUES ({', '.join('?' * len(row))})",
                             list(row.values()))
        conn.commit()
    finally:
        conn.close()
    return path.read_bytes()


def build(workdir: Path, schema: str = "ios16") -> Scenario:
    """The test library, built in ``workdir``; the Scenario holds its bytes and what should be read back."""
    shows, episodes = _expected(schema)
    data = write_library(Path(workdir) / f"MTLibrary-{schema}.sqlite", schema)
    return Scenario(schema=schema, shows=shows, episodes=episodes, files={LIBRARY: data})


def empty_library(workdir: Path) -> bytes:
    """A library with its tables but no shows or episodes."""
    return write_library(Path(workdir) / "MTLibrary-empty.sqlite", "ios16", shows=[], episodes=[])


def library_problem() -> Optional[str]:
    """Why the podcast tests can't read a library here, or None when they can."""
    try:
        module = importlib.import_module("ios_backup_core.extractors.podcasts")
    except ImportError:
        module = None
    if module is None or not all(hasattr(module, name) for name in ("PodcastExtractor", "podcasts_to_opml")):
        return ("this ios-backup-core has no Podcasts extractor (ios-backup-core#25); set PYTHONPATH to a "
                "checkout that has it")
    return None


# ── Backups ──────────────────────────────────────────────────────────────────

def make_minimal(dest: Path, files: dict, udid: str = PLAIN_UDID) -> Path:
    """A bare plain backup holding only ``files`` ((domain, relative path) -> bytes)."""
    return wb.make_minimal_plain(dest, files, udid)


def make_einstein_copy(source: Path, dest: Path, scenario, udid: str = PLAIN_UDID,
                       device_name: str = DEVICE_NAME) -> Path:
    """A copy of an unencrypted backup (Einstein's) with the scenario's files added, under a new UDID."""
    return wb.make_plain_copy(source, dest, scenario, udid=udid, device_name=device_name)


def make_encrypted(out_parent: Path, scenario, password: str = PASSWORD, udid: str = ENCRYPTED_UDID) -> Path:
    """A new encrypted backup holding only the scenario's files (backupgen's BackupWriter); returns its folder."""
    container, _ = wb._backupgen()
    device = container.Device(name=DEVICE_NAME, product_type="iPhone12,1", product_name="iPhone 11",
                              ios=wb.SCHEMA_VERSION, build="21D50", phone_number="+1 202 555 0100", udid=udid)
    writer = container.BackupWriter(Path(out_parent), device, datetime(2025, 10, 2, tzinfo=timezone.utc),
                                    wb.SCHEMA_VERSION, password=password, seed=11)
    for (domain, rel), data in scenario.files.items():
        writer.add_file(domain, rel, data)
    return writer.finalize()


# ── The demo library, for screenshots ────────────────────────────────────────

_DEMO_SHOWS = [
    # title, author, followed, implicitly followed, episodes, category
    ("The Quiet Workshop", "Hollis Marrow", True, False, 48, "Arts"),
    ("Tidewater Stories", "Juniper Lane Audio", True, False, 36, "Society & Culture"),
    ("Small Kitchen Science", "Dr. Ama Okafor", True, False, 52, "Science"),
    ("Northbound Notes", "Pell & Reyes", True, False, 27, "Travel"),
    ("Lantern Hour", "Sable Radio Collective", True, False, 60, "Fiction"),
    ("The Long Commute", "Theo Vance", True, False, 41, "Comedy"),
    ("Garden Ledger", "Wren Ashby", False, True, 22, "Leisure"),
    ("Field Recording Club", "Mika Sorensen", False, False, 30, "Music"),
]
_DEMO_WORDS = ["Tides", "Clockwork", "Bread", "Maps", "Weather", "Letters", "Copper", "Moss", "Lanterns",
               "Rivers", "Salt", "Orchards", "Signals", "Paper", "Stone", "Harbors", "Embers", "Kites"]
_DEMO_FORMS = ["On {}", "The quiet life of {}", "{} and other stories", "What {} remember", "A short history of {}",
               "Notes on {}", "{}, revisited", "Why we keep {}", "{} at midnight", "Listener mail: {}"]


def _slug(title: str) -> str:
    return "-".join("".join(c.lower() if c.isalnum() else " " for c in title).split())


def demo_rows(seed: int = 26) -> tuple[list, list]:
    """Eight fictional shows, 20-60 episodes each over 2024-2026, about 25 listened, a few in
    progress, saved or downloaded."""
    rng = random.Random(seed)
    start, end = _at(2024, 1, 8, 5), _at(2026, 10, 27, 5)
    shows, episodes = [], []
    listened_budget = {0: 6, 1: 4, 2: 5, 3: 2, 4: 4, 5: 2, 6: 1, 7: 1}  # about 25 in all
    pk = 1000
    for n, (title, author, followed, implicit, count, category) in enumerate(_DEMO_SHOWS, start=1):
        slug = _slug(title)
        shows.append({
            "Z_PK": n, "ZSORTORDER": n, "ZTITLE": title, "ZAUTHOR": author, "ZCATEGORY": category,
            "ZSUBSCRIBED": 1 if (followed or implicit) else 0, "ZISIMPLICITLYFOLLOWED": 1 if implicit else 0,
            "ZFEEDURL": f"https://feeds.example.com/{slug}.xml", "ZWEBPAGEURL": f"https://example.com/{slug}",
            "ZADDEDDATE": apple(start + timedelta(days=rng.randint(0, 200))) if followed else None,
            "ZUUID": f"demo-podcast-{n}", "ZSHOWTYPEINFEED": "episodic",
        })
        span = (end - start).total_seconds()
        dates = sorted(start + timedelta(seconds=rng.uniform(0, span)) for _ in range(count))
        listened = set(rng.sample(range(max(0, count - 15), count), listened_budget[n - 1]))
        recent = sorted(set(range(count - 6, count)) - listened)
        in_progress = rng.choice(recent) if n <= 4 and recent else None
        last_played = None
        for i, published in enumerate(dates):
            pk += 1
            published = published.replace(minute=0, second=0, microsecond=0)
            duration = float(rng.randint(18, 75) * 60 + rng.randint(0, 59))
            row = {
                "Z_PK": pk, "ZPODCAST": n, "ZTITLE": f"{i + 1}. " + rng.choice(_DEMO_FORMS).format(rng.choice(_DEMO_WORDS)),
                "ZPUBDATE": apple(published), "ZDURATION": duration, "ZEPISODENUMBER": i + 1,
                "ZGUID": f"{slug}-{i + 1}", "ZPLAYCOUNT": 0, "ZPLAYHEAD": 0.0,
                # Following a show marks its back catalogue played (see the extractor).
                "ZPLAYSTATE": 0 if followed and i < count - 8 else 2,
                "ZENCLOSUREURL": f"https://cdn.example.com/{slug}/{i + 1}.mp3",
                "ZWEBPAGEURL": f"https://example.com/{slug}/{i + 1}",
            }
            if i in listened:
                played = min(published + timedelta(hours=rng.randint(6, 240)), end)
                row.update(ZPLAYCOUNT=rng.choice([1, 1, 1, 2]), ZLASTDATEPLAYED=apple(played), ZPLAYSTATE=0)
                last_played = max(last_played or played, played)
                if rng.random() < 0.25:
                    row["ZASSETURL"] = _DOWNLOADED.format(f"{slug}-{i + 1}")
            if i == in_progress:
                row.update(ZPLAYHEAD=float(rng.randint(120, int(duration) - 60)), ZPLAYSTATE=1, ZSAVED=1,
                           ZASSETURL=_DOWNLOADED.format(f"{slug}-{i + 1}"))
            elif i == count - 1 and n in (2, 5):
                row["ZSAVED"] = 1
            episodes.append(row)
        if last_played:
            shows[-1]["ZLASTDATEPLAYED"] = apple(last_played)
    return shows, episodes


def build_demo(workdir: Path):
    """The demo library's files ((domain, path) -> bytes) in a Scenario-like object, plus its counts."""
    shows, episodes = demo_rows()
    data = write_library(Path(workdir) / "MTLibrary-demo.sqlite", "ios16", shows=shows, episodes=episodes)
    listened = sum(1 for e in episodes if e.get("ZPLAYCOUNT") or e.get("ZPLAYHEAD") or e.get("ZLASTDATEPLAYED"))
    return Scenario(schema="ios16", files={LIBRARY: data}), len(shows), len(episodes), listened


# ── command line ─────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Write a fictional backup with Apple Podcasts in it.")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="a plain demo backup for screenshots: Einstein's copy plus eight shows")
    demo.add_argument("dest", help="folder to write the backup into (made if missing)")
    args = parser.parse_args(argv)

    out = Path(args.dest).resolve()
    target = out / DEMO_UDID
    if target.exists():
        print(f"{target} already exists: remove it, or pick another folder", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="podcasts-demo-") as parts:
        scenario, n_shows, n_episodes, n_listened = build_demo(Path(parts))
        backup_dir = make_einstein_copy(wb._einstein_dir(), target, scenario, udid=DEMO_UDID,
                                        device_name=DEMO_DEVICE_NAME)
    print(backup_dir)
    print(DEMO_UDID)
    print(f"{n_shows} podcasts, {n_episodes} episodes, {n_listened} listened", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
