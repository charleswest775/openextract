"""The data bundle (python/bundle.py, engine method export_bundle) on small made-up backups.

The corpus tests (python/tests/corpus/test_corpus_bundle.py) make bundles from the
generated Maren, Einstein and testpersona backups and compare them with their answer
keys. These check the parts those can't: the spam and deleted marks, a reader that
fails, a bundle that can't be written, the request's options, and that nothing goes
near the network.
"""

import errno
import hashlib
import json
import os
import plistlib
import socket
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
import bundle  # noqa: E402
import build_info  # noqa: E402
from bundle_schema import KEYWORDS, SCHEMAS, check_bundle, errors, load_schema, read_lines  # noqa: E402
from rpc_contract_support import load_engine_module  # noqa: E402

# The engine's own copy of main.py: test_backup.py reloads "main" with its classes mocked
SidecarServer = load_engine_module().SidecarServer

# ios-backup-core keeps a deleted spam voicemail's spam mark from charleswest775/ios-backup-core#36 on;
# before that only the list it's in is known. CI tests against the commit pinned in ios-backup-core.ref.
from ios_backup_core.extractors import voicemail as _core_voicemail  # noqa: E402
SPAM_MARK = hasattr(_core_voicemail, "is_spam")

UDID = "00008030-0000000000000002"
ACCOUNT = "A-0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D"
AMR = b"#!AMR\n" + bytes(32)
# Made-up flag words: known bits (0x1 heard, 0x8 deleted, 0x80 spam, 0x2) beside one the reader ignores (0x40000)
LIVE, SPAM, TRASHED, DELETED_LONG_AGO, SPAM_THEN_DELETED = 0x40003, 0x40082, 0x4000A, 0x4000B, 0x4008A


