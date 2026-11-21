"""
The engine's Voice Memos methods over real (minimal) backups, called the way the RPC handlers are.

Each state the Voice Memos library can be in, and what every method and the
home screen's counts (get_backup_stats) say about it:

  * not in the backup (Voice Memos never used, or an ios-backup-core without
    Voice Memos support): calm empties, no error anywhere, and nothing saved;
  * in the backup with nothing to list: "no_records";
  * listed but unreadable: an error, counted in the overview's errors, and
    saves fail instead of writing empty files;
  * a layout the library can't read yet: "unsupported_format", not an error
    in the overview;
  * a full library, in the iOS 26 and the iOS 13 layouts, and an old phone's
    Recordings.db: what the list, the audio, the transcripts and the home
    screen's counts say agree.

Reading a library needs ios-backup-core with the Voice Memos extractor and its
backupgen (for the table definitions and the .m4a files): those cases skip
without it (or fail when OPENEXTRACT_REQUIRE_GENERATED=1). The calm "not in
the backup" case runs either way.
"""

import base64
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, skip_or_fail  # noqa: E402
import voice_memos_backup as vb  # noqa: E402

NOTHING_TO_SAVE = "There are no voice memos in this backup to save."
NOT_FOUND = {"error": "Recording not found."}
IN_ICLOUD = {"error": "This recording was kept in iCloud only, so it isn't in the backup.",
             "empty_reason": "in_icloud_only"}
NOT_IN_BACKUP = {"error": "This recording isn't in the backup.", "empty_reason": "not_in_backup"}
M4A_MAGIC = b"ftyp"
PDT = timezone(timedelta(hours=-7), "PDT")


def _needs_library():
    problem = vb.library_problem()
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
        backup_dir = vb.make_minimal(self.tmp / f"b{self.n}" / udid, files, udid)
        for domain, rel in missing:
            fid = vb.wb.file_id(domain, rel)
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
        """((recordings outside Recently Deleted, their seconds, recordings in Recently Deleted, status), errors)."""
        stats = self.call("get_backup_stats", udid=udid)
        o = stats["overview"]
        counts = (o["total_voice_memos"], o["total_voice_memo_seconds"], o["total_deleted_voice_memos"],
                  o["voice_memos_status"])
        return counts, stats["errors"]

    def assert_every_method(self, udid, *, memos, audio, transcript, save):
        """Each method answers the same way for the state; saves never write a file for it."""
        self.assertEqual(self.call("list_voice_memos", udid=udid), memos)
        for memo_id in (1, "1"):
            self.assertEqual(self.call("get_voice_memo_audio", udid=udid, memo_id=memo_id), audio)
            self.assertEqual(self.call("get_voice_memo_audio", udid=udid, memo_id=memo_id, as_file=True), audio)
            self.assertEqual(self.call("get_voice_memo_transcript", udid=udid, memo_id=memo_id), transcript)
        out = self.out(f"save-{udid[-2:]}")
        for fmt in ("recordings", "csv"):
            self.assertEqual(self.call("export_voice_memos", udid=udid, output_dir=str(out), format=fmt), save)
        self.assertEqual(self.call("export_voice_memos", udid=udid, output_dir=str(out), format="recordings",
                                   memo_ids=[1]), save)
        self.assertFalse(out.exists())


class TestNotInBackup(EngineCase):

    def test_calm_everywhere(self):
        udid = self.open({})
        self.assert_every_method(
            udid,
            memos={"voice_memos": [], "empty_reason": "not_in_backup"},
            audio=NOT_FOUND, transcript=NOT_FOUND,
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, 0, "not_in_backup"), []))

    def test_without_library_support_every_method_is_calm(self):
        # An ios-backup-core from before Voice Memos: the engine starts, and says it once.
        import voice_memos
        saved = voice_memos._told_no_support
        self.addCleanup(setattr, voice_memos, "_told_no_support", saved)
        voice_memos._told_no_support = False
        log = io.StringIO()
        with redirect_stderr(log):
            first, second = voice_memos._NoVoiceMemoSupport(), voice_memos._NoVoiceMemoSupport()
        self.assertEqual(log.getvalue().count("no Voice Memos extractor"), 1)
        self.server.voice_memo_extractor._inner = first
        udid = self.open({vb.LIBRARY: b"whatever is there"})
        self.assert_every_method(
            udid,
            memos={"voice_memos": [], "empty_reason": "not_in_backup"},
            audio=NOT_FOUND, transcript=NOT_FOUND,
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, 0, "not_in_backup"), []))
        self.assertIsNone(second.get_audio_path(None, 1))
        self.assertIsNone(second.get_transcript(None, 1))


