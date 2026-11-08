"""
How far along a long save is, for export.progress notifications.

Saving a big photo library from an encrypted backup decrypts every file first
and can take tens of minutes (OE-14). The app shows "Saving 1,234 of 5,678
photos and videos…" from these updates so the save doesn't look frozen.

Reporting every file would flood the pipe to Electron, so ExportProgress passes
on at most one update per INTERVAL seconds, plus the first and the last.
"""

import time
from typing import Callable, Optional

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
