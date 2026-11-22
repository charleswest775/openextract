"""
Messages and WhatsApp web-page saves when a file can't be read or written.

A full disk used to be swallowed: the save said it worked, left files cut short
under the photos' names, and called those photos "not in this backup", which
could get a backup deleted. What must hold:

  * no room (in the folder, or in the temp folder an encrypted backup is
    decrypted into) stops the save in plain words, taking back what it wrote;
  * one file's own problem (it can't be read, or named there) is counted and
    labelled, and the save goes on;
  * "not in this backup" is said only of a file the backup hasn't got, and a
    file's name is never given to part of it.
"""

import builtins
import errno
import io
import os
import sys
import threading

import pytest
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import OpenBackup  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from whatsapp import SHARED_DOMAIN, WhatsAppExtractor  # noqa: E402

NO_ROOM = "There isn't enough space to save here"
NO_ROOM_TO_DECRYPT = "There isn't enough space on this computer to decrypt"
NO_ROOM_FOR_PDF = "There isn't enough space on this computer to make the PDF"
NOT_HERE = "not in this backup"
MB = 1000 * 1000


class SmallDisk:
    """Writing under ``root`` runs out of room after ``room`` bytes, part of the way into a file, as a real disk does.

    ``when="close"``: the write is taken and fails as the file is closed, as on a network drive.
    ``text``: pages count too; otherwise only attachments do.
    """

    def __init__(self, monkeypatch, root, room, *, when="write", text=False, error=errno.ENOSPC):
        self.left = room
        self.error = error
        real_open = builtins.open
        root = os.path.normcase(os.path.abspath(str(root)))
        disk = self

        def open_(file, mode="r", *args, **kwargs):
            f = real_open(file, mode, *args, **kwargs)
            if isinstance(file, int) or not set(mode) & set("wxa"):
                return f
            if "b" not in mode and not text:
                return f
            if not os.path.normcase(os.path.abspath(os.fsdecode(file))).startswith(root):
                return f
            return _FullFile(f, disk, when)

        monkeypatch.setattr(builtins, "open", open_)

    def fail(self):
        raise OSError(self.error, os.strerror(self.error))


class _FullFile:
    def __init__(self, f, disk, when):
        self._f, self._disk, self._when = f, disk, when
        self._over = False

    def write(self, data):
        size = len(data) if isinstance(data, str) else memoryview(data).nbytes
        if size <= self._disk.left:
            self._disk.left -= size
            return self._f.write(data)
        fits, self._disk.left = self._disk.left, 0
        self._f.write(data[:fits])
        if self._when == "close":
            self._over = True
            return size
        self._disk.fail()

    def fileno(self):
        # So copies go through write(), not the system's own file copy
        raise io.UnsupportedOperation("fileno")

    def close(self):
        self._f.close()
        if self._over:
            self._over = False
            self._disk.fail()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __getattr__(self, name):
        return getattr(self._f, name)


class FakeBackup:
    def __init__(self):
        self.files: dict = {}
        self.broken: set = set()

    def get_file(self, relative_path, domain="HomeDomain"):
        if relative_path in self.broken:
            raise ValueError("damaged entry")
        return self.files.get((domain, relative_path))


class FakeDecryptor:
    """iphone-backup-decrypt's extract_file, over files that are already plain."""

    def __init__(self, files):
        self.files = files
        self.error = None

    def extract_file(self, *, relative_path, domain_like=None, output_filename):
        src = self.files.get((domain_like, relative_path))
        if not src:
            raise FileNotFoundError
        if self.error:
            raise self.error
        with open(src, "rb") as fin:
            data = fin.read()
        with open(output_filename, "wb") as fout:
            fout.write(data)