def _voicemail_db(rows) -> bytes:
    """rows: (ROWID, date, sender, duration, flags, trashed_date)"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "voicemail.db")
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE voicemail (ROWID INTEGER PRIMARY KEY, remote_uid INTEGER, date INTEGER, "
            "token TEXT, sender TEXT, callback_num TEXT, duration INTEGER, expiration INTEGER, "
            "trashed_date INTEGER, flags INTEGER, receiver TEXT, label TEXT)"
        )
        conn.executemany(
            "INSERT INTO voicemail (ROWID, date, sender, duration, flags, trashed_date) VALUES (?, ?, ?, ?, ?, ?)", rows)
        conn.commit()
        conn.close()
        with open(path, "rb") as f:
            return f.read()


def _make_backup(backup_dir: str, files: dict) -> None:
    os.makedirs(backup_dir)
    with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": UDID, "Device Name": "Test: iPhone?", "Product Type": "iPhone17,1",
                       "Product Version": "26.1"}, f)
    with open(os.path.join(backup_dir, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": False}, f)
    manifest = sqlite3.connect(os.path.join(backup_dir, "Manifest.db"))
    manifest.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
    for rel_path, data in files.items():
        file_id = hashlib.sha1(f"HomeDomain-{rel_path}".encode()).hexdigest()
        os.makedirs(os.path.join(backup_dir, file_id[:2]), exist_ok=True)
        with open(os.path.join(backup_dir, file_id[:2], file_id), "wb") as f:
            f.write(data)
        manifest.execute("INSERT INTO Files VALUES (?, 'HomeDomain', ?, 1, NULL)", (file_id, rel_path))
    manifest.commit()
    manifest.close()


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        backup_dir = os.path.join(self.tmp.name, UDID)
        _make_backup(backup_dir, {
            "Library/Voicemail/voicemail.db": _voicemail_db([
                (1, 1_700_000_000, "+15550000001", 20, LIVE, 0),
                (2, 1_710_000_000, "+15550000002", 30, SPAM, 0),
                (3, 1_720_000_000, "+15550000003", 40, TRASHED, 1_720_000_100),
                (4, 1_600_000_000, "+15550000004", 50, DELETED_LONG_AGO, 0),
                (5, 1_725_000_000, "+15550000005", 12, SPAM_THEN_DELETED, 1_725_000_100),
                (6, 1_726_000_000, "+15550000001", 8, LIVE, 0),  # no audio in the backup
            ]),
            f"Library/Voicemail/{ACCOUNT}/voicemail.db": _voicemail_db([
                (27, 1_730_000_000, "+15550000007", 60, 0x3, 0),  # only in the account store
            ]),
            **{f"Library/Voicemail/{n}.amr": AMR + bytes([n]) for n in (1, 2, 3, 4, 5)},
            f"Library/Voicemail/{ACCOUNT}/27.amr": AMR,
        })
        self.server = SidecarServer()
        self.notifications = []
        self.server.send_notification = lambda method, params: self.notifications.append((method, params))
        opened = self.server.open_backup({"udid": UDID, "backup_dir": backup_dir})
        self.assertEqual(opened["status"], "open")
        self.addCleanup(self.server.backup_manager.close_backup, UDID)
        self.out = os.path.join(self.tmp.name, "out")

    def export(self, **params):
        response = self.server.handle_request({"id": "b-1", "method": "export_bundle", "params": {
            "udid": UDID, "output_dir": self.out, **params}})
        self.assertEqual(response["id"], "b-1")
        return response

    def bundle(self, **params) -> dict:
        response = self.export(**params)
        self.assertNotIn("error", response, response.get("error"))
        return response["result"]

    def manifest(self, result) -> dict:
        with open(os.path.join(result["path"], "manifest.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_a_bundle_checks_against_its_schemas_and_sums(self):
        result = self.bundle(time_zone="Europe/London")
        self.assertEqual(check_bundle(result["path"]), [])
        self.assertEqual(result["schema_version"], "0.1")
        self.assertEqual(os.path.dirname(result["path"]), self.out)
        # The device name is made safe for a folder name
        self.assertTrue(os.path.basename(result["path"]).startswith("OpenExtract Bundle - Test_ iPhone_ - "))
        manifest = self.manifest(result)
        self.assertEqual((manifest["format"], manifest["experimental"], manifest["time_zone_used"]),
                         ("openextract-bundle", True, "UTC"))
        self.assertEqual(manifest["computer_time_zone"], "Europe/London")
        self.assertEqual(manifest["backup"]["ios_version"], "26.1")
        self.assertEqual(manifest["backup"]["device_name"], "Test: iPhone?")
        self.assertEqual(manifest["backup"]["udid_sha256"], hashlib.sha256(UDID.encode()).hexdigest())
        self.assertEqual(manifest["app"]["version"], build_info.app_version())
        self.assertIn("integrity check", manifest["integrity"]["meaning"])

    @unittest.skipUnless(SPAM_MARK, "needs ios-backup-core with is_spam (charleswest775/ios-backup-core#36)")
    def test_every_voicemail_with_its_spam_and_deleted_marks(self):
        result = self.bundle()
        rows = {v["id"]: v for v in read_lines(os.path.join(result["path"], "voicemail.jsonl"))}
        self.assertEqual(
            {i: (v["folder"], v["is_spam"], v["is_deleted"]) for i, v in rows.items()},
            {"1": ("voicemail", False, False), "2": ("spam", True, False), "3": ("deleted", False, True),
             "4": ("deleted", False, True), "5": ("deleted", True, True), "6": ("voicemail", False, False),
             f"{ACCOUNT}.27": ("voicemail", False, False)},
        )
        self.assertEqual(rows["2"]["phone_number"], "+15550000002")
        self.assertEqual(rows["1"]["date_utc"], "2023-11-14T22:13:20Z")
        # Audio is copied and hashed; a voicemail whose audio isn't in the backup says so
        audio = os.path.join(result["path"], *rows["2"]["audio_path"].split("/"))
        with open(audio, "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), rows["2"]["audio_sha256"])
        self.assertEqual((rows["6"]["audio_path"], rows["6"]["audio_sha256"]), (None, None))
        section = self.manifest(result)["types"]["voicemail"]
        self.assertEqual(section["lists"], {"voicemail": 3, "spam": 1, "deleted": 3})
        self.assertEqual(section["audio"], {"copied": 6, "not_in_backup": 1, "failed": 0})
        self.assertEqual((section["first_utc"], section["last_utc"]), ("2020-09-13T12:26:40Z", "2024-10-27T03:33:20Z"))

    def test_kinds_the_backup_lacks_say_why(self):
        types = self.manifest(self.bundle())["types"]
        self.assertEqual((types["messages"]["count"], types["messages"]["empty_reason"]), (0, "not_in_backup"))
        self.assertEqual(types["photos"]["count"], 0)
        self.assertTrue(types["photos"]["empty_reason"])
        self.assertIsNone(types["voicemail"]["empty_reason"])

    def test_people_from_voicemail_and_the_calls_made_of_it(self):
        result = self.bundle()
        with open(os.path.join(result["path"], "people.json"), encoding="utf-8") as f:
            people = json.load(f)
        first = people["people"][0]
        self.assertEqual(first["identifier"], "+15550000001")
        # Two voicemails, and each shows as a missed call too, as in the app
        self.assertEqual(first["counts"], {"messages": 0, "calls": 2, "voicemail": 2})
        self.assertEqual(people["sources"], ["messages", "calls", "voicemail"])
        calls = read_lines(os.path.join(result["path"], "calls.jsonl"))
        self.assertTrue(calls and all(c["source"] == "voicemail" for c in calls))
        # Deleted voicemails aren't counted, as the app's People screen doesn't show them: no one is
        # made of those alone
        deleted_only = {"+15550000003", "+15550000004", "+15550000005"}
        self.assertFalse(deleted_only & {p["identifier"] for p in people["people"]})

    def test_only_the_kinds_asked_for(self):
        result = self.bundle(types=["voicemail"], files={"voicemail_audio": False})
        self.assertEqual(result["files"], ["SHA256SUMS", "manifest.json", "voicemail.jsonl"])
        manifest = self.manifest(result)
        self.assertEqual({t for t, s in manifest["types"].items() if s["included"]}, {"voicemail"})
        self.assertEqual(manifest["types"]["calls"], {"included": False})
        self.assertFalse(manifest["files_copied"]["voicemail_audio"])
        rows = read_lines(os.path.join(result["path"], "voicemail.jsonl"))
        self.assertTrue(all(r["audio_path"] is None for r in rows))
        self.assertEqual(check_bundle(result["path"]), [])

    def test_progress_goes_out_as_export_progress(self):
        self.bundle()
        progress = [p for m, p in self.notifications if m == "export.progress"]
        self.assertTrue(progress)
        self.assertTrue(all(p["kind"] == "bundle" for p in progress))
        self.assertEqual(progress[0]["done"], 0)
        self.assertEqual(progress[-1]["done"], progress[-1]["total"])

    def test_a_bad_request_is_a_clean_error_and_writes_nothing(self):
        for params in ({"types": ["messages", "diary"]}, {"types": []}, {"types": "messages"}):
            response = self.export(**params)
            self.assertEqual(response["error"]["code"], -32000, params)
            self.assertFalse(os.path.exists(self.out) and os.listdir(self.out), params)
        self.assertIn("diary", self.export(types=["diary"])["error"]["message"])

    def test_a_backup_that_isnt_open_writes_nothing(self):
        response = self.server.handle_request({"id": 7, "method": "export_bundle", "params": {
            "udid": "00000000-NOT-OPEN", "output_dir": self.out}})
        self.assertIn("error", response)
        self.assertFalse(os.path.exists(self.out))

    def test_a_kind_that_fails_to_read_leaves_the_rest(self):
        with mock.patch.object(self.server.call_extractor, "list_calls", side_effect=RuntimeError("calls broke")):
            result = self.bundle()
        self.assertEqual(result["errors"], {"calls": "RuntimeError: calls broke"})
        manifest = self.manifest(result)
        self.assertEqual(manifest["types"]["calls"]["error"], "RuntimeError: calls broke")
        self.assertIsNone(manifest["types"]["calls"]["empty_reason"])
        self.assertEqual(manifest["types"]["voicemail"]["count"], 7)
        with open(os.path.join(result["path"], "people.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["sources"], ["messages", "voicemail"])
        self.assertEqual(check_bundle(result["path"]), [])

    def test_a_bundle_that_cant_be_written_is_removed(self):
        real = bundle._Writer.write_json

        def full_disk(writer, rel, value):
            if rel == "manifest.json":
                raise OSError(errno.ENOSPC, "No space left on device", writer.path(rel))
            return real(writer, rel, value)

        with mock.patch.object(bundle._Writer, "write_json", full_disk):
            response = self.export()
        self.assertEqual(response["error"]["code"], -32000)
        self.assertIn("No space", response["error"]["message"])
        self.assertEqual(os.listdir(self.out), [])  # no half-written bundle left behind
        # The engine carries on
        self.assertEqual(self.server.handle_request({"id": 2, "method": "ping"})["result"]["status"], "ok")

    def test_nothing_goes_near_the_network(self):
        def no_network(*args, **kwargs):
            raise AssertionError("the bundle tried to use the network")

        with mock.patch.object(socket.socket, "connect", no_network), \
                mock.patch.object(socket, "create_connection", no_network), \
                mock.patch.object(socket, "getaddrinfo", no_network):
            result = self.bundle()
        self.assertEqual(result["errors"], {})

    def test_two_bundles_get_two_folders(self):
        first, second = self.bundle(), self.bundle()
        self.assertNotEqual(first["path"], second["path"])
        self.assertTrue(second["path"].endswith("(2)"))


class HelpersTest(unittest.TestCase):
    def test_dates_are_written_in_utc(self):
        self.assertEqual(bundle.utc("2024-07-05T09:10:00-07:00"), "2024-07-05T16:10:00Z")
        self.assertEqual(bundle.utc("2024-07-05T16:10:00+00:00"), "2024-07-05T16:10:00Z")
        self.assertEqual(bundle.utc("2024-07-05T16:10:00.250000+00:00"), "2024-07-05T16:10:00.25Z")
        self.assertEqual(bundle.utc("2024-07-05T16:10:00"), "2024-07-05T16:10:00Z")  # no offset: UTC
        self.assertEqual(bundle.utc("2024-07-05T16:10:00Z"), "2024-07-05T16:10:00Z")
        for nothing in ("", None, "not a date"):
            self.assertIsNone(bundle.utc(nothing))

    def test_a_caller_with_no_number_has_no_name(self):
        """The engine names a call or voicemail with no number "Unknown"; that's no name in the address book."""
        self.assertIsNone(bundle._name_or_none("Unknown", None))
        self.assertIsNone(bundle._name_or_none("Unknown", ""))
        self.assertEqual(bundle._name_or_none("Unknown", "+15550000001"), "Unknown")  # a contact really called that
        self.assertEqual(bundle._name_or_none("Dentist", "+15550000001"), "Dentist")
        self.assertIsNone(bundle._name_or_none("+15550000001", "+15550000001"))

    def test_file_names_work_everywhere(self):
        self.assertEqual(bundle.safe_name('a<b>c:"d"/e\\f|g?h*i\x01'), "a_b_c__d__e_f_g_h_i_")
        self.assertEqual(bundle.safe_name("  .hidden. "), "hidden")
        self.assertEqual(bundle.safe_name(""), "file")
        long = bundle.safe_name("x" * 300 + ".jpeg")
        self.assertEqual((len(long), long[-5:]), (80, ".jpeg"))

    def test_json_is_valid_utf8_whatever_the_backup_held(self):
        text = bundle.to_json({"text": "half an emoji \ud83d", "raw": b"\x00\xff", "nan": float("nan")})
        text.encode("utf-8")
        self.assertEqual(json.loads(text), {"text": "half an emoji �", "raw": "00ff", "nan": None})


