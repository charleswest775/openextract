"""
Saving voice memos (python/voice_memos.py): the recordings as audio files, one recording, or a CSV.

What must hold:

  * the "Voice Memos" folder holds each recording whose audio is in the
    backup, named "<local date and time> <title>.<ext>" and dated when it was
    recorded, its transcript beside it as a .txt, the ones in Recently
    Deleted in a folder of that name, and "Voice Memos.csv" listing every
    recording, those not in the backup too;
  * a save of chosen recordings writes just those files into the folder
    picked; one whose audio isn't in the backup says why and writes nothing;
  * the CSV has its columns, local dates with the offset (here in fixed PDT
    and IST zones), lengths as H:MM:SS, and no cell a spreadsheet would run;
  * a save never overwrites a file ("Voice Memos (2)"), names are safe on
    every system, and nothing to save writes nothing and says so calmly.

The saves run through the engine's handlers over a minimal backup holding the
test library (voice_memos_backup.py); they skip without ios-backup-core's
Voice Memos extractor and backupgen (or fail when
OPENEXTRACT_REQUIRE_GENERATED=1). The CSV cell cases feed the adapter
recordings in the library's shape, so they run without it.
"""

import csv
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, read_csv, skip_or_fail  # noqa: E402
import voice_memos_backup as vb  # noqa: E402
import voice_memos  # noqa: E402
from app_copies import title_stem  # noqa: E402
from voice_memos import VoiceMemoExtractor  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")
IST = timezone(timedelta(hours=5, minutes=30), "IST")
HEADER = ["Title", "Date", "Duration", "Folder", "Favorite", "Recently Deleted", "Deleted Date",
          "Recorded on Watch", "Audio File", "Transcript"]
NOTHING_TO_SAVE = "There are no voice memos in this backup to save."


def _needs_library():
    problem = vb.library_problem()
    if problem:
        skip_or_fail(problem)


def _files(folder: Path) -> list:
    return sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file())


class SaveCase(unittest.TestCase):
    """The test library in a minimal backup, opened in an in-process engine whose saves show PDT."""

    ZONE = PDT

    def setUp(self):
        _needs_library()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.server = load_engine_module().SidecarServer()
        self.server.voice_memo_extractor.local_tz = self.ZONE
        self.scenario = vb.build(self.tmp / "parts", "ios26")
        self.udid = "00008120-0000000000000077"
        backup_dir = vb.make_minimal(self.tmp / "backup" / self.udid, self.scenario.files, self.udid)
        self.server.methods["open_backup"]({"udid": self.udid, "backup_dir": str(backup_dir)})
        self.addCleanup(self.server.backup_manager.close_backup, self.udid)
        self.out = self.tmp / "out"
        self.out.mkdir()
        self.progress = []
        self.server._export_progress = lambda kind: (lambda d, t, f: self.progress.append((kind, d, t, f)))

    def save(self, fmt="recordings", out=None, **params):
        return self.server.methods["export_voice_memos"](
            {"udid": self.udid, "output_dir": str(out or self.out), "format": fmt, **params})

    def stamp(self, memo_id) -> str:
        return datetime.fromisoformat(self.scenario.memos[memo_id]["date"]).astimezone(self.ZONE).strftime("%Y-%m-%d %H.%M")


