"""
Saving podcasts (python/podcasts.py): OPML for another podcast app, CSV for a spreadsheet.

What must hold:

  * OPML is well-formed, escapes titles and addresses, holds only the shows
    the user chose to follow that have a feed, and is titled after the iPhone;
  * the CSVs have their columns, local dates with the offset, and no cell a
    spreadsheet would run as a formula;
  * a save never overwrites a file ("Podcasts (2).opml");
  * nothing to save writes nothing and says so calmly; a library that can't
    be read fails the save with its own words.

The CSV and adapter cases feed the adapter shows and episodes in the shape
ios-backup-core's PodcastExtractor returns (fictional, example.com
addresses), so they run without the library. The OPML is the library's
podcasts_to_opml: those cases skip without it (or fail when
OPENEXTRACT_REQUIRE_GENERATED=1), and so does the round trip through a real
backup.
"""

import json
import os
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, read_csv, skip_or_fail  # noqa: E402
import podcasts_backup as pb  # noqa: E402
import podcasts  # noqa: E402
from podcasts import PodcastExtractor  # noqa: E402

UNREADABLE = "Podcasts are in this backup but could not be read. The backup may be incomplete or damaged."
PACIFIC = timezone(timedelta(hours=-7))
NOW = datetime(2026, 11, 12, 15, 4, 5, tzinfo=timezone.utc)

SHOWS_HEADER = ["Title", "Author", "Followed", "Feed URL", "Website", "Added", "Last played", "Episodes", "Listened"]
EPISODES_HEADER = ["Podcast", "Title", "Published", "Duration (s)", "Listened", "Play count", "Last played",
                   "Position (s)", "State", "Saved", "Downloaded on iPhone", "Audio URL", "Web page"]


def _needs_library():
    problem = pb.library_problem()
    if problem:
        skip_or_fail(problem)


def _show(pid, title, *, followed=True, feed="auto", webpage=None, author="Sam Example", added=None,
          last_played=None, episodes=0, listened=0, implicit=False):
    return {
        "id": pid, "uuid": f"uuid-{pid}", "title": title, "author": author, "description": None,
        "category": None, "feed_url": f"https://feeds.example.com/{pid}.xml" if feed == "auto" else feed,
        "original_feed_url": None, "webpage_url": webpage, "image_url": None, "store_url": None,
        "store_id": None, "show_type": None, "followed": followed, "subscribed": followed or implicit,
        "implicitly_followed": implicit, "hidden": False, "added_date": added, "last_played_date": last_played,
        "unfollowed_date": None, "episode_count": episodes, "listened_count": listened,
    }


def _episode(eid, pid, title, *, show="Show", published=None, duration=None, play_count=0, playhead=None,
             last_played=None, state="unplayed", saved=False, downloaded=False, audio=None, page=None):
    return {
        "id": eid, "podcast_id": pid, "podcast_title": show, "uuid": None, "guid": None, "title": title,
        "author": None, "published_date": published, "duration_seconds": duration, "play_count": play_count,
        "playhead_seconds": playhead, "last_played_date": last_played, "play_state": state,
        "listened": bool(play_count or playhead or last_played), "saved": saved,
        "downloaded_on_phone": downloaded, "enclosure_url": audio, "webpage_url": page, "season": None,
        "episode_number": None, "episode_type": None, "video": False, "removed_from_feed": False, "hidden": False,
    }


class FakeInner:
    """Answers like the library's PodcastExtractor."""

    def __init__(self, podcasts=None, episodes=None):
        self.podcasts = podcasts if podcasts is not None else {"podcasts": [], "empty_reason": "not_in_backup"}
        self.episodes = episodes if episodes is not None else {"episodes": [], "empty_reason": "no_records"}
        self.calls = []

    def list_podcasts(self, backup):
        self.calls.append(("list_podcasts",))
        return json.loads(json.dumps(self.podcasts))

    def list_episodes(self, backup, podcast_id=None, listened_only=False, include_descriptions=False):
        self.calls.append(("list_episodes", podcast_id, listened_only, include_descriptions))
        return json.loads(json.dumps(self.episodes))


class Backup:
    def __init__(self, device_name="Sam's iPhone"):
        self.info = {"device_name": device_name} if device_name is not None else {}


