"""
What the fake iPhone does during a backup: a list of DeviceLink steps ("ops").

The same list is the trace format. A trace recorded from a real backup (recorder.py) holds the
messages the iPhone sent, with names, paths and sizes but never file contents, so it can be
replayed here as it is. Each op is a dict with an "op" key:

    {"op": "DownloadFiles", "paths": ["{udid}/Status.plist"], "progress": 0}
    {"op": "GetFreeDiskSpace"}                    # "required": bytes the iPhone needs, optional
    {"op": "CreateDirectory", "path": "{udid}/Snapshot"}
    {"op": "UploadFiles", "progress": 12.5, "files": [
        {"path": "{udid}/Snapshot/3d/3d0d7e5f...", "device_name": "/var/mobile/...", "size": 52133,
         "domain": "HomeDomain", "relative_path": "Library/SMS/sms.db",  # optional, for Manifest.db
         "error": "..."}]}                        # optional: the iPhone couldn't read this file
    {"op": "MoveItems", "items": {"{udid}/Snapshot/3d": "{udid}/3d"}, "progress": 100}
    {"op": "RemoveItems", "paths": ["{udid}/Snapshot"], "progress": 100}
    {"op": "CopyItem", "src": "...", "dst": "..."}
    {"op": "ContentsOfDirectory", "path": "{udid}"}
    {"op": "ProcessMessage", "content": {"ErrorCode": 0}}   # the iPhone's final answer
    {"op": "Notify", "name": "com.apple.LocalAuthentication.ui.presented"}
    {"op": "Sleep", "seconds": 2}
    {"op": "Drop"}      # the iPhone closes the backup connection here
    {"op": "Unplug"}    # the cable comes out here

"{udid}" stands for the iPhone's UDID. A recorded op may also carry "t", the seconds since the
backup started; replay ignores it unless asked to keep the pacing (FakeIPhone(pace=...)).

The order of synthetic_backup() follows what the field reports and pymobiledevice3 show: files
arrive in <udid>/Snapshot/<xx>/, then the iPhone moves them into place and removes Snapshot
(OE-11 failed on "...\\Snapshot\\00", OE-6 on "...\\Snapshot\\51\\..."). It is a model until a
trace from a real iPhone replaces or confirms it.
"""

from __future__ import annotations

import hashlib
import json
import os
import plistlib
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional

UDID_PLACEHOLDER = "{udid}"
METADATA_FILES = ("Manifest.db", "Manifest.plist", "Status.plist", "Info.plist")
MiB = 1024 * 1024

LOCAL_AUTH_PRESENTED = "com.apple.LocalAuthentication.ui.presented"
LOCAL_AUTH_DISMISSED = "com.apple.LocalAuthentication.ui.dismissed"


def file_id(domain: str, relative_path: str) -> str:
    """The name a file gets in a backup: SHA-1 of "<domain>-<relative path>"."""
    return hashlib.sha1(f"{domain}-{relative_path}".encode()).hexdigest()


def _sample_files(count: int, large: Iterable[int]) -> list[dict]:
    """Files like a small iPhone's: messages, contacts, notes, photos and a few big videos."""
    files = [
        ("HomeDomain", "Library/SMS/sms.db", 320 * 1024),
        ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", 96 * 1024),
        ("HomeDomain", "Library/CallHistoryDB/CallHistory.storedata", 64 * 1024),
        ("AppDomainGroup-group.com.apple.notes", "NoteStore.sqlite", 128 * 1024),
        ("HomeDomain", "Library/Safari/History.db", 48 * 1024),
    ]
    for i in range(max(0, count - len(files))):
        if i % 3 == 0:
            files.append(("CameraRollDomain", f"Media/DCIM/100APPLE/IMG_{i:04d}.HEIC", 24 * 1024 + (i * 7919) % 40960))
        elif i % 3 == 1:
            files.append(("MediaDomain", f"Library/SMS/Attachments/{i % 97:02x}/{i:02d}/IMG_{i:04d}.jpeg", 8 * 1024 + (i * 104729) % 30000))
        else:
            files.append(("HomeDomain", f"Library/Preferences/com.example.app{i}.plist", 600 + (i * 31) % 4000))
    for i, size in enumerate(large):
        files.append(("CameraRollDomain", f"Media/DCIM/100APPLE/IMG_{9000 + i:04d}.MOV", size))
    return [
        {
            "path": None,  # filled in below, once the file ID is known
            "device_name": f"/var/mobile/{relative_path}",
            "size": size,
            "domain": domain,
            "relative_path": relative_path,
        }
        for domain, relative_path, size in files
    ]