class TestRecordingsFolder(SaveCase):

    def test_the_folder(self):
        s = self.scenario
        result = self.save()
        folder = self.out / "Voice Memos"
        self.assertEqual(result["status"], "success")
        self.assertEqual(Path(result["path"]), folder)
        self.assertEqual((result["count"], result["not_in_backup"], result["failed"]),
                         (len(s.available), len(s.memos) - len(s.available), 0))
        self.assertEqual(sorted(Path(f).relative_to(folder).as_posix() for f in result["files"]), _files(folder))
        names = _files(folder)
        # Named by when they were recorded, in local time, then the title.
        self.assertIn(f"{self.stamp(vb.SITE_WALK)} Site walk.m4a", names)
        self.assertIn(f"{self.stamp(vb.LAYERED_MEMO)} Song sketch.qta", names)
        self.assertIn(f"{self.stamp(vb.UNTITLED)} Recording.m4a", names)
        self.assertIn(f"{self.stamp(vb.SLASHES)} Plans sketches v2.m4a", names)  # no folder made from "/"
        self.assertIn(f"{self.stamp(vb.FORMULA)} =SUM(A1) idea.m4a", names)
        # Two with one name in one minute: the newer is saved first, the older is "(2)".
        twins = sorted(n for n in names if "Twin take" in n)
        self.assertEqual(twins, [f"{self.stamp(vb.TWIN_A)} Twin take (2).m4a", f"{self.stamp(vb.TWIN_A)} Twin take.m4a"])
        # Recently Deleted apart; the one kept in iCloud only isn't there.
        self.assertIn(f"Recently Deleted/{self.stamp(vb.DELETED)} Old draft.m4a", names)
        self.assertFalse(any("Permit call" in n for n in names))
        # Each file is the recording as it was, dated when it was recorded.
        expected = {}
        for memo_id in s.available:
            memo = s.memos[memo_id]
            stem = title_stem(f"{self.stamp(memo_id)} {memo['title'] or 'Recording'}", "Recording")
            stem += " (2)" if memo_id == vb.TWIN_A else ""
            expected[memo_id] = ("Recently Deleted/" if memo["is_deleted"] else "") + f"{stem}.{memo['format']}"
        self.assertEqual(sorted(n for n in names if not n.endswith((".txt", ".csv"))), sorted(expected.values()))
        for memo_id, name in expected.items():
            path = folder / name
            self.assertEqual(path.read_bytes(), s.audio[memo_id], memo_id)
            recorded = datetime.fromisoformat(s.memos[memo_id]["date"]).timestamp()
            self.assertAlmostEqual(path.stat().st_mtime, recorded, delta=1, msg=memo_id)
        # The transcript beside its recording, dated the same.
        text = folder / f"{self.stamp(vb.SITE_WALK)} Site walk.txt"
        self.assertEqual(text.read_text(encoding="utf-8"), vb.TRANSCRIPT_TEXT + "\n")
        self.assertEqual(sum(1 for n in names if n.endswith(".txt")), 1)
        self.assertAlmostEqual(text.stat().st_mtime, datetime.fromisoformat(s.memos[vb.SITE_WALK]["date"]).timestamp(),
                               delta=1)
        # Progress, as the app shows it.
        self.assertEqual(self.progress[0], ("voice_memos", 0, len(s.available), 0))
        self.assertEqual(self.progress[-1], ("voice_memos", len(s.available), len(s.available), 0))

    def test_the_spreadsheet_in_the_folder(self):
        s = self.scenario
        self.save()
        folder = self.out / "Voice Memos"
        rows = read_csv(folder / "Voice Memos.csv")
        self.assertEqual(rows[0], HEADER)
        self.assertEqual(len(rows) - 1, len(s.memos))
        by_title = {r[0]: r for r in rows[1:]}
        walk = by_title["Site walk"]
        self.assertEqual(walk[1], datetime.fromisoformat(s.memos[vb.SITE_WALK]["date"]).astimezone(PDT).isoformat())
        self.assertEqual(walk[1:6], [walk[1], "0:01:23", vb.FOLDER_NAME, "Yes", "No"])
        self.assertEqual(walk[8:], [f"{self.stamp(vb.SITE_WALK)} Site walk.m4a", vb.TRANSCRIPT_TEXT])
        self.assertEqual(by_title["Old draft"][5:7], ["Yes", datetime.fromisoformat(
            s.memos[vb.DELETED]["deleted_date"]).astimezone(PDT).isoformat()])
        self.assertEqual(by_title["Old draft"][8], f"Recently Deleted/{self.stamp(vb.DELETED)} Old draft.m4a")
        self.assertEqual(by_title["Permit call"][8], "Kept in iCloud only")
        self.assertEqual(by_title["'" + vb.FORMULA_TITLE][0], "'" + vb.FORMULA_TITLE)  # never a formula
        self.assertIn("", by_title)  # the untitled one
        for row in rows[1:]:
            if row[8] not in ("Kept in iCloud only", "Not in the backup"):
                self.assertTrue((folder / row[8]).is_file(), row[8])

    def test_saving_again_never_overwrites(self):
        first = self.save()
        second = self.save()
        self.assertEqual(Path(second["path"]).name, "Voice Memos (2)")
        self.assertEqual(_files(Path(first["path"])), _files(Path(second["path"])))

    def test_where_it_cant_be_saved(self):
        blocker = self.tmp / "a file"
        blocker.write_text("x")
        result = self.save(out=blocker)
        self.assertTrue(result["error"].startswith("Voice memos couldn't be saved there: "), result)

    def test_unsupported_format(self):
        out = self.tmp / "never"
        self.assertEqual(self.save("mp3", out=out), {"error": "Unsupported format: mp3"})
        self.assertFalse(out.exists())


