"""
Record what a real iPhone sends during a backup, as a trace the fake iPhone can replay.

The trace holds each DeviceLink message's name, paths, sizes and progress, and the iPhone's
final answer. It never holds file contents. The iPhone's own names for files (which show app
names and photo file names) are replaced by a hash unless --keep-names is given, and the UDID
by "{udid}". Backup paths are already hashes, apart from Manifest.db and the like.

On the computer with the iPhone plugged in, from the repository's root:

    python python/tests/fake_iphone/recorder.py --out D:\\trace-backup --trace D:\\backup-trace.jsonl

That makes a real backup into --out (an empty folder) through OpenExtract's engine, as the app
does, and writes the trace. Copy the trace into python/tests/fake_iphone/traces/ and
test_replay_trace replays it on every test run.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Any, Iterator, Optional, Union

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from fake_iphone.plan import UDID_PLACEHOLDER
    from fake_iphone.real_modules import module, real_pymobiledevice3
else:
    from .plan import UDID_PLACEHOLDER
    from .real_modules import module, real_pymobiledevice3

_FILE_OPS = {
    "DLMessageDownloadFiles": "DownloadFiles",
    "DLMessageMoveItems": "MoveItems",
    "DLMessageMoveFiles": "MoveItems",
    "DLMessageRemoveItems": "RemoveItems",
    "DLMessageRemoveFiles": "RemoveItems",
}


class _Trace:
    def __init__(self, udid: Optional[str], keep_names: bool) -> None:
        self.udid = udid
        self.keep_names = keep_names
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

    def device_name(self, name: str) -> str:
        if self.keep_names:
            return name
        return "sha1:" + hashlib.sha1(name.encode("utf-8", "surrogateescape")).hexdigest()[:16]

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
def record_devicelink(trace_path: Union[str, Path], udid: Optional[str] = None, keep_names: bool = False) -> Iterator[list]:
    """Record every DeviceLink session in this process while the block runs; write the trace after."""
    with real_pymobiledevice3():
        device_link = module("pymobiledevice3.services.device_link")
    DeviceLink = device_link.DeviceLink
    trace = _Trace(udid, keep_names)
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
                entry = {"path": file_name, "device_name": trace.device_name(device_name),
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
        with open(trace_path, "w", encoding="utf-8", newline="\n") as f:
            for op in trace.ops:
                f.write(json.dumps(op, sort_keys=True) + "\n")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="an empty folder for the backup")
    parser.add_argument("--trace", required=True, help="where to write the trace (.jsonl)")
    parser.add_argument("--udid", help="the iPhone to back up (default: the only one connected)")
    parser.add_argument("--keep-names", action="store_true", help="keep the iPhone's own file names in the trace")
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

    with record_devicelink(args.trace, udid=udid, keep_names=args.keep_names) as ops:
        try:
            result = manager.start_backup(udid, args.out, False, None, notify)
            print(f"\nBackup finished: {result}")
        except Exception as e:
            print(f"\nBackup failed: {e}")
    print(f"Wrote {len(ops)} messages to {args.trace}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