def _unknown_keywords(schema: dict) -> set:
    """Keywords anywhere in a schema that bundle_schema.errors doesn't check."""
    found = set(schema) - KEYWORDS
    for key in ("properties", "$defs"):
        for sub in schema.get(key, {}).values():
            found |= _unknown_keywords(sub)
    if isinstance(schema.get("items"), dict):
        found |= _unknown_keywords(schema["items"])
    return found


class SchemaFilesTest(unittest.TestCase):
    def test_each_schema_names_itself_and_uses_known_keywords(self):
        names = sorted(p.name for p in (SCHEMAS / bundle.SCHEMA_VERSION).glob("*.schema.json"))
        self.assertEqual(len(names), 9)
        for name in names:
            schema = load_schema(bundle.SCHEMA_VERSION, name)
            self.assertTrue(schema["$id"].endswith(f"/schema/{bundle.SCHEMA_VERSION}/{name}"), name)
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertEqual(_unknown_keywords(schema), set(), name)

    def test_the_checker_catches_a_bad_record(self):
        schema = load_schema("0.1", "voicemail.schema.json")
        good = {"id": "1", "date_utc": "2024-07-05T16:10:00Z", "phone_number": "+15550000001", "contact_name": None,
                "duration": 3, "is_read": True, "folder": "spam", "is_spam": True, "is_deleted": False,
                "transcript": None, "audio_path": "voicemail/1.amr", "audio_sha256": "0" * 64}
        self.assertEqual(errors(schema, good), [])
        self.assertTrue(errors(schema, {**good, "folder": "trash"}))
        self.assertTrue(errors(schema, {**good, "date_utc": "2024-07-05 16:10"}))
        self.assertTrue(errors(schema, {**good, "audio_path": "../escape.amr"}))
        self.assertTrue(errors(schema, {**good, "extra": 1}))
        self.assertTrue(errors(schema, {k: v for k, v in good.items() if k != "is_spam"}))