class TestLibraryStates(EngineCase):

    def setUp(self):
        super().setUp()
        _needs_library()

    def test_nothing_to_list(self):
        # The tables with no rows (both layouts), and an empty file (which SQLite reads as a database with no tables)
        libraries = [({vb.LIBRARY: vb.empty_library(self.tmp / "e26", "ios26")}),
                     ({(vb.MEDIA_DOMAIN, "Media/Recordings/CloudRecordings.db"): vb.empty_library(self.tmp / "e13", "ios13")}),
                     ({vb.LIBRARY: b""})]
        for files in libraries:
            udid = self.open(files)
            self.assert_every_method(
                udid,
                memos={"voice_memos": [], "empty_reason": "no_records"},
                audio=NOT_FOUND, transcript=NOT_FOUND,
                save={"error": NOTHING_TO_SAVE, "empty_reason": "no_records"},
            )
            self.assertEqual(self.overview(udid), ((0, 0, 0, "no_records"), []))

    def test_listed_but_unreadable(self):
        for files, missing in (({vb.LIBRARY: b"not a database " * 64}, ()),
                               ({vb.LIBRARY: b"x"}, (vb.LIBRARY,))):
            udid = self.open(files, missing)
            unreadable = self.call("list_voice_memos", udid=udid)
            self.assertEqual(unreadable["voice_memos"], [])
            self.assertNotIn("empty_reason", unreadable)
            error = unreadable["error"]
            self.assertIn("could not be read", error)
            self.assertNotIn("Error", error.split("(")[0])  # words for people, before any detail
            self.assert_every_method(udid, memos=unreadable, audio={"error": error}, transcript={"error": error},
                                     save={"error": error})
            counts, errors = self.overview(udid)
            self.assertEqual(counts, (0, 0, 0, "error"))
            self.assertEqual(errors, [f"voice memos: {error}"])

    def test_a_layout_it_cant_read_is_not_an_error(self):
        import sqlite3
        path = self.tmp / "odd.db"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE ZSOMETHINGELSE (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT)")
        conn.execute("INSERT INTO ZSOMETHINGELSE VALUES (1, 'x')")
        conn.commit()
        conn.close()
        udid = self.open({vb.LIBRARY: path.read_bytes()})
        result = self.call("list_voice_memos", udid=udid)
        self.assertEqual((result["voice_memos"], result["empty_reason"]), ([], "unsupported_format"))
        self.assertIn("older format", result["error"])
        out = self.out()
        self.assertEqual(self.call("export_voice_memos", udid=udid, output_dir=str(out), format="csv"),
                         {"error": result["error"], "empty_reason": "unsupported_format"})
        self.assertFalse(out.exists())
        self.assertEqual(self.overview(udid), ((0, 0, 0, "unsupported_format"), []))

    def test_every_recording_in_recently_deleted(self):
        # Someone deleted their memos and wants them back. The screen lists them and a save writes
        # them, so the overview says there are some, not that the library is empty.
        deleted = vb._at(2025, 6, 20, 10, 0)
        rows = [row[:7] + (deleted,) + row[8:] for row in vb._RECORDINGS]
        with mock.patch.object(vb, "_RECORDINGS", rows):
            s = vb.build(self.tmp / "deleted", "ios26")
        udid = self.open(s.files)
        listed = self.call("list_voice_memos", udid=udid)["voice_memos"]
        self.assertEqual((len(listed), all(m["is_deleted"] for m in listed)), (len(rows), True))
        self.assertEqual(self.overview(udid), ((0, 0, len(rows), "ok"), []))
        self.assertEqual(self.call("get_backup_stats", udid=udid)["overview"]["total_voice_memos_with_audio"],
                         len(s.available))
        out = self.out("deleted-save")
        out.mkdir()
        saved = self.call("export_voice_memos", udid=udid, output_dir=str(out), format="recordings")
        self.assertEqual(saved["count"], len(s.available))

    def test_no_recordings_audio_in_the_backup(self):
        # Every recording kept in iCloud only: the list and a spreadsheet work, but there is no audio
        # to save, so the overview says so and the Save panel doesn't offer "Audio files".
        rows = [row[:4] + (vb.NEEDS_DOWNLOAD,) + row[5:8] + ("icloud", None) for row in vb._RECORDINGS]
        with mock.patch.object(vb, "_RECORDINGS", rows):
            s = vb.build(self.tmp / "icloud", "ios26")
        udid = self.open(s.files)
        listed = self.call("list_voice_memos", udid=udid)["voice_memos"]
        self.assertEqual((len(listed), any(m["audio_available"] for m in listed)), (len(rows), False))
        o = self.call("get_backup_stats", udid=udid)["overview"]
        self.assertEqual((o["voice_memos_status"], o["total_voice_memos_with_audio"]), ("ok", 0))
        self.assertGreater(o["total_voice_memos"] + o["total_deleted_voice_memos"], 0)

    def test_an_old_phones_recordings_db(self):
        files, expected = vb.legacy_library(self.tmp / "legacy")
        udid = self.open(files)
        result = self.call("list_voice_memos", udid=udid)
        self.assertEqual(result["folders"], [])
        got = {m["id"]: m for m in result["voice_memos"]}
        for memo_id, want in expected.items():
            self.assertEqual({k: got[memo_id][k] for k in want}, want, memo_id)
        audio = self.call("get_voice_memo_audio", udid=udid, memo_id=1)
        self.assertEqual(base64.b64decode(audio["data"])[4:8], M4A_MAGIC)
        self.assertEqual(self.call("get_voice_memo_audio", udid=udid, memo_id=2), NOT_IN_BACKUP)
        self.assertEqual(self.overview(udid), ((2, 6, 0, "ok"), []))


