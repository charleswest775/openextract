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
HOUR = 3600


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
    folders = _make_versions(core, [10 * 60, 2 * HOUR, 3 * HOUR, 5 * HOUR, 30 * HOUR])
    other = ensure_generated(OTHER).parent
    age(other, 30 * HOUR)
    leftover = syn_root(core) / f".{ITEM.key}@0123456789ab.abcd1234.tmp"  # from a killed run
    leftover.mkdir()
    age(leftover, 2 * HOUR)
    fresh_temp = syn_root(core) / f".{ITEM.key}@0123456789ab.efgh5678.tmp"  # a run generating now
    fresh_temp.mkdir()

    core.set_version("new")
    current = ensure_generated(ITEM).parent
    # Kept: the one just made, the next two most recently used (10 minutes, 2 hours: the newest
    # three in all). Gone: the ones over an hour old beyond those. Other items are left alone.
    assert {p.name for p in syn_root(core).iterdir() if not p.name.startswith(".")} == {
        current.name, folders[0].name, folders[1].name, other.name}
    assert not leftover.exists() and fresh_temp.exists()


def test_pruning_never_deletes_a_version_used_in_the_last_hour(core):
    folders = _make_versions(core, [5 * 60, 10 * 60, 20 * 60, 40 * 60, 59 * 60])
    core.set_version("new")
    ensure_generated(ITEM)
    assert len(versions(core)) == len(folders) + 1


def test_using_a_version_counts_as_recent(core):
    used, unused = _make_versions(core, [5 * HOUR, 5 * HOUR])
    core.set_version("old-0")  # a run with the first checkout: finds its version and marks it used
    assert ensure_generated(ITEM).parent == used
    assert time.time() - used.stat().st_mtime < 60

    # Three newer versions later neither is among the newest three, but one was used just now.
    for n in range(3):
        core.set_version(f"newer-{n}")
        ensure_generated(ITEM)
    assert used.exists() and not unused.exists()


def test_without_backupgen_nothing_is_found_or_generated(core, monkeypatch):
    ensure_generated(ITEM)
    monkeypatch.setenv("OPENEXTRACT_IOS_BACKUP_CORE", str(core.root.parent / "nowhere"))
    monkeypatch.setattr(synthetic, "backupgen_root", lambda: None)
    assert ensure_generated(ITEM) is None
    assert ITEM.item_dir() is None and ITEM.backup_dir() is None and ITEM.expected() is None
