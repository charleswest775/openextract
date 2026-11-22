"""
An engine to kill partway through a backup: no except or finally block runs, as in a crash or a
power cut. test_backup_replace.py starts this, waits for it to say it's at `stage`, and kills it.

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

import backup_replace  # noqa: E402
import device_backup  # noqa: E402

STAGES = ("passcode", "transfer", "moving", "finishing", "before the swap", "between the renames",
          "after the swap", "deleting")


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

    rename = backup_replace._rename
    renames = [0]

    def rename_until(src, dst, *args, **kwargs):
        renames[0] += 1
        if (stage, renames[0]) in (("before the swap", 1), ("between the renames", 2), ("after the swap", 3)):
            wait_to_be_killed()
        return rename(src, dst, *args, **kwargs)

    backup_replace._rename = rename_until
    if stage == "deleting":
        remove = os.remove
        removed = [0]

        def remove_some(path, *args, **kwargs):
            if f"{udid}{backup_replace._OLD}" in str(path):
                removed[0] += 1
                if removed[0] == 3:
                    wait_to_be_killed()
            return remove(path, *args, **kwargs)

        os.remove = remove_some

    run_backup(phone, Path(out), hang_timeout=150)
    print("FINISHED", flush=True)


if __name__ == "__main__":
    main()