class BuildInfoTest(unittest.TestCase):
    def test_ping_says_the_apps_version(self):
        with open(os.path.join(HERE, "..", "..", "package.json"), encoding="utf-8") as f:
            version = json.load(f)["version"]
        self.assertEqual(SidecarServer().ping({}), {"status": "ok", "version": version})

    def test_a_built_engine_reads_build_info_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "build_info.json"), "w", encoding="utf-8") as f:
                json.dump({"app_version": "9.9.9", "ios_backup_core_commit": "a" * 40}, f)
            with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "_MEIPASS", tmp, create=True):
                self.assertEqual(build_info.app_version(), "9.9.9")
                self.assertEqual(build_info.ios_backup_core_commit(), "a" * 40)

    def test_the_commit_is_read_from_a_checkout(self):
        sha, other = "1" * 40, "2" * 40
        with tempfile.TemporaryDirectory() as tmp:
            repo = os.path.join(tmp, "repo")
            git = os.path.join(repo, ".git")
            os.makedirs(os.path.join(git, "refs", "heads"))
            os.makedirs(os.path.join(repo, "src", "pkg"))
            with open(os.path.join(git, "HEAD"), "w") as f:
                f.write("ref: refs/heads/main\n")
            with open(os.path.join(git, "refs", "heads", "main"), "w") as f:
                f.write(sha + "\n")
            self.assertEqual(build_info.git_commit(os.path.join(repo, "src", "pkg")), sha)
            # A branch only in packed-refs
            os.remove(os.path.join(git, "refs", "heads", "main"))
            with open(os.path.join(git, "packed-refs"), "w") as f:
                f.write(f"# pack-refs with: peeled\n{sha} refs/heads/main\n")
            self.assertEqual(build_info.git_commit(repo), sha)
            # Detached, as CI checks it out
            with open(os.path.join(git, "HEAD"), "w") as f:
                f.write(other + "\n")
            self.assertEqual(build_info.git_commit(repo), other)
            # A worktree: .git is a file, and its branches are in the main checkout
            wt_git = os.path.join(git, "worktrees", "wt")
            os.makedirs(wt_git)
            with open(os.path.join(wt_git, "HEAD"), "w") as f:
                f.write("ref: refs/heads/main\n")
            with open(os.path.join(wt_git, "commondir"), "w") as f:
                f.write("../..\n")
            wt = os.path.join(tmp, "wt")
            os.makedirs(wt)
            with open(os.path.join(wt, ".git"), "w") as f:
                f.write(f"gitdir: {wt_git}\n")
            self.assertEqual(build_info.git_commit(wt), sha)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(build_info.git_commit(tmp))


if __name__ == "__main__":
    unittest.main()