class Saver:
    """One source's saves, reading fake chats and a fake backup."""

    def __init__(self, source, tmp):
        self.source = source
        self.whatsapp = source == "whatsapp"
        self.domain = SHARED_DOMAIN if self.whatsapp else "MediaDomain"
        self.prefix = "wa" if self.whatsapp else ""
        self.noun = "chat" if self.whatsapp else "conversation"
        self.image_word = "Photo" if self.whatsapp else "Image"
        self.src, self.out = tmp / "backup", tmp / "out"
        self.src.mkdir()
        self.out.mkdir()
        self.backup = FakeBackup()
        self.chats: dict = {}
        self.last_id = 0
        if self.whatsapp:
            self.extractor = WhatsAppExtractor()
            self.extractor._inner = self
        else:
            self.extractor = MessageExtractor.__new__(MessageExtractor)
            self.extractor.get_messages = self.get_messages

    def get_messages(self, backup, chat_id, *args, **kwargs):
        messages = list(self.chats.get(chat_id, []))
        return {"messages": messages, "total": len(messages), "next_offset": len(messages)}

    def add(self, name, data=None, *, image=None, chat=1, in_backup=True, available=None, thumbnail=None):
        """A message with one attachment, its file in the fake backup unless not ``in_backup``."""
        self.last_id += 1
        folder = "Message/Media/x" if self.whatsapp else "Library/SMS/Attachments/ab"
        rel = f"{folder}/{name}"
        if in_backup:
            self.put(rel, data, image)
        att = {
            "attachment_id": self.last_id,
            "filename": rel if self.whatsapp else f"~/{rel}",
            "mime_type": "image/tiff" if name.endswith(".tiff") else "image/jpeg",
            "transfer_name": name,
            "thumbnail_path": thumbnail,
            "available": in_backup if available is None else available,
        }
        self.chats.setdefault(chat, []).append({
            "message_id": self.last_id, "date": f"2026-01-01T09:{self.last_id:02d}:00+00:00",
            "text": "", "sender": "Alice", "is_from_me": False, "has_attachments": True,
            "message_type": "image", "attachments": [att],
        })
        return att

    def put(self, rel, data=None, image=None):
        path = self.src / f"f{len(self.backup.files)}"
        if image:
            Image.new("RGB", (64, 48), (10, 120, 200)).save(path, image)
        else:
            path.write_bytes(os.urandom(64) if data is None else data)
        self.backup.files[(self.domain, rel)] = str(path)
        return path

    def save(self, fmt="html", chat=1, out=None):
        return self.extractor.export_conversation(self.backup, chat, {}, fmt, str(out or self.out),
                                                  display_name="Mom")

    def save_all(self, mode="separate", fmt="html"):
        names = {c: f"Person {c}" for c in self.chats}
        return self.extractor.export_conversations(self.backup, sorted(self.chats), names, {}, fmt, str(self.out),
                                                   mode=mode)

    def saved(self):
        """{name: bytes} of every file in the folder saved into, however deep."""
        return {p.name: p.read_bytes() for p in self.out.rglob("*") if p.is_file()}

    def pages(self):
        return "".join(p.read_text(encoding="utf-8") for p in sorted(self.out.rglob("*.html")))

    def encrypt(self, monkeypatch, tmp):
        temp = tmp / "temp"
        temp.mkdir()
        decryptor = FakeDecryptor(self.backup.files)
        self.backup = OpenBackup(str(self.src), "UDID", {}, True, decryptor)
        self.backup.cleanup()
        monkeypatch.setattr(self.backup, "_temp_dir", str(temp))
        return decryptor


@pytest.fixture(params=["messages", "whatsapp"])
def saver(request, tmp_path):
    return Saver(request.param, tmp_path)


def stops(words, do):
    with pytest.raises(Exception) as caught:
        do()
    assert words in str(caught.value)
    assert "Errno" not in str(caught.value)
    return str(caught.value)


# ── No room where it's being saved ────────────────────────────────────────────

