"""
Saving photos from an encrypted backup needs room for one decrypted photo on this computer, not all of them.

Each photo of an encrypted backup is decrypted to a temp copy on the computer's
own drive before it's saved, even to another drive. Those copies used to stay
until the backup was closed, so saving a whole library needed its size free on
the system drive as well as where it went, and when that ran out every photo
after counted as one failed photo instead of the save stopping and saying why.

Uses a really encrypted Backupgen backup (encrypted_backup.py): 12 photos.
"""

import errno
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent, HERE.parent.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from encrypted_backup import PASSWORD, make_encrypted_backup  # noqa: E402

import backup  # noqa: E402
import photos  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from save_files import NO_ROOM_TO_DECRYPT  # noqa: E402

UDID = "00008110-000A1B2C3D4E5F60"
PHOTOS = 12


@pytest.fixture
def opened(tmp_path):
    made = make_encrypted_backup(tmp_path / "made", UDID)
    manager = backup.BackupManager()
    assert manager.open_backup(UDID, password=PASSWORD, backup_dir=str(made))["status"] == "open"
    yield manager.get_open_backup(UDID)
    manager.close_backup(UDID)


def decrypted_photos(backup) -> list:
    return sorted(name for name in os.listdir(backup._temp_dir) if name.endswith(".HEIC"))


def test_a_save_keeps_one_decrypted_photo_at_a_time(opened, tmp_path, monkeypatch):
    most = []
    real_copy = photos.copy_new

    def copy_new(source, path):
        most.append(len(decrypted_photos(opened)))
        real_copy(source, path)

    monkeypatch.setattr(photos, "copy_new", copy_new)
    result = PhotoExtractor().export_photos(opened, str(tmp_path / "saved"))

    assert result["exported"] == PHOTOS and result["errors"] == 0
    assert len(os.listdir(tmp_path / "saved")) == PHOTOS
    assert max(most) == 1, f"decrypted copies in temp while saving: {most}"
    assert decrypted_photos(opened) == []


def test_a_photo_decrypted_before_the_save_is_left_for_whoever_has_it(opened, tmp_path):
    """A photo on screen or open in another app (get_file_for_app hands out the temp copy) stays."""
    extractor = PhotoExtractor()
    first = extractor.list_photos(opened, limit=1)["photos"][0]["file_hash"]
    shown = extractor._resolve_file(opened, first)

    result = extractor.export_photos(opened, str(tmp_path / "saved"))

    assert result["exported"] == PHOTOS
    assert os.path.isfile(shown)
    assert extractor._resolve_file(opened, first) == shown
    assert decrypted_photos(opened) == [os.path.basename(shown)]


def test_a_saved_photo_can_be_decrypted_again_afterwards(opened, tmp_path):
    extractor = PhotoExtractor()
    extractor.export_photos(opened, str(tmp_path / "saved"))
    first = extractor.list_photos(opened, limit=1)["photos"][0]["file_hash"]
    again = extractor._resolve_file(opened, first)
    assert again and os.path.isfile(again)


def test_no_room_to_decrypt_stops_the_save_once_and_says_so(opened, tmp_path, monkeypatch):
    decryptor = opened._decrypted_backup
    real_extract = decryptor.extract_file
    tries = []

    def extract_file(**kwargs):
        if "/DCIM/" not in kwargs["relative_path"]:  # Photos.sqlite and the like: there aren't any
            return real_extract(**kwargs)
        tries.append(kwargs["relative_path"])
        if len(tries) > 3:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_extract(**kwargs)

    monkeypatch.setattr(decryptor, "extract_file", extract_file)
    result = PhotoExtractor().export_photos(opened, str(tmp_path / "saved"))

    assert result == {"error": f"{NO_ROOM_TO_DECRYPT} The 3 photos saved before that are complete."}
    assert len(tries) <= 5, f"kept trying after the temp folder was full: {len(tries)} tries"
    assert len(os.listdir(tmp_path / "saved")) == 3



def test_a_photo_that_cant_be_saved_still_has_its_copy_dropped(opened, tmp_path, monkeypatch):
    def copy_new(source, path):
        raise OSError(errno.EIO, "Input/output error")

    monkeypatch.setattr(photos, "copy_new", copy_new)
    result = PhotoExtractor().export_photos(opened, str(tmp_path / "saved"))

    assert (result["exported"], result["errors"]) == (0, PHOTOS)
    assert decrypted_photos(opened) == []
