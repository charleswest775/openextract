"""
How far along a long save is, for export.progress notifications.

Saving a big photo library from an encrypted backup decrypts every file first
and can take tens of minutes (OE-14). The app shows "Saving 1,234 of 5,678
photos and videos…" from these updates so the save doesn't look frozen.

Reporting every file would flood the pipe to Electron, so ExportProgress passes
on at most one update per INTERVAL seconds, plus the first and the last.

ChatSaveProgress does the same for saves of Messages conversations and WhatsApp
chats. Each update also starts the app's time limit for the save over
(electron/sidecar.ts), so a slow save that is still moving isn't given up on.
"""

import time
from typing import Callable, Iterator, Optional, Sequence

# on_progress(done, total, failed): files handled so far (saved or not), files
# the save will handle in all, and how many of the handled ones failed.
ProgressCallback = Callable[[int, int, int], None]


class ExportProgress:
    INTERVAL = 0.25  # seconds

    def __init__(self, on_progress: Optional[ProgressCallback], total: int,
                 clock: Callable[[], float] = time.monotonic):
        self._on_progress = on_progress
        self.total = total
        self._clock = clock
        self._last: Optional[float] = None

    def update(self, done: int, failed: int) -> None:
        """Report done of total (failed of them failed), unless an update went out just now.

        The first update always goes out, so the app can show the total
        straight away, and so does the last (done == total).
        """
        if self._on_progress is None:
            return
        # A file whose copy worked but whose extra step failed counts twice.
        done = min(done, self.total)
        now = self._clock()
        if self._last is not None and now - self._last < self.INTERVAL and done < self.total:
            return
        self._last = now
        self._on_progress(done, self.total, failed)


class ChatSaveProgress:
    """How far a save of chats has got: each is read a page at a time, then written a message at a time.

    on_progress gets {phase: "reading" or "saving", done, total, chat, chats, percent}:
    done of total messages of chat number ``chat`` (from 1) of ``chats``, and how much
    of this whole engine call that makes, 0 to 100. With ``read_first`` every chat is
    read before any is written (a PDF's plan, or everything in one file), so reading
    is the first tenth of the whole rather than a tenth of each chat.
    """

    INTERVAL = ExportProgress.INTERVAL
    READING = 0.1  # reading a chat is quick beside writing it with its photos

    def __init__(self, on_progress: Optional[Callable[[dict], None]] = None, chats: int = 1,
                 read_first: bool = False, clock: Callable[[], float] = time.monotonic):
        self._on_progress = on_progress
        self._chats = max(chats, 1)
        self._chat = 0  # from 0
        self._read_first = read_first
        self._clock = clock
        self._last: Optional[float] = None

    def start_chat(self, index: int) -> None:
        self._chat = index

    def read(self, done: int, total: int) -> None:
        self._send("reading", done, total)

    def saving(self, messages: Sequence) -> Iterator:
        """``messages``, reporting each as it is come to."""
        for done, message in enumerate(messages):
            self._send("saving", done, len(messages))
            yield message

    def one_file(self) -> None:
        """Every chat has been read: what's left is writing the one file they share."""
        self._chat, self._chats = 0, 1

    def _send(self, phase: str, done: int, total: int) -> None:
        if self._on_progress is None or total <= 0:
            return
        now = self._clock()
        if self._last is not None and now - self._last < self.INTERVAL:
            return
        self._last = now
        done = min(done, total)
        part = done / total
        if phase == "saving":
            part = self.READING + (1 - self.READING) * part
        elif not self._read_first:
            part *= self.READING
        overall = (self._chat + part) / self._chats
        if phase == "reading" and self._read_first:
            overall *= self.READING
        self._on_progress({
            "phase": phase, "done": done, "total": total,
            "chat": self._chat + 1, "chats": self._chats, "percent": int(overall * 100),
        })