@pytest.mark.parametrize("when", ["write", "close"])
def test_four_photos_and_room_for_two_and_a_bit_stops_the_save(saver, monkeypatch, when):
    for n in range(4):
        saver.add(f"IMG_{n}.jpg", os.urandom(MB))
    SmallDisk(monkeypatch, saver.out, int(2.7 * MB), when=when)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_the_last_file_not_fitting_stops_the_save(saver, monkeypatch):
    saver.add("small.jpg", os.urandom(1000))
    saver.add("big.jpg", os.urandom(MB))
    SmallDisk(monkeypatch, saver.out, 2000)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_no_room_for_the_page_stops_the_save_in_plain_words(saver, monkeypatch):
    saver.add("IMG_1.jpg")
    SmallDisk(monkeypatch, saver.out, 500, text=True)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_no_room_for_the_folder_of_files_stops_the_save(saver, monkeypatch):
    saver.add("IMG_1.jpg")
    real = os.makedirs

    def makedirs(path, *args, **kwargs):
        if str(path).endswith("_attachments"):
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC), path)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(os, "makedirs", makedirs)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_no_room_for_a_preview_jpeg_stops_the_save(saver, monkeypatch):
    saver.add("scan.tiff", image="TIFF")
    original = next(saver.src.iterdir()).stat().st_size
    SmallDisk(monkeypatch, saver.out, original + 10)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_no_room_for_a_whatsapp_thumbnail_stops_the_save(tmp_path, monkeypatch):
    saver = Saver("whatsapp", tmp_path)
    saver.put("Message/Media/x/gone.thumb", os.urandom(5000))
    saver.add("gone.jpg", in_backup=False, thumbnail="Message/Media/x/gone.thumb")
    SmallDisk(monkeypatch, saver.out, 100)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_no_room_for_a_whatsapp_map_stops_the_save(tmp_path, monkeypatch):
    saver = Saver("whatsapp", tmp_path)
    saver.put("Message/Media/x/map.thumb", os.urandom(5000))
    saver.chats[1] = [{"message_id": 1, "date": "2026-01-01T09:00:00+00:00", "message_type": "shared_location",
                       "location": {"attachment_id": 1, "thumbnail_path": "Message/Media/x/map.thumb"}}]
    SmallDisk(monkeypatch, saver.out, 100)
    stops(NO_ROOM, saver.save)
    assert list(saver.out.iterdir()) == []


def test_save_all_stops_and_says_the_ones_before_are_complete(saver, monkeypatch):
    for chat in (1, 2, 3):
        saver.add(f"IMG_{chat}.jpg", os.urandom(MB), chat=chat)
    SmallDisk(monkeypatch, saver.out, int(2.5 * MB))
    said = stops(NO_ROOM, saver.save_all)
    assert f"The 2 {saver.noun}s saved before that are complete." in said
    saved = saver.saved()
    assert sorted(len(data) for name, data in saved.items() if not name.endswith(".html")) == [MB, MB]
    assert len([name for name in saved if name.endswith(".html")]) == 2


def test_save_all_in_one_page_stops(saver, monkeypatch):
    for chat in (1, 2):
        saver.add(f"IMG_{chat}.jpg", os.urandom(MB), chat=chat)
    SmallDisk(monkeypatch, saver.out, int(1.5 * MB))
    assert "saved before that" not in stops(NO_ROOM, lambda: saver.save_all("merged"))
    assert list(saver.out.iterdir()) == []


def test_stopping_takes_back_only_what_this_save_wrote(saver, monkeypatch):
    saver.add("IMG_1.jpg", os.urandom(MB))
    saver.add("IMG_2.jpg", os.urandom(MB))
    page = saver.save()["file"]
    os.remove(page)  # moved away, say: its folder of files stays
    folder = os.path.splitext(page)[0] + "_attachments"
    with open(os.path.join(folder, "mine.txt"), "w") as f:
        f.write("mine")
    before = saver.saved()
    saver.add("IMG_3.jpg", os.urandom(MB))
    saver.chats[1][-1]["date"] = saver.chats[1][0]["date"]  # so the page gets the same name
    SmallDisk(monkeypatch, saver.out, 1000)
    stops(NO_ROOM, saver.save)
    assert saver.saved() == before


def test_a_folder_that_cant_be_saved_in_says_so(saver, monkeypatch):
    saver.add("IMG_1.jpg")
    SmallDisk(monkeypatch, saver.out, 0, text=True, error=errno.EACCES)
    stops("OpenExtract can't save in that folder", saver.save)


def test_no_room_to_make_a_pdf_stops_it(saver, monkeypatch):
    saver.add("IMG_1.jpg", image="JPEG")
    SmallDisk(monkeypatch, saver.out, 50)
    stops(NO_ROOM_FOR_PDF, lambda: saver.save("pdf_source"))


# ── No room to decrypt ────────────────────────────────────────────────────────