class TestChosenRecordings(SaveCase):

    def test_one_recording_straight_into_the_folder(self):
        for asked in ([vb.SITE_WALK], [str(vb.SITE_WALK)]):
            out = self.tmp / f"one-{asked[0]!r}"
            out.mkdir()
            result = self.save(out=out, memo_ids=asked)
            audio = out / f"{self.stamp(vb.SITE_WALK)} Site walk.m4a"
            self.assertEqual(result, {"status": "success", "count": 1, "path": str(audio),
                                      "files": [str(audio), str(out / f"{self.stamp(vb.SITE_WALK)} Site walk.txt")],
                                      "not_in_backup": 0, "failed": 0})
            self.assertEqual(audio.read_bytes(), self.scenario.audio[vb.SITE_WALK])
            self.assertEqual(_files(out), sorted(Path(f).name for f in result["files"]))  # no folder, no CSV
        again = self.save(out=out, memo_ids=[vb.SITE_WALK])
        self.assertEqual(Path(again["path"]).name, f"{self.stamp(vb.SITE_WALK)} Site walk (2).m4a")

    def test_a_deleted_recording_saves_like_any_other(self):
        result = self.save(memo_ids=[vb.DELETED])
        self.assertEqual(Path(result["path"]), self.out / f"{self.stamp(vb.DELETED)} Old draft.m4a")

    def test_several(self):
        result = self.save(memo_ids=[vb.FORMULA, vb.ICLOUD, vb.UNTITLED, 999])
        self.assertEqual((result["count"], result["not_in_backup"], result["failed"]), (2, 1, 0))
        self.assertEqual(len(_files(self.out)), 2)

    def test_audio_not_in_the_backup_writes_nothing(self):
        out = self.tmp / "none"
        self.assertEqual(self.save(out=out, memo_ids=[vb.ICLOUD]),
                         {"error": "This recording was kept in iCloud only, so it isn't in the backup.",
                          "empty_reason": "in_icloud_only"})
        self.assertFalse(out.exists())

    def test_ids_that_are_not_recordings(self):
        out = self.tmp / "never"
        for ids in ([999], ["abc"], [True], [-3], [], "x", ["9" * 5000]):
            self.assertEqual(self.save(out=out, memo_ids=ids), {"error": "Recording not found."}, ids)
        self.assertFalse(out.exists())


class TestCsvOnly(SaveCase):

    def test_the_spreadsheet_alone(self):
        s = self.scenario
        result = self.save("csv")
        path = self.out / "Voice Memos.csv"
        self.assertEqual(result, {"status": "success", "count": len(s.memos), "path": str(path), "files": [str(path)],
                                  "not_in_backup": len(s.memos) - len(s.available), "failed": 0})
        self.assertEqual(_files(self.out), ["Voice Memos.csv"])
        rows = read_csv(path)
        self.assertEqual(rows[0], HEADER)
        by_title = {r[0]: r for r in rows[1:]}
        self.assertEqual(by_title["Site walk"][8], s.memos[vb.SITE_WALK]["file_name"])  # its name in the backup
        self.assertEqual(by_title["Site walk"][9], vb.TRANSCRIPT_TEXT)
        self.assertEqual(by_title["Permit call"][8], "Kept in iCloud only")
        self.assertEqual(Path(self.save("csv")["path"]).name, "Voice Memos (2).csv")
        self.assertEqual(self.progress, [])  # a spreadsheet is quick: no progress


