"""
The iPhone's end of a service connection: a blocking socket in a thread of its own.

The computer's end is one half of socket.socketpair() wrapped in pymobiledevice3's own
ServiceConnection, so everything above the socket on the computer's side is real. On Windows
socketpair() is a TCP connection over 127.0.0.1, as usbmuxd's is there.
"""

from __future__ import annotations

import plistlib
import socket
import struct
import sys
import threading
from typing import Any, Optional

# DeviceLink file transfer framing (pymobiledevice3/services/device_link.py)
CODE_SUCCESS = 0x00
CODE_ERROR_LOCAL = 0x06
CODE_ERROR_REMOTE = 0x0B
CODE_FILE_DATA = 0x0C

SOCKET_BUFFER = 1024 * 1024


class HostClosed(Exception):
    """The computer closed the connection."""


class HostStalled(Exception):
    """The computer stopped taking data for longer than the iPhone waits."""


class Dropped(Exception):
    """The fake iPhone dropped the connection on purpose (fault injection)."""


def socket_pair() -> tuple[socket.socket, socket.socket]:
    """(computer's end, iPhone's end), with buffers like a USB connection's rather than a pipe's."""
    host, device = socket.socketpair()
    for s in (host, device):
        for opt in (socket.SO_SNDBUF, socket.SO_RCVBUF):
            try:
                s.setsockopt(socket.SOL_SOCKET, opt, SOCKET_BUFFER)
            except OSError:
                pass
    return host, device


class DeviceSocket:
    def __init__(self, sock: socket.socket, name: str, *, send_budget: Optional[int] = None,
                 stall_timeout: Optional[float] = None) -> None:
        self.sock = sock
        self.name = name
        self.sent = 0
        self.received = 0
        self.send_budget = send_budget  # bytes the iPhone sends before it drops the connection
        self.stall_timeout = stall_timeout
        self.closed = False
        self._send_lock = threading.Lock()
        sock.setblocking(True)

    # ── sending ──
    def sendall(self, data: bytes) -> None:
        with self._send_lock:
            if self.send_budget is not None and self.sent + len(data) > self.send_budget:
                allowed = max(0, self.send_budget - self.sent)
                self._send(data[:allowed])
                raise Dropped(f"{self.name}: dropped after {self.sent} bytes")
            self._send(data)

    def _send(self, data: bytes) -> None:
        if not data:
            return
        if self.closed:
            raise HostClosed(self.name)
        try:
            self.sock.settimeout(self.stall_timeout)
            self.sock.sendall(data)
        except socket.timeout as e:
            raise HostStalled(f"{self.name}: the computer took no data for {self.stall_timeout}s") from e
        except OSError as e:
            raise HostClosed(f"{self.name}: {e!r}") from e
        self.sent += len(data)

    def send_plist(self, value: Any) -> None:
        payload = plistlib.dumps(value, fmt=plistlib.FMT_BINARY)
        self.sendall(struct.pack(">I", len(payload)) + payload)

    def send_prefixed(self, data: bytes) -> None:
        self.sendall(struct.pack(">I", len(data)) + data)

    def send_frame(self, code: int, data: bytes = b"") -> None:
        self.sendall(struct.pack(">IB", len(data) + 1, code) + data)

    # ── receiving ──
    def recvall(self, size: int) -> bytes:
        buf = bytearray()
        while len(buf) < size:
            if self.closed:
                raise HostClosed(self.name)
            try:
                self.sock.settimeout(None)
                chunk = self.sock.recv(min(size - len(buf), SOCKET_BUFFER))
            except OSError as e:
                raise HostClosed(f"{self.name}: {e!r}") from e
            if not chunk:
                raise HostClosed(f"{self.name}: the computer closed the connection")
            buf += chunk
        self.received += size
        return bytes(buf)

    def recv_plist(self) -> Any:
        (size,) = struct.unpack(">I", self.recvall(4))
        return plistlib.loads(self.recvall(size))

    def recv_prefixed(self) -> bytes:
        (size,) = struct.unpack(">I", self.recvall(4))
        return self.recvall(size)

    def recv_frame(self) -> tuple[int, bytes]:
        size, code = struct.unpack(">IB", self.recvall(5))
        return code, self.recvall(size - 1)

    def close(self, reset: bool = False) -> None:
        """Close the connection. reset=True sends a TCP reset where the socket supports one."""
        if self.closed:
            return
        self.closed = True
        try:
            if reset:
                # struct linger: two u_shorts on Windows, two ints elsewhere
                linger = struct.pack("HH" if sys.platform == "win32" else "ii", 1, 0)
                self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
            # Wakes a thread blocked on the socket; SHUT_RD sends nothing, so a reset stays a reset.
            self.sock.shutdown(socket.SHUT_RD if reset else socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass
