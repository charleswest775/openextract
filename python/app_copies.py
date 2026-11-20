"""
Copies of a backup's files, made for another app to open.

A backup keeps each file under a hash, with no extension. A computer goes by
a file's name to pick the app that opens it, so it can't open a file where it
lies in the backup. From a backup on an exFAT, NTFS or network drive, which
marks every file executable, macOS does worse: it runs the file, and clicking
a video opened Terminal (issue #297).

So nothing is opened in place. The file is copied to the system's temp folder
under its own name, without its permissions, and the copy is what another app
opens. Messages' and WhatsApp's attachments (messages.py, whatsapp.py) and the
Photos screen's videos (photos.py) all come through here.

A long session that opens or plays many videos would fill the temp folder's
disk, so each part of the app keeps its copies to BUDGET_BYTES: past that, the
copies handed out longest ago are removed (see AppCopies).
"""

import atexit
import errno
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import uuid
from collections import OrderedDict
from typing import Callable, Iterable, Optional

from messages import _FILE_NAME_UNSAFE, _WINDOWS_DEVICE_NAMES, _without_lone_surrogates

# Copies live in one folder per engine and part of the app, under the system's
# temp folder, named "openextract-<part>-<engine's process id>-<random>". The
# app stops the engine by killing it, so an engine rarely cleans up after
# itself: the next one removes the folders of engines that have ended as it
# starts. A folder whose process id is in use (a second OpenExtract, or a new
# process given the same id) is removed only once it hasn't been touched for
# STALE_SECONDS; an engine touches its own on every copy. Electron's PDF
# staging folders use the same hour.
STALE_SECONDS = 3600

# Copies another app may open (``openable``), by extension, which is what
# Windows and macOS go by when they open a file: photos, videos, audio and
# documents, which a viewer opens without running anything. Everything else (a
# program, script, shortcut, archive, web page, contact or calendar file, or a
# name with no extension) is still copied, but only to show in its folder. The
# name comes from the backup, and a WhatsApp document's from whoever sent it:
# "Invoice.pdf.exe" opened from here would run, and Windows wouldn't warn,
# since the copy didn't come from the internet.
OPENABLE_EXTENSIONS = frozenset({
    # photos
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff",
    # video
    "mp4", "mov", "m4v", "3gp", "avi", "mkv", "webm",
    # audio
    "opus", "ogg", "oga", "mp3", "m4a", "aac", "wav", "amr", "caf", "flac",
    # documents
    "pdf", "txt", "rtf", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "odp", "pages", "numbers", "key", "epub",
})

# Longest copy name, before its extension: 80 characters keeps a Windows path
# well inside 260, and 200 bytes keeps the name, its extension and the
# ".<8 hex>.partial" of a copy in progress inside the 255 bytes Linux allows
# (a title in Chinese or emoji takes 3 or 4 bytes a character).
STEM_CHARS = 80
STEM_BYTES = 200
EXT_BYTES = 16

# A copy that reports its progress is read and written this much at a time.
_CHUNK_BYTES = 8 * 1024 * 1024

# Room a copy must leave on the temp folder's disk, which is usually the
# system's: a long video mustn't fill it to the last byte. A small file only
# has to leave as much again as its own size, so a nearly full disk can still
# open a document.
_SPARE_BYTES = 200 * 1024 * 1024

# Most bytes one part of the app keeps in copies while the engine runs. Past
# this, the copies handed out longest ago are removed until the rest fits (see
# AppCopies._make_room): opening or playing a video again copies it again.
BUDGET_BYTES = 2 * 1024 ** 3

# A copy handed out this recently is never removed to make room, even past the
# budget: it may be playing in the app, which reads it as it plays, or be open
# in another app.
IN_USE_SECONDS = 10 * 60

# on_progress(bytes copied so far, bytes in all)
ProgressCallback = Callable[[int, int], None]


