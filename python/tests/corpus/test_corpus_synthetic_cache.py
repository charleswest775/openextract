"""The generated-backup cache (corpus/synthetic.py): one folder per item and ios-backup-core version.

Two test runs with different ios-backup-core checkouts used to share ``<cache>/syn/<key>/``
and delete each other's backups mid-run whenever their generators differed. These tests use
a stand-in backupgen in a temporary checkout, so they need neither ios-backup-core nor the
network.
"""

import os
import plistlib
import re
import time
import types
from pathlib import Path

import pytest

from corpus import synthetic
from corpus.synthetic import SyntheticItem, ensure_generated

ITEM = SyntheticItem("syn-fake-ios26-plain", "fake", "ios26", None, ("pr",))
OTHER = SyntheticItem("syn-fake-ios17-encrypted", "fake", "ios17", "test", ("pr",))
RECENT = synthetic.KEEP_RECENT_SECONDS  # a version used this recently is never deleted
MINUTE = 60


class FakeCore:
    """A checkout with a backupgen/ the fingerprint hashes, and a generator that counts its runs."""

    def __init__(self, root: Path):
        self.root = root
        self.calls = []
        self.during = None  # called with the output folder in the middle of generating
        (root / "backupgen" / "personas" / "fake").mkdir(parents=True)
        (root / "backupgen" / "personas" / "fake" / "persona.json").write_text("{}")
        self.set_version("1")

    def set_version(self, version: str) -> None:
        (self.root / "backupgen" / "generate.py").write_text(f"VERSION = {version!r}\n")
        self.version = version

    def generate(self, persona, snapshot, out_dir, *, password=None):
        out_dir = Path(out_dir)
        self.calls.append(out_dir)
        backup = out_dir / "00008030-FAKE"
        backup.mkdir(parents=True)
        with open(backup / "Manifest.plist", "wb") as f:
            plistlib.dump({"IsEncrypted": password is not None}, f)
        (backup / "Manifest.db").write_text(f"version {self.version}")
        if self.during:
            self.during(out_dir)
        (out_dir / "expected.json").write_text('{"udid": "00008030-FAKE", "ios": "26.0", "product_type": "iPhone16,1"}')
        return backup


