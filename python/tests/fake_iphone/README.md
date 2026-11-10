# The fake iPhone

A scripted iPhone that OpenExtract's engine backs up as if one were plugged in, so the whole
backup path runs in CI on Windows, macOS and Linux without a phone. The scenarios are in
[`../test_fake_iphone_backup.py`](../test_fake_iphone_backup.py).

```bash
pytest python/tests/test_fake_iphone_backup.py -v    # or: pytest python/tests -m fake_iphone
```

Each scenario takes about a second; all of them, under 10 seconds.

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
{"op": "MoveItems", "items": {"{udid}/Snapshot/3d": "{udid}/3d"}, "progress": 100}
{"op": "ProcessMessage", "content": {"ErrorCode": 0}}
```

`synthetic_backup()` makes a full backup of a fictional iPhone: about 120 small files, three big
"videos" (made up as they're sent, so they cost nothing until written), a real `Manifest.db`. Files
arrive in `Snapshot/<xx>/`, are moved into place, and `Snapshot` is removed. That order is a model
built from the field reports and pymobiledevice3; a trace from a real iPhone should replace it.

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
message names, paths, sizes and progress, never file contents. The iPhone's own file names are
replaced by a hash unless `--keep-names`, and its UDID by `{udid}`. With the iPhone plugged in:

```bash
python python/tests/fake_iphone/recorder.py --out <empty folder> --trace backup-trace.jsonl
```

Put the trace in [`traces/`](traces) and `test_replay_trace` replays it on every run. Add
`pace=1` to `FakeIPhone` to replay it at the speed it was recorded.
`traces/synthetic-small-backup.jsonl` was recorded from the fake iPhone itself, so it shows the
format; it isn't evidence of what a real iPhone does.