class NotEnoughSpace(OSError):
    """The temp folder's disk has no room for the copy: ``needed`` and ``free`` are bytes."""

    def __init__(self, needed: int, free: int):
        super().__init__(errno.ENOSPC, f"the copy needs {needed} bytes and {free} are free")
        self.needed = needed
        self.free = free


def temp_prefix(label: str) -> str:
    """What the names of one part of the app's copy folders start with: "openextract-whatsapp-"."""
    return f"openextract-{label}-"


def openable_extension(ext: str) -> bool:
    """Whether ".pdf" (say) is a photo, video, audio file or document's extension (see OPENABLE_EXTENSIONS)."""
    return ext.lower().lstrip(".") in OPENABLE_EXTENSIONS


def is_openable(file_name: str) -> bool:
    return openable_extension(os.path.splitext(file_name)[1])


def visible(text: str) -> str:
    """``text`` without invisible format characters.

    Direction marks can make "Invoice<RLO>fdp.exe" read as "Invoiceexe.pdf";
    zero-width spaces and joiners hide inside a name. Unicode calls all of
    them "format" characters (Cf), which covers messages.py's
    _FILE_NAME_UNSAFE marks and more; line and paragraph separators go too.
    """
    return "".join(ch for ch in text if unicodedata.category(ch) not in ("Cf", "Zl", "Zp"))


def cut_utf8(text: str, max_bytes: int) -> str:
    """The longest start of ``text`` that is at most ``max_bytes`` in UTF-8, never half a character."""
    return text.encode("utf-8")[:max_bytes].decode("utf-8", "ignore")


