"""
Tests for splitting a long PDF save by year (python/pdf_parts.py).

A PDF holds its photos whole, so one of a long, busy chat can be gigabytes. The
save stays one file when everything fits, however many years it covers; when it
doesn't, it's split by year, quiet years sharing a file and a year too big on
its own split into runs of months. Each part is then saved on its own, and the
Messages and WhatsApp saves keep only that part's messages.
"""

import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import pdf_parts  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from pdf_parts import MAX_IMAGES, MAX_PAGES, MESSAGES_PER_PAGE, plan  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")


def year(y, messages_per_month, images_per_month, months=range(1, 13)):
    return {f"{y}-{m:02d}": [messages_per_month, images_per_month] for m in months}


def labels(result):
    return [p["label"] for p in result["parts"]]


class TestPlan(unittest.TestCase):

    def test_a_few_texts_over_three_years_stay_one_file(self):
        result = plan({"2022-03": [1, 0], "2023-05": [1, 0], "2024-07": [1, 0]})
        self.assertFalse(result["split"])
        self.assertEqual(result["parts"], [{"from": None, "to": None, "label": None, "undated": True,
                                            "messages": 3, "images": 0}])

    def test_years_that_fit_together_stay_one_file(self):
        # 3 years, 900 photos and about 1,400 pages in all: under the limits
        counts = {**year(2022, 300, 25), **year(2023, 300, 25), **year(2024, 300, 25)}
        self.assertLess(sum(c[1] for c in counts.values()), MAX_IMAGES)
        self.assertFalse(plan(counts)["split"])

    def test_three_heavy_years_make_three_files(self):
        counts = {**year(2022, 500, 40), **year(2023, 500, 40), **year(2024, 500, 40)}
        result = plan(counts)
        self.assertTrue(result["split"])
        self.assertEqual(labels(result), ["2022", "2023", "2024"])
        self.assertEqual([(p["from"], p["to"]) for p in result["parts"]],
                         [("2022-01", "2022-12"), ("2023-01", "2023-12"), ("2024-01", "2024-12")])
        self.assertEqual([p["images"] for p in result["parts"]], [480, 480, 480])
        self.assertEqual(result["messages"], 18000)
        self.assertEqual(sum(p["messages"] for p in result["parts"]), 18000)

    def test_quiet_years_share_a_file_and_busy_years_get_their_own(self):
        counts = {f"{y}-06": [30, 2] for y in range(2015, 2022)}
        for y in (2022, 2023, 2024):
            counts.update(year(y, 900, 50))
        self.assertEqual(labels(plan(counts)), ["2015–2021", "2022", "2023", "2024"])

    def test_a_quiet_year_between_busy_ones_isnt_glued_to_one(self):
        counts = {**year(2022, 900, 50), "2023-04": [10, 0], **year(2024, 900, 50)}
        self.assertEqual(labels(plan(counts)), ["2022", "2023", "2024"])

    def test_photos_alone_can_make_a_split(self):
        # Few messages, but 1,200 photos: 400 MB in one file
        counts = {**year(2023, 10, 50), **year(2024, 10, 50)}
        self.assertEqual(labels(plan(counts)), ["2023", "2024"])

    def test_text_alone_can_make_a_split(self):
        # No photos, but about 3,300 pages
        counts = {**year(2023, 1500, 0), **year(2024, 1500, 0)}
        self.assertGreater(36000 / MESSAGES_PER_PAGE, MAX_PAGES)
        self.assertEqual(labels(plan(counts)), ["2023", "2024"])

    def test_a_year_too_big_on_its_own_splits_into_even_runs_of_months(self):
        result = plan(year(2024, 2000, 200))  # 2,400 photos in one year
        self.assertEqual(labels(result), ["Jan–Apr 2024", "May–Aug 2024", "Sep–Dec 2024"])
        self.assertEqual([(p["from"], p["to"]) for p in result["parts"]],
                         [("2024-01", "2024-04"), ("2024-05", "2024-08"), ("2024-09", "2024-12")])
        # A year a little too big: two halves, not nine months and three
        self.assertEqual(labels(plan(year(2024, 1000, 100))), ["Jan–Jun 2024", "Jul–Dec 2024"])

    def test_a_split_year_sits_between_whole_years(self):
        counts = {**year(2022, 900, 50), **year(2023, 2000, 200), "2024-02": [5, 0]}
        self.assertEqual(labels(plan(counts)), ["2022", "Jan–Apr 2023", "May–Aug 2023", "Sep–Dec 2023", "2024"])

    def test_a_single_month_too_big_on_its_own_is_one_part(self):
        counts = {"2024-01": [10, 5], "2024-02": [100, 1500], "2024-03": [10, 5]}
        result = plan(counts)
        self.assertIn("Feb 2024", labels(result))
        self.assertEqual(sum(p["images"] for p in result["parts"]), 1510)

    def test_messages_without_a_date_go_with_the_first_part(self):
        counts = {None: [5, 1], **year(2023, 600, 60), **year(2024, 600, 60)}
        result = plan(counts)
        self.assertEqual(labels(result), ["2023", "2024"])
        self.assertEqual([p["undated"] for p in result["parts"]], [True, False])
        self.assertEqual(result["parts"][0]["messages"], 7205)
        self.assertEqual(sum(p["messages"] for p in result["parts"]), result["messages"])

    def test_nothing_to_save_is_one_empty_file(self):
        self.assertEqual(labels(plan({})), [None])
        self.assertEqual(labels(plan({None: [3, 0]})), [None])

    def test_estimate_is_about_how_big_one_pdf_would_be(self):
        result = plan({**year(2023, 500, 100), **year(2024, 500, 100)})  # 2,400 photos, 12,000 messages
        self.assertEqual(result["estimate"], {"pages": round(12000 / 11 + 2400 * 0.43),
                                              "megabytes": round(2400 * 0.5 + 12000 * 0.0007)})

    def test_file_label_uses_plain_hyphens(self):
        self.assertEqual(pdf_parts.file_label({"label": "2019–2021"}), "2019-2021")
        self.assertEqual(pdf_parts.file_label({"label": "Jan–Jun 2024"}), "Jan-Jun 2024")
        self.assertEqual(pdf_parts.file_label(None), "")