def synthetic_backup(
    file_count: int = 120,
    large_files: Iterable[int] = (8 * MiB, 8 * MiB, 12 * MiB),
    batch_size: int = 40,
    snapshot: bool = True,
) -> list[dict]:
    """
    A full backup of a fictional iPhone, in the order the iPhone sends it. Large files are
    generated as they're sent, so a "video" costs nothing until the computer writes it.
    """
    files = _sample_files(file_count, large_files)
    prefix = f"{UDID_PLACEHOLDER}/Snapshot" if snapshot else UDID_PLACEHOLDER
    for f in files:
        fid = file_id(f["domain"], f["relative_path"])
        f["path"] = f"{prefix}/{fid[:2]}/{fid}"

    ops: list[dict] = [
        # The iPhone asks for the last backup's Status.plist and Manifest.db to see what it can skip.
        # pymobiledevice3 has just written Status.plist; Manifest.db is missing in a new folder.
        {"op": "DownloadFiles", "paths": [f"{UDID_PLACEHOLDER}/Status.plist"], "progress": 0},
        {"op": "DownloadFiles", "paths": [f"{UDID_PLACEHOLDER}/Manifest.db"], "progress": 0},
        {"op": "GetFreeDiskSpace"},
    ]
    if snapshot:
        ops.append({"op": "CreateDirectory", "path": prefix})
    for xx in sorted({f["path"].split("/")[-2] for f in files}):
        ops.append({"op": "CreateDirectory", "path": f"{prefix}/{xx}"})

    # Small files go in batches, big ones in a batch of their own.
    regular = [f for f in files if f["size"] < 4 * MiB]
    batches = [regular[i:i + batch_size] for i in range(0, len(regular), batch_size)]
    batches += [[f] for f in files if f["size"] >= 4 * MiB]
    for i, batch in enumerate(batches):
        ops.append({"op": "UploadFiles", "progress": round(1 + 97 * i / len(batches), 2), "files": batch})

    metadata = [
        {"path": f"{prefix}/Manifest.db", "device_name": "Manifest.db", "size": 0, "generate": "manifest_db"},
        {"path": f"{prefix}/Manifest.plist", "device_name": "Manifest.plist", "size": 0, "generate": "manifest_plist"},
        {"path": f"{prefix}/Status.plist", "device_name": "Status.plist", "size": 0, "generate": "status_plist"},
    ]
    ops.append({"op": "UploadFiles", "progress": 98.5, "files": metadata})
    if snapshot:
        moves = {f"{prefix}/{xx}": f"{UDID_PLACEHOLDER}/{xx}" for xx in sorted({f["path"].split("/")[-2] for f in files})}
        moves.update({f"{prefix}/{name}": f"{UDID_PLACEHOLDER}/{name}" for name in ("Manifest.db", "Manifest.plist", "Status.plist")})
        ops.append({"op": "MoveItems", "items": moves, "progress": 100})
        ops.append({"op": "RemoveItems", "paths": [prefix], "progress": 100})
    ops.append({"op": "ProcessMessage", "content": {"ErrorCode": 0, "ErrorDescription": ""}})
    return ops


def uploaded_files(ops: Iterable[dict]) -> list[dict]:
    """Every file the plan sends, in order."""
    return [f for op in ops if op["op"] == "UploadFiles" for f in op["files"]]


def payload_bytes(ops: Iterable[dict]) -> int:
    """Bytes of file data in the plan, not counting generated metadata files."""
    return sum(f["size"] for f in uploaded_files(ops) if not f.get("generate") and not f.get("error"))