@pytest.fixture
def core(tmp_path, monkeypatch):
    fake = FakeCore(tmp_path / "ios-backup-core")
    monkeypatch.setenv("OPENEXTRACT_IOS_BACKUP_CORE", str(fake.root))
    monkeypatch.setenv("OPENEXTRACT_CORPUS_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(synthetic, "_import_backupgen", lambda: types.SimpleNamespace(generate=types.SimpleNamespace(generate=fake.generate)))
    monkeypatch.setattr(synthetic, "_fingerprints", {})
    monkeypatch.setattr(synthetic, "_imported", None)  # a corpus test earlier in this session may have imported the real one
    return fake


def syn_root(core) -> Path:
    return core.root.parent / "cache" / "syn"


def versions(core, key=ITEM.key) -> list[str]:
    return sorted(p.name for p in syn_root(core).iterdir() if p.name.startswith(f"{key}@"))


def age(path: Path, seconds: float) -> None:
    """Make a folder look generated (and last used) ``seconds`` ago."""
    when = time.time() - seconds
    os.utime(path, (when, when))


def test_each_engine_version_gets_its_own_folder(core):
    first = ensure_generated(ITEM)
    assert first is not None and (first / "Manifest.db").read_text() == "version 1"
    folder = first.parent
    assert re.fullmatch(rf"{ITEM.key}@[0-9a-f]{{12}}", folder.name)  # no ':', fine on Windows
    assert ITEM.item_dir() == folder and ITEM.backup_dir() == first and ITEM.expected()["udid"] == "00008030-FAKE"

    # Another checkout with a different generator, sharing the cache: its own folder; the first stays.
    core.set_version("2")
    second = ensure_generated(ITEM)
    assert second.parent != folder and (second / "Manifest.db").read_text() == "version 2"
    assert (first / "Manifest.db").read_text() == "version 1"
    assert ITEM.item_dir() == second.parent
    assert len(versions(core)) == 2

    # Back to the first: found again, not generated again.
    core.set_version("1")
    calls = len(core.calls)
    assert ensure_generated(ITEM) == first
    assert len(core.calls) == calls


def test_items_and_versions_dont_mix(core):
    a, b = ensure_generated(ITEM), ensure_generated(OTHER)
    assert a.parent != b.parent and a.parent.name.startswith(ITEM.key + "@") and b.parent.name.startswith(OTHER.key + "@")
    calls = len(core.calls)
    assert ensure_generated(ITEM) == a and ensure_generated(OTHER) == b
    assert len(core.calls) == calls


def test_generation_is_atomic(core):
    seen = {}

    def during(out_dir):
        # Half-way through, the item has no folder under its final name: other runs see nothing,
        # not half a backup.
        seen["out_dir"] = out_dir
        seen["final"] = ITEM.item_dir()
        seen["final_exists"] = ITEM.item_dir().exists()
        seen["backup_dir"] = ITEM.backup_dir()

    core.during = during
    backup = ensure_generated(ITEM)
    assert seen["final_exists"] is False and seen["backup_dir"] is None
    assert seen["out_dir"].parent == seen["final"].parent and seen["out_dir"].name.startswith(".")
    assert not seen["out_dir"].exists() and backup.parent == seen["final"]
    assert [p.name for p in syn_root(core).iterdir()] == [seen["final"].name]


def test_a_failed_generation_leaves_nothing_behind(core):
    old = ensure_generated(ITEM)
    core.set_version("2")

    def boom(out_dir):
        raise RuntimeError("generator crashed")

    core.during = boom
    with pytest.raises(RuntimeError):
        ensure_generated(ITEM)
    assert ITEM.backup_dir() is None and not ITEM.item_dir().exists()
    assert [p.name for p in syn_root(core).iterdir()] == [old.parent.name]  # no temporary folder left
    assert (old / "Manifest.db").read_text() == "version 1"


def test_a_run_that_finishes_the_same_version_first_wins(core):
    def other_run_finishes_first(out_dir):
        core.during = None
        ensure_generated(ITEM)  # the "other run", into the final folder

    core.during = other_run_finishes_first
    backup = ensure_generated(ITEM)
    assert len(core.calls) == 2 and backup == ITEM.backup_dir()
    assert [p.name for p in syn_root(core).iterdir()] == [backup.parent.name]


def test_a_broken_folder_under_the_versions_name_is_replaced(core):
    folder = ITEM.item_dir()
    folder.mkdir(parents=True)
    (folder / "junk.txt").write_text("left by hand")
    backup = ensure_generated(ITEM)
    assert backup.parent == folder and not (folder / "junk.txt").exists()
    assert [p.name for p in syn_root(core).iterdir()] == [folder.name]


def _make_versions(core, ages: list[float]) -> list[Path]:
    """Generate one version per age (in seconds, oldest last) and date each one."""
    folders = []
    for n, seconds in enumerate(ages):
        core.set_version(f"old-{n}")
        folders.append(ensure_generated(ITEM).parent)
    for folder, seconds in zip(folders, ages):
        age(folder, seconds)
    return folders


def test_pruning_keeps_the_newest_and_the_recently_used(core):
    folders = _make_versions(core, [10 * MINUTE, RECENT + 1 * MINUTE, RECENT + 2 * MINUTE, RECENT + 3 * MINUTE, 2 * RECENT])
    other = ensure_generated(OTHER).parent
    age(other, 2 * RECENT)
    leftover = syn_root(core) / f".{ITEM.key}@0123456789ab.abcd1234.tmp"  # from a killed run
    leftover.mkdir()
    age(leftover, RECENT + MINUTE)
    fresh_temp = syn_root(core) / f".{ITEM.key}@0123456789ab.efgh5678.tmp"  # a run generating now
    fresh_temp.mkdir()

    core.set_version("new")
    current = ensure_generated(ITEM).parent
    # Kept: the one just made, the next two most recently used (the newest three in all). Gone:
    # the ones not used within RECENT beyond those. Other items are left alone.
    assert {p.name for p in syn_root(core).iterdir() if not p.name.startswith(".")} == {
        current.name, folders[0].name, folders[1].name, other.name}
    assert not leftover.exists() and fresh_temp.exists()


def test_pruning_never_deletes_a_version_used_recently(core):
    # A run that started hours ago and still has its backups open.
    assert RECENT >= 24 * 3600
    folders = _make_versions(core, [5 * MINUTE, 2 * 3600, 5 * 3600, 12 * 3600, RECENT - 10 * MINUTE])
    core.set_version("new")
    ensure_generated(ITEM)
    assert len(versions(core)) == len(folders) + 1


def test_using_a_version_counts_as_recent(core):
    used, unused = _make_versions(core, [2 * RECENT, 2 * RECENT])
    core.set_version("old-0")  # a run with the first checkout: finds its version and marks it used
    assert ensure_generated(ITEM).parent == used
    assert time.time() - used.stat().st_mtime < 60

    # Three newer versions later neither is among the newest three, but one was used just now.
    for n in range(3):
        core.set_version(f"newer-{n}")
        ensure_generated(ITEM)
    assert used.exists() and not unused.exists()


def test_looking_a_version_up_counts_as_using_it(core):
    folder = ensure_generated(ITEM).parent
    for look_up in (ITEM.item_dir, ITEM.backup_dir, ITEM.expected, lambda: synthetic.mark_used(folder)):
        age(folder, 2 * RECENT)
        look_up()
        assert time.time() - folder.stat().st_mtime < 60, look_up
    synthetic.mark_used(folder.with_name("not-there"))  # no error
    synthetic.mark_used(None)


def test_a_version_moved_away_after_the_check_is_made_again(core, monkeypatch):
    # Another run's _prune takes the folder between this run's check and its return.
    real_prune = synthetic._prune

    def prune_and_lose_it(syn_root, key, current, **kw):
        real_prune(syn_root, key, current, **kw)
        synthetic._remove(current)

    ensure_generated(ITEM)
    calls = len(core.calls)
    monkeypatch.setattr(synthetic, "_prune", prune_and_lose_it)
    backup = ensure_generated(ITEM)
    assert backup is not None and backup == ITEM.backup_dir() and len(core.calls) == calls + 1


def test_a_broken_folder_another_run_replaced_first_is_used(core, monkeypatch):
    folder = ITEM.item_dir()
    folder.mkdir(parents=True)
    (folder / "junk.txt").write_text("left by hand")
    real_remove = synthetic._remove

    def other_run_replaces_it_first(path):
        real_remove(path)
        core.during = None
        monkeypatch.setattr(synthetic, "_remove", real_remove)
        ensure_generated(ITEM)  # the other run, which puts a complete one in place

    monkeypatch.setattr(synthetic, "_remove", other_run_replaces_it_first)
    backup = ensure_generated(ITEM)
    assert backup.parent == folder and not (folder / "junk.txt").exists()
    assert [p.name for p in syn_root(core).iterdir()] == [folder.name]


def test_a_broken_folder_that_cant_be_moved_says_so(core, monkeypatch):
    # On Windows a folder open in another program can't be renamed, and _remove leaves it.
    folder = ITEM.item_dir()
    folder.mkdir(parents=True)
    (folder / "junk.txt").write_text("left by hand")
    monkeypatch.setattr(synthetic, "_remove", lambda path: None)
    with pytest.raises(RuntimeError, match="couldn't be replaced"):
        ensure_generated(ITEM)
    assert (folder / "junk.txt").exists()
    assert [p.name for p in syn_root(core).iterdir()] == [folder.name]  # no temporary folder left


def test_backupgen_edited_during_a_run_isnt_filed_under_the_new_version(core, monkeypatch):
    # backupgen was imported (as version 1) and its code then edited: this process still runs
    # version 1, so it mustn't generate anything into version 2's folder.
    version_1 = (core.root.resolve(), synthetic._code_hash(core.root))
    monkeypatch.setattr(synthetic, "_imported", version_1)
    first = ensure_generated(ITEM)
    core.set_version("2")
    with pytest.raises(RuntimeError, match="changed while this run was going"):
        ensure_generated(OTHER)
    assert OTHER.backup_dir() is None and (first / "Manifest.db").read_text() == "version 1"

    # Another run, started after the edit, generates version 2: this one may use that.
    monkeypatch.setattr(synthetic, "_imported", None)
    made_by_the_other_run = ensure_generated(OTHER)
    monkeypatch.setattr(synthetic, "_imported", version_1)
    assert ensure_generated(OTHER) == made_by_the_other_run


def test_backupgen_from_another_checkout_isnt_used(core, monkeypatch, tmp_path):
    monkeypatch.setattr(synthetic, "_imported", (tmp_path / "elsewhere", "0" * 64))
    with pytest.raises(RuntimeError, match="imported from"):
        ensure_generated(ITEM)


def test_the_fingerprint_ignores_what_doesnt_shape_the_output(core):
    base = ITEM.item_dir()
    gen = core.root / "backupgen"

    def fingerprint():
        synthetic._fingerprints.clear()
        return synthetic.item_fingerprint(ITEM)

    before = fingerprint()
    (gen / ".DS_Store").write_bytes(b"finder")
    (gen / "personas" / "fake" / ".generate.py.swp").write_bytes(b"vim")
    (gen / "generate.py~").write_text("emacs")
    (gen / "__pycache__").mkdir()
    (gen / "__pycache__" / "generate.cpython-311.pyc").write_bytes(b"bytecode")
    (gen / ".git-ish").mkdir()
    (gen / ".git-ish" / "x.py").write_text("hidden")
    (gen / "personas" / "other").mkdir()
    (gen / "personas" / "other" / "persona.json").write_text("{}")  # another persona's pack
    assert fingerprint() == before and ITEM.item_dir() == base

    # Shared files directly in personas/, and shared folders there that aren't a persona, count.
    (gen / "personas" / "shared.json").write_text("{}")
    shared = fingerprint()
    assert shared != before
    (gen / "personas" / "_common").mkdir()
    (gen / "personas" / "_common" / "names.txt").write_text("Ada")
    assert fingerprint() != shared


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_generated_folders_follow_the_umask(core):
    old = os.umask(0o022)
    try:
        folder = ensure_generated(ITEM).parent
    finally:
        os.umask(old)
    assert folder.stat().st_mode & 0o777 == 0o755


def test_without_backupgen_nothing_is_found_or_generated(core, monkeypatch):
    ensure_generated(ITEM)
    monkeypatch.setenv("OPENEXTRACT_IOS_BACKUP_CORE", str(core.root.parent / "nowhere"))
    monkeypatch.setattr(synthetic, "backupgen_root", lambda: None)
    assert ensure_generated(ITEM) is None
    assert ITEM.item_dir() is None and ITEM.backup_dir() is None and ITEM.expected() is None
