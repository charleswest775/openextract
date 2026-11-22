"""
An engine to kill partway through a backup: no except or finally block runs, as in a crash or a
power cut. test_backup_beside.py starts this, waits for it to say it's at `stage`, and kills it.

    python killed_engine.py <folder to back up into> <stage> <udid>
"""

import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

from fake_iphone import FakeIPhone, run_backup  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402

import backup_beside  # noqa: E402
import device_backup  # noqa: E402

STAGES = ("passcode", "transfer", "moving", "finishing", "before the rename", "after the rename")


def main() -> None:
    out, stage, udid = sys.argv[1:]
    assert stage in STAGES, stage
    device_backup._BYTES_REPORT_INTERVAL_S = 0.05

    def wait_to_be_killed(*_args) -> None:
        # The pid, not the parent's: on Windows a venv's python.exe starts the real one.
        print(f"READY {os.getpid()}", flush=True)
        time.sleep(120)
        os._exit(3)

    ops = plans.synthetic_backup(file_count=20, large_files=())
    if stage == "passcode":
        ops.insert(0, {"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED})
    phone = FakeIPhone(ops, udid=udid, will_encrypt=True)
    before_op = {"passcode": "DownloadFiles", "transfer": "MoveItems", "moving": "RemoveItems",
                 "finishing": "ContentsOfDirectory"}
    if stage in before_op:
        phone.before(before_op[stage], wait_to_be_killed)

    rename = backup_beside.Destination._rename

    def rename_or_die(self, src, dst):
        if stage == "before the rename":
            wait_to_be_killed()
        renamed = rename(self, src, dst)
        if stage == "after the rename":
            wait_to_be_killed()
        return renamed

    backup_beside.Destination._rename = rename_or_die
    run_backup(phone, Path(out), hang_timeout=150)
    print("FINISHED", flush=True)


if __name__ == "__main__":
    main()
