"""
Searching for iPhones (backup.list_devices) and asking one to trust this computer
(backup.pair_device), end to end, against the scripted fake iPhone (python/tests/fake_iphone).

One iPhone that never answered made the search run until the app gave up 5 minutes later, and
everything else the app asked for waited behind it (OE-37, OE-8, OE-31, all on Windows). The
engine now gives each step of the search a time limit and lists a silent iPhone as not
answering, and pair_device, which the app calls every 2 seconds for an iPhone that doesn't
trust this computer yet, has the same limits. As in test_fake_iphone_backup.py, nothing in
pymobiledevice3 is mocked: the engine runs, and the fake iPhone answers, or doesn't, on the
other end.
"""

import re
import sys
import time
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fake_iphone import FakeIPhone, pair, run_search  # noqa: E402

import device_backup  # noqa: E402

pytestmark = pytest.mark.fake_iphone

REPO = HERE.parents[1]
# Words a non-technical person shouldn't have to read. usbmuxd may follow a plain description,
# as in _device_service_error, so someone can look it up, but never stands for one.
JARGON = re.compile(r"sidecar|engine|lockdown|handshake|timed? ?out|RSD", re.I)

# Shortened limits for these scenarios, so a silent iPhone costs a second, not ten.
ANSWER_S = 1.0
USB_SEARCH_S = 3.0
# A search that waited out ANSWER_S. Windows' clock ticks every ~16 ms, so it can read 0.985 s.
WAITED_S = ANSWER_S - 0.1


@pytest.fixture(autouse=True)
def quick_limits(monkeypatch):
    monkeypatch.setattr(device_backup, "_ANSWER_TIMEOUT_S", ANSWER_S)
    monkeypatch.setattr(device_backup, "_CLOSE_TIMEOUT_S", 0.3)
    monkeypatch.setattr(device_backup, "_USB_SEARCH_TIMEOUT_S", USB_SEARCH_S)
    monkeypatch.setattr(device_backup, "_PAIR_TIMEOUT_S", USB_SEARCH_S)


def _assert_plain(message, usbmuxd_named=False):
    assert message and not JARGON.search(message), message
    if not usbmuxd_named:
        assert "usbmux" not in message, message


def test_search_finds_an_iphone_that_answers():
    phone = FakeIPhone(will_encrypt=True)
    run = run_search(phone)

    assert run.error is None
    assert run.devices == [{
        "udid": phone.udid,
        "name": run.devices[0]["name"],  # pymobiledevice3 names it after its model
        "ios_version": "18.1",
        "connection_type": "usb",
        "trusted": True,
        "encrypts_backups": True,
        "answering": True,
    }]
    assert run.seconds < ANSWER_S


def test_iphone_that_never_answers_its_handshake_is_listed_as_not_answering():
    phone = FakeIPhone(stops_answering="handshake")
    run = run_search(phone, hang_timeout=20)

    # Back within the limit, not after the app's 5 minutes.
    assert run.error is None
    assert WAITED_S <= run.seconds < ANSWER_S + 2
    [device] = run.devices
    assert device["udid"] == phone.udid
    assert device["connection_type"] == "usb"
    assert device["answering"] is False
    # Not False: the app would ask an iPhone that doesn't answer to trust this computer.
    assert device["trusted"] is None
    assert device["ios_version"] == ""
    _assert_plain(device["message"])
    assert "Unplug it, unlock it, plug it back in, then click Refresh" in device["message"]
    assert "restart your iPhone" in device["message"]
    assert any("lockdown handshake: no answer" in event for _, event in phone.events)


def test_iphone_that_stops_answering_after_its_handshake_is_listed_as_not_answering():
    phone = FakeIPhone(stops_answering="questions")
    run = run_search(phone, hang_timeout=20)

    assert run.error is None
    assert WAITED_S <= run.seconds < ANSWER_S + 2
    [device] = run.devices
    assert device["answering"] is False and device["trusted"] is None
    # It said who it is before it went quiet.
    assert device["ios_version"] == "18.1" and device["name"] != "iPhone"
    _assert_plain(device["message"])


