# The fake iPhone

A scripted iPhone that OpenExtract's engine backs up as if one were plugged in, so the whole
backup path runs in CI on Windows, macOS and Linux without a phone. The scenarios are in
[`../test_fake_iphone_backup.py`](../test_fake_iphone_backup.py).

```bash
pytest python/tests/test_fake_iphone_backup.py -v    # or: pytest python/tests -m fake_iphone
```

Each scenario takes about a second; all of them, about 13 seconds.

## What's real and what's fake

Real, on the computer's side: `DeviceBackupManager.start_backup()` (`python/device_backup.py`),
pymobiledevice3's `Mobilebackup2Service.backup()`, `DeviceLink` (`upload_files`, `move_items`,
`remove_items`, ...), `ServiceConnection`, `NotificationProxyService` and `AfcService`, and the
files they write to disk.

Fake: the iPhone. `FakeIPhone` patches pymobiledevice3's usbmux device list and
`create_using_usbmux()`, and hands out a `LockdownClient` subclass whose services are socket
pairs. The iPhone's end of each runs in a thread ([`services.py`](services.py)): MobileBackup2
plays a backup plan step by step, and notification proxy, AFC, installation proxy and SpringBoard
answer just enough for a backup. On Windows a socket pair is a TCP connection over 127.0.0.1, as
usbmuxd's is.

`test_backup.py` replaces pymobiledevice3 with mocks in `sys.modules` when pytest collects it;
[`real_modules.py`](real_modules.py) puts the real modules back while a fake iPhone is plugged in.

## The backup plan

A plan is a list of DeviceLink steps ([`plan.py`](plan.py) lists them all):

```python
{"op": "CreateDirectory", "path": "{udid}/Snapshot/3d"}
{"op": "UploadFiles", "progress": 12.5, "files": [{"path": "{udid}/Snapshot/3d/3d0d...", "size": 52133}]}
{"op": "MoveItems", "items": {"{udid}/Snapshot/3d/3d0d...": "{udid}/3d/3d0d..."}, "progress": 99}
{"op": "ProcessMessage", "content": {"ErrorCode": 0}}
```

`synthetic_backup()` makes a first full backup of a fictional iPhone: about 120 small files and
three big "videos" (14 MB in all, made up as they're sent), and a real `Manifest.db`. Its order
follows a trace of a real one (an iPhone 17 on iOS 27.2, 47,277 files):
1. The iPhone reads `Status.plist`, asks for free space, and creates `<xx>` and `Snapshot/<xx>`
   for all 256 `<xx>`.
2. It sends every file to `Snapshot/<xx>/<fileID>`, up to 128 files per message, then
   `Manifest.plist` and `Manifest.db`.
3. It moves the files one by one, 128 per message, to `<xx>/<fileID>`, then the two manifests.
4. It removes `Snapshot`, reads the three metadata files back, and lists every folder.
5. `Status.plist` is written in place four times along the way.

A second backup into the same folder hasn't been traced.

## Adding a scenario

1. Make a phone: `FakeIPhone(plan, ...faults)`. Change the plan (it's a plain list) for anything
   the iPhone does differently: insert `{"op": "Drop"}` where it hangs up, give a file
   `"error": "..."` for one it can't read, add `{"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED}`
   and `{"op": "Sleep", "seconds": 1}` for a passcode prompt.
2. Add faults:
   - on the iPhone: `drop_after_bytes`, `unplug_on_drop`, `drop_everything`, `reset_on_drop`,
     `stall_timeout`, `refuse_attempts={0: {"ErrorCode": 208}}`, `sync_lock_busy`, `locked`
     (see `FakeIPhone`'s docstring);
   - on the computer: `slow_disk()`, `stalling_disk()`, `failing_disk()` (monkeypatch
     pymobiledevice3's writes), and `InUse` / `in_use()` for a file or folder another program has
     open. On Windows that's a real open handle; elsewhere the folder is made read-only;
   - at the right moment: `phone.before("MoveItems", fn)` runs `fn` in the iPhone's thread just
     before it sends that step.
3. `run = run_backup(phone, out)` and assert what the app would get: `run.error` (the text the
   app shows) or `run.result`, `run.progress` (every `backup.progress` notification, with `t`),
   `run.phases`, `run.files()`, and `run.assert_progress_never_goes_back()`. The phone's side is
   in `phone.final_answers`, `phone.statuses`, `phone.events`.

A scenario that shows a bug nobody has fixed yet gets `@pytest.mark.xfail(strict=True, reason=...)`
(see `docs/TESTING.md`). If the iPhone's own side fails (`phone.errors`), `run_backup` fails the
test: that's a bug in the fake, not the engine.

## Recording a real backup

[`recorder.py`](recorder.py) records what a real iPhone sends during a backup, as a plan:
message names, paths, sizes and progress, never file contents. With the iPhone plugged in:

```bash
python python/tests/fake_iphone/recorder.py --out <empty folder> --trace backup-trace.jsonl
```

Traces are scrubbed by default. File IDs are SHA-1s of the file's domain and path, so a
dictionary of known paths could tell which apps an iPhone has; each keeps its `<xx>` folder and
gets a salted hash for the rest. The iPhone's own file names become `file-000001`, `file-000002`,
…, and sizes are rounded to two significant figures. `--raw` keeps everything, for looking at
locally; never commit a raw trace. `recorder.py scrub raw.jsonl scrubbed.jsonl` scrubs one
afterwards.

A trace in [`traces/`](traces) is replayed by `test_replay_trace` on every run.
`FakeIPhone(plan, pace=1)` replays one at its recorded speed. `FakeIPhone(plan, size_cap=1024)`
sends at most 1 KiB of each file, so a 68 GB trace replays in seconds.
`traces/synthetic-small-backup.jsonl` was recorded from the fake iPhone itself, to show the format.