class TestPartWindow(unittest.TestCase):

    def test_in_part_by_local_month(self):
        part = {"from": "2023-01", "to": "2023-12", "undated": False}
        self.assertTrue(pdf_parts.in_part(datetime(2023, 1, 1, 0, 5, tzinfo=PDT), part))
        self.assertTrue(pdf_parts.in_part(datetime(2023, 12, 31, 23, 59, tzinfo=PDT), part))
        self.assertFalse(pdf_parts.in_part(datetime(2024, 1, 1, tzinfo=PDT), part))
        self.assertFalse(pdf_parts.in_part(None, part))
        self.assertTrue(pdf_parts.in_part(None, {**part, "undated": True}))
        self.assertTrue(pdf_parts.in_part(None, None))

    def test_query_window_is_a_day_wider_than_the_part_in_utc(self):
        frm, to = pdf_parts.query_window({"from": "2023-01", "to": "2023-12", "undated": False}, PDT)
        self.assertEqual((frm, to), ("2022-12-31T07:00:00+00:00", "2024-01-02T07:00:00+00:00"))
        frm, to = pdf_parts.query_window({"from": "2024-03", "to": "2024-03", "undated": False}, PDT)
        self.assertEqual(to, "2024-04-02T07:00:00+00:00")

    def test_query_window_reads_everything_when_the_part_holds_undated_messages(self):
        self.assertEqual(pdf_parts.query_window({"from": "2023-01", "to": "2023-12", "undated": True}, PDT),
                         (None, None))
        self.assertEqual(pdf_parts.query_window(None, PDT), (None, None))
        self.assertEqual(pdf_parts.query_window({"from": None, "to": None, "undated": True}, PDT), (None, None))

    def test_query_window_on_this_computers_clock(self):
        frm, to = pdf_parts.query_window({"from": "2023-06", "to": "2023-06", "undated": False}, None)
        self.assertLess(datetime.fromisoformat(frm), datetime(2023, 6, 1, tzinfo=timezone.utc))
        self.assertGreater(datetime.fromisoformat(to), datetime(2023, 7, 1, tzinfo=timezone.utc))