@pytest.mark.parametrize("fmt", ["html", "pdf_source"])
def test_no_room_to_decrypt_stops_the_save(saver, monkeypatch, tmp_path, fmt):
    saver.add("IMG_1.jpg", image="JPEG")
    saver.encrypt(monkeypatch, tmp_path).error = OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))
    stops(NO_ROOM_TO_DECRYPT, lambda: saver.save(fmt))
    assert list(saver.out.iterdir()) == []


def test_once_there_is_room_to_decrypt_the_same_session_saves_the_file(saver, monkeypatch, tmp_path):
    saver.add("IMG_1.jpg", b"the photo")
    decryptor = saver.encrypt(monkeypatch, tmp_path)
    decryptor.error = OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))
    stops(NO_ROOM_TO_DECRYPT, saver.save)
    decryptor.error = None
    # get_file remembers that it found nothing, until the backup is opened again
    assert saver.save()["failed_files"] == 0
    assert saver.saved()[f"{saver.prefix}1-IMG_1.jpg"] == b"the photo"


def test_a_file_that_cant_be_decrypted_is_counted_and_the_save_goes_on(saver, monkeypatch, tmp_path):
    saver.add("IMG_1.jpg")
    saver.encrypt(monkeypatch, tmp_path).error = ValueError("Invalid CBC padding on decrypted data!")
    assert saver.save()["failed_files"] == 1
    assert f"{saver.image_word} couldn&#x27;t be read: IMG_1.jpg" in saver.pages()
    assert NOT_HERE not in saver.pages()


# ── One file's own problem ────────────────────────────────────────────────────

def test_a_file_that_fails_part_way_through_reading_is_counted_and_leaves_nothing(saver, monkeypatch):
    saver.add("bad.jpg", os.urandom(3 * MB))
    saver.add("good.jpg", b"good")
    bad = saver.backup.files[(saver.domain, saver.chats[1][0]["attachments"][0]["filename"].replace("~/", ""))]
    real_open = builtins.open

    class FailsHalfway(io.BytesIO):
        def read(self, *args):
            if self.tell():
                raise OSError(errno.EIO, os.strerror(errno.EIO), bad)
            return super().read(MB)

        def readinto(self, into):
            data = self.read()
            into[:len(data)] = data
            return len(data)

    def open_(file, mode="r", *args, **kwargs):
        if file == bad and mode == "rb":
            with real_open(file, mode) as f:
                return FailsHalfway(f.read())
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", open_)
    assert saver.save()["failed_files"] == 1
    saved = saver.saved()
    assert [n for n in saved if not n.endswith(".html")] == [f"{saver.prefix}2-good.jpg"]
    assert f"{saver.image_word} couldn&#x27;t be read: bad.jpg" in saver.pages()
    assert NOT_HERE not in saver.pages()


@pytest.mark.skipif(os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0), reason="needs file modes")
def test_a_file_that_may_not_be_read_is_counted(saver):
    saver.add("locked.jpg")
    path = next(saver.src.iterdir())
    path.chmod(0)
    try:
        assert saver.save()["failed_files"] == 1
    finally:
        path.chmod(0o600)
    assert f"{saver.image_word} couldn&#x27;t be read: locked.jpg" in saver.pages()


@pytest.mark.skipif(os.name != "nt", reason="Windows' file locks")
def test_a_file_another_program_has_locked_is_counted(saver):
    import msvcrt

    saver.add("locked.jpg", os.urandom(5000))
    with open(next(saver.src.iterdir()), "r+b") as held:
        msvcrt.locking(held.fileno(), msvcrt.LK_NBLCK, 5000)
        try:
            assert saver.save()["failed_files"] == 1
        finally:
            held.seek(0)
            msvcrt.locking(held.fileno(), msvcrt.LK_UNLCK, 5000)
    assert f"{saver.image_word} couldn&#x27;t be read: locked.jpg" in saver.pages()


def test_a_listed_file_that_cant_be_had_is_never_called_not_in_the_backup(saver):
    saver.add("listed.jpg", in_backup=False, available=True)
    assert saver.save()["failed_files"] == 1
    assert f"{saver.image_word} couldn&#x27;t be read: listed.jpg" in saver.pages()
    assert NOT_HERE not in saver.pages()


