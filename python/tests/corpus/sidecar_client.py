"""Drive the real sidecar over JSON-RPC, the way Electron's main process does.

The client starts ``python/main.py`` (or the binary named by
``$OPENEXTRACT_SIDECAR``), waits for its ``{"status":"ready"}`` line, then
sends one request per line with a unique integer id and waits for the matching
response. Anything on stdout that isn't JSON, or a response with an id we
didn't send, is a protocol violation: it would break Electron too, so
``call`` raises ``ProtocolError`` as soon as it sees one.
"""

from __future__ import annotations

import itertools
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

PYTHON_DIR = Path(__file__).resolve().parents[2]
SIDECAR_MAIN = PYTHON_DIR / "main.py"
_EOF = object()


class SidecarError(RuntimeError):
    """The sidecar answered with a JSON-RPC error object."""

    def __init__(self, method: str, code: Any, message: str):
        super().__init__(f"{method}: [{code}] {message}")
        self.method, self.code, self.message = method, code, message


class ProtocolError(RuntimeError):
    """The sidecar broke the stdin/stdout protocol (noise on stdout, wrong ids, early exit)."""


class SidecarClient:
    def __init__(self, command: Optional[list[str]] = None, startup_timeout: float = 120):
        if command is None:
            binary = os.environ.get("OPENEXTRACT_SIDECAR")
            command = [binary] if binary else [sys.executable, "-u", str(SIDECAR_MAIN)]
        self.command = command
        self.startup_timeout = startup_timeout
        self.protocol_errors: list[str] = []
        self.notifications: list[dict] = []
        self.calls = 0
        self._ids = itertools.count(1)
        self._lines: "queue.Queue[Any]" = queue.Queue()
        self._proc: Optional[subprocess.Popen] = None
        self._tmp = tempfile.TemporaryDirectory(prefix="openextract-sidecar-")
        self._stderr_path = Path(self._tmp.name) / "stderr.log"

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> "SidecarClient":
        env = dict(os.environ)
        env["OPENEXTRACT_LOG_PATH"] = str(Path(self._tmp.name) / "python_log.txt")
        env["PYTHONUNBUFFERED"] = "1"
        self._stderr = open(self._stderr_path, "wb")
        self._proc = subprocess.Popen(
            self.command,
            cwd=str(PYTHON_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        first = self._next_line(self.startup_timeout, waiting_for="the ready line")
        if first != {"status": "ready"}:
            raise ProtocolError(f"expected {{'status': 'ready'}} first, got {first!r}")
        return self

    def close(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=15)
        self._stderr.close()
        self._proc = None
        self._tmp.cleanup()

    def __enter__(self) -> "SidecarClient":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.close()

    # ── protocol ─────────────────────────────────────────────────────────────

    def _read_stdout(self) -> None:
        for raw in self._proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                self._lines.put(json.loads(line))
            except json.JSONDecodeError:
                self.protocol_errors.append(f"non-JSON line on stdout: {line[:200]!r}")
        self._lines.put(_EOF)

    def stderr_tail(self, limit: int = 4000) -> str:
        try:
            return self._stderr_path.read_bytes()[-limit:].decode("utf-8", errors="replace")
        except OSError:
            return ""

    def _next_line(self, timeout: float, waiting_for: str) -> Any:
        try:
            item = self._lines.get(timeout=timeout)
        except queue.Empty:
            raise ProtocolError(f"timed out after {timeout:.0f}s waiting for {waiting_for}") from None
        if item is _EOF:
            code = self._proc.poll() if self._proc else None
            raise ProtocolError(
                f"sidecar exited (code {code}) while waiting for {waiting_for}\n--- stderr ---\n{self.stderr_tail()}"
            )
        return item

    def call(self, method: str, params: Optional[dict] = None, timeout: float = 600) -> Any:
        """Send one request and return its ``result``; raise ``SidecarError`` on an error response."""
        if self._proc is None:
            raise ProtocolError("sidecar is not running")
        request_id = next(self._ids)
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        self._proc.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
        self._proc.stdin.flush()
        self.calls += 1
        while True:
            message = self._next_line(timeout, waiting_for=f"the response to {method} (id {request_id})")
            if isinstance(message, dict) and "id" not in message and "method" in message:
                self.notifications.append(message)
                continue
            if not isinstance(message, dict) or message.get("id") != request_id:
                self.protocol_errors.append(
                    f"unexpected message while waiting for id {request_id} ({method}): {str(message)[:200]}"
                )
                raise ProtocolError(self.protocol_errors[-1])
            if self.protocol_errors:
                raise ProtocolError("; ".join(self.protocol_errors))
            if "error" in message:
                error = message["error"] or {}
                raise SidecarError(method, error.get("code"), error.get("message", ""))
            return message.get("result")

    def send_raw(self, line: str, timeout: float = 60) -> Any:
        """Write a raw line (e.g. malformed JSON) and return the next message."""
        self._proc.stdin.write((line + "\n").encode("utf-8"))
        self._proc.stdin.flush()
        return self._next_line(timeout, waiting_for="a reply to a raw line")
