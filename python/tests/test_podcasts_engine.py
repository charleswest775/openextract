"""
The engine's Podcasts methods over real (minimal) backups, called the way the RPC handlers are.

Each state the Podcasts library can be in, and what every method and the home
screen's counts (get_backup_stats) say about it:

  * not in the backup (Podcasts never used, or an ios-backup-core without
    Podcasts support): calm empties, no error anywhere, and nothing saved;
  * in the backup with nothing to list: "no_records";
  * listed but unreadable: an error, counted in the overview's errors, and
    saves fail instead of writing empty files;
  * a full library, in the iOS 13 and the iOS 16+ layouts: what the lists,
    their filters and the home screen's counts say agree.

Reading a library needs ios-backup-core with the Podcasts extractor: those
cases skip without it (or fail when OPENEXTRACT_REQUIRE_GENERATED=1). The
calm "not in the backup" case runs either way.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, skip_or_fail  # noqa: E402
import podcasts_backup as pb  # noqa: E402

NOTHING_TO_SAVE = "There are no podcasts in this backup to save."


def _needs_library():
    problem = pb.library_problem()
    if problem:
        skip_or_fail(problem)


class EngineCase(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)  # runs last: after the backups are closed (Windows)
        self.tmp = Path(tmp.name)
        self.server = load_engine_module().SidecarServer()
        self.addCleanup(self._close_all)
        self.n = 0

    def _close_all(self):
        for udid in list(self.server.backup_manager._open_backups):
            self.server.backup_manager.close_backup(udid)

    def open(self, files: dict, missing=()) -> str:
        """Open a bare backup holding ``files``; ``missing`` are listed in its Manifest.db but not on disk."""
        self.n += 1
        udid = f"00008120-00000000000000{self.n:02d}"
        backup_dir = pb.make_minimal(self.tmp / f"b{self.n}" / udid, files, udid)
        for domain, rel in missing:
            fid = pb.wb.file_id(domain, rel)
            os.remove(backup_dir / fid[:2] / fid)
        self.assertEqual(self.call("open_backup", udid=udid, backup_dir=str(backup_dir))["status"], "open")
        return udid

    def call(self, method, **params):
        result = self.server.methods[method](params)
        json.dumps(result)  # what goes back to the app must be plain JSON as it is
        return result

    def out(self, name="out") -> Path:
        return self.tmp / name  # not made: a save that has nothing to write must not make it either

    def overview(self, udid):
        stats = self.call("get_backup_stats", udid=udid)
        o = stats["overview"]
        counts = (o["total_podcasts"], o["total_podcasts_followed"], o["total_podcast_episodes_listened"],
                  o["podcasts_status"])
        return counts, stats["errors"]

    def assert_every_method(self, udid, *, podcasts, episodes, save):
        """Each method answers the same way for the state; saves never write a file for it."""
        self.assertEqual(self.call("list_podcasts", udid=udid), podcasts)
        self.assertEqual(self.call("list_podcast_episodes", udid=udid), episodes)
        self.assertEqual(self.call("list_podcast_episodes", udid=udid, podcast_id=1, listened_only=True), episodes)
        out = self.out(f"save-{udid[-2:]}")
        for fmt in ("opml", "csv"):
            self.assertEqual(self.call("export_podcasts", udid=udid, output_dir=str(out), format=fmt), save)
        self.assertFalse(out.exists())


class TestNotInBackup(EngineCase):

    def test_calm_everywhere(self):
        udid = self.open({})
        self.assert_every_method(
            udid,
            podcasts={"podcasts": [], "empty_reason": "not_in_backup"},
            episodes={"episodes": [], "empty_reason": "not_in_backup"},
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, 0, "not_in_backup"), []))

    def test_without_library_support_every_method_is_calm(self):
        # An ios-backup-core from before Podcasts: the engine starts, and says it once.
        import podcasts
        saved = podcasts._told_no_support
        self.addCleanup(setattr, podcasts, "_told_no_support", saved)
        podcasts._told_no_support = False
        log = io.StringIO()
        with redirect_stderr(log):
            first, second = podcasts._NoPodcastSupport(), podcasts._NoPodcastSupport()
        self.assertEqual(log.getvalue().count("no Podcasts extractor"), 1)
        self.server.podcast_extractor._inner = first
        udid = self.open({pb.LIBRARY: b"whatever is there"})
        self.assert_every_method(
            udid,
            podcasts={"podcasts": [], "empty_reason": "not_in_backup"},
            episodes={"episodes": [], "empty_reason": "not_in_backup"},
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, 0, "not_in_backup"), []))
        self.assertEqual(second.list_episodes(None, podcast_id=3), {"episodes": [], "empty_reason": "not_in_backup"})


class TestLibraryStates(EngineCase):

    def setUp(self):
        super().setUp()
        _needs_library()

    def test_nothing_to_list(self):
        # The tables with no rows, and an empty file (which SQLite reads as a database with no tables)
        for data in (pb.empty_library(self.tmp / f"parts{self.n}"), b""):
            udid = self.open({pb.LIBRARY: data})
            self.assert_every_method(
                udid,
                podcasts={"podcasts": [], "empty_reason": "no_records"},
                episodes={"episodes": [], "empty_reason": "no_records"},
                save={"error": NOTHING_TO_SAVE, "empty_reason": "no_records"},
            )
            self.assertEqual(self.overview(udid), ((0, 0, 0, "no_records"), []))

    def test_listed_but_unreadable(self):
        for files, missing in (({pb.LIBRARY: b"not a database " * 64}, ()),
                               ({pb.LIBRARY: b"x"}, (pb.LIBRARY,))):
            udid = self.open(files, missing)
            unreadable = self.call("list_podcasts", udid=udid)
            self.assertEqual(unreadable["podcasts"], [])
            self.assertNotIn("empty_reason", unreadable)
            error = unreadable["error"]
            self.assertIn("could not be read", error)
            self.assertNotIn("Error", error.split("(")[0])  # words for people, before any detail
            self.assert_every_method(udid, podcasts=unreadable, episodes={"episodes": [], "error": error},
                                     save={"error": error})
            counts, errors = self.overview(udid)
            self.assertEqual(counts, (0, 0, 0, "error"))
            self.assertEqual(errors, [f"podcasts: {error}"])

    def test_a_show_with_no_episodes_table(self):
        import sqlite3
        path = self.tmp / "shows-only.sqlite"
        conn = sqlite3.connect(path)
        conn.execute(f"CREATE TABLE ZMTPODCAST ({pb.IOS16_PODCAST})")
        conn.execute("INSERT INTO ZMTPODCAST (Z_PK, ZTITLE, ZSUBSCRIBED, ZFEEDURL) VALUES "
                     "(1, 'Lone Show', 1, 'https://feeds.example.com/lone.xml')")
        conn.commit()
        conn.close()
        udid = self.open({pb.LIBRARY: path.read_bytes()})
        shows = self.call("list_podcasts", udid=udid)["podcasts"]
        self.assertEqual([(s["title"], s["followed"], s["episode_count"]) for s in shows], [("Lone Show", True, 0)])
        self.assertEqual(self.call("list_podcast_episodes", udid=udid), {"episodes": [], "empty_reason": "no_records"})
        self.assertEqual(self.overview(udid), ((1, 1, 0, "ok"), []))


class FullLibrary:
    """The test library in one layout; subclasses set SCHEMA."""

    SCHEMA = "ios16"

    def setUp(self):
        super().setUp()
        _needs_library()
        self.scenario = pb.build(self.tmp / "parts", self.SCHEMA)
        self.udid = self.open(self.scenario.files)

    def test_shows_read_as_the_library_holds_them(self):
        s = self.scenario
        result = self.call("list_podcasts", udid=self.udid)
        self.assertNotIn("error", result)
        self.assertNotIn("empty_reason", result)
        for show in result["podcasts"]:
            self.assertEqual({k: show[k] for k in s.shows[show["id"]]}, s.shows[show["id"]], show["id"])
        self.assertEqual({p["id"] for p in result["podcasts"]}, set(s.shows))

    def test_episodes_and_their_filters(self):
        s = self.scenario
        every = self.call("list_podcast_episodes", udid=self.udid)["episodes"]
        self.assertEqual([e["id"] for e in every], s.newest_first(s.episodes))
        for e in every:
            self.assertEqual({k: e[k] for k in s.episodes[e["id"]]}, s.episodes[e["id"]], e["id"])
        for show_id in s.shows:
            for podcast_id in (show_id, str(show_id)):
                ids = [e["id"] for e in self.call("list_podcast_episodes", udid=self.udid,
                                                  podcast_id=podcast_id)["episodes"]]
                self.assertEqual(ids, s.newest_first(s.episodes_of(show_id)))
        history = self.call("list_podcast_episodes", udid=self.udid, listened_only=True)["episodes"]
        self.assertEqual([e["id"] for e in history], s.newest_first(s.listened))
        self.assertNotIn(pb.EP_BACK_CATALOGUE, s.listened)  # marked played, never heard
        by_id = {e["id"]: e for e in every}
        self.assertEqual(by_id[pb.EP_BACK_CATALOGUE]["play_state"], "played")
        self.assertEqual((by_id[pb.EP_IN_PROGRESS]["play_state"], by_id[pb.EP_IN_PROGRESS]["playhead_seconds"],
                          by_id[pb.EP_IN_PROGRESS]["saved"]), ("in_progress", pb.IN_PROGRESS_AT, True))
        self.assertTrue(by_id[pb.EP_DOWNLOADED]["downloaded_on_phone"])
        self.assertEqual(by_id[pb.EP_UNPLAYED]["title"], "Rounding errors")  # stored as a BLOB
        self.assertEqual(self.call("list_podcast_episodes", udid=self.udid, podcast_id=999),
                         {"episodes": [], "empty_reason": "no_records"})

    def test_counts_on_the_home_screen_match_the_lists(self):
        shows = self.call("list_podcasts", udid=self.udid)["podcasts"]
        history = self.call("list_podcast_episodes", udid=self.udid, listened_only=True)["episodes"]
        counts, errors = self.overview(self.udid)
        self.assertEqual(counts, (len(shows), sum(1 for p in shows if p["followed"]), len(history), "ok"))
        s = self.scenario
        self.assertEqual(counts, (len(s.shows), len(s.followed), len(s.listened), "ok"))
        self.assertEqual(errors, [])

    def test_reopening_reads_the_library_again(self):
        before = self.call("list_podcasts", udid=self.udid)
        backup_dir = self.server.backup_manager.get_open_backup(self.udid).backup_dir
        self.assertEqual(self.call("open_backup", udid=self.udid, backup_dir=backup_dir)["status"], "open")
        self.assertEqual(self.call("list_podcasts", udid=self.udid), before)


class TestIos16Library(FullLibrary, EngineCase):
    SCHEMA = "ios16"

    def test_implicitly_followed_is_not_followed(self):
        show = next(p for p in self.call("list_podcasts", udid=self.udid)["podcasts"] if p["id"] == pb.SHOW_IMPLICIT)
        self.assertEqual((show["subscribed"], show["implicitly_followed"], show["followed"]), (True, True, False))


class TestIos13Library(FullLibrary, EngineCase):
    SCHEMA = "ios13"

    def test_no_implicit_follows_before_ios16(self):
        show = next(p for p in self.call("list_podcasts", udid=self.udid)["podcasts"] if p["id"] == pb.SHOW_IMPLICIT)
        self.assertEqual((show["implicitly_followed"], show["followed"], show["unfollowed_date"]), (False, True, None))


if __name__ == "__main__":
    unittest.main()
