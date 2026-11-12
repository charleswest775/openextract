"""A scripted fake iPhone that runs OpenExtract's whole backup path without a phone. See README.md."""

from .device import DEFAULT_UDID, FakeIPhone
from .harness import BackupRun, InUse, failing_disk, in_use, run_backup, slow_disk
from .plan import load_trace, save_trace, synthetic_backup

__all__ = [
    "DEFAULT_UDID",
    "BackupRun",
    "FakeIPhone",
    "InUse",
    "failing_disk",
    "in_use",
    "load_trace",
    "run_backup",
    "save_trace",
    "slow_disk",
    "synthetic_backup",
]
