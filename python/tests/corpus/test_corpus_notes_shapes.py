"""Notes on generated backups: every note the answer key has, by its id, and nothing else.

The test persona's notes have the shapes a Notes reader must handle (ios-backup-core's
backupgen, writers/notes.py and writers/legacy_notes.py):

- an old notes.sqlite beside NoteStore, an "On My iPhone" account iOS 9 never upgraded,
  whose notes are listed as "legacy_<row>" (ios-backup-core#40: only those used to be
  listed), and one note there with ZDELETEDFLAG 1, which isn't;
- notes with no letters (a code, two numbers on two lines, emoji), whose text used to
  come back blank (also #40);
- titled notes whose text can't be read (ICNoteData.ZDATA NULL or empty, or no row);
- a placeholder for a note not yet downloaded from iCloud: no title, not listed;
- notes in Recently Deleted, listed with is_deleted (#41);
- a notes.sqlite note listed until it's deleted between the iOS 15 and 17 backups, and one
  edited after the iOS 15 backup.

Einstein's iOS 26 backups have a NoteStore with only an account, an empty folder and a
placeholder, so Notes is there with nothing to show; his iOS 15 and 17 ones have none.

test_corpus_answer_key.test_notes_match_answer_key compares titles, text and dates as a
multiset; these check ids, stores and Recently Deleted note by note, and, read straight
from the databases (raw_backup), that every notes.sqlite row not marked deleted is listed
and no deleted one is, and that no placeholder is listed (on any backup, real ones too).
"""

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus

NOTE_STORE = ("AppDomainGroup-group.com.apple.notes", "NoteStore.sqlite")
LEGACY = ("HomeDomain", "Library/Notes/notes.sqlite")
LEGACY_PREFIX = "legacy_"


def _expected_notes(ctx) -> list:
    expected = ctx.item.expected() if hasattr(ctx.item, "expected") else None
    if not expected:
        pytest.skip("no answer key (not a generated backup)")
    notes = expected["notes"]
    if notes and not any("note_id" in n for n in notes):
        pytest.skip("answer key from a backupgen that doesn't give note ids")
    assert all("note_id" in n for n in notes), "some answer-key notes have no note_id"
    ctx.require_open()
    return notes


def _listed(ctx) -> dict:
    notes = ctx.notes_result.get("notes", [])
    by_id = {n["note_id"]: n for n in notes}
    assert len(by_id) == len(notes), "two notes share an id"
    return by_id


def _sample(values, limit=5):
    values = sorted(values, key=str)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


def test_every_note_by_its_id(ctx):
    want = {n["note_id"]: n for n in _expected_notes(ctx)}
    got = _listed(ctx)
    assert set(got) == set(want), f"missing {_sample(set(want) - set(got))}, unexpected {_sample(set(got) - set(want))}"
    for note_id, w in want.items():
        g = got[note_id]
        assert (g["title"], g["body"], g["is_deleted"]) == (w["title"], w["text"], w["deleted"]), note_id
        assert parse_iso(g["created"]) == parse_iso(w["created"]), note_id
        assert parse_iso(g["modified"]) == parse_iso(w["modified"]), note_id
    assert ctx.stats["overview"]["total_notes"] == len(want)


def test_notes_from_the_old_notes_file(ctx):
    notes = _expected_notes(ctx)
    legacy = [n for n in notes if n["store"] == "legacy"]
    if not legacy:
        pytest.skip("no notes.sqlite notes in this backup")
    beside_note_store = any(n["store"] == "notestore" for n in notes)
    assert all(str(n["note_id"]).startswith(LEGACY_PREFIX) == beside_note_store for n in legacy)
    got = _listed(ctx)
    # Which listed notes come from notes.sqlite, by the reader's ids alone: "legacy_<row>" beside NoteStore's
    # notes, every note when NoteStore has none
    if beside_note_store:
        listed_rows = {int(i.removeprefix(LEGACY_PREFIX)) for i in got if str(i).startswith(LEGACY_PREFIX)}
    else:
        listed_rows = set(got)
    rows = ctx.raw.query(*LEGACY, "SELECT Z_PK, ZDELETEDFLAG FROM ZNOTE")
    assert rows is not None, "the answer key has notes.sqlite notes but the backup has no notes.sqlite"
    kept = {r["Z_PK"] for r in rows if not r["ZDELETEDFLAG"]}
    deleted = {r["Z_PK"] for r in rows if r["ZDELETEDFLAG"]}
    assert listed_rows == kept, f"rows listed {_sample(listed_rows)}, rows not deleted {_sample(kept)}"
    assert not deleted & listed_rows, f"deleted rows listed: {_sample(deleted & listed_rows)}"


def test_placeholders_for_notes_not_downloaded_arent_listed(ctx):
    ctx.require_open()
    conn = ctx.raw.connect(*NOTE_STORE)
    if conn is None:
        pytest.skip("no NoteStore.sqlite in this backup")
    try:
        if "ZNEEDSINITIALFETCHFROMCLOUD" not in ctx.raw.columns(conn, "ZICCLOUDSYNCINGOBJECT"):
            pytest.skip("this NoteStore has no ZNEEDSINITIALFETCHFROMCLOUD")
        placeholders = [r[0] for r in conn.execute(
            "SELECT o.Z_PK FROM ZICCLOUDSYNCINGOBJECT o JOIN Z_PRIMARYKEY e ON e.Z_ENT = o.Z_ENT "
            "WHERE e.Z_NAME = 'ICNote' AND o.ZTITLE1 IS NULL AND o.ZNEEDSINITIALFETCHFROMCLOUD = 1")]
    finally:
        conn.close()
    if not placeholders:
        pytest.skip("no placeholder notes in this backup")
    listed = set(_listed(ctx))
    assert not listed & set(placeholders), f"placeholders listed: {_sample(listed & set(placeholders))}"


def test_notes_with_no_letters_or_no_readable_text(ctx):
    notes = _expected_notes(ctx)
    letterless = [n for n in notes if n["text"] and not any(ch.isalpha() for ch in n["text"])]
    unreadable = [n for n in notes if not n["text"]]
    if not letterless and not unreadable:
        pytest.skip("every note here has letters and readable text")
    got = _listed(ctx)
    wrong = [n["note_id"] for n in letterless + unreadable if got[n["note_id"]]["body"] != n["text"]]
    assert not wrong, f"notes whose text came back different: {_sample(wrong)}"
    assert all(got[n["note_id"]]["title"] == n["title"] for n in unreadable)