SHOWS = [
    _show(1, "Field Notes & <Margins>", webpage="https://example.com/notes?a=1&b=2",
          added="2025-03-01T12:00:00+00:00", last_played="2025-06-02T07:45:00+00:00", episodes=2, listened=1),
    _show(2, "=1+1 Radio", author="@formula", episodes=1, listened=1),
    _show(3, "Studio Archive", feed=None),                         # followed, but no feed
    _show(4, "Morning Tidepool", followed=False, implicit=True),   # played, never chosen
    _show(5, "Old Habits Hour", followed=False),
]
EPISODES = [
    _episode(11, 1, "Moss, measured", show="Field Notes & <Margins>", published="2025-05-30T04:00:00+00:00",
             duration=1834.6, play_count=2, last_played="2025-06-02T07:45:00+00:00", state="played",
             downloaded=True, audio="https://cdn.example.com/12.mp3", page="https://example.com/12"),
    _episode(12, 1, "Lichen", show="Field Notes & <Margins>", published="2025-05-16T04:00:00+00:00",
             duration=2410.0, playhead=754.4, state="in_progress", saved=True),
    _episode(21, 2, "-30 Degrees and Falling", show="=1+1 Radio", published="2025-07-01T09:00:00+00:00",
             play_count=1, state=None),
]


