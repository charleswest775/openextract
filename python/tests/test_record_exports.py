"""
Tests for the saved record documents (python/record_document.py) and the saves
built on them: call history, web history, notes and recovered messages as a
web page, the print-ready page Electron prints to a PDF (pdf_source) and plain
text, and their spreadsheets' byte-order mark and formula guard.

The engine methods themselves, on generated backups, are in test_rpc_contract.py;
local dates are in test_calls_web_notes_local_time.py.
"""

import csv
import os
import sys
import tempfile
import unittest
from datetime import timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import record_document as rd  # noqa: E402
from browser_history import BrowserHistoryExtractor  # noqa: E402
from calls import CallExtractor, call_duration, call_kind  # noqa: E402
from message_recovery import _document as recovered_document  # noqa: E402
from notes import NoteExtractor  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")
EVIL = '<script>alert("x")</script> & <img src=x onerror=alert(1)>'


def _read(path, encoding="utf-8"):
    with open(path, encoding=encoding) as f:
        return f.read()


class _TempDir(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = self._tmp.name


class TestDocumentPage(_TempDir):

    def _doc(self, **section):
        return rd.RecordDocument(title="Call history", summary="2 calls", sections=[rd.Section(**section)])

    def test_a_whole_page_that_loads_nothing_and_prints_well(self):
        page = rd.document_html(self._doc(columns=[rd.Column("When", "when")], rows=[["Jul 5"]]))
        self.assertTrue(page.startswith("<!DOCTYPE html>"))
        self.assertIn('<meta charset="utf-8">', page)
        self.assertIn("<title>Call history</title>", page)
        self.assertIn("<h1>Call history</h1>", page)
        self.assertIn('<div class="summary">2 calls</div>', page)
        self.assertIn("@media print", page)
        self.assertIn("thead { display: table-header-group; }", page)  # the heading row on every printed page
        self.assertIn("Made with OpenExtract", page)  # the footer every export has
        for loads in ("<script", "<img", "<link", " src=", "@import", "url("):
            self.assertNotIn(loads, page.lower())
        self.assertTrue(page.rstrip().endswith("</html>"))

    def test_everything_from_the_backup_is_escaped(self):
        doc = rd.RecordDocument(title=EVIL, summary=EVIL, sections=[
            rd.Section(heading=EVIL, meta=EVIL, columns=[rd.Column(EVIL)], rows=[[EVIL]]),
            rd.Section(text=EVIL),
        ])
        page = rd.document_html(doc)
        self.assertNotIn("<script", page)
        self.assertNotIn("<img", page)
        escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;"
        # title, h1, summary, heading, meta, column, cell, text
        self.assertEqual(page.count(escaped), 8)
        self.assertIn(f'<div class="text">{escaped}</div>', page)
        self.assertEqual(page.count("<div"), page.count("</div>"))

    def test_cells_keep_line_breaks_emoji_and_right_to_left_text(self):
        page = rd.document_html(self._doc(columns=[rd.Column("Message")], rows=[["first line\nsecond 🎉 مرحبا"]]))
        self.assertIn("<td>first line<br>second 🎉 مرحبا</td>", page)

    def test_column_kinds_lay_cells_out(self):
        page = rd.document_html(self._doc(
            columns=[rd.Column("When", "when"), rd.Column("Page"), rd.Column("Address", "long"), rd.Column("Visits", "number")],
            rows=[["Jul 5, 2024, 9:10 AM", "News", "https://example.com/a/very/long/path", "3"]],
        ))
        self.assertIn('<th>When</th><th>Page</th><th>Address</th><th class="number">Visits</th>', page)
        self.assertIn('<td class="when">Jul 5, 2024, 9:10 AM</td><td>News</td>'
                      '<td class="long">https://example.com/a/very/long/path</td><td class="number">3</td>', page)

    def test_a_text_section_keeps_the_text_as_written(self):
        page = rd.document_html(self._doc(text="Milk\n  Eggs\n\nBread"))
        self.assertIn('<div class="text">Milk\n  Eggs\n\nBread</div>', page)

    def test_an_empty_table_says_so(self):
        page = rd.document_html(self._doc(columns=[rd.Column("When")], rows=[], empty="No calls."))
        self.assertIn('<p class="empty">No calls.</p>', page)
        self.assertNotIn("<table>", page)


class TestDocumentText(unittest.TestCase):

    def test_rows_read_as_lines_with_the_date_first(self):
        doc = rd.RecordDocument(title="Web history", summary="2 page visits", sections=[rd.Section(
            columns=[rd.Column("When", "when"), rd.Column("Page"), rd.Column("Site"), rd.Column("Visits", "number", labelled=True)],
            rows=[["Jul 5, 2024, 9:10 AM", "News\nof the day", "example.com", "3"], ["Jul 6, 2024, 8:00 PM", "", "x.test", ""]],
        )])
        self.assertEqual(rd.document_text(doc), (
            "Web history\n2 page visits\n\n"
            "[Jul 5, 2024, 9:10 AM] News of the day · example.com · Visits 3\n"
            "[Jul 6, 2024, 8:00 PM] x.test\n"
        ))

    def test_sections_have_headings_and_their_own_lines(self):
        doc = rd.RecordDocument(title="Recovered messages", sections=[
            rd.Section(heading="Karin", meta="Recently Deleted", columns=[rd.Column("When", "when")], rows=[["x"]],
                       text_lines=["[Jul 5] Karin: hi"]),
            rd.Section(heading="Shopping", text="Milk\nEggs"),
            rd.Section(heading="Nothing", columns=[rd.Column("When")], rows=[], empty="None found."),
        ])
        self.assertEqual(rd.document_text(doc), (
            "Recovered messages\n\n"
            "Karin\n==========\nRecently Deleted\n\n[Jul 5] Karin: hi\n\n"
            "Shopping\n==========\n\nMilk\nEggs\n\n"
            "Nothing\n==========\n\nNone found.\n"
        ))

    def test_a_table_without_dates_joins_its_values(self):
        doc = rd.RecordDocument(title="T", sections=[rd.Section(columns=[rd.Column("A"), rd.Column("B")], rows=[["1", None]])])
        self.assertEqual(rd.document_text(doc), "T\n\n1\n")


class TestWriting(_TempDir):

    def test_formats_and_file_names(self):
        doc = rd.RecordDocument(title="T")
        html_path = rd.write_document(doc, self.out, "call_history", "html")
        print_path = rd.write_document(doc, self.out, "call_history", "pdf_source")
        txt_path = rd.write_document(doc, self.out, "call_history", "txt")
        self.assertEqual([os.path.basename(p) for p in (html_path, print_path, txt_path)],
                         ["call_history.html", "call_history (2).html", "call_history.txt"])
        self.assertEqual(_read(html_path), _read(print_path))  # no pictures: the printed page is the web page
        with open(txt_path, "rb") as f:
            self.assertTrue(f.read().startswith(b"\xef\xbb\xbfT\n"))  # UTF-8 with its mark, as conversation saves
        with self.assertRaises(ValueError):
            rd.write_document(doc, self.out, "x", "pdf")

    def test_writes_into_a_folder_that_doesnt_exist_yet(self):
        path = rd.write_document(rd.RecordDocument(title="T"), os.path.join(self.out, "new", "deeper"), "x", "html")
        self.assertTrue(os.path.isfile(path))

    def test_unused_path_never_overwrites(self):
        for name in ("Notes.txt", "Notes (2).txt"):
            with open(os.path.join(self.out, name), "w") as f:
                f.write("kept")
        self.assertEqual(os.path.basename(rd.unused_path(self.out, "Notes", ".txt")), "Notes (3).txt")
        self.assertEqual(os.path.basename(rd.unused_path(self.out, "Notes", ".html")), "Notes.html")

    def test_file_base(self):
        self.assertEqual(rd.file_base('Mom: cell/home?', "x"), "Mom cell home")
        self.assertEqual(rd.file_base("  ..hidden. ", "x"), "hidden")
        self.assertEqual(rd.file_base("CON", "x"), "_CON")
        self.assertEqual(rd.file_base("con.txt notes", "x"), "_con.txt notes")
        self.assertEqual(rd.file_base("‮evil‬", "x"), "evil")
        self.assertEqual(rd.file_base(None, "Note_7"), "Note_7")
        self.assertEqual(rd.file_base("???", "Note_7"), "Note_7")
        self.assertEqual(rd.file_base("a" * 80, "x"), "a" * 60)
        self.assertEqual(rd.file_base("a" * 80, "x", 50), "a" * 50)
        self.assertEqual(rd.file_base("Café 🎂 список", "x"), "Café 🎂 список")

    def test_csv_cell(self):
        for formula in ("=HYPERLINK(1)", "+1", "-2", "@SUM(A1)", "\tx", "\rx"):
            self.assertEqual(rd.csv_cell(formula), "'" + formula)
        self.assertEqual(rd.csv_cell("Plain"), "Plain")
        self.assertEqual(rd.csv_cell(None), "")
        self.assertEqual(rd.csv_cell(3), 3)
        self.assertEqual(rd.csv_cell(False), False)

    def test_date_span_and_plural(self):
        self.assertEqual(rd.date_span(["2024-07-05T16:10:09+00:00", "2024-07-06T00:48:12+00:00"], PDT), "Jul 5, 2024")
        self.assertEqual(rd.date_span(["2026-06-21T12:00:00+00:00", None, "nope", "2024-07-05T16:10:09+00:00"], PDT),
                         "Jul 5, 2024 to Jun 21, 2026")
        self.assertEqual(rd.date_span([None, ""], PDT), "")
        self.assertEqual(rd.plural(1, "call"), "1 call")
        self.assertEqual(rd.plural(1234, "page visit"), "1,234 page visits")
        self.assertEqual(rd.plural(2, "person", "people"), "2 people")


# ── The saves ────────────────────────────────────────────────────────────────

def _call(**over):
    return {"date": "2024-07-05T16:10:09+00:00", "contact_name": "Riley Okafor", "address": "+15035550142",
            "direction": "incoming", "status": "answered", "duration": 242, "app": "Phone", **over}


class TestCallsSave(_TempDir):

    def _ext(self, calls):
        ext = CallExtractor.__new__(CallExtractor)
        ext.local_tz = PDT
        patcher = mock.patch.object(ext, "list_calls", return_value={"calls": calls})
        patcher.start()
        self.addCleanup(patcher.stop)
        return ext

    def test_kind_and_duration_read_as_the_calls_screen_shows_them(self):
        self.assertEqual(call_kind(_call()), "Incoming")
        self.assertEqual(call_kind(_call(direction="outgoing")), "Outgoing")
        self.assertEqual(call_kind(_call(status="missed")), "Missed")
        self.assertEqual(call_kind(_call(direction="unknown")), "Unknown")
        self.assertEqual([call_duration(s) for s in (0, None, 45, 242, 3600, 3725, 59.6, "x")],
                         ["0s", "0s", "45s", "4m 2s", "1h", "1h 2m 5s", "1m", ""])

    def test_the_web_page_has_a_row_per_call(self):
        ext = self._ext([_call(), _call(contact_name="", status="missed", duration=0, app=""),
                         _call(contact_name="Mom", address="", direction="outgoing")])
        result = ext.export_calls(None, {}, self.out, "html")
        page = _read(result["file"])
        self.assertEqual((result["success"], result["count"], result["path"]), (True, 3, result["file"]))
        self.assertIn("<td>Riley Okafor</td><td>+15035550142</td><td>Incoming</td>"
                      '<td class="number">4m 2s</td><td>Phone</td>', page)
        # No saved name: the number, once; no app: Phone, as the screen says
        self.assertIn("<td>+15035550142</td><td></td><td>Missed</td>", page)
        self.assertIn('<td class="number">0s</td><td>Phone</td>', page)
        self.assertIn("<td>Mom</td><td></td><td>Outgoing</td>", page)
        self.assertIn("3 calls, Jul 5, 2024", page)

    def test_plain_text(self):
        result = self._ext([_call()]).export_calls(None, {}, self.out, "txt")
        lines = _read(result["file"], "utf-8-sig").splitlines()
        self.assertEqual(lines[:2], ["Call history", "1 call, Jul 5, 2024"])
        self.assertIn("[Jul 5, 2024, 9:10 AM] Riley Okafor · +15035550142 · Incoming · 4m 2s · Phone", lines)

    def test_an_unknown_format_is_an_error_and_reads_nothing(self):
        ext = self._ext([_call()])
        self.assertEqual(ext.export_calls(None, {}, self.out, "pdf"), {"error": "Unsupported format: pdf"})
        ext.list_calls.assert_not_called()
        self.assertEqual(os.listdir(self.out), [])

    def test_the_csv_is_still_the_default(self):
        result = self._ext([_call()]).export_calls_csv(None, {}, self.out)
        self.assertEqual(os.path.basename(result["path"]), "call_history.csv")
        self.assertEqual(result["file"], result["path"])


class TestWebHistorySave(_TempDir):

    def _ext(self, visits):
        ext = BrowserHistoryExtractor.__new__(BrowserHistoryExtractor)
        ext.local_tz = PDT
        patcher = mock.patch.object(ext, "list_browser_history", return_value={"visits": visits})
        patcher.start()
        self.addCleanup(patcher.stop)
        return ext

    def _visit(self, **over):
        return {"visit_date": "2024-07-05T16:10:09+00:00", "browser": "safari", "url": "https://example.com/news",
                "title": "News", "domain": "example.com", "visit_count": 1234, **over}

    def test_a_page_title_never_runs_as_a_formula(self):
        result = self._ext([self._visit(title='=HYPERLINK("http://evil.test","Click")')]).export_browser_history(None, self.out)
        with open(result["path"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[1][3], '\'=HYPERLINK("http://evil.test","Click")')
        self.assertEqual(rows[1][2], "https://example.com/news")

    def test_the_web_page(self):
        visits = [self._visit(), self._visit(title="", browser="firefox", visit_count=None, url="http://a.test/" + "x" * 300)]
        page = _read(self._ext(visits).export_browser_history(None, self.out, "all", "pdf_source")["file"])
        self.assertIn("<td>News</td><td>example.com</td><td class=\"long\">https://example.com/news</td>"
                      '<td>Safari</td><td class="number">1,234</td>', page)
        # No title: the site's name; no count: nothing
        self.assertIn("<td>example.com</td><td>example.com</td>", page)
        self.assertIn('<td>Firefox</td><td class="number"></td>', page)
        self.assertIn("2 page visits", page)

    def test_an_unknown_format_is_an_error(self):
        self.assertEqual(self._ext([self._visit()]).export_browser_history(None, self.out, "all", "md"),
                         {"error": "Unsupported format: md"})


def _note(note_id, title, body, created="2024-07-05T16:10:09+00:00", modified="2024-07-06T00:48:12+00:00"):
    return {"note_id": note_id, "title": title, "body": body, "created": created, "modified": modified}


class TestNotesSave(_TempDir):

    NOTES = [
        _note(1, "Shopping", "Shopping\nMilk\nEggs"),
        _note(2, "Shopping", "Shopping\nBread"),
        _note("x3", "<b>Plans</b>", "Trip & stuff"),
        _note(4, "", "no title at all"),
    ]

    def _ext(self, notes=None):
        ext = NoteExtractor.__new__(NoteExtractor)
        ext.local_tz = PDT
        patcher = mock.patch.object(ext, "list_notes", return_value={"notes": notes if notes is not None else self.NOTES})
        patcher.start()
        self.addCleanup(patcher.stop)
        return ext

    def test_one_file_each_never_overwrites_a_note_with_the_same_title(self):
        result = self._ext().export_notes(None, [1, 2], "txt", self.out)
        self.assertEqual([os.path.basename(p) for p in result["exported"]], ["Shopping.txt", "Shopping (2).txt"])
        self.assertEqual((result["status"], result["count"], result["files"]), ("ok", 2, result["exported"]))
        self.assertNotIn("file", result)
        self.assertIn("Bread", _read(result["exported"][1]))

    def test_a_note_without_a_usable_title_is_named_by_its_id(self):
        result = self._ext().export_notes(None, [4, "x3"], "html", self.out)
        self.assertEqual(sorted(os.path.basename(p) for p in result["exported"]), ["Note_4.html", "b Plans b.html"])

    def test_one_note_as_a_web_page(self):
        page = _read(self._ext().export_notes(None, [1], "html", self.out)["exported"][0])
        self.assertIn("<h1>Shopping</h1>", page)
        self.assertIn("Created Jul 5, 2024, 9:10 AM · Edited Jul 5, 2024, 5:48 PM", page)
        # Its title is the heading already, as on the Notes screen
        self.assertIn('<div class="text">Milk\nEggs</div>', page)

    def test_every_note_in_one_file(self):
        ext = self._ext()
        for fmt, ext_name in (("html", "Notes.html"), ("pdf_source", "Notes (2).html"), ("txt", "Notes.txt")):
            result = ext.export_notes(None, None, fmt, self.out, "merged")
            self.assertEqual(os.path.basename(result["file"]), ext_name)
            self.assertEqual((result["count"], result["exported"], result["files"]), (4, [result["file"]], [result["file"]]))
        page = _read(os.path.join(self.out, "Notes.html"))
        self.assertIn("<h1>Notes</h1>", page)
        self.assertIn('<div class="summary">4 notes</div>', page)
        self.assertEqual(page.count("<h2>"), 4)
        self.assertIn("<h2>&lt;b&gt;Plans&lt;/b&gt;</h2>", page)
        self.assertIn("<h2>Untitled</h2>", page)
        text = _read(os.path.join(self.out, "Notes.txt"))
        self.assertEqual(text.count("Title: "), 4)
        self.assertEqual(text.count("\n\n" + "-" * 60 + "\n\n"), 3)
        self.assertTrue(text.startswith("Title: Shopping\nCreated: Jul 5, 2024, 9:10 AM\n"))

    def test_merged_only_the_notes_asked_for(self):
        result = self._ext().export_notes(None, ["x3", 4], "txt", self.out, "merged")
        self.assertEqual(result["count"], 2)
        self.assertNotIn("Milk", _read(result["file"]))

    def test_an_unknown_format_or_mode_is_an_error_and_writes_nothing(self):
        ext = self._ext()
        self.assertEqual(ext.export_notes(None, [1], "docx", self.out), {"error": "Unsupported format: docx"})
        self.assertEqual(ext.export_notes(None, [1], "", self.out), {"error": "Unsupported format: "})
        self.assertEqual(ext.export_notes(None, [1], None, self.out), {"error": "Unsupported format: None"})
        self.assertEqual(ext.export_notes(None, [1], "txt", self.out, "zip"), {"error": "Unsupported mode: zip"})
        ext.list_notes.assert_not_called()
        self.assertEqual(os.listdir(self.out), [])

    def test_formats_are_read_whatever_their_case(self):
        result = self._ext().export_notes(None, [1], "TXT", self.out)
        self.assertEqual(result["status"], "ok")

    def test_nothing_to_save(self):
        self.assertEqual(self._ext().export_notes(None, [99], "txt", self.out),
                         {"status": "error", "message": "No matching notes found."})
        self.assertEqual(self._ext([]).export_notes(None, None, "html", self.out, "merged"),
                         {"status": "error", "message": "No matching notes found."})

    def test_the_old_reportlab_pdf_still_works_merged(self):
        try:
            import reportlab  # noqa: F401
        except ImportError:
            self.skipTest("reportlab isn't installed")
        result = self._ext().export_notes(None, None, "pdf", self.out, "merged")
        with open(result["file"], "rb") as f:
            self.assertEqual(f.read(5), b"%PDF-")
        self.assertEqual(os.path.basename(result["file"]), "Notes.pdf")


class TestRecoveredDocument(unittest.TestCase):

    def _message(self, text, source="recently_deleted", **over):
        return {"message_id": 1, "text": text, "message_type": "text", "date": "2024-07-05T16:10:09+00:00",
                "is_from_me": False, "sender": "Karin", "sender_handle": "+15035550107", "has_attachments": False,
                "is_reaction": False, "source": source, "deleted_date": "2024-07-06T00:48:12+00:00", **over}

    def test_a_section_per_conversation_in_the_screens_words(self):
        convos = [
            {"recovery_id": "recent:4", "source": "recently_deleted", "display_name": "Book club", "chat_identifier": "chat9",
             "is_group": True, "message_count": 2},
            {"recovery_id": "orphan:+1", "source": "orphaned", "display_name": "", "chat_identifier": "+15035550199",
             "is_group": False, "message_count": 1},
        ]
        by_convo = {
            "recent:4": [self._message("See you at 7"), self._message("me too", is_from_me=True, sender="")],
            "orphan:+1": [self._message("lost", source="orphaned", deleted_date=None, sender="", sender_handle="")],
        }
        doc = recovered_document(convos, by_convo, PDT)
        self.assertEqual((doc.title, doc.summary), ("Recovered messages", "3 messages in 2 conversations"))
        self.assertEqual([s.heading for s in doc.sections], ["Book club", "+15035550199"])
        self.assertEqual(doc.sections[0].meta, "Recently Deleted · Group · 2 messages recovered")
        self.assertEqual(doc.sections[1].meta, "Left behind · original chat deleted · 1 message recovered")
        self.assertEqual(doc.sections[0].rows[1], ["Jul 5, 2024, 9:10 AM", "Me", "me too", "Jul 5, 2024, 5:48 PM"])
        self.assertEqual(doc.sections[1].rows[0][1:], ["", "lost", ""])
        text = rd.document_text(doc)
        self.assertIn("[Jul 5, 2024, 9:10 AM] Karin: See you at 7 (deleted Jul 5, 2024, 5:48 PM)", text)
        self.assertIn("[Jul 5, 2024, 9:10 AM] Unknown: lost\n", text)

    def test_nothing_recovered_is_still_a_document(self):
        doc = recovered_document([], {}, PDT)
        self.assertEqual(doc.summary, "0 messages in 0 conversations")
        self.assertIn("No deleted messages were found in this backup.", rd.document_html(doc))


if __name__ == "__main__":
    unittest.main()