def test_device_service_that_never_answers_is_a_plain_error(monkeypatch):
    # usbmuxd (on Windows, Apple Devices' AppleMobileDeviceProcess) takes the connection but
    # never sends the list of devices.
    phone = FakeIPhone()

    async def never_lists(*args, **kwargs):
        await phone.never_answer("usbmuxd device list")

    monkeypatch.setattr(phone, "_list_devices", never_lists)
    run = run_search(phone, hang_timeout=20)

    assert run.result is None
    assert WAITED_S <= run.seconds < ANSWER_S + 4
    _assert_plain(run.error, usbmuxd_named=True)
    # Not DEVICE_SERVICE_REQUIRED: on Windows that offers to install Apple Devices.
    assert not run.error.startswith(device_backup.DEVICE_SERVICE_PREFIX)
    assert "isn't answering" in run.error and "Refresh" in run.error


@pytest.mark.parametrize("platform, fix", [
    ("win32", "restart your iPhone and your PC, which also restarts Apple Devices"),
    ("darwin", "restart your iPhone, then try again"),
    ("linux", "restart your iPhone, then try again"),
])
def test_not_answering_says_what_to_do_on_each_system(monkeypatch, platform, fix):
    monkeypatch.setattr(sys, "platform", platform)
    for connection, first in [("usb", "Unplug it"), ("wifi", "Plug it into this computer with a cable")]:
        message = device_backup._not_answering_message(connection)
        _assert_plain(message)
        assert first in message and fix in message, message


@pytest.mark.parametrize("platform, fix", [
    ("win32", "Apple Devices, which Windows uses to talk to iPhones, isn't answering. Restart your PC"),
    ("darwin", "Restart your Mac"),
    ("linux", "sudo systemctl restart usbmuxd"),
])
def test_device_service_not_answering_says_what_to_do_on_each_system(monkeypatch, platform, fix):
    monkeypatch.setattr(sys, "platform", platform)
    message = str(device_backup._device_service_not_answering())
    _assert_plain(message, usbmuxd_named=True)
    assert fix in message and "click Refresh" in message


def test_the_engines_limits_end_a_search_before_the_app_stops_waiting(monkeypatch):
    # The real limits, not this file's shortened ones.
    monkeypatch.undo()
    assert device_backup._ANSWER_TIMEOUT_S <= 10
    # One iPhone: a handshake, one question and closing fit in the USB step.
    assert 2 * device_backup._ANSWER_TIMEOUT_S + device_backup._CLOSE_TIMEOUT_S <= device_backup._USB_SEARCH_TIMEOUT_S
    # usbmuxd's list (with _run_bounded's 2 s to spare), then every USB iPhone at once.
    worst = device_backup._ANSWER_TIMEOUT_S + 2 + device_backup._USB_SEARCH_TIMEOUT_S
    main_ts = (REPO / "electron" / "main.ts").read_text(encoding="utf-8")
    app_limit_s = int(re.search(r"const LIST_DEVICES_TIMEOUT_MS = ([\d_]+);", main_ts)[1].replace("_", "")) / 1000
    assert "method === 'backup.list_devices' ? LIST_DEVICES_TIMEOUT_MS" in main_ts
    # The app's limit leaves room for starting Apple Devices on Windows on top (usually ~10 s).
    assert worst + 30 <= app_limit_s, (worst, app_limit_s)


# ── Asking an iPhone to trust this computer (backup.pair_device) ─────────────

def _pair_requests_sent(phone):
    """The pairing records the computer sent, one per Pair request."""
    return [r["PairRecord"] for r in phone.pair_requests]


def _timed_search(manager):
    """list_devices() with the phone already plugged in, and how long it took."""
    t0 = time.monotonic()
    result = manager.list_devices()
    return {**result, "seconds": time.monotonic() - t0}


