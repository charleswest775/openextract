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


class NamedByNumberTest(unittest.TestCase):
    """named_by_number is namedByNumber (src/lib/people.ts), case for case (scripts/people.test.mjs)."""

    def test_records_the_address_book_had_no_name_for(self):
        for name, identifier in [
            (None, "+15035550123"), ("", "+15035550123"), ("+15035550123", "+15035550123"),
            ("(503) 555-0123", "+15035550123"), ("5035550123", "+1 503 555 0123"),
            ("Mom@iCloud.com", "mom@icloud.com"), ("72727", "72727"),
        ]:
            with self.subTest(name=name, identifier=identifier):
                self.assertTrue(people_merge.named_by_number(
                    {"type": "call", "contactName": name, "contactIdentifier": identifier}))

    def test_named_records_and_records_with_no_number(self):
        for name, identifier in [
            ("Mom", "+15035550123"), ("Unknown", "+15035550123"), ("+15035550100", "+15035550123"),
            ("Mom", "mom@icloud.com"), ("Diane", None), ("Diane", ""), (None, None), ("", ""),
        ]:
            with self.subTest(name=name, identifier=identifier):
                self.assertFalse(people_merge.named_by_number(
                    {"type": "call", "contactName": name, "contactIdentifier": identifier}))

    def test_a_group_conversation_never_is(self):
        for name in ("chat123456789012345678", None):
            self.assertFalse(people_merge.named_by_number({
                "type": "message", "contactName": name, "contactIdentifier": "chat123456789012345678",
                "message": {"isGroup": True, "chatId": 1}}))


class BundleEntriesTest(unittest.TestCase):
    """The data bundle's people.json counts what the People page counts."""

    def test_an_apps_call_counts_for_the_person_of_that_name(self):
        conversation = {"chat_id": 4, "chat_identifier": "+15035550301", "display_name": "Diane", "is_group": False}
        entries = [
            {**people_merge.message_entry(conversation, "2026-03-01T00:00:00Z"), "count": 12},
            people_merge.call_entry({"address": "5B9C7F2E-1D3A-4E8B-9F60-2A7C1E4D8B93", "contact_name": "Diane",
                                     "app": "net.whatsapp.WhatsApp"}, "2026-03-02T00:00:00Z"),
            people_merge.call_entry({"address": "+15035550301", "contact_name": ""}, "2026-03-03T00:00:00Z"),
            people_merge.voicemail_entry({"phone_number": "", "contact_name": ""}, "2026-03-04T00:00:00Z"),
        ]
        [diane] = people_merge.gather_people(entries)
        self.assertEqual((diane["name"], diane["total"], diane["counts"]["call"], diane["last"]),
                         ("Diane", 14, 2, "2026-03-03T00:00:00Z"))
        self.assertEqual(diane["ids"], {"5035550301"})

    def test_a_caller_with_no_number_is_no_ones(self):
        """The engine names a voicemail or call with no number "Unknown"; it still joins no one's history (#310)."""
        conversation = {"chat_id": 4, "chat_identifier": "+15035550301", "display_name": "Diane", "is_group": False}
        entries = [
            {**people_merge.message_entry(conversation, "2026-03-01T00:00:00Z"), "count": 3},
            people_merge.voicemail_entry({"phone_number": "", "contact_name": "Unknown"}, "2026-03-04T00:00:00Z"),
            people_merge.call_entry({"address": "", "contact_name": "Unknown"}, "2026-03-04T00:00:00Z"),
        ]
        [diane] = people_merge.gather_people(entries)
        self.assertEqual((diane["name"], diane["total"], diane["counts"]["voicemail"]), ("Diane", 3, 0))
        # Not even someone the address book calls "Unknown"
        named = {**conversation, "chat_identifier": "+15035550399", "display_name": "Unknown"}
        [unknown] = people_merge.gather_people([{**people_merge.message_entry(named, "2026-03-01T00:00:00Z"), "count": 1},
                                                *entries[1:]])
        self.assertEqual((unknown["name"], unknown["total"], unknown["counts"]["call"]), ("Unknown", 1, 0))


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
