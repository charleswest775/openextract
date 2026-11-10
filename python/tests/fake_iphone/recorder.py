"""
Record what a real iPhone sends during a backup, as a trace the fake iPhone can replay.

The trace holds each DeviceLink message's name, paths, sizes and progress, and the iPhone's
final answer. It never holds file contents, and by default it's scrubbed (scrub_ops()):

- a file ID (SHA-1 of the file's domain and path, guessable with a dictionary of known paths)
  keeps its first two characters, its <xx> folder, and gets a salted hash for the rest; the salt
  is random and thrown away;
- the iPhone's own file names become file-000001, file-000002, ...;
- sizes are rounded to two significant figures;
- the UDID becomes "{udid}".

--raw keeps all of it, for looking at locally; don't commit a raw trace.

On the computer with the iPhone plugged in, from the repository's root:

    python python/tests/fake_iphone/recorder.py --out D:\\trace-backup --trace D:\\backup-trace.jsonl

That makes a real backup into --out (an empty folder) through OpenExtract's engine, as the app
does, and writes the trace. A trace in python/tests/fake_iphone/traces/ is replayed by
test_replay_trace on every test run. To scrub a trace recorded raw or by an older recorder:

    python python/tests/fake_iphone/recorder.py scrub raw-trace.jsonl scrubbed-trace.jsonl
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import re
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Any, Iterator, Optional, Union

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from fake_iphone.plan import METADATA_FILES, UDID_PLACEHOLDER, load_trace, save_trace
    from fake_iphone.real_modules import module, real_pymobiledevice3
else:
    from .plan import METADATA_FILES, UDID_PLACEHOLDER, load_trace, save_trace
    from .real_modules import module, real_pymobiledevice3

_FILE_OPS = {
    "DLMessageDownloadFiles": "DownloadFiles",
    "DLMessageMoveItems": "MoveItems",
    "DLMessageMoveFiles": "MoveItems",
    "DLMessageRemoveItems": "RemoveItems",
    "DLMessageRemoveFiles": "RemoveItems",
}


_FILE_ID = re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])")
_KEPT_NAMES = set(METADATA_FILES) | {"Manifest.mbdx", "Snapshot"}


def _round(size: Any) -> Any:
    """Two significant figures: 52133 -> 52000, 8137974512 -> 8100000000."""
    if not isinstance(size, int) or isinstance(size, bool) or size < 100:
        return size
    digits = len(str(size)) - 2
    return round(size, -digits)


def scrub_ops(ops: list[dict], salt: Optional[bytes] = None) -> list[dict]:
    """A copy of a trace that doesn't give away the iPhone's file names, IDs or exact sizes."""
    salt = salt if salt is not None else os.urandom(16)
    names: dict[str, str] = {}

    def file_id(match: re.Match) -> str:
        found = match.group(0)
        return found[:2] + hashlib.sha1(salt + found.encode()).hexdigest()[2:]

    def path(value: Any) -> Any:
        return _FILE_ID.sub(file_id, value) if isinstance(value, str) else value

    def name(value: str) -> str:
        if value.rsplit("/", 1)[-1] in _KEPT_NAMES:
            return value
        return names.setdefault(value, f"file-{len(names) + 1:06d}")

    scrubbed = []
    for op in ops:
        op = dict(op)
        if "files" in op:
            op["files"] = [dict(f, path=path(f["path"]), device_name=name(f.get("device_name", f["path"])),
                                size=_round(f.get("size", 0))) for f in op["files"]]
        if "items" in op:
            op["items"] = {path(k): path(v) for k, v in op["items"].items()}
        if "paths" in op:
            op["paths"] = [path(p) for p in op["paths"]]
        for key in ("path", "src", "dst"):
            if key in op:
                op[key] = path(op[key])
        if isinstance(op.get("content"), dict) and "ErrorDescription" in op["content"]:
            op["content"] = dict(op["content"], ErrorDescription=path(op["content"]["ErrorDescription"]))
        scrubbed.append(op)
    return scrubbed


class _Trace:
    def __init__(self, udid: Optional[str]) -> None:
        self.udid = udid
        self.ops: list[dict] = []
        self.t0: Optional[float] = None
        self._lock = threading.Lock()

    def add(self, op: dict) -> None:
        with self._lock:
            now = time.monotonic()
            if self.t0 is None:
                self.t0 = now
            op["t"] = round(now - self.t0, 3)
            self.ops.append(self.scrub(op))

    def scrub(self, value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(self.udid, UDID_PLACEHOLDER) if self.udid else value
        if isinstance(value, list):
            return [self.scrub(v) for v in value]
        if isinstance(value, dict):
            return {self.scrub(k): self.scrub(v) for k, v in value.items()}
        if isinstance(value, bytes):
            return f"<{len(value)} bytes>"
        return value if isinstance(value, (int, float, bool)) or value is None else repr(value)

    def message(self, message: list) -> None:
        command = message[0]
        if command in ("DLMessageUploadFiles", "DLMessageVersionExchange", "DLMessageDeviceReady"):
            return  # files are recorded by upload_files(); the handshake is always the same
        if command == "DLMessageProcessMessage":
            content = message[1] if len(message) > 1 and isinstance(message[1], dict) else {}
            if "ProtocolVersion" in content:
                return  # the answer to Hello

            keep = {k: content[k] for k in ("ErrorCode", "ErrorDescription", "MessageName") if k in content}
            self.add({"op": "ProcessMessage", "content": keep})
        elif command in _FILE_OPS:
            op = {"op": _FILE_OPS[command], "progress": _number(message, 3)}
            if op["op"] == "MoveItems":
                op["items"] = dict(message[1])
            else:
                op["paths"] = list(message[1])
            self.add(op)
        elif command == "DLMessageCreateDirectory":
            self.add({"op": "CreateDirectory", "path": message[1]})
        elif command == "DLMessageCopyItem":
            self.add({"op": "CopyItem", "src": message[1], "dst": message[2]})
        elif command == "DLContentsOfDirectory":
            self.add({"op": "ContentsOfDirectory", "path": message[1]})
        elif command == "DLMessageGetFreeDiskSpace":
            self.add({"op": "GetFreeDiskSpace"})
        elif command == "DLMessagePurgeDiskSpace":
            self.add({"op": "PurgeDiskSpace", "amount": _number(message, 1), "urgency": _number(message, 2)})
        else:
            self.add({"op": "Unknown", "message": [m if isinstance(m, (str, int, float)) else repr(m)[:200] for m in message]})


def _number(message: list, index: int) -> Any:
    return message[index] if len(message) > index and isinstance(message[index], (int, float)) else None


@contextlib.contextmanager
def record_devicelink(trace_path: Union[str, Path], udid: Optional[str] = None, raw: bool = False) -> Iterator[list]:
    """
    Record every DeviceLink session in this process while the block runs; write the trace after,
    scrubbed unless raw=True.
    """
    with real_pymobiledevice3():
        device_link = module("pymobiledevice3.services.device_link")
    DeviceLink = device_link.DeviceLink
    trace = _Trace(udid)
    original_receive = DeviceLink.receive_message
    original_upload = DeviceLink.upload_files

    async def receive_message(self):
        message = await original_receive(self)
        try:
            trace.message(list(message))
        except Exception as e:  # never let the recorder break a backup
            trace.add({"op": "Unknown", "error": repr(e)})
        return message

    async def upload_files(self, message):
        files: list[tuple[str, str]] = []
        preserve = self.preserve_file

        def watching(file_name: str, device_name: str) -> bool:
            files.append((file_name, device_name))
            return preserve(file_name, device_name) if preserve is not None else True

        self.preserve_file = watching
        failed: set[str] = set()
        try:
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                await original_upload(self, message)
            for w in caught:
                text = str(w.message)
                if text.startswith("Failed to fully upload: "):
                    failed.add(text[len("Failed to fully upload: "):].split(". Device file name:")[0])
                warnings.warn_explicit(w.message, w.category, w.filename, w.lineno)
        finally:
            self.preserve_file = preserve
            entries = []
            for file_name, device_name in files:
                path = self.root_path / file_name
                entry = {"path": file_name, "device_name": device_name,
                         "size": path.stat().st_size if path.is_file() else 0}
                if file_name in failed:
                    entry["error"] = "the iPhone couldn't send this file"
                entries.append(entry)
            trace.add({"op": "UploadFiles", "progress": _number(list(message), 2), "files": entries})

    DeviceLink.receive_message = receive_message
    DeviceLink.upload_files = upload_files
    try:
        yield trace.ops
    finally:
        DeviceLink.receive_message = original_receive
        DeviceLink.upload_files = original_upload
        save_trace(trace.ops if raw else scrub_ops(trace.ops), trace_path)


def main(argv: Optional[list[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["scrub"]:
        if len(argv) != 3:
            print("usage: recorder.py scrub <trace.jsonl> <scrubbed.jsonl>", file=sys.stderr)
            return 2
        save_trace(scrub_ops(load_trace(argv[1])), argv[2])
        print(f"Wrote {argv[2]}")
        return 0

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="an empty folder for the backup")
    parser.add_argument("--trace", required=True, help="where to write the trace (.jsonl)")
    parser.add_argument("--udid", help="the iPhone to back up (default: the only one connected)")
    parser.add_argument("--raw", action="store_true", help="don't scrub the trace (for looking at locally only)")
    args = parser.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    import device_backup

    manager = device_backup.DeviceBackupManager()
    udid = args.udid
    if not udid:
        devices = manager.list_devices()["devices"]
        if len(devices) != 1:
            print(f"Found {len(devices)} iPhones; say which with --udid: {[d['udid'] for d in devices]}", file=sys.stderr)
            return 2
        udid = devices[0]["udid"]

    def notify(phase, percent, files_done, files_total, bytes_done=0):
        print(f"\r{phase:<12} {percent:3d}%  {bytes_done / 1e9:7.2f} GB", end="", flush=True)

    with record_devicelink(args.trace, udid=udid, raw=args.raw) as ops:
        try:
            result = manager.start_backup(udid, args.out, False, None, notify)
            print(f"\nBackup finished: {result}")
        except Exception as e:
            print(f"\nBackup failed: {e}")
    print(f"Wrote {len(ops)} messages to {args.trace}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