class TestCsvInIndia(SaveCase):
    ZONE = IST

    def test_dates_in_local_time(self):
        s = self.scenario
        rows = read_csv(Path(self.save("csv")["path"]))
        walk = next(r for r in rows[1:] if r[0] == "Site walk")
        self.assertEqual(walk[1], datetime.fromisoformat(s.memos[vb.SITE_WALK]["date"]).astimezone(IST).isoformat())
        self.assertTrue(walk[1].endswith("+05:30"))
        # 21:15 UTC on May 13 is already May 14 in India, and a saved file says so.
        self.assertEqual(Path(self.save(memo_ids=[vb.SITE_WALK])["path"]).name, "2025-05-14 02.45 Site walk.m4a")


class TestNothingToSave(unittest.TestCase):

    def test_nothing_is_written(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name) / "out"
        ext = VoiceMemoExtractor()
        for listed, reason in (({"voice_memos": [], "empty_reason": "not_in_backup"}, "not_in_backup"),
                               ({"voice_memos": [], "empty_reason": "no_records"}, "no_records")):
            with mock.patch.object(ext, "list_voice_memos", return_value=listed):
                for fmt in ("recordings", "csv"):
                    self.assertEqual(ext.export_voice_memos(None, str(out), fmt),
                                     {"error": NOTHING_TO_SAVE, "empty_reason": reason})
        unreadable = {"voice_memos": [], "error": "Voice Memos are in this backup but could not be read."}
        with mock.patch.object(ext, "list_voice_memos", return_value=unreadable):
            self.assertEqual(ext.export_voice_memos(None, str(out), "csv"), {"error": unreadable["error"]})
        # Recordings only in iCloud: no audio files to save, but a spreadsheet of them.
        icloud = {"voice_memos": [_memo(1, audio=False, reason="in_icloud_only")], "folders": []}
        with mock.patch.object(ext, "list_voice_memos", return_value=icloud):
            result = ext.export_voice_memos(None, str(out), "recordings")
            self.assertEqual(result["empty_reason"], "not_in_backup")
            self.assertIn("Save them as a spreadsheet", result["error"])
            self.assertFalse(out.exists())
            self.assertEqual(ext.export_voice_memos(None, str(out), "csv")["count"], 1)


def _memo(memo_id, *, title="Memo", date="2024-07-06T00:48:12+00:00", seconds=3725.4, audio=True, reason=None,
          favorite=None, deleted=False, watch=None):
    return {"id": memo_id, "unique_id": f"U-{memo_id}", "title": title, "date": date, "duration_seconds": seconds,
            "folder_id": None, "folder": None, "is_favorite": favorite, "is_deleted": deleted,
            "deleted_date": "2024-07-07T07:05:00+00:00" if deleted else None, "in_phone_list": True,
            "recorded_on_watch": watch, "is_enhanced": None, "is_layered": None, "is_spatial": None,
            "has_transcript": None, "file_name": f"2024 {memo_id}.m4a" if audio else None,
            "format": "m4a" if audio else None, "audio_available": audio, "audio_missing_reason": reason,
            "source": "CloudRecordings.db"}


