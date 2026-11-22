"""
A really encrypted synthetic backup for the backup tests, and a fake-iPhone plan that sends one.

Written by ios-backup-core's backupgen with made-up data and a quick keybag, so "can still be
unlocked" in a test means unlocked with the password, not just that a file kept its size.
"""

from __future__ import annotations

import importlib
import sys
from datetime import datetime, timezone
from pathlib import Path

from corpus.synthetic import backupgen_root
from fake_iphone import plan as plans
from rpc_contract_support import skip_or_fail

PASSWORD = "synthetic backup password"
SMS = ("HomeDomain", "Library/SMS/sms.db")


MADE = datetime(2024, 5, 6, 12, tzinfo=timezone.utc)


def make_encrypted_backup(out: Path, udid: str, *, seed: int = 1, text: bytes = b"the only copy",
                          when: datetime = MADE) -> Path:
    """<out>/<udid>: a finished, encrypted backup whose sms.db holds `text`."""
    root = backupgen_root()
    if root is None:
        skip_or_fail("ios-backup-core's backupgen wasn't found; set OPENEXTRACT_IOS_BACKUP_CORE")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    container = importlib.import_module("backupgen.container")
    device = container.Device(name="Test iPhone", product_type="iPhone15,2", product_name="iPhone 14 Pro",
                              ios="17.3", build="21D50", phone_number="+1 555 0100", udid=udid)
    writer = container.BackupWriter(out_dir=out, device=device, seed=seed, password=PASSWORD,
                                    backup_date=when,
                                    container_version="17.3")
    writer.add_file(*SMS, text)
    for i in range(12):
        writer.add_file("CameraRollDomain", f"Media/DCIM/100APPLE/IMG_{i:04d}.HEIC", bytes([i]) * (400 + i))
    return writer.finalize()


def plan_sending(backup_dir: Path) -> list[dict]:
    """A backup plan in the order a real iPhone uses (plan.py), sending this backup's own bytes."""
    u, snapshot = plans.UDID_PLACEHOLDER, f"{plans.UDID_PLACEHOLDER}/Snapshot"
    stored = sorted(p for p in backup_dir.glob("??/*") if p.is_file())
    folders = sorted({p.parent.name for p in stored})
    status = {"op": "UploadFiles", "progress": 1, "files": [
        {"path": f"{u}/Status.plist", "device_name": "Status.plist", "size": 0,
         "data": (backup_dir / "Status.plist").read_bytes()}]}

    def sending(path: Path, name: str) -> dict:
        data = path.read_bytes()
        return {"path": f"{snapshot}/{name}", "device_name": name, "size": len(data), "data": data}

    payload = [sending(p, f"{p.parent.name}/{p.name}") for p in stored]
    metadata = [sending(backup_dir / name, name) for name in ("Manifest.plist", "Manifest.db")]
    return [
        {"op": "DownloadFiles", "paths": [f"{u}/Status.plist"], "progress": 0},
        {"op": "GetFreeDiskSpace"},
        {"op": "CreateDirectory", "path": u},
        *({"op": "CreateDirectory", "path": f"{u}/{xx}"} for xx in folders),
        {"op": "CreateDirectory", "path": snapshot},
        *({"op": "CreateDirectory", "path": f"{snapshot}/{xx}"} for xx in folders),
        status,
        {"op": "UploadFiles", "progress": 90, "files": payload},
        {"op": "UploadFiles", "progress": 98, "files": metadata},
        *({"op": "MoveItems", "progress": 99, "items": {f["path"]: f["path"].replace("/Snapshot/", "/")}}
          for f in payload + metadata),
        status,
        {"op": "RemoveItems", "paths": [snapshot], "progress": 99.9},
        {"op": "ProcessMessage", "content": {"ErrorCode": 0, "MessageName": "Response"}},
    ]