def test_iphone_asks_once_until_the_user_taps_trust():
    phone = FakeIPhone(paired=False)
    manager = device_backup.DeviceBackupManager()
    with phone.plugged_in():
        states = []
        for trust in ("pending", "locked", "trusted"):
            phone.trust = trust
            run = pair(phone, manager)
            assert run.error is None, run.error
            states.append(run.state)
        search = manager.list_devices()

    assert states == ["waiting", "locked", "trusted"]
    # One request, sent three times: the iPhone showed "Trust This Computer?" once.
    sent = _pair_requests_sent(phone)
    assert len(sent) == 3 and sent[1] == sent[0] and sent[2] == sent[0]
    assert phone.pair_record["HostID"] == sent[0]["HostID"]
    assert phone.pair_record["HostPrivateKey"] and phone.pair_record["EscrowBag"] == b"fake escrow bag"
    [device] = search["devices"]
    assert device["trusted"] is True and device["answering"] is True


def test_iphone_that_wasnt_trusted_is_asked_again_with_a_new_request():
    phone = FakeIPhone(paired=False, trust="denied")
    manager = device_backup.DeviceBackupManager()
    with phone.plugged_in():
        states = [pair(phone, manager).state, pair(phone, manager).state]

    assert states == ["denied", "waiting"]
    first, second = _pair_requests_sent(phone)
    assert first["HostCertificate"] != second["HostCertificate"]


@pytest.mark.parametrize("fault, event", [
    ("handshake", "lockdown handshake: no answer"),
    ("questions", "lockdown get_value /DevicePublicKey: no answer"),
    ("pairing", "lockdown Pair: no answer"),
])
def test_iphone_that_stops_answering_while_asked_to_trust_is_not_answering(fault, event):
    # It answered the search, so the app asks it to trust this computer, then it went quiet.
    phone = FakeIPhone(paired=False, stops_answering=fault)
    with phone.plugged_in():
        run = pair(phone, device_backup.DeviceBackupManager(), hang_timeout=20)

    # Back within the limit, not when the app gives up 5 minutes later.
    assert run.error is None, run.error
    assert WAITED_S <= run.seconds < ANSWER_S + 2
    assert run.state == "not_answering"
    _assert_plain(run.result["message"])
    assert "Unplug it, unlock it, plug it back in, then click Refresh" in run.result["message"]
    assert any(event in e for _, e in phone.events), phone.events


def test_iphone_that_doesnt_answer_trust_leaves_the_engine_free_and_gets_the_same_request():
    phone = FakeIPhone(paired=False, stops_answering="pairing")
    manager = device_backup.DeviceBackupManager()
    with phone.plugged_in():
        quiet = pair(phone, manager, hang_timeout=20)
        # The engine works on one request at a time: the next one is answered at once.
        search = _timed_search(manager)
        # It answers again (unplugged and plugged back in), and the user taps Trust.
        phone.stops_answering = None
        phone.trust = "trusted"
        trusted = pair(phone, manager)

    assert quiet.state == "not_answering"
    assert search["seconds"] < ANSWER_S
    [device] = search["devices"]
    assert device["answering"] is True and device["trusted"] is False
    assert trusted.state == "trusted"
    # The request it didn't answer may be the one it showed "Trust This Computer?" for: it's
    # sent again, rather than a new one that would make the iPhone ask again.
    first, second = _pair_requests_sent(phone)
    assert first == second


def test_asking_to_trust_ends_before_the_app_stops_waiting(monkeypatch):
    monkeypatch.undo()
    # A step that misses its limit is reported by that limit, its connection closed.
    assert device_backup._ANSWER_TIMEOUT_S + device_backup._CLOSE_TIMEOUT_S < device_backup._PAIR_TIMEOUT_S
    sidecar_ts = (REPO / "electron" / "sidecar.ts").read_text(encoding="utf-8")
    app_limit_s = int(re.search(r"TIMEOUT_MS = (\d+);", sidecar_ts)[1]) / 1000
    assert device_backup._PAIR_TIMEOUT_S * 4 <= app_limit_s, (device_backup._PAIR_TIMEOUT_S, app_limit_s)