class FullLibrary:
    """The test library in one layout; subclasses set LAYOUT."""

    LAYOUT = "ios26"

    def setUp(self):
        super().setUp()
        _needs_library()
        self.scenario = vb.build(self.tmp / "parts", self.LAYOUT)
        self.udid = self.open(self.scenario.files)

    def test_recordings_read_as_the_library_holds_them(self):
        s = self.scenario
        result = self.call("list_voice_memos", udid=self.udid)
        self.assertNotIn("error", result)
        self.assertNotIn("empty_reason", result)
        self.assertEqual([m["id"] for m in result["voice_memos"]], s.newest_first())
        for memo in result["voice_memos"]:
            self.assertEqual({k: memo[k] for k in s.memos[memo["id"]]}, s.memos[memo["id"]], memo["id"])
        self.assertEqual(result["folders"], s.folders)
        by_id = {m["id"]: m for m in result["voice_memos"]}
        self.assertEqual(by_id[vb.BLOB]["title"], vb.BLOB_TITLE)  # stored as a BLOB

    def test_audio_comes_as_recorded(self):
        s = self.scenario
        for memo_id in s.available:
            for asked in (memo_id, str(memo_id)):
                result = self.call("get_voice_memo_audio", udid=self.udid, memo_id=asked)
                data = base64.b64decode(result["data"], validate=True)
                self.assertEqual(data, s.audio[memo_id])
                self.assertEqual((result["mime_type"], result["memo_id"], result["size"]),
                                 ("audio/mp4", memo_id, len(s.audio[memo_id])))
                self.assertTrue(result["filename"].endswith("." + s.memos[memo_id]["format"]))
        # Named for another app: the title, then when it was recorded in local time (21:15 UTC is 14:15 in PDT).
        self.server.voice_memo_extractor.local_tz = PDT
        self.assertEqual(self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.SITE_WALK)["filename"],
                         "Site walk 2025-05-13 14.15.m4a")
        self.assertEqual(self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.UNTITLED)["filename"][:10],
                         "Recording ")
        self.assertNotIn("/", self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.SLASHES)["filename"])
        self.assertEqual(self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.ICLOUD), IN_ICLOUD)

    def test_ids_that_are_not_a_recording(self):
        for bad in (999, -1, True, None, "1.0", "../../Manifest", "", [1], {"id": 1}, 2 ** 70, "9" * 5000):
            self.assertEqual(self.call("get_voice_memo_audio", udid=self.udid, memo_id=bad), NOT_FOUND, bad)
            self.assertEqual(self.call("get_voice_memo_transcript", udid=self.udid, memo_id=bad), NOT_FOUND, bad)
        with self.assertRaises(KeyError):
            self.call("get_voice_memo_audio", udid=self.udid)  # a required param: a JSON-RPC error

    def test_a_recording_too_big_to_send_inline(self):
        with mock.patch("voice_memos.MAX_INLINE_BYTES", 100):
            result = self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.SITE_WALK)
        size = len(self.scenario.audio[vb.SITE_WALK])
        self.assertEqual(result, {"too_large": True, "mime_type": "audio/mp4", "memo_id": vb.SITE_WALK,
                                  "filename": result["filename"], "size": size})

    def test_a_copy_to_open_in_another_app(self):
        s = self.scenario
        backup_dir = Path(self.server.backup_manager.get_open_backup(self.udid).backup_dir).resolve()
        for memo_id, ext in ((vb.SITE_WALK, ".m4a"), (vb.LAYERED_MEMO, ".qta")):
            result = self.call("get_voice_memo_audio", udid=self.udid, memo_id=memo_id, as_file=True)
            path = Path(result["path"])
            self.assertEqual(set(result), {"path", "mime_type", "filename", "size", "openable"})
            self.assertEqual(path.read_bytes(), s.audio[memo_id])
            self.assertEqual((path.name, path.suffix, result["mime_type"], result["openable"]),
                             (result["filename"], ext, "audio/mp4", True))
            self.assertFalse(path.resolve().is_relative_to(backup_dir))  # a copy, never the backup's file
        self.assertEqual(self.call("get_voice_memo_audio", udid=self.udid, memo_id=vb.ICLOUD, as_file=True), IN_ICLOUD)

    def test_transcripts(self):
        s = self.scenario
        for memo_id in s.memos:
            result = self.call("get_voice_memo_transcript", udid=self.udid, memo_id=memo_id)
            self.assertEqual(result["memo_id"], memo_id)
            if s.memos[memo_id]["has_transcript"]:
                self.assertEqual(result["text"], vb.TRANSCRIPT_TEXT)
                self.assertEqual([(x["text"], x["start"], x["end"]) for x in result["segments"]], vb.TRANSCRIPT)
                self.assertEqual(result["locale"], "en_US")
            else:
                self.assertEqual(result, {"memo_id": memo_id, "text": None, "segments": [], "locale": None})

    def test_listing_never_opens_an_audio_file(self):
        backup = self.server.backup_manager.get_open_backup(self.udid)
        asked = []
        real = backup.get_file

        def spy(relative_path, domain="HomeDomain"):
            asked.append(relative_path)
            return real(relative_path, domain=domain)

        with mock.patch.object(backup, "get_file", side_effect=spy):
            self.call("list_voice_memos", udid=self.udid)
            self.call("get_backup_stats", udid=self.udid)
        audio = [p for p in asked if p.lower().endswith((".m4a", ".qta", ".qt"))]
        self.assertEqual(audio, [])

    def test_a_file_listed_but_missing_from_the_folder(self):
        s = self.scenario
        udid = self.open(s.files, missing=[s.paths[vb.TWIN_A]])
        listed = {m["id"]: m for m in self.call("list_voice_memos", udid=udid)["voice_memos"]}
        self.assertTrue(listed[vb.TWIN_A]["audio_available"])  # the manifest lists it
        self.assertEqual(self.call("get_voice_memo_audio", udid=udid, memo_id=vb.TWIN_A), NOT_IN_BACKUP)
        out = self.out("missing")
        out.mkdir()
        result = self.call("export_voice_memos", udid=udid, output_dir=str(out), format="recordings")
        self.assertEqual((result["count"], result["not_in_backup"], result["failed"]),
                         (len(s.available) - 1, len(s.memos) - len(s.available) + 1, 0))
        self.assertEqual(self.call("export_voice_memos", udid=udid, output_dir=str(out), format="recordings",
                                   memo_ids=[vb.TWIN_A]), NOT_IN_BACKUP)

    def test_counts_on_the_home_screen_match_the_list(self):
        s = self.scenario
        memos = self.call("list_voice_memos", udid=self.udid)["voice_memos"]
        kept = [m for m in memos if not m["is_deleted"]]
        counts, errors = self.overview(self.udid)
        self.assertEqual(counts, (len(kept), int(round(sum(m["duration_seconds"] for m in kept))),
                                  len(memos) - len(kept), "ok"))
        self.assertEqual(counts, (len(s.kept), s.kept_seconds, len(s.memos) - len(s.kept), "ok"))
        self.assertEqual(counts[2], 1)  # "Old draft", in Recently Deleted
        self.assertEqual(errors, [])

    def test_reopening_reads_the_library_again(self):
        before = self.call("list_voice_memos", udid=self.udid)
        backup_dir = self.server.backup_manager.get_open_backup(self.udid).backup_dir
        self.assertEqual(self.call("open_backup", udid=self.udid, backup_dir=backup_dir)["status"], "open")
        self.assertEqual(self.call("list_voice_memos", udid=self.udid), before)


class TestIos26Library(FullLibrary, EngineCase):
    LAYOUT = "ios26"

    def test_folders_and_favorites(self):
        memos = {m["id"]: m for m in self.call("list_voice_memos", udid=self.udid)["voice_memos"]}
        self.assertEqual({i for i, m in memos.items() if m["folder"] == vb.FOLDER_NAME}, {vb.SITE_WALK})
        self.assertEqual({i for i, m in memos.items() if m["is_favorite"]}, {vb.SITE_WALK, vb.BLOB})
        self.assertTrue(memos[vb.LAYERED_MEMO]["is_layered"])
        self.assertEqual(memos[vb.LAYERED_MEMO]["format"], "qta")


class TestIos13Library(FullLibrary, EngineCase):
    LAYOUT = "ios13"

    def test_no_favorites_or_folders_before_they_existed(self):
        result = self.call("list_voice_memos", udid=self.udid)
        self.assertEqual(result["folders"], [])
        self.assertTrue(all(m["is_favorite"] is None and m["folder"] is None for m in result["voice_memos"]))


if __name__ == "__main__":
    unittest.main()
