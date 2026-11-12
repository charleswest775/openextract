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
    {"op": "MoveItems", "items": {"{udid}/Snapshot/3d/3d0d7e5f...": "{udid}/3d/3d0d7e5f..."}, "progress": 99}
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

synthetic_backup() follows a trace of a real first full backup (an iPhone 17 on iOS 27.2 into an
empty folder, 2026-11-10; 47,277 files, 68 GB): it creates <udid>/<xx> and <udid>/Snapshot/<xx>
for all 256 <xx>, sends every file to Snapshot/<xx>/<fileID> in batches of up to 128, moves
them ONE FILE AT A TIME (128 per message) to <xx>/<fileID>, then Manifest.plist and Manifest.db,
removes Snapshot, reads Status.plist, Manifest.plist and Manifest.db back, and lists every
folder. Status.plist is written in place four times. A second backup into the same folder
hasn't been traced.
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


ALL_PREFIXES = [f"{i:02x}" for i in range(256)]
MOVES_PER_MESSAGE = 128


def _status_upload(progress: float) -> dict:
    status = {"path": f"{UDID_PLACEHOLDER}/Status.plist", "device_name": "Status.plist", "size": 0,
              "generate": "status_plist"}
    return {"op": "UploadFiles", "progress": progress, "files": [status]}


def synthetic_backup(
    file_count: int = 120,
    large_files: Iterable[int] = (3 * MiB, 3 * MiB, 5 * MiB),
    batch_size: int = 128,
) -> list[dict]:
    """
    A first full backup of a fictional iPhone, in the order a real one sends it (see the module's
    docstring). Large files are generated as they're sent, so a "video" costs nothing until the
    computer writes it.
    """
    u, snapshot = UDID_PLACEHOLDER, f"{UDID_PLACEHOLDER}/Snapshot"
    files = _sample_files(file_count, large_files)
    for f in files:
        fid = file_id(f["domain"], f["relative_path"])
        f["path"] = f"{snapshot}/{fid[:2]}/{fid}"

    ops: list[dict] = [
        # The last backup's Status.plist (pymobiledevice3 has just written one), then a pause while
        # the iPhone prepares (22 s in the trace).
        {"op": "DownloadFiles", "paths": [f"{u}/Status.plist"], "progress": 0},
        {"op": "GetFreeDiskSpace"},
        {"op": "CreateDirectory", "path": u},
        *({"op": "CreateDirectory", "path": f"{u}/{xx}"} for xx in ALL_PREFIXES),
        {"op": "CreateDirectory", "path": snapshot},
        *({"op": "CreateDirectory", "path": f"{snapshot}/{xx}"} for xx in ALL_PREFIXES),
        _status_upload(0.08),
    ]
    batches = [files[i:i + batch_size] for i in range(0, len(files), batch_size)]
    for i, batch in enumerate(batches):
        ops.append({"op": "UploadFiles", "progress": round(0.08 + 98.8 * (i + 1) / len(batches), 3), "files": batch})
    for name, kind in (("Manifest.plist", "manifest_plist"), ("Manifest.db", "manifest_db")):
        ops.append({"op": "UploadFiles", "progress": 98.9, "files": [
            {"path": f"{snapshot}/{name}", "device_name": name, "size": 0, "generate": kind}]})
    ops.append(_status_upload(98.9))

    moves = [(f["path"], f"{u}/{f['path'][len(snapshot) + 1:]}") for f in files]
    chunks = [moves[i:i + MOVES_PER_MESSAGE] for i in range(0, len(moves), MOVES_PER_MESSAGE)]
    for i, chunk in enumerate(chunks):
        ops.append({"op": "MoveItems", "items": dict(chunk), "progress": round(98.9 + 1.09 * (i + 1) / len(chunks), 4)})
    for name in ("Manifest.plist", "Manifest.db"):
        ops.append({"op": "MoveItems", "items": {f"{snapshot}/{name}": f"{u}/{name}"}, "progress": 99.999})

    ops += [
        _status_upload(99.999),
        {"op": "RemoveItems", "paths": [snapshot], "progress": 99.9996},
        {"op": "RemoveItems", "paths": [f"{u}/Manifest.mbdx"], "progress": 99.9998},
        _status_upload(100.0),
        *({"op": "DownloadFiles", "paths": [f"{u}/{name}"], "progress": 100.0}
          for name in ("Status.plist", "Manifest.plist", "Manifest.db")),
        {"op": "ContentsOfDirectory", "path": u},
        *({"op": "ContentsOfDirectory", "path": f"{u}/{xx}"} for xx in ALL_PREFIXES),
        {"op": "ProcessMessage", "content": {"ErrorCode": 0, "MessageName": "Response"}},
    ]
    return ops


def uploaded_files(ops: Iterable[dict]) -> list[dict]:
    """Every file the plan sends, in order."""
    return [f for op in ops if op["op"] == "UploadFiles" for f in op["files"]]


def payload_bytes(ops: Iterable[dict]) -> int:
    """Bytes of file data in the plan, not counting generated metadata files."""
    return sum(f["size"] for f in uploaded_files(ops) if not f.get("generate") and not f.get("error"))


def final_locations(ops: Iterable[dict]) -> dict[str, str]:
    """{path a file was sent to: where it is once the plan's moves are done}, for every file sent."""
    ops = list(ops)
    where = {f["path"]: f["path"] for f in uploaded_files(ops)}
    sent_to = {path: path for path in where}  # current path -> path it was sent to
    for op in ops:
        if op["op"] != "MoveItems":
            continue
        for src, dst in op["items"].items():
            if src in sent_to:
                original = sent_to.pop(src)
                where[original] = dst
                sent_to[dst] = original
                continue
            inside = src + "/"  # a folder: everything in it moves with it
            for current in [c for c in sent_to if c.startswith(inside)]:
                original = sent_to.pop(current)
                where[original] = dst + current[len(src):]
                sent_to[where[original]] = original
    return where


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


def status_plist(state: str = "finished") -> bytes:
    """The iPhone's Status.plist. A step can give its "state": "finished" is the only one a real
    backup's last Status.plist has; what it writes before that isn't in the trace (names only)."""
    return plistlib.dumps({
        "BackupState": "new",
        "Date": datetime.now(timezone.utc).replace(tzinfo=None),
        "IsFullBackup": True,
        "SnapshotState": state,
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