class TestCsvCells(unittest.TestCase):
    """Cells from recordings in the library's shape, with flags an older iOS doesn't have."""

    def test_cells(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ext = VoiceMemoExtractor()
        ext.local_tz = PDT
        memos = [_memo(1, title="-1 degrees", favorite=True, watch=True),
                 _memo(2, title="@here", seconds=None, audio=False, reason="not_in_backup", deleted=True),
                 _memo(3, title="+plan", seconds=59.6, favorite=False, watch=False)]
        with mock.patch.object(ext, "list_voice_memos", return_value={"voice_memos": memos, "folders": []}):
            result = ext.export_voice_memos(None, tmp.name, "csv")
        with open(result["path"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[1], ["'-1 degrees", "2024-07-05T17:48:12-07:00", "1:02:05", "", "Yes", "No", "",
                                   "Yes", "2024 1.m4a", ""])
        self.assertEqual(rows[2], ["'@here", "2024-07-05T17:48:12-07:00", "", "", "", "Yes",
                                   "2024-07-07T00:05:00-07:00", "", "Not in the backup", ""])
        self.assertEqual(rows[3][2:8], ["0:01:00", "", "No", "No", "", "No"])


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestComputersTimeZone(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"TZ": "America/Los_Angeles"})
        patcher.start()
        self.addCleanup(time.tzset)
        self.addCleanup(patcher.stop)
        time.tzset()

    def test_the_computers_zone_by_default(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ext = VoiceMemoExtractor()
        self.assertIsNone(ext.local_tz)
        with mock.patch.object(ext, "list_voice_memos", return_value={"voice_memos": [_memo(1)], "folders": []}):
            result = ext.export_voice_memos(None, tmp.name, "csv")
        with open(result["path"], newline="", encoding="utf-8-sig") as f:
            self.assertEqual(list(csv.reader(f))[1][1], "2024-07-05T17:48:12-07:00")
        self.assertEqual(ext.app_file_name(_memo(1)), "Memo 2024-07-05 17.48.m4a")


class TestNames(unittest.TestCase):

    def test_safe_names(self):
        self.assertEqual(title_stem("a/b\\c:d*e?f\"g<h>i|j", "Recording"), "a b c d e f g h i j")
        self.assertEqual(title_stem("   ...  ", "Recording"), "Recording")
        self.assertEqual(title_stem("CON", "Recording"), "_CON")
        self.assertEqual(len(title_stem("x" * 300, "Recording")), 80)
        self.assertEqual(title_stem("14.15 take", "Recording"), "14.15 take")  # a dot isn't an extension

    def test_emoji_sequences_stay_whole(self):
        zwj, emoji_style = "\N{ZERO WIDTH JOINER}", "\N{VARIATION SELECTOR-16}"
        woman, girl, laptop = "\N{WOMAN}", "\N{GIRL}", "\N{PERSONAL COMPUTER}"
        # The joiners inside an emoji sequence stay, so the name shows what the title does ...
        for title in (f"\N{STUDIO MICROPHONE}{emoji_style} emoji {woman}{zwj}{woman}{zwj}{girl} memo",  # a family
                      f"{woman}\N{EMOJI MODIFIER FITZPATRICK TYPE-4}{zwj}{laptop} code",  # after a skin tone
                      f"\N{HEAVY BLACK HEART}{emoji_style}{zwj}\N{FIRE}",  # after the emoji style mark
                      f"\N{WAVING WHITE FLAG}{emoji_style}{zwj}\N{RAINBOW} flag"):
            self.assertEqual(title_stem(title, "Recording"), title)
        # ... while every other invisible character still goes, a joiner between letters too.
        self.assertEqual(title_stem(f"a{zwj}b c\N{ZERO WIDTH SPACE}d", "Recording"), "ab cd")
        self.assertEqual(title_stem("x\N{RIGHT-TO-LEFT OVERRIDE}fdp.exe", "Recording"), "xfdp.exe")
        self.assertEqual(title_stem(f"{zwj}{woman} {woman}{zwj}", "Recording"), f"{woman} {woman}")
        self.assertEqual(title_stem(zwj, "Recording"), "Recording")
        # Cut short inside a sequence, the name doesn't end on an invisible joiner.
        self.assertEqual(title_stem("x" * 78 + f"{woman}{zwj}{laptop}", "Recording"), "x" * 78 + woman)

    def test_ids(self):
        self.assertEqual([voice_memos.memo_id(v) for v in (3, "3", " 3 ", 0)], [3, 3, 3, 0])
        self.assertEqual([voice_memos.memo_id(v) for v in (True, -1, "3a", 3.0, None, "", 2 ** 64)], [None] * 7)
        # More digits than Python makes a number of: not a recording, not an error.
        self.assertEqual([voice_memos.memo_id(v) for v in ("9" * 5000, str(2 ** 63))], [None, None])


if __name__ == "__main__":
    unittest.main()
