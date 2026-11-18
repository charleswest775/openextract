"""
Searching for iPhones (backup.list_devices), end to end, against the scripted fake iPhone
(python/tests/fake_iphone).

One iPhone that never answered made the search run until the app gave up 5 minutes later, and
everything else the app asked for waited behind it (OE-37, OE-8, OE-31, all on Windows). The
engine now gives each step of the search a time limit and lists a silent iPhone as not
answering. As in test_fake_iphone_backup.py, nothing in pymobiledevice3 is mocked: the engine's
list_devices() runs, and the fake iPhone answers, or doesn't, on the other end.
"""

import re
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fake_iphone import FakeIPhone, run_search  # noqa: E402

import device_backup  # noqa: E402

pytestmark = pytest.mark.fake_iphone

REPO = HERE.parents[1]
# Words a non-technical person shouldn't have to read. usbmuxd may follow a plain description,
# as in _device_service_error, so someone can look it up, but never stands for one.
JARGON = re.compile(r"sidecar|engine|lockdown|handshake|timed? ?out|RSD", re.I)

# Shortened limits for these scenarios, so a silent iPhone costs a second, not ten.
ANSWER_S = 1.0
USB_SEARCH_S = 3.0


@pytest.fixture(autouse=True)
def quick_limits(monkeypatch):
    monkeypatch.setattr(device_backup, "_ANSWER_TIMEOUT_S", ANSWER_S)
    monkeypatch.setattr(device_backup, "_CLOSE_TIMEOUT_S", 0.3)
    monkeypatch.setattr(device_backup, "_USB_SEARCH_TIMEOUT_S", USB_SEARCH_S)


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
    assert ANSWER_S <= run.seconds < ANSWER_S + 2
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
    assert ANSWER_S <= run.seconds < ANSWER_S + 2
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
    assert ANSWER_S <= run.seconds < ANSWER_S + 4
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
    # usbmuxd's list (with _run_bounded's 2 s to spare), every USB iPhone at once, then Wi-Fi.
    worst = device_backup._ANSWER_TIMEOUT_S + 2 + device_backup._USB_SEARCH_TIMEOUT_S + device_backup._RSD_TIMEOUT_S
    main_ts = (REPO / "electron" / "main.ts").read_text(encoding="utf-8")
    app_limit_s = int(re.search(r"const LIST_DEVICES_TIMEOUT_MS = ([\d_]+);", main_ts)[1].replace("_", "")) / 1000
    assert "method === 'backup.list_devices' ? LIST_DEVICES_TIMEOUT_MS" in main_ts
    # The app's limit leaves room for starting Apple Devices on Windows on top (usually ~10 s).
    assert worst + 30 <= app_limit_s, (worst, app_limit_s)
