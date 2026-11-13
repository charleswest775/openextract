"""
Back up my iPhone on a computer without Apple's iPhone software (#184).

pymobiledevice3 reaches iPhones through usbmuxd, which Windows only gets from Apple's
software (Apple Devices or iTunes) and Linux from the usbmuxd package. Without it the
engine must answer backup.list_devices with a DEVICE_SERVICE_REQUIRED error, which the
app shows as a setup card, and keep running. These tests start the real engine
(python/main.py, or the binary in $OPENEXTRACT_SIDECAR) and talk to it over JSON-RPC,
the way the app does.

They skip on a computer that has usbmuxd, such as any Mac. Environment variables:

- OPENEXTRACT_EXPECT_NO_DEVICE_SERVICE=1: fail, rather than skip, when usbmuxd is
  there. CI sets it on GitHub's Windows and Linux runners, which have no Apple software.
- OPENEXTRACT_TEST_APPLE_DEVICES=1 (Windows): also install Apple Devices with
  backup.install_device_support (winget, from the Microsoft Store), check the engine
  reaches Apple's service, then stop the service and check the engine starts it again.
  That installs software and accepts the Microsoft Store's and Apple's terms, so only
  set it on a throwaway machine such as a hosted runner (windows-device-support.yml).
"""

import os
import socket
import subprocess
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "corpus"))
from sidecar_client import SidecarClient, SidecarError  # noqa: E402

WINDOWS = sys.platform == "win32"
APPLE_USBMUXD = ("127.0.0.1", 27015)  # Apple's usbmuxd on Windows
PREFIX = "DEVICE_SERVICE_REQUIRED: "


def _powershell(command: str) -> str:
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True, text=True, timeout=60,
    ).stdout.strip()


def _apple_usbmuxd_listening() -> bool:
    try:
        with socket.create_connection(APPLE_USBMUXD, timeout=1):
            return True
    except OSError:
        return False


def _apple_devices_installed() -> bool:
    return bool(_powershell("(Get-AppxPackage AppleInc.AppleDevices).Version"))


def _device_service_present() -> bool:
    """Whether this computer has usbmuxd, running or ready to start."""
    if WINDOWS:
        itunes = subprocess.run(["sc.exe", "query", "Apple Mobile Device Service"],
                                capture_output=True).returncode == 0
        return _apple_usbmuxd_listening() or itunes or _apple_devices_installed()
    return os.path.exists("/var/run/usbmuxd") or "USBMUXD_SOCKET_ADDRESS" in os.environ


@pytest.fixture
def engine():
    with SidecarClient() as client:
        yield client


@pytest.fixture
def no_device_service():
    if _device_service_present():
        if os.environ.get("OPENEXTRACT_EXPECT_NO_DEVICE_SERVICE") == "1":
            pytest.fail("This computer has usbmuxd (Apple's software or the usbmuxd package), "
                        "so it can't check what the engine does without it")
        pytest.skip("this computer has usbmuxd")


@pytest.mark.usefixtures("no_device_service")
def test_list_devices_says_what_to_install(engine):
    for attempt in (1, 2):  # the second time is the card's Check again
        with pytest.raises(SidecarError) as error:
            engine.call("backup.list_devices", timeout=120)
        message = error.value.message
        assert message.startswith(PREFIX), message
        if WINDOWS:
            assert "Apple Devices" in message, message
        elif sys.platform.startswith("linux"):
            assert "usbmuxd" in message, message
    assert engine.call("ping")["status"] == "ok"  # still running


@pytest.mark.skipif(WINDOWS, reason="Windows installs Apple Devices; see test_install_apple_devices")
def test_install_device_support_is_for_windows(engine):
    with pytest.raises(SidecarError) as error:
        engine.call("backup.install_device_support")
    assert error.value.message == "Only Windows needs Apple Devices."
    assert engine.call("ping")["status"] == "ok"


@pytest.mark.skipif(not WINDOWS or os.environ.get("OPENEXTRACT_TEST_APPLE_DEVICES") != "1",
                    reason="installs Apple Devices: Windows with OPENEXTRACT_TEST_APPLE_DEVICES=1 only")
def test_install_apple_devices(engine):
    # Installs it with winget if it's missing, and starts Apple's service either way.
    assert engine.call("backup.install_device_support", timeout=900) == {"installed": True}
    assert _apple_devices_installed()
    assert "devices" in engine.call("backup.list_devices", timeout=120)
    assert _apple_usbmuxd_listening()

    # Nothing starts Apple's service until the next sign-in, so the engine does.
    _powershell("Stop-Process -Name AppleMobileDeviceProcess, AppleMobileDeviceLauncher -Force "
                "-ErrorAction SilentlyContinue")
    deadline = time.monotonic() + 10
    while _apple_usbmuxd_listening() and time.monotonic() < deadline:
        time.sleep(0.5)
    assert not _apple_usbmuxd_listening(), "couldn't stop Apple's service"
    assert "devices" in engine.call("backup.list_devices", timeout=120)
    assert _apple_usbmuxd_listening()
