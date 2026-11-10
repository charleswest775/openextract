"""
Running OpenExtract's engine against a FakeIPhone, and the faults on the computer's side.

run_backup() calls DeviceBackupManager.start_backup() the way main.py's backup.start does and
returns what the app would get: the result, or the error text it would show, plus every
backup.progress notification.
"""

from __future__ import annotations

import contextlib
import errno
import os
import stat
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional

from .device import FakeIPhone
from .real_modules import module

PYTHON_DIR = Path(__file__).resolve().parents[2]
if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))

import device_backup  # noqa: E402


@dataclass
class BackupRun:
    phone: FakeIPhone
    output_dir: Path
    result: Optional[dict] = None
    error: Optional[str] = None  # what the app shows: str() of the engine's exception
    exception: Optional[BaseException] = None
    progress: list[dict] = field(default_factory=list)  # backup.progress params, plus "t"
    seconds: float = 0.0

    @property
    def backup_dir(self) -> Path:
        return self.output_dir / self.phone.udid

    @property
    def phases(self) -> list[str]:
        """Phases in the order they were shown, without repeats."""
        shown: list[str] = []
        for p in self.progress:
            if not shown or shown[-1] != p["phase"]:
                shown.append(p["phase"])
        return shown

    def files(self) -> set[str]:
        """Every file under the backup folder, as a relative path with forward slashes."""
        if not self.backup_dir.exists():
            return set()
        return {p.relative_to(self.backup_dir).as_posix() for p in self.backup_dir.rglob("*") if p.is_file()}

    def assert_progress_never_goes_back(self) -> None:
        percents = [p["percent"] for p in self.progress]
        assert percents == sorted(percents), f"the bar went backwards: {percents}"
        sizes = [p["bytes_done"] for p in self.progress]
        assert sizes == sorted(sizes), f"bytes copied went backwards: {sizes}"


# A scenario takes a second or two. One that runs this long is stuck: the fake iPhone unplugs
# itself, so the engine's reads fail and the test fails instead of holding up CI.
HANG_TIMEOUT_S = 60.0


def run_backup(phone: FakeIPhone, output_dir: Path, *, encrypted: bool = False,
               password: Optional[str] = None) -> BackupRun:
    run = BackupRun(phone=phone, output_dir=Path(output_dir))
    t0 = time.monotonic()
    hung = threading.Event()

    def give_up() -> None:
        hung.set()
        phone.log(f"watchdog: no result after {HANG_TIMEOUT_S:.0f}s, unplugging")
        phone.unplug()

    watchdog = threading.Timer(HANG_TIMEOUT_S, give_up)
    watchdog.daemon = True

    # main.py's backup.start notify, recorded instead of written to stdout.
    def notify(phase: str, percent: int, files_done: int, files_total: int, bytes_done: int = 0) -> None:
        run.progress.append({
            "phase": phase, "percent": percent, "files_done": files_done, "files_total": files_total,
            "bytes_done": bytes_done, "t": round(time.monotonic() - t0, 3),
        })

    with phone.plugged_in():
        watchdog.start()
        try:
            run.result = device_backup.DeviceBackupManager().start_backup(
                udid=phone.udid, output_dir=str(output_dir), encrypted=encrypted, password=password, notify=notify,
            )
        except Exception as e:  # main.py turns this into {"error": {"message": str(e)}}
            run.exception = e
            run.error = str(e)
        finally:
            watchdog.cancel()
    run.seconds = time.monotonic() - t0
    assert not hung.is_set(), (
        f"the backup was still running after {HANG_TIMEOUT_S:.0f}s; the fake iPhone's last events: "
        f"{phone.events[-15:]}; the engine then reported: {run.error!r}")
    assert not phone.errors, "the fake iPhone itself failed:\n" + "\n".join(phone.errors)
    return run


# ── Faults on the computer's side ────────────────────────────────────────────

