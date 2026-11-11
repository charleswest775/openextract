"""
The engine's WhatsApp methods over real (minimal) backups, called the way the RPC handlers are.

Each WhatsApp state a backup can be in, and what every method and the home
screen's counts (get_backup_stats) say about it:

  * not in the backup (most iPhones): calm empties, no error anywhere;
  * in the backup with nothing to list: "no_records";
  * listed but unreadable (a zero-length file): an error, counted in the
    overview's errors, and saves fail instead of writing empty files;
  * a layout this version can't read: an error with "unsupported_format",
    which the app shows but doesn't count as a failure.

Also: a plain backup's media files have no extension on disk, so copies for
opening in another app must get one, and every result must be plain JSON.

Building ChatStorage needs ios-backup-core with the WhatsApp extractor and
backupgen's harvested schemas: those cases skip without them (or fail when
OPENEXTRACT_REQUIRE_GENERATED=1).
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from rpc_contract_support import load_engine_module, skip_or_fail  # noqa: E402
import whatsapp_backup as wb  # noqa: E402

CHAT_DB = (wb.SHARED_DOMAIN, "ChatStorage.sqlite")


def _needs_store():
    problem = wb.backupgen_problem()
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

    def open(self, files: dict) -> str:
        self.n += 1
        udid = f"00008120-00000000000000{self.n:02d}"
        backup_dir = wb.make_minimal_plain(self.tmp / f"b{self.n}" / udid, files, udid)
        self.assertEqual(self.call("open_backup", udid=udid, backup_dir=str(backup_dir))["status"], "open")
        return udid

    def call(self, method, **params):
        result = self.server.methods[method](params)
        json.dumps(result)  # what goes back to the app must be plain JSON as it is
        return result

    def out(self, name="out") -> Path:
        path = self.tmp / name
        path.mkdir()
        return path

    def assert_every_method(self, udid, *, list_result, page_extra, error_expected):
        """Each method answers ``state`` the same way; saves never write a file for it."""
        self.assertEqual(self.call("list_whatsapp_chats", udid=udid), list_result)
        page = self.call("get_whatsapp_messages", udid=udid, chat_id=1, offset=0, limit=50)
        self.assertEqual(page, {"messages": [], "total": 0, "next_offset": 0, "offset": 0, "limit": 50, **page_extra})
        self.assertEqual(self.call("get_whatsapp_message_offset", udid=udid, chat_id=1, message_id=1),
                         {"offset": 0, "found": False})
        search = self.call("search_whatsapp_messages", udid=udid, query="hello")
        self.assertEqual(search, {"results": [], "query": "hello", **page_extra})
        attachment = self.call("get_whatsapp_attachment", udid=udid, attachment_id=1)
        self.assertEqual(attachment, error_expected)
        self.assertEqual(self.call("get_whatsapp_attachment", udid=udid, attachment_id=1, as_file=True), error_expected)
        out = self.out(f"save-{udid[-2:]}")
        self.assertEqual(self.call("export_whatsapp_chat", udid=udid, chat_id=1, format="html", output_dir=str(out)),
                         error_expected)
        for mode in ("separate", "merged"):
            self.assertEqual(self.call("export_whatsapp_chats", udid=udid, chat_ids=[1, 2], format="txt",
                                       conversation_names={"1": "A"}, output_dir=str(out), mode=mode),
                             error_expected)
        self.assertEqual(os.listdir(out), [])

    def overview(self, udid):
        stats = self.call("get_backup_stats", udid=udid)
        o = stats["overview"]
        return (o["total_whatsapp_messages"], o["total_whatsapp_chats"], o["whatsapp_status"]), stats["errors"]


class TestNotInBackup(EngineCase):

    def test_calm_everywhere(self):
        udid = self.open({})
        self.assert_every_method(
            udid,
            list_result={"conversations": [], "empty_reason": "not_in_backup"},
            page_extra={"empty_reason": "not_in_backup"},
            error_expected={"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, "not_in_backup"), []))


class TestStoreStates(EngineCase):

    def setUp(self):
        super().setUp()
        _needs_store()
        _, self.sqlitegen = wb._backupgen()

    def store(self, populate) -> bytes:
        self.n += 1
        return self.sqlitegen.build(self.tmp / f"ChatStorage{self.n}.sqlite", wb.SCHEMA_VERSION,
                                    "ChatStorage.sqlite", populate)

    def test_nothing_to_list(self):
        def only_status(db):
            db.table("ZWACHATSESSION").insert({"Z_PK": 1, "Z_ENT": 4, "ZCONTACTJID": "0@status", "ZSESSIONTYPE": 3})
            db.table("ZWAMESSAGE").insert({"Z_PK": 1, "Z_ENT": 9, "ZCHATSESSION": 1, "ZSORT": 1, "ZMESSAGETYPE": 0,
                                           "ZMESSAGEDATE": wb.T0, "ZTEXT": "a status"})
        for populate in (lambda db: None, only_status):
            udid = self.open({CHAT_DB: self.store(populate)})
            self.assertEqual(self.call("list_whatsapp_chats", udid=udid),
                             {"conversations": [], "empty_reason": "no_records"})
            # Status updates aren't chats: not readable through a chat id either
            page = self.call("get_whatsapp_messages", udid=udid, chat_id=1)
            self.assertEqual((page["messages"], page["total"]), ([], 0))
            self.assertEqual(self.call("search_whatsapp_messages", udid=udid, query="status")["results"], [])
            self.assertEqual(self.overview(udid), ((0, 0, "no_records"), []))

    def test_listed_but_unreadable(self):
        udid = self.open({CHAT_DB: b""})
        unreadable = self.call("list_whatsapp_chats", udid=udid)
        self.assertEqual(unreadable["conversations"], [])
        self.assertNotIn("empty_reason", unreadable)
        error = unreadable["error"]
        self.assertIn("could not be read", error)
        self.assert_every_method(udid, list_result=unreadable, page_extra={"error": error},
                                 error_expected={"error": error})
        (counts, errors) = self.overview(udid)
        self.assertEqual(counts, (0, 0, "error"))
        self.assertEqual(errors, [f"whatsapp: {error}"])

    def test_a_layout_this_version_cant_read(self):
        import sqlite3
        path = self.tmp / "other.sqlite"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE ZSOMETHINGELSE (Z_PK INTEGER PRIMARY KEY)")
        conn.close()
        udid = self.open({CHAT_DB: path.read_bytes()})
        listed = self.call("list_whatsapp_chats", udid=udid)
        self.assertEqual((listed["conversations"], listed["empty_reason"]), ([], "unsupported_format"))
        error = listed["error"]
        self.assert_every_method(udid, list_result=listed,
                                 page_extra={"error": error, "empty_reason": "unsupported_format"},
                                 error_expected={"error": error, "empty_reason": "unsupported_format"})
        # Shown on the WhatsApp screen, but not one of the backup's errors
        self.assertEqual(self.overview(udid), ((0, 0, "unsupported_format"), []))


class TestFullStore(EngineCase):

    def setUp(self):
        super().setUp()
        _needs_store()
        self.scenario = wb.build_files(self.tmp / "parts")
        self.udid = self.open(self.scenario.files)

    def test_counts_on_the_home_screen_match_the_list(self):
        chats = self.call("list_whatsapp_chats", udid=self.udid)["conversations"]
        self.assertEqual({c["chat_id"]: c["message_count"] for c in chats}, self.scenario.counts)
        (counts, errors) = self.overview(self.udid)
        self.assertEqual(counts, (self.scenario.total_messages, len(self.scenario.counts), "ok"))
        self.assertEqual(errors, [])

    def test_copies_from_a_plain_backup_get_their_extension(self):
        # In an unencrypted backup the file on disk is named by its hash, with no extension.
        found = self.server.whatsapp_extractor._inner.get_attachment(
            self.server.backup_manager.get_open_backup(self.udid), wb.ATT_DOCUMENT)
        self.assertEqual(os.path.splitext(found["path"])[1], "")
        copy = self.call("get_whatsapp_attachment", udid=self.udid, attachment_id=wb.ATT_DOCUMENT, as_file=True)
        self.assertEqual(os.path.basename(copy["path"]), wb.DOCUMENT_TITLE)
        self.assertEqual(Path(copy["path"]).read_bytes(), wb.PDF_BYTES)
        voice = self.call("get_whatsapp_attachment", udid=self.udid, attachment_id=wb.ATT_VOICE_NOTE, as_file=True)
        self.assertTrue(voice["path"].endswith("voice.opus"))
        thumb = self.call("get_whatsapp_attachment", udid=self.udid, attachment_id=wb.ATT_IMAGE,
                          thumbnail=True, as_file=True)
        self.assertTrue(thumb["path"].endswith(".jpg"))
        self.assertEqual(Path(thumb["path"]).read_bytes(), self.scenario.thumb_bytes)

    def test_every_message_page_is_plain_json(self):
        for chat_id in self.scenario.counts:
            page = self.call("get_whatsapp_messages", udid=self.udid, chat_id=chat_id, limit=500)
            self.assertNotIn("error", page)
            self.assertEqual(len(page["messages"]), self.scenario.counts[chat_id])

    def test_reopening_reads_the_store_again(self):
        before = self.call("list_whatsapp_chats", udid=self.udid)
        backup_dir = self.server.backup_manager.get_open_backup(self.udid).backup_dir
        self.assertEqual(self.call("open_backup", udid=self.udid, backup_dir=backup_dir)["status"], "open")
        self.assertEqual(self.call("list_whatsapp_chats", udid=self.udid), before)


if __name__ == "__main__":
    unittest.main()