class AdapterCase(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.out = self.tmp / "out"
        self.pod = PodcastExtractor()
        self.pod.local_tz = PACIFIC
        self.inner = self.pod._inner = FakeInner({"podcasts": SHOWS}, {"episodes": EPISODES})
        self.backup = Backup()

    def save(self, fmt, backup=None):
        return self.pod.export_podcasts(backup or self.backup, str(self.out), fmt, now=NOW)


class TestCsv(AdapterCase):

    def test_every_show_and_episode_with_its_columns(self):
        result = self.save("csv")
        shows_csv, episodes_csv = str(self.out / "Podcasts.csv"), str(self.out / "Podcast episodes.csv")
        self.assertEqual(result, {"status": "success", "count": 5, "path": shows_csv,
                                  "files": [shows_csv, episodes_csv]})
        rows = read_csv(Path(shows_csv))
        self.assertEqual(rows[0], SHOWS_HEADER)
        self.assertEqual(rows[1], ["Field Notes & <Margins>", "Sam Example", "Yes", "https://feeds.example.com/1.xml",
                                   "https://example.com/notes?a=1&b=2", "2025-03-01T05:00:00-07:00",
                                   "2025-06-02T00:45:00-07:00", "2", "1"])
        self.assertEqual([r[0] for r in rows[1:]], ["Field Notes & <Margins>", "'=1+1 Radio", "Studio Archive",
                                                    "Morning Tidepool", "Old Habits Hour"])
        self.assertEqual(rows[2][1], "'@formula")
        self.assertEqual([r[2] for r in rows[1:]], ["Yes", "Yes", "Yes", "No", "No"])
        self.assertEqual(rows[3][3], "")  # no feed address
        rows = read_csv(Path(episodes_csv))
        self.assertEqual(rows[0], EPISODES_HEADER)
        self.assertEqual(rows[1], ["Field Notes & <Margins>", "Moss, measured", "2025-05-29T21:00:00-07:00", "1835",
                                   "Yes", "2", "2025-06-02T00:45:00-07:00", "", "Played", "No", "Yes",
                                   "https://cdn.example.com/12.mp3", "https://example.com/12"])
        self.assertEqual(rows[2][3:10], ["2410", "Yes", "0", "", "754", "In progress", "Yes"])
        self.assertEqual(rows[3][:2], ["'=1+1 Radio", "'-30 Degrees and Falling"])  # never a formula
        self.assertEqual(rows[3][8], "")  # a state the library didn't know
        self.assertEqual(self.inner.calls[-1], ("list_episodes", None, False, False))  # no descriptions

    def test_excel_reads_it_as_utf8(self):
        self.save("csv")
        for name in ("Podcasts.csv", "Podcast episodes.csv"):
            self.assertTrue((self.out / name).read_bytes().startswith(b"\xef\xbb\xbfPod" if "episodes" in name
                                                                       else b"\xef\xbb\xbfTitle"))

    def test_saving_again_never_overwrites(self):
        first = self.save("csv")
        second = self.save("csv")
        self.assertEqual([os.path.basename(f) for f in second["files"]], ["Podcasts (2).csv", "Podcast episodes (2).csv"])
        self.assertEqual(len(os.listdir(self.out)), 4)
        self.assertEqual(read_csv(Path(first["path"])), read_csv(Path(second["path"])))

    def test_no_episodes_still_saves_the_shows(self):
        self.inner.episodes = {"episodes": [], "empty_reason": "no_records"}
        result = self.save("csv")
        self.assertEqual(result["count"], 5)
        self.assertEqual(read_csv(Path(result["files"][1])), [EPISODES_HEADER])

    def test_episodes_that_cant_be_read_save_nothing(self):
        self.inner.episodes = {"episodes": [], "error": UNREADABLE}
        self.assertEqual(self.save("csv"), {"error": UNREADABLE})
        self.assertFalse(self.out.exists())


class TestNothingToSave(AdapterCase):

    def test_each_empty_state_writes_nothing(self):
        for reason in ("not_in_backup", "no_records"):
            self.inner.podcasts = {"podcasts": [], "empty_reason": reason}
            for fmt in ("opml", "csv"):
                self.assertEqual(self.save(fmt), {"error": "There are no podcasts in this backup to save.",
                                                  "empty_reason": reason})
        self.assertFalse(self.out.exists())

    def test_a_library_that_cant_be_read_fails_with_its_words(self):
        self.inner.podcasts = {"podcasts": [], "error": UNREADABLE}
        for fmt in ("opml", "csv"):
            self.assertEqual(self.save(fmt), {"error": UNREADABLE})
        self.assertFalse(self.out.exists())

    def test_an_unknown_format_reads_nothing(self):
        self.assertEqual(self.save("docx"), {"error": "Unsupported format: docx"})
        self.assertEqual(self.inner.calls, [])
        self.assertFalse(self.out.exists())

    def test_a_folder_that_cant_be_written(self):
        blocker = self.tmp / "a-file"
        blocker.write_text("in the way")
        result = self.pod.export_podcasts(self.backup, str(blocker / "out"), "csv")
        self.assertTrue(result["error"].startswith("The podcasts couldn't be saved there"), result)


class TestOpml(AdapterCase):

    def setUp(self):
        super().setUp()
        _needs_library()

    def test_only_followed_shows_with_a_feed_escaped(self):
        result = self.save("opml")
        path = str(self.out / "Podcasts.opml")
        self.assertEqual(result, {"status": "success", "count": 2, "path": path, "files": [path]})
        text = Path(path).read_text(encoding="utf-8")
        self.assertTrue(text.startswith('<?xml version="1.0" encoding="UTF-8"?>'))
        self.assertIn("Field Notes &amp; &lt;Margins&gt;", text)
        self.assertIn("https://example.com/notes?a=1&amp;b=2", text)
        root = ET.fromstring(text)
        self.assertEqual((root.tag, root.get("version")), ("opml", "2.0"))
        self.assertEqual(root.findtext("head/title"), "Podcasts from Sam's iPhone")
        self.assertEqual(parsedate_to_datetime(root.findtext("head/dateCreated")), NOW)
        self.assertEqual(root.findtext("head/dateCreated"), "Thu, 12 Nov 2026 15:04:05 GMT")
        outlines = root.findall("body/outline")
        self.assertEqual([(o.get("text"), o.get("xmlUrl"), o.get("htmlUrl")) for o in outlines], [
            ("Field Notes & <Margins>", "https://feeds.example.com/1.xml", "https://example.com/notes?a=1&b=2"),
            ("=1+1 Radio", "https://feeds.example.com/2.xml", None),
        ])

    def test_titled_podcasts_when_the_backup_has_no_device_name(self):
        for backup in (Backup(None), Backup("Unknown"), Backup("  ")):
            result = self.save("opml", backup)
            self.assertEqual(ET.parse(result["path"]).getroot().findtext("head/title"), "Podcasts")

    def test_a_device_name_that_needs_escaping(self):
        result = self.save("opml", Backup("Pat & <Lee>'s iPhone"))
        self.assertEqual(ET.parse(result["path"]).getroot().findtext("head/title"), "Podcasts from Pat & <Lee>'s iPhone")

    def test_saving_again_never_overwrites(self):
        names = [os.path.basename(self.save("opml")["path"]) for _ in range(3)]
        self.assertEqual(names, ["Podcasts.opml", "Podcasts (2).opml", "Podcasts (3).opml"])

    def test_no_followed_show_with_a_feed_writes_nothing(self):
        self.inner.podcasts = {"podcasts": [SHOWS[2], SHOWS[3], SHOWS[4]]}
        self.assertEqual(self.save("opml"), {"error": "None of the podcasts you follow have a feed address to save.",
                                             "empty_reason": "no_records"})
        self.assertFalse(self.out.exists())

    def test_no_followed_show_says_so_not_that_feeds_are_missing(self):
        # Shows only played (implicitly followed) or unfollowed: every one has a feed
        self.inner.podcasts = {"podcasts": [SHOWS[3], SHOWS[4]]}
        result = self.save("opml")
        self.assertEqual(result["empty_reason"], "no_records")
        self.assertTrue(result["error"].startswith("You don't follow any of the podcasts in this backup"))
        self.assertNotIn("feed address", result["error"])
        self.assertFalse(self.out.exists())


class TestThroughTheEngine(unittest.TestCase):
    """The test library in a real backup, saved through the RPC handler."""

    def setUp(self):
        _needs_library()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.server = load_engine_module().SidecarServer()
        self.addCleanup(self._close_all)
        self.scenario = pb.build(self.tmp / "parts")
        backup_dir = pb.make_minimal(self.tmp / "b" / pb.PLAIN_UDID, self.scenario.files)
        self.assertEqual(self.call("open_backup", udid=pb.PLAIN_UDID, backup_dir=str(backup_dir))["status"], "open")

    def _close_all(self):
        for udid in list(self.server.backup_manager._open_backups):
            self.server.backup_manager.close_backup(udid)

    def call(self, method, **params):
        result = self.server.methods[method](params)
        json.dumps(result)
        return result

    def test_opml_round_trip(self):
        out = self.tmp / "out"
        result = self.call("export_podcasts", udid=pb.PLAIN_UDID, output_dir=str(out), format="opml")
        self.assertEqual(result["count"], len(self.scenario.opml_feeds))
        root = ET.parse(result["path"]).getroot()
        self.assertEqual(root.findtext("head/title"), "Podcasts from Test iPhone")  # make_minimal's device
        self.assertEqual({o.get("text"): o.get("xmlUrl") for o in root.iter("outline")}, self.scenario.opml_feeds)
        self.assertNotIn(pb.IMPLICIT_TITLE, self.scenario.opml_feeds)
        self.assertNotIn(pb.NO_FEED_TITLE, self.scenario.opml_feeds)

    def test_csv_round_trip(self):
        out = self.tmp / "out"
        result = self.call("export_podcasts", udid=pb.PLAIN_UDID, output_dir=str(out), format="csv")
        shows, episodes = (read_csv(Path(f)) for f in result["files"])
        self.assertEqual(len(shows) - 1, len(self.scenario.shows))
        self.assertEqual(len(episodes) - 1, len(self.scenario.episodes))
        self.assertIn("'" + pb.FORMULA_TITLE, [r[0] for r in shows])
        self.assertEqual(sum(1 for r in episodes[1:] if r[4] == "Yes"), len(self.scenario.listened))
        for row in episodes[1:]:
            if row[2]:
                self.assertIsNotNone(datetime.fromisoformat(row[2]).utcoffset())

    def test_the_default_format_is_opml(self):
        out = self.tmp / "out"
        result = self.call("export_podcasts", udid=pb.PLAIN_UDID, output_dir=str(out))
        self.assertTrue(result["path"].endswith("Podcasts.opml"))


class TestModule(unittest.TestCase):

    def test_formula_guard_only_touches_text(self):
        self.assertEqual([podcasts._csv_cell(v) for v in ("=a", "+1", "-1", "@x", "\tx", "\rx", "ok", 3, None)],
                         ["'=a", "'+1", "'-1", "'@x", "'\tx", "'\rx", "ok", 3, ""])


if __name__ == "__main__":
    unittest.main()