class _WatchedFile:
    """A file pymobiledevice3 writes a received file to, with a hook on every write."""

    def __init__(self, f, on_write) -> None:
        self._f = f
        self._on_write = on_write

    def write(self, data) -> int:
        self._on_write(len(data))
        return self._f.write(data)

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> Any:
        return self._f.__exit__(*exc)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._f, name)


def _patch_device_link_writes(monkeypatch, on_write) -> None:
    """Route the writes of DeviceLink.upload_files() through on_write(nbytes)."""
    device_link = module("pymobiledevice3.services.device_link")

    def watched_open(file, mode="r", *args, **kwargs):
        f = open(file, mode, *args, **kwargs)
        return _WatchedFile(f, on_write) if "w" in mode or "a" in mode else f

    monkeypatch.setattr(device_link, "open", watched_open, raising=False)


def slow_disk(monkeypatch, bytes_per_second: float) -> None:
    """The computer writes received files at this speed, blocking as a slow drive does."""
    _patch_device_link_writes(monkeypatch, lambda n: time.sleep(n / bytes_per_second))


def stalling_disk(monkeypatch, after_bytes: int, seconds: float) -> None:
    """Once this many bytes are written, one write blocks for `seconds` (antivirus, a drive waking)."""
    written = [0]

    def on_write(n: int) -> None:
        before = written[0]
        written[0] += n
        if before <= after_bytes < written[0]:
            time.sleep(seconds)

    _patch_device_link_writes(monkeypatch, on_write)


def failing_disk(monkeypatch, after_bytes: int, error: int = errno.ENOSPC) -> None:
    """Writing a received file fails once this many bytes have been written (disk full by default)."""
    written = [0]

    def on_write(n: int) -> None:
        written[0] += n
        if written[0] > after_bytes:
            raise OSError(error, os.strerror(error))  # as write() raises it: no file name

    _patch_device_link_writes(monkeypatch, on_write)


@contextlib.contextmanager
def in_use(path: Path) -> Iterator[None]:
    """
    Another program has `path` open, as Windows Defender, OneDrive or the search indexer do.

    On Windows this is real: a handle on a file stops it, and the folders it's in, from being
    renamed or deleted ("Access is denied", "being used by another process"). A folder gets a
    handle on every file in it. Other systems have no such locks, so there the folder that holds
    `path` is made read-only, which stops `path` being moved or deleted with PermissionError.
    """
    path = Path(path)
    if sys.platform == "win32":
        files = [p for p in ([path] if path.is_file() else path.rglob("*")) if p.is_file()]
        handles = [open(p, "rb") for p in files]
        folders = [_open_folder(p) for p in ([path] + [p for p in path.rglob("*") if p.is_dir()] if path.is_dir() else [])]
        try:
            yield
        finally:
            for h in handles:
                h.close()
            for h in folders:
                _close_handle(h)
    else:
        parent = path.parent
        mode = parent.stat().st_mode
        parent.chmod(stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP)
        try:
            yield
        finally:
            parent.chmod(mode)


def _open_folder(path: Path) -> int:
    """A handle on a folder that lets others read and write but not delete, as Explorer holds."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                     wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    generic_read, share_read_write, open_existing, backup_semantics = 0x80000000, 0x1 | 0x2, 3, 0x02000000
    handle = kernel32.CreateFileW(str(path), generic_read, share_read_write, None, open_existing, backup_semantics, None)
    if handle in (None, wintypes.HANDLE(-1).value):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def _close_handle(handle: int) -> None:
    import ctypes

    ctypes.WinDLL("kernel32").CloseHandle(ctypes.c_void_p(handle))


class InUse:
    """in_use() started from the fake iPhone's thread (phone.before) and ended by the test."""

    def __init__(self) -> None:
        self._stack = contextlib.ExitStack()

    def lock(self, path: Path) -> None:
        self._stack.enter_context(in_use(path))

    def release(self) -> None:
        self._stack.close()


def is_root() -> bool:
    return hasattr(os, "geteuid") and os.geteuid() == 0
