"""Voice Memos invariants for every backup in the corpus.

What the engine's Voice Memos methods return, checked against the Voice Memos
database read directly (``raw_backup.RawBackup``, not ios-backup-core): which
state the library is in (not in the backup, in it with no recordings, or
read), every recording row listed once, and every audio file the backup holds
beside the database claimed by a recording, so none is silently left out.

None of the public backups has a recording: Hickman's iOS 13 phones have the
database with no rows (both CloudRecordings.db and the older Recordings.db),
the later ones only empty folders. HICKMAN pins those states; the row and file
checks run on the generated backups and on any future item that has
recordings.

Failure messages name ids and counts only, never titles or file names from a backup.
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.corpus

SHARED_DOMAIN = "AppDomainGroup-group.com.apple.VoiceMemos.shared"
AUDIO = (".m4a", ".qta", ".qt")
NOTHING_TO_SAVE = "There are no voice memos in this backup to save."

# What list_voice_memos says on the public backups (maps/research-voicememos.md §6).
HICKMAN = {
    "pub-hickman-13.3.1": "no_records",
    "pub-hickman-13.4.1": "no_records",
    "pub-hickman-15.3.1": "not_in_backup",
    "pub-hickman-16.1.2": "not_in_backup",
    "pub-hickman-17.3": "not_in_backup",
}


def _sample(values, limit=5):
    values = list(values)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


def _files_under(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file())


def _databases(raw, name: str) -> list:
    """(domain, path) of each copy of ``name`` in the backup, the way the library ranks them."""
    found = [(d, p) for d, p in raw.find_files(f"%{name}") if p.rsplit("/", 1)[-1] == name and ".composition/" not in p]
    return sorted(found, key=lambda f: ("voicememos.shared" not in f[0].lower(), f[0] != "MediaDomain", f))


def _rows(raw, where, table) -> list:
    conn = raw.connect(*where)
    if conn is None:
        return []
    try:
        if table not in raw.tables(conn):
            return []
        return [r[0] for r in conn.execute(f"SELECT Z_PK FROM {table}")]
    finally:
        conn.close()


class RawLibrary:
    """Which database the library should read, and its rows."""

    def __init__(self, ctx):
        ctx.require_open()
        raw = ctx.raw
        cloud, legacy = _databases(raw, "CloudRecordings.db"), _databases(raw, "Recordings.db")
        self.source, self.ids = None, []
        if cloud:
            self.source, self.ids = cloud[0], _rows(raw, cloud[0], "ZCLOUDRECORDING")
            folder = cloud[0][1].rsplit("/", 1)[0]
            beside = (cloud[0][0], f"{folder}/Recordings.db")
            if not self.ids and raw.has_file(*beside) and _rows(raw, beside, "ZRECORDING"):
                self.source, self.ids = beside, _rows(raw, beside, "ZRECORDING")
        elif legacy:
            self.source, self.ids = legacy[0], _rows(raw, legacy[0], "ZRECORDING")
        self.audio = []
        if self.source:
            domain, path = self.source
            folder = path.rsplit("/", 1)[0] if "/" in path else ""
            prefix = f"{folder}/" if folder else ""
            for d, p in raw.find_files(f"{prefix}%", domain):
                rest = p[len(prefix):]
                if "/" not in rest and rest.lower().endswith(AUDIO):
                    self.audio.append(rest)


def test_state_of_the_library(ctx, tmp_path):
    """Not in the backup, in it with nothing, or read: the same on the screen, in the counts and on save."""
    ctx.require_open()
    library = RawLibrary(ctx)
    result = ctx.voice_memos_result
    if library.source is None:
        want = "not_in_backup"
    elif not library.ids:
        want = "no_records"
    else:
        want = "ok"
    pinned = HICKMAN.get(ctx.item.key)
    if pinned:
        assert want == pinned, f"the raw library reads as {want}, the research found {pinned}"
    o = ctx.stats.get("overview", {})
    if want == "ok":
        assert "error" not in result and result.get("voice_memos"), sorted(result)
        assert o.get("voice_memos_status") == "ok"
        return
    assert result == {"voice_memos": [], "empty_reason": want}, sorted(result)
    counts = (o.get("total_voice_memos"), o.get("total_voice_memo_seconds"), o.get("total_deleted_voice_memos"),
              o.get("voice_memos_status"))
    assert counts == (0, 0, 0, want), counts
    assert ctx.rpc("get_voice_memo_audio", memo_id=1) == {"error": "Recording not found."}
    for fmt in ("recordings", "csv"):
        out = tmp_path / fmt
        out.mkdir()
        saved = ctx.rpc("export_voice_memos", output_dir=str(out), format=fmt)
        assert saved == {"error": NOTHING_TO_SAVE, "empty_reason": want}, sorted(saved)
        assert _files_under(out) == [], f"{fmt}: wrote {len(_files_under(out))} files for a library with no recordings"


def test_every_recording_listed_once(ctx):
    library = RawLibrary(ctx)
    if not library.ids:
        pytest.skip("no recordings in this backup")
    memos = ctx.voice_memos_result.get("voice_memos", [])
    ids = [m["id"] for m in memos]
    assert len(ids) == len(set(ids)), f"{len(ids) - len(set(ids))} recordings listed twice"
    assert set(ids) == set(library.ids), (
        f"missing recordings {_sample(sorted(set(library.ids) - set(ids)))}, "
        f"unexpected {_sample(sorted(set(ids) - set(library.ids)))}"
    )
    source = Path(library.source[1]).name
    assert {m["source"] for m in memos} == {source}, "a list mixes databases"
    dates = [m["date"] for m in memos if m["date"]]
    assert dates == sorted(dates, reverse=True), "recordings aren't newest first"


def test_no_audio_file_is_left_out(ctx):
    """Every recording file beside the database belongs to a listed recording (vacuous on the public backups)."""
    library = RawLibrary(ctx)
    if not library.audio:
        pytest.skip("no recordings' files in this backup")
    claimed = {m["file_name"] for m in ctx.voice_memos_result.get("voice_memos", []) if m.get("audio_available")}
    unclaimed = sorted(set(library.audio) - claimed)
    assert not unclaimed, f"{len(unclaimed)} of {len(library.audio)} audio files belong to no listed recording"
    listed_missing = [m["id"] for m in ctx.voice_memos_result.get("voice_memos", [])
                      if m.get("audio_available") and m["file_name"] not in library.audio]
    assert not listed_missing, f"recordings said to have audio the backup doesn't list: {_sample(listed_missing)}"