class FakeMessages(MessageExtractor):
    """MessageExtractor over a list of messages, recording the date filters it was asked for."""

    def __init__(self, messages):
        self._messages = messages
        self.asked = []
        self.local_tz = PDT

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        self.asked.append((date_from, date_to))
        return {"messages": self._messages[offset:offset + limit], "total": len(self._messages)}


class NoFiles:
    """A backup without the photos' files: the PDF gets labels instead."""

    def get_file(self, relative_path, domain="HomeDomain"):
        return None


def _msg(i, date, images=0):
    atts = [{"attachment_id": i * 10 + k, "filename": f"IMG_{i}_{k}.HEIC", "mime_type": "image/heic"}
            for k in range(images)]
    return {"message_id": i, "date": date, "text": f"message {i}", "sender": "Alice", "is_from_me": False,
            "has_attachments": bool(atts), "attachments": atts}


class TestMessagesSaveOfOnePart(unittest.TestCase):

    def setUp(self):
        # New Year's Eve in California is already New Year's Day in UTC
        self.ext = FakeMessages([
            _msg(1, "2022-06-01T12:00:00+00:00", images=2),
            _msg(2, "2023-01-01T05:30:00+00:00"),  # Dec 31 2022, 10:30 PM in California
            _msg(3, "2023-07-04T18:00:00+00:00", images=1),
            _msg(4, None),
        ])

    def test_plan_counts_messages_and_photos_by_local_month(self):
        result = self.ext.plan_pdf_parts(None, [7], {})
        group = result["groups"][0]
        self.assertEqual((group["chat_ids"], group["messages"], group["images"]), ([7], 4, 3))

    def test_a_part_keeps_its_local_months_only(self):
        out = tempfile.mkdtemp()
        part = {"from": "2022-01", "to": "2022-12", "label": "2022", "undated": False}
        result = self.ext.export_conversation(None, 7, {}, "txt", out, display_name="Alice", part=part)
        self.assertEqual(result["message_count"], 2)
        with open(result["file"], encoding="utf-8-sig") as f:
            text = f.read()
        self.assertIn("message 1", text)
        self.assertIn("message 2", text)  # the Dec 31 message stays in 2022
        # Read a day wider than the part, in UTC
        self.assertEqual(self.ext.asked[-1], ("2021-12-31T07:00:00+00:00", "2023-01-02T07:00:00+00:00"))

    def test_the_part_holding_undated_messages_reads_everything(self):
        out = tempfile.mkdtemp()
        part = {"from": "2023-01", "to": "2023-12", "label": "2023", "undated": True}
        result = self.ext.export_conversation(None, 7, {}, "txt", out, display_name="Alice", part=part)
        self.assertEqual(result["message_count"], 2)  # July 4th, and the one with no date
        self.assertEqual(self.ext.asked[-1], (None, None))

    def test_a_date_range_asked_for_is_kept(self):
        out = tempfile.mkdtemp()
        part = {"from": "2023-01", "to": "2023-12", "label": "2023", "undated": False}
        self.ext.export_conversation(None, 7, {}, "txt", out, date_from="2023-01-01", date_to="2023-03-01",
                                     display_name="Alice", part=part)
        self.assertEqual(self.ext.asked[-1], ("2023-01-01", "2023-03-01"))

    def test_merged_part_is_named_for_its_years(self):
        out = tempfile.mkdtemp()
        part = {"from": "2022-01", "to": "2023-12", "label": "2022–2023", "undated": False}
        result = self.ext.export_conversations(None, [7], {7: "Alice"}, {}, "txt", out, mode="merged", part=part)
        self.assertEqual(result["message_count"], 3)
        html = self.ext.export_conversations(NoFiles(), [7], {7: "Alice"}, {}, "html", out, mode="merged", part=part)
        self.assertEqual(os.path.basename(html["files"][0]), "all_conversations.html")  # HTML saves aren't split
        pdf = self.ext.export_conversations(NoFiles(), [7], {7: "Alice"}, {}, "pdf_source", out, mode="merged",
                                            part=part)
        self.assertEqual(os.path.basename(pdf["files"][0]), "all_conversations 2022-2023.html")


if __name__ == "__main__":
    unittest.main()