def test_an_entry_that_raises_costs_one_file(saver):
    att = saver.add("damaged.jpg")
    saver.add("good.jpg")
    saver.backup.broken.add(att["filename"].replace("~/", ""))
    assert saver.save()["failed_files"] == 1
    assert f"{saver.prefix}2-good.jpg" in saver.saved()
    assert NOT_HERE not in saver.pages()


def test_a_file_the_backup_hasnt_got_is_still_called_that(saver):
    saver.add("gone.jpg", in_backup=False)
    assert saver.save()["failed_files"] == 0
    assert f"{saver.image_word} {NOT_HERE}: gone.jpg" in saver.pages()


@pytest.mark.parametrize("code", [errno.ENAMETOOLONG, errno.EINVAL, errno.ENOENT, errno.EACCES])
def test_a_file_that_cant_have_its_name_there_is_counted_and_the_save_goes_on(saver, monkeypatch, code):
    saver.add("odd.jpg")
    saver.add("good.jpg")
    real = os.replace

    def replace(src, dest):
        if str(dest).endswith("odd.jpg"):
            raise OSError(code, os.strerror(code), src, None, dest)
        return real(src, dest)

    monkeypatch.setattr(os, "replace", replace)
    assert saver.save()["failed_files"] == 1
    saved = saver.saved()
    assert [n for n in saved if not n.endswith(".html")] == [f"{saver.prefix}2-good.jpg"]
    assert f"{saver.image_word} couldn&#x27;t be saved: odd.jpg" in saver.pages()
    assert NOT_HERE not in saver.pages()


def test_a_file_too_big_for_that_drive_is_counted_and_the_save_goes_on(saver, monkeypatch):
    saver.add("small.jpg", b"small")
    saver.add("huge.jpg", os.urandom(5000))
    SmallDisk(monkeypatch, saver.out, 1000, error=errno.EFBIG)
    assert saver.save()["failed_files"] == 1
    assert f"{saver.image_word} couldn&#x27;t be saved: huge.jpg" in saver.pages()
    assert [n for n in saver.saved() if not n.endswith(".html")] == [f"{saver.prefix}1-small.jpg"]


@pytest.mark.skipif(os.name != "nt", reason="Windows' limit on a path's length")
def test_a_path_too_long_for_windows_costs_that_file_at_most(saver, tmp_path):
    out = tmp_path / ("d" * max(1, 175 - len(str(tmp_path))))
    out.mkdir()
    saver.out = out
    saver.add("n" * 90 + ".jpg")
    saver.add("good.jpg")
    failed = saver.save()["failed_files"]
    assert failed in (0, 1)  # 0 where long paths are turned on
    assert f"{saver.prefix}2-good.jpg" in saver.saved()
    assert len([n for n in saver.saved() if not n.endswith(".html")]) == 2 - failed
    assert NOT_HERE not in saver.pages()


@pytest.mark.skipif(os.name != "nt", reason="Windows' sharing rules")
def test_a_file_held_open_for_a_moment_still_gets_its_name(saver, monkeypatch):
    saver.add("IMG_1.jpg", b"the photo")
    real = os.replace
    held = []

    def replace(src, dest):
        if not held:  # as a virus scanner or OneDrive does with a file just written
            held.append(open(src, "rb"))
            threading.Timer(0.15, held[0].close).start()
        return real(src, dest)

    monkeypatch.setattr(os, "replace", replace)
    assert saver.save()["failed_files"] == 0
    assert saver.saved()[f"{saver.prefix}1-IMG_1.jpg"] == b"the photo"


def test_failures_add_up_over_save_all(saver):
    for chat in (1, 2):
        saver.add(f"listed{chat}.jpg", chat=chat, in_backup=False, available=True)
    assert saver.save_all()["failed_files"] == 2
    assert saver.save_all("merged")["failed_files"] == 2


def test_a_picture_the_pdf_cant_draw_is_not_called_missing(saver):
    saver.add("broken.jpg", b"not a picture")
    saver.save("pdf_source")
    assert f"{saver.image_word} couldn&#x27;t be read: broken.jpg" in saver.pages()
    assert NOT_HERE not in saver.pages()
