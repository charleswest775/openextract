"""A scripted fake iPhone that runs OpenExtract's whole backup path without a phone. See README.md."""

from .device import DEFAULT_UDID, FakeIPhone
from .harness import (BackupRun, InUse, PairRun, SearchRun, failing_disk, in_use, pair, run_backup,
                      run_search, slow_disk)
from .plan import load_trace, save_trace, synthetic_backup

__all__ = [
    "DEFAULT_UDID",
    "BackupRun",
    "FakeIPhone",
    "InUse",
    "PairRun",
    "SearchRun",
    "failing_disk",
    "in_use",
    "load_trace",
    "pair",
    "run_backup",
    "run_search",
    "save_trace",
    "slow_disk",
    "synthetic_backup",
]
