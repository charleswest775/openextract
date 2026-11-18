"""The engine's People merge (python/people_merge.py) gives what the app's does.

The app merges people in TypeScript (src/components/people/gather.ts); a data
bundle's people.json is made in Python. Both run the cases in
fixtures/people-merge.json (scripts/people-merge.test.mjs is the TypeScript side),
so a rule changed in one and not the other fails here or there.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import people_merge  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "people-merge.json")


def _cases():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)["cases"]


class PeopleMergeFixtureTest(unittest.TestCase):
    def test_every_case_matches_the_app(self):
        cases = _cases()
        self.assertGreaterEqual(len(cases), 5)
        for case in cases:
            with self.subTest(case["name"]):
                people = people_merge.gather_people(case["entries"], case["cards"])
                self.assertEqual([people_merge.plain(p) for p in people], case["people"])
                self.assertEqual(people_merge.link_cards(people, case["cards"]), case["cardOf"])

    def test_one_entry_with_a_count_is_that_many_entries(self):
        """The bundle passes one entry per conversation with its message count, so a big
        backup needn't hold an entry per message. It must come out the same."""
        for case in _cases():
            with self.subTest(case["name"]):
                expanded, counted = [], []
                for e in case["entries"]:
                    expanded += [e] * 3
                    counted.append({**e, "count": 3})
                self.assertEqual(
                    [people_merge.plain(p) for p in people_merge.gather_people(counted, case["cards"])],
                    [people_merge.plain(p) for p in people_merge.gather_people(expanded, case["cards"])],
                )


class EntriesFromRecordsTest(unittest.TestCase):
    """Engine records become entries the way the app's Timeline makes them (useTimeline.ts)."""

    def test_a_facetime_uuid_is_no_ones_number(self):
        e = people_merge.call_entry({"address": "6B1F2C8E-1D2A-4C1B-9F7E-0A1B2C3D4E5F", "contact_name": "",
                                     "app": "T84QZS65DQ.com.facebook.Facebook"}, "2026-01-01T00:00:00Z")
        self.assertEqual((e["contactIdentifier"], e["contactName"]), (None, "Facebook"))

    def test_a_call_with_no_saved_name_is_named_by_its_number(self):
        e = people_merge.call_entry({"address": "+15035550100", "contact_name": ""}, "2026-01-01T00:00:00Z")
        self.assertEqual((e["contactIdentifier"], e["contactName"]), ("+15035550100", "+15035550100"))

    def test_voicemail_and_message_entries(self):
        vm = people_merge.voicemail_entry({"phone_number": "+15035550100", "contact_name": "Dot"}, "t")
        self.assertEqual((vm["type"], vm["contactName"], vm["contactIdentifier"]), ("voicemail", "Dot", "+15035550100"))
        msg = people_merge.message_entry(
            {"chat_id": 9, "chat_identifier": "chat9", "display_name": "", "is_group": True}, "t")
        self.assertEqual((msg["contactName"], msg["message"]), ("chat9", {"isGroup": True, "chatId": 9}))

    def test_numbers_compare_on_ascii_digits_only(self):
        self.assertEqual(people_merge.norm_phone("+1 (503) 555-0100"), "5035550100")
        self.assertEqual(people_merge.norm_phone("٥٥٥١٢٣٤٥٦٧"), "")
        self.assertEqual(people_merge.norm_phone("120363025246125486@g.us"), "")


if __name__ == "__main__":
    unittest.main()