def split_name(name: str) -> tuple:
    """A file's own name as (stem, extension): no folders, nothing invisible, nothing a file name can't hold."""
    name = visible(_without_lone_surrogates(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(f"(?:{_FILE_NAME_UNSAFE})+", "_", name).strip(" .")
    return os.path.splitext(name)


def join_name(stem: str, ext: str, default_stem: str) -> str:
    """A file name every system accepts, from split_name's parts; ``default_stem`` when nothing is left of the stem."""
    stem = cut_utf8(stem[:STEM_CHARS], STEM_BYTES).strip(" .") or default_stem
    if stem.split(".")[0].rstrip().upper() in _WINDOWS_DEVICE_NAMES:
        stem = f"_{stem}"
    return stem + cut_utf8(ext, EXT_BYTES)


def safe_part(value) -> str:
    """``value`` (a backup's UDID, a file's id) as a folder name."""
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_") or "backup"


def same_file(src: str, dest: str) -> bool:
    """``dest`` is already a copy of ``src``: replace_with_copy gives it the same size and modification time.

    On a disk that keeps coarser times the copy is just made again.
    """
    try:
        a, b = os.stat(src), os.stat(dest)
    except OSError:
        return False
    return a.st_size == b.st_size and a.st_mtime_ns == b.st_mtime_ns


def _copy_reporting(src: str, dest: str, on_progress: ProgressCallback) -> None:
    total = os.path.getsize(src)
    done = 0
    with open(src, "rb") as fin, open(dest, "wb") as fout:
        while True:
            chunk = fin.read(_CHUNK_BYTES)
            if not chunk:
                break
            fout.write(chunk)
            done += len(chunk)
            on_progress(done, total)


def replace_with_copy(src: str, dest: str, on_progress: Optional[ProgressCallback] = None) -> None:
    """Copy ``src`` to ``dest`` whole: never a half-written file under the real name.

    The bytes and the modification time only (for same_file). Not the
    permissions: a backup on an exFAT or NTFS drive marks every file
    executable, and macOS runs an executable file it is asked to open. The
    copy is readable by its owner only, where the system has such
    permissions (Windows' chmod only sets read-only, which would stop the
    copy being replaced or removed).

    ``on_progress`` is for a file big enough to take a while (a long video
    from a slow drive): it is called as the copy goes.
    """
    partial = f"{dest}.{uuid.uuid4().hex[:8]}.partial"
    try:
        if on_progress is None:
            shutil.copyfile(src, partial)
        else:
            _copy_reporting(src, partial, on_progress)
        stat = os.stat(src)
        os.utime(partial, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        if os.name != "nt":
            os.chmod(partial, 0o600)
        os.replace(partial, dest)
    finally:
        if os.path.exists(partial):
            try:
                os.remove(partial)
            except OSError:
                pass


def _check_space(folder: str, src: str) -> None:
    """Raise NotEnoughSpace unless ``folder``'s disk has room for a copy of ``src`` (see _SPARE_BYTES)."""
    size = os.path.getsize(src)
    try:
        free = shutil.disk_usage(folder).free
    except OSError:
        return  # can't tell: the copy itself says if it doesn't fit
    if free < size + min(size, _SPARE_BYTES):
        raise NotEnoughSpace(size, free)


def _now() -> float:
    """The clock copies are timed by (a test sets it)."""
    return time.monotonic()


def _size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _remove_dir(get_path) -> None:
    path = get_path()
    if path:
        shutil.rmtree(path, ignore_errors=True)


def process_running(pid: int) -> bool:
    """Whether a process with this id is running; True when that can't be told (the age rule then decides)."""
    if pid == os.getpid():
        return True
    if pid <= 0 or pid > 0xFFFFFFFF:
        return False  # no engine has such an id (and os.kill(0, ...) would mean this process group)
    if os.name == "nt":
        # Never os.kill here: on Windows it ends the process whatever the signal.
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: no such process
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)  # signal 0 only asks whether the process is there
    except ProcessLookupError:
        return False
    except OSError:
        return True  # there, but another user's (PermissionError), or can't tell
    return True


def remove_stale_temp_dirs(prefix: str) -> None:
    """Remove the copy folders named ``prefix``… that engines which have ended left behind (see STALE_SECONDS).

    One look at the temp folder. Only this app's own folders are touched, and
    a link is never followed.
    """
    root = tempfile.gettempdir()
    cutoff = time.time() - STALE_SECONDS
    owner_id = re.compile(re.escape(prefix) + r"(\d+)-")
    try:
        with os.scandir(root) as it:
            entries = [e for e in it if e.name.startswith(prefix)]
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            owner = owner_id.match(entry.name)
            ended = owner is not None and not process_running(int(owner.group(1)))
            if ended or entry.stat(follow_symlinks=False).st_mtime < cutoff:
                shutil.rmtree(entry.path, ignore_errors=True)
        except OSError:
            pass


class AppCopies:
    """One part of the app's copies ("whatsapp", "photos"), in this engine's folder for them.

    The copies are kept to BUDGET_BYTES. The engine remembers when it last
    handed out each copy (not the file's modification time, which same_file
    reads to know a copy), and past the budget it removes the copies handed
    out longest ago, never one handed out in the last IN_USE_SECONDS.
    """

    def __init__(self, label: str):
        self.label = label
        self.prefix = temp_prefix(label)
        self.folder: Optional[str] = None
        # Each copy this engine has handed out, the one handed out longest ago
        # first: path -> (when it was last handed out, by _now(); its bytes).
        self._handed_out: "OrderedDict[str, tuple]" = OrderedDict()
        # Made once, as the engine starts: copies an earlier engine left behind
        # (decrypted, under readable names) shouldn't wait for a file to be opened.
        remove_stale_temp_dirs(self.prefix)

    def root(self) -> str:
        """This engine's folder for these copies, made on first use (and again if something removed it)."""
        if self.folder and os.path.isdir(self.folder):
            return self.folder
        if self.folder is None:
            # Runs only when the engine exits on its own; see STALE_SECONDS.
            atexit.register(_remove_dir, lambda: self.folder)
        else:
            self._handed_out.clear()  # gone with the folder
        self.folder = tempfile.mkdtemp(prefix=f"{self.prefix}{os.getpid()}-")
        return self.folder

    def copy(self, src: str, parts: Iterable, file_name: str,
             on_progress: Optional[ProgressCallback] = None) -> str:
        """Copy ``src`` to ``<this engine's folder>/<parts…>/<file_name>``; returns where the copy is.

        A folder per ``parts`` (the backup, then the file's id) keeps the
        file's own name, which is what the other app shows, while two files
        with one name don't collide. A copy that is already there is used
        again. Raises OSError when the copy can't be made, NotEnoughSpace
        when the disk has no room for it.

        Older copies may be removed first to keep within BUDGET_BYTES (see
        _make_room), which never makes this fail.
        """
        root = self.root()
        try:
            os.utime(root)  # still in use: see STALE_SECONDS
        except OSError:
            pass
        folder = os.path.join(root, *(safe_part(part) for part in parts))
        dest = os.path.join(folder, file_name)
        if same_file(src, dest):
            self._hand_out(dest)
            return dest
        # Room for the new copy first, which may also be what lets it fit on the disk.
        self._make_room(dest, _size(src))
        _check_space(root, src)
        os.makedirs(folder, exist_ok=True)
        try:
            replace_with_copy(src, dest, on_progress)
        except OSError:
            # The earlier copy is open in another app (Windows won't replace
            # it then): make a new one beside it.
            folder = os.path.join(folder, uuid.uuid4().hex[:8])
            os.makedirs(folder, exist_ok=True)
            dest = os.path.join(folder, file_name)
            replace_with_copy(src, dest, on_progress)
        self._hand_out(dest)
        return dest

    def _hand_out(self, path: str) -> None:
        """Note that ``path`` is handed out now, then keep the copies within the budget."""
        size = _size(path)
        self._handed_out[path] = (_now(), size)
        self._handed_out.move_to_end(path)
        self._make_room(path, size)

    def _make_room(self, keep: str, keep_bytes: int) -> None:
        """Remove copies, the one handed out longest ago first, until the rest fit in BUDGET_BYTES.

        ``keep`` (the copy being made or handed out, ``keep_bytes`` big) stays,
        as does any copy handed out in the last IN_USE_SECONDS, so the copies
        may stay over the budget for a while. A copy the system won't let go
        (Windows keeps a file that is open in another app) stays until a later
        try. Never raises: a copy that can't be removed mustn't stop one being
        handed out. Folders left empty go too.
        """
        try:
            total = keep_bytes + sum(size for path, (_, size) in self._handed_out.items() if path != keep)
            if total <= BUDGET_BYTES:
                return
            in_use_since = _now() - IN_USE_SECONDS
            removed = freed = 0
            for path, (when, size) in list(self._handed_out.items()):
                if total <= BUDGET_BYTES:
                    break
                if path == keep or when > in_use_since:
                    continue
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass  # already gone
                except OSError:
                    continue  # open in another app: next time
                del self._handed_out[path]
                total -= size
                removed += 1
                freed += size
                self._remove_empty_folders(os.path.dirname(path))
            if removed:
                print(f"[{self.label}] removed {removed} older copies ({freed} bytes) to keep within "
                      f"{BUDGET_BYTES} bytes", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001 - see above
            print(f"[{self.label}] could not remove older copies: {e}", file=sys.stderr, flush=True)

    def _remove_empty_folders(self, folder: str) -> None:
        """Remove ``folder`` and then each folder above it while empty, up to (never including) this engine's folder."""
        if not self.folder:
            return
        root = os.path.abspath(self.folder)
        folder = os.path.abspath(folder)
        while folder != root and os.path.dirname(folder) != folder:
            try:
                if os.path.commonpath([root, folder]) != root:
                    return
                os.rmdir(folder)  # only when empty
            except (OSError, ValueError):  # not empty; or (ValueError) on another drive
                return
            folder = os.path.dirname(folder)