def final_location(path: str, ops: Iterable[dict]) -> str:
    """Where a file sent to `path` ends up once the plan's moves are done."""
    for op in ops:
        if op["op"] != "MoveItems":
            continue
        for src, dst in op["items"].items():
            if path == src:
                path = dst
            elif path.startswith(src + "/"):
                path = dst + path[len(src):]
    return path


def with_udid(value, udid: str):
    """Replace "{udid}" in strings, lists and dict values."""
    if isinstance(value, str):
        return value.replace(UDID_PLACEHOLDER, udid)
    if isinstance(value, list):
        return [with_udid(v, udid) for v in value]
    if isinstance(value, dict):
        return {with_udid(k, udid): with_udid(v, udid) for k, v in value.items()}
    return value


# ── File contents ────────────────────────────────────────────────────────────

CHUNK = 64 * 1024


def filler(path: str, size: int, chunk: int = CHUNK) -> Iterator[bytes]:
    """Deterministic contents for a file, made up as it's sent: the same 64 KiB block repeated."""
    seed = hashlib.sha256(path.encode()).digest()
    block = (seed * (chunk // len(seed) + 1))[:chunk]
    left = size
    while left > 0:
        n = min(chunk, left)
        yield block[:n]
        left -= n


def expected_prefix(path: str, n: int = 32) -> bytes:
    """The first n bytes filler() writes for path, for checking a file's contents."""
    return b"".join(filler(path, n))[:n]


def manifest_db(files: list[dict], udid: str) -> bytes:
    """A real Manifest.db (SQLite) that lists the files, as a reader of the backup expects."""
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        con = sqlite3.connect(tmp)
        con.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
        con.execute("CREATE TABLE Properties (key TEXT PRIMARY KEY, value BLOB)")
        for f in files:
            if f.get("generate") or f.get("error"):
                continue
            name = f["path"].rsplit("/", 1)[-1]
            domain = f.get("domain", "UnknownDomain")
            relative_path = f.get("relative_path", f.get("device_name", name))
            con.execute(
                "INSERT OR REPLACE INTO Files VALUES (?, ?, ?, 1, ?)",
                (name, domain, relative_path, plistlib.dumps({"Size": f["size"]}, fmt=plistlib.FMT_BINARY)),
            )
        con.commit()
        con.close()
        return Path(tmp).read_bytes()
    finally:
        os.unlink(tmp)


def manifest_plist(values: dict) -> bytes:
    return plistlib.dumps({
        "IsEncrypted": False,
        "Version": "10.0",
        "Date": datetime.now(timezone.utc).replace(tzinfo=None),
        "SystemDomainsVersion": "24.0",
        "WasPasscodeSet": True,
        "Applications": {},
        "Lockdown": {k: values[k] for k in ("BuildVersion", "DeviceName", "ProductType", "ProductVersion", "SerialNumber", "UniqueDeviceID")},
    }, fmt=plistlib.FMT_BINARY)


def status_plist() -> bytes:
    return plistlib.dumps({
        "BackupState": "new",
        "Date": datetime.now(timezone.utc).replace(tzinfo=None),
        "IsFullBackup": True,
        "SnapshotState": "finished",
        "UUID": str(uuid.uuid4()).upper(),
        "Version": "3.3",
    }, fmt=plistlib.FMT_BINARY)


# ── Traces ───────────────────────────────────────────────────────────────────

def save_trace(ops: Iterable[dict], path: os.PathLike | str) -> None:
    """Write a plan or recorded trace as JSON Lines, one op per line."""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for op in ops:
            f.write(json.dumps(op, sort_keys=True) + "\n")


def load_trace(path: os.PathLike | str, udid: Optional[str] = None) -> list[dict]:
    """
    Read a trace written by save_trace() or recorder.py. With `udid`, that UDID is replaced
    by "{udid}" wherever it appears, for a trace recorded without the placeholder.
    """
    ops = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                op = json.loads(line)
                if udid:
                    op = json.loads(json.dumps(op).replace(udid, UDID_PLACEHOLDER))
                ops.append(op)
    return ops
