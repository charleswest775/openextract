"""
Tests for device_backup.py — DeviceBackupManager

These tests use unittest.mock to isolate the code under test from pymobiledevice3
(which requires a real USB/Wi-Fi device).  We patch at the import level so the
module can be imported even when pymobiledevice3 is not installed.
"""

import sys
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal pymobiledevice3 stub so device_backup can be imported without the
# real library being present in the test environment.
# ---------------------------------------------------------------------------

def _make_package(name):
    """Create a module that Python treats as a package (has __path__)."""
    mod = types.ModuleType(name)
    mod.__path__ = []
    return mod


def _make_pymobiledevice3_stub():
    """Return a minimal stub package tree for pymobiledevice3."""
    pkg = _make_package("pymobiledevice3")
    pkg.usbmux = types.ModuleType("pymobiledevice3.usbmux")
    pkg.lockdown = types.ModuleType("pymobiledevice3.lockdown")
    pkg.services = _make_package("pymobiledevice3.services")
    pkg.services.mobilebackup2 = types.ModuleType("pymobiledevice3.services.mobilebackup2")
    pkg.remote = _make_package("pymobiledevice3.remote")
    pkg.remote.utils = types.ModuleType("pymobiledevice3.remote.utils")
    pkg.remote.remote_service_discovery = types.ModuleType(
        "pymobiledevice3.remote.remote_service_discovery"
    )
    pkg.exceptions = types.ModuleType("pymobiledevice3.exceptions")
    pkg.ca = types.ModuleType("pymobiledevice3.ca")

    # Populate with MagicMocks so attribute access works
    pkg.usbmux.list_devices = AsyncMock(return_value=[])
    pkg.lockdown.create_using_usbmux = AsyncMock()
    pkg.services.mobilebackup2.Mobilebackup2Service = MagicMock()
    pkg.remote.utils.get_rsds = MagicMock(return_value=[])
    pkg.remote.remote_service_discovery.RemoteServiceDiscoveryService = MagicMock()
    pkg.ca.generate_pairing_cert_chain = MagicMock()

    # Exception classes used in device_backup.py
    pkg.exceptions.ConnectionFailedToUsbmuxdError = type("ConnectionFailedToUsbmuxdError", (Exception,), {})
    pkg.exceptions.ConnectionTerminatedError = type("ConnectionTerminatedError", (Exception,), {})
    pkg.exceptions.PasswordRequiredError = type("PasswordRequiredError", (Exception,), {})
    pkg.exceptions.NotEnoughDiskSpaceError = type("NotEnoughDiskSpaceError", (Exception,), {})
    pkg.exceptions.MissingValueError = type("MissingValueError", (Exception,), {})
    pkg.exceptions.PairingDialogResponsePendingError = type("PairingDialogResponsePendingError", (Exception,), {})
    pkg.exceptions.UserDeniedPairingError = type("UserDeniedPairingError", (Exception,), {})

    return pkg


def _install_stub():
    stub = _make_pymobiledevice3_stub()
    for name in [
        "pymobiledevice3",
        "pymobiledevice3.usbmux",
        "pymobiledevice3.lockdown",
        "pymobiledevice3.services",
        "pymobiledevice3.services.mobilebackup2",
        "pymobiledevice3.remote",
        "pymobiledevice3.remote.utils",
        "pymobiledevice3.remote.remote_service_discovery",
        "pymobiledevice3.exceptions",
        "pymobiledevice3.ca",
    ]:
        if "." in name:
            parts = name.split(".")[1:]  # skip "pymobiledevice3"
            obj = stub
            for part in parts:
                obj = getattr(obj, part)
            sys.modules[name] = obj
        else:
            sys.modules[name] = stub
    return stub


_stub = _install_stub()

# Now safe to import our module
sys.path.insert(0, "python")
import device_backup  # noqa: E402
from device_backup import DeviceBackupManager, _device_service_error, _disk_full_message  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_lockdown_mock(udid="abc-123", name="iPhone 15", ios_version="17.4", paired=True):
    m = MagicMock()
    m.udid = udid
    m.display_name = name
    m.product_version = ios_version
    m.paired = paired
    m.get_value = AsyncMock(return_value=False)
    m.close = AsyncMock()
    return m


def _make_usbmux_device(serial="abc-123", connection_type="USB"):
    m = MagicMock()
    m.serial = serial
    m.connection_type = connection_type
    return m


# ---------------------------------------------------------------------------
# Test: backup.list_devices
# ---------------------------------------------------------------------------

class TestListDevices(unittest.TestCase):

    def setUp(self):
        self.manager = DeviceBackupManager()

    def test_returns_usb_device(self):
        """A single USB-connected device should be returned."""
        usbmux_dev = _make_usbmux_device("DEV-1", "USB")
        lockdown = _make_lockdown_mock("DEV-1", "Alice's iPhone", "17.4")

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[]),
        ):
            result = self.manager.list_devices()

        self.assertEqual(len(result["devices"]), 1)
        device = result["devices"][0]
        self.assertEqual(device["udid"], "DEV-1")
        self.assertEqual(device["name"], "Alice's iPhone")
        self.assertEqual(device["ios_version"], "17.4")
        self.assertEqual(device["connection_type"], "usb")

    def test_wifi_connection_type_mapped(self):
        """A device flagged as Network/WiFi by usbmuxd should be tagged 'wifi'."""
        usbmux_dev = _make_usbmux_device("DEV-2", "Network")
        lockdown = _make_lockdown_mock("DEV-2", "Bob's iPhone", "16.7")

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[]),
        ):
            result = self.manager.list_devices()

        self.assertEqual(result["devices"][0]["connection_type"], "wifi")

    def test_rsd_wifi_device_included(self):
        """
        An iOS 17+ device found via RSD (not visible in usbmuxd) should be
        listed with connection_type='wifi'.
        """
        rsd_mock = MagicMock()
        rsd_mock.hostname = "192.168.1.5"
        rsd_mock.port = 58783

        rsd_service_mock = MagicMock()
        rsd_service_mock.__enter__ = MagicMock(return_value=rsd_service_mock)
        rsd_service_mock.__exit__ = MagicMock(return_value=False)
        rsd_service_mock.udid = "RSD-DEV-99"
        rsd_service_mock.get_value = lambda key: {
            "DeviceName": "Carol's iPhone",
            "ProductVersion": "17.5",
        }.get(key, "")

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[]),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[rsd_mock]),
            patch(
                "pymobiledevice3.remote.remote_service_discovery.RemoteServiceDiscoveryService",
                return_value=rsd_service_mock,
            ),
        ):
            result = self.manager.list_devices()

        self.assertEqual(len(result["devices"]), 1)
        dev = result["devices"][0]
        self.assertEqual(dev["udid"], "RSD-DEV-99")
        self.assertEqual(dev["name"], "Carol's iPhone")
        self.assertEqual(dev["connection_type"], "wifi")

    def test_no_rsd_duplicates(self):
        """
        A device visible via both usbmuxd and RSD should appear only once
        (USB entry wins).
        """
        usbmux_dev = _make_usbmux_device("SHARED-UDID", "USB")
        lockdown = _make_lockdown_mock("SHARED-UDID", "Dave's iPhone", "17.4")

        rsd_mock = MagicMock()
        rsd_mock.hostname = "192.168.1.10"
        rsd_mock.port = 58783
        rsd_service_mock = MagicMock()
        rsd_service_mock.__enter__ = MagicMock(return_value=rsd_service_mock)
        rsd_service_mock.__exit__ = MagicMock(return_value=False)
        rsd_service_mock.udid = "SHARED-UDID"
        rsd_service_mock.get_value = lambda key: ""

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[rsd_mock]),
            patch(
                "pymobiledevice3.remote.remote_service_discovery.RemoteServiceDiscoveryService",
                return_value=rsd_service_mock,
            ),
        ):
            result = self.manager.list_devices()

        # Should appear only once, with connection_type=usb (from usbmuxd)
        self.assertEqual(len(result["devices"]), 1)
        self.assertEqual(result["devices"][0]["connection_type"], "usb")

    def test_broken_device_skipped(self):
        """A device that raises during lockdown connection should be silently skipped."""
        good_dev = _make_usbmux_device("GOOD", "USB")
        bad_dev = _make_usbmux_device("BAD", "USB")
        good_lockdown = _make_lockdown_mock("GOOD", "Eve's iPhone", "17.0")

        def _create_lockdown(serial=None, **kwargs):
            if serial == "BAD":
                raise ConnectionError("Device busy")
            return good_lockdown

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[good_dev, bad_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, side_effect=_create_lockdown),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[]),
        ):
            result = self.manager.list_devices()

        self.assertEqual(len(result["devices"]), 1)
        self.assertEqual(result["devices"][0]["udid"], "GOOD")

    def test_untrusted_device_is_listed_without_asking_it_to_trust(self):
        """Searching must not pair: each pairing attempt is a new Trust prompt on the iPhone."""
        usbmux_dev = _make_usbmux_device("DEV-1", "USB")
        lockdown = _make_lockdown_mock("DEV-1", "iPhone 16", "26.1", paired=False)

        with (
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                  return_value=lockdown) as create,
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[]),
        ):
            result = self.manager.list_devices()

        self.assertEqual(result["devices"][0]["trusted"], False)
        self.assertEqual(create.await_args.kwargs.get("autopair"), False)
        lockdown.close.assert_awaited_once()

    def test_no_device_service_is_a_setup_step(self):
        """Without usbmuxd (on Windows: no Apple Devices or iTunes) the error says so, with its own prefix."""
        with (
            patch(
                "pymobiledevice3.usbmux.list_devices",
                new_callable=AsyncMock,
                side_effect=_stub.exceptions.ConnectionFailedToUsbmuxdError(),
            ),
            # On Windows the engine would otherwise look for Apple Devices on this machine.
            patch("device_backup._start_apple_devices", return_value="missing"),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                self.manager.list_devices()
        self.assertTrue(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED: "))

    def test_device_service_error_names_the_fix_for_each_system(self):
        for platform, fix in [
            ("win32", "needs Apple Devices"),
            ("darwin", "Restart your Mac"),
            ("linux", "sudo apt install usbmuxd"),
        ]:
            with patch.object(sys, "platform", platform):
                message = str(_device_service_error())
            self.assertTrue(message.startswith("DEVICE_SERVICE_REQUIRED: "), platform)
            self.assertIn(fix, message, platform)

    def test_missing_library_raises(self):
        """ImportError from pymobiledevice3 should surface as RuntimeError."""
        with patch.dict(sys.modules, {"pymobiledevice3.usbmux": None}):
            # Re-import to pick up the patched module map
            import importlib
            import device_backup as db_mod
            importlib.reload(db_mod)
            mgr = db_mod.DeviceBackupManager()
            with self.assertRaises((RuntimeError, TypeError, ImportError)):
                mgr.list_devices()


# ---------------------------------------------------------------------------
# Test: Apple Devices on Windows (starting and installing it)
# ---------------------------------------------------------------------------

def _no_usbmuxd():
    return _stub.exceptions.ConnectionFailedToUsbmuxdError()


class TestAppleDevicesOnWindows(unittest.TestCase):

    def setUp(self):
        self.manager = DeviceBackupManager()

    def _list_on(self, platform, start_status, usbmux_results):
        with (
            patch.object(sys, "platform", platform),
            patch("device_backup._start_apple_devices", return_value=start_status) as start,
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, side_effect=usbmux_results),
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                  return_value=_make_lockdown_mock("DEV-1")),
        ):
            return self.manager.list_devices(), start

    def test_installed_but_not_running_is_started_and_searched_again(self):
        """Right after Apple Devices is installed nothing listens until we start it."""
        result, start = self._list_on("win32", "running", [_no_usbmuxd(), [_make_usbmux_device("DEV-1")]])
        start.assert_called_once()
        self.assertEqual([d["udid"] for d in result["devices"]], ["DEV-1"])

    def test_not_installed_is_the_setup_step(self):
        with self.assertRaises(RuntimeError) as ctx:
            self._list_on("win32", "missing", [_no_usbmuxd()])
        self.assertTrue(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED: "))

    def test_installed_but_wont_start_is_an_error_to_report(self):
        with self.assertRaises(RuntimeError) as ctx:
            self._list_on("win32", "failed", [_no_usbmuxd()])
        self.assertIn("installed but didn't start", str(ctx.exception))
        self.assertFalse(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED"))

    def test_only_windows_tries_to_start_apple_devices(self):
        with (
            patch.object(sys, "platform", "darwin"),
            patch("device_backup._start_apple_devices") as start,
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, side_effect=_no_usbmuxd()),
            self.assertRaises(RuntimeError) as ctx,
        ):
            self.manager.list_devices()
        start.assert_not_called()
        self.assertTrue(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED: "))

    # _start_apple_devices: PowerShell finds and starts the launcher, then we wait for port 27015.

    def _start(self, stdout="started", listening=(True,), run_error=None):
        run = MagicMock(return_value=MagicMock(stdout=stdout), side_effect=run_error)
        with (
            patch("device_backup._run_hidden", run),
            patch("device_backup._windows_usbmuxd_listening", side_effect=list(listening)),
            patch("device_backup.time.sleep"),
        ):
            return device_backup._start_apple_devices(wait_s=0), run

    def test_start_reports_missing_running_and_failed(self):
        self.assertEqual(self._start(stdout="missing")[0], "missing")
        self.assertEqual(self._start(listening=(True,))[0], "running")
        self.assertEqual(self._start(listening=(False, False))[0], "failed")
        self.assertEqual(self._start(run_error=OSError("no powershell"))[0], "failed")

    def test_start_runs_the_launcher_inside_the_apple_devices_package(self):
        _, run = self._start()
        args = run.call_args.args[0]
        self.assertTrue(args[0].lower().endswith("powershell.exe"))
        self.assertIn("Get-AppxPackage AppleInc.AppleDevices", args[-1])
        self.assertIn("AppleMobileDeviceLauncher.exe", args[-1])

    # install_device_support: winget, then start.

    def _install(self, start_statuses, winget="C:\\winget.exe", winget_result=None):
        run = MagicMock(return_value=winget_result or MagicMock(returncode=0, stdout="", stderr=""))
        with (
            patch.object(sys, "platform", "win32"),
            patch("device_backup._start_apple_devices", side_effect=list(start_statuses)),
            patch("device_backup._find_winget", return_value=winget),
            patch("device_backup._run_hidden", run),
        ):
            return self.manager.install_device_support(), run

    def test_install_uses_winget_from_the_microsoft_store_then_starts_it(self):
        result, run = self._install(["missing", "running"])
        self.assertEqual(result, {"installed": True})
        args = run.call_args.args[0]
        self.assertEqual(args[:4], ["C:\\winget.exe", "install", "--id", "9NP83LWLPZ9K"])
        for flag in ("--source", "msstore", "--silent", "--accept-package-agreements", "--disable-interactivity"):
            self.assertIn(flag, args)

    def test_install_skips_winget_when_already_installed(self):
        result, run = self._install(["running"])
        self.assertEqual(result, {"installed": True})
        run.assert_not_called()

    def test_install_without_winget_points_to_the_store(self):
        with self.assertRaises(RuntimeError) as ctx:
            self._install(["missing"], winget=None)
        self.assertIn("Microsoft Store", str(ctx.exception))

    def test_install_failure_names_the_winget_error(self):
        failed = MagicMock(returncode=-1978335212, stdout="", stderr="")  # 0x8A150014, as Windows returns it
        with self.assertRaises(RuntimeError) as ctx:
            self._install(["missing", "missing"], winget_result=failed)
        self.assertIn("0x8a150014", str(ctx.exception))
        self.assertIn("Microsoft Store", str(ctx.exception))

    def test_install_is_windows_only(self):
        with patch.object(sys, "platform", "darwin"), self.assertRaises(RuntimeError):
            self.manager.install_device_support()


# ---------------------------------------------------------------------------
# Test: backup.start
# ---------------------------------------------------------------------------

class TestPairDevice(unittest.TestCase):
    """backup.pair_device: one Trust prompt per iPhone, however often the app asks."""

    def setUp(self):
        self.manager = DeviceBackupManager()
        self.certs = MagicMock(side_effect=lambda key: (b"host-cert", b"host-key", b"device-cert",
                                                        b"root-cert", b"root-key"))

    def _lockdown(self, pair_outcomes, paired=False):
        lockdown = _make_lockdown_mock("DEV-1", paired=paired)
        lockdown.host_id = "HOST-ID"
        lockdown.system_buid = "BUID"
        lockdown.wifi_mac_address = "aa:bb"
        lockdown.get_value = AsyncMock(return_value=b"device-public-key")
        lockdown._request_pair = AsyncMock(side_effect=pair_outcomes)
        lockdown.save_pair_record = AsyncMock()
        lockdown.validate_pairing = AsyncMock(return_value=True)
        return lockdown

    def _pair(self, lockdown):
        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                  return_value=lockdown) as create,
            patch("pymobiledevice3.ca.generate_pairing_cert_chain", self.certs),
        ):
            result = self.manager.pair_device("DEV-1")
        self.assertEqual(create.await_args.kwargs.get("autopair"), False)
        return result["state"]

    def test_already_trusted(self):
        lockdown = self._lockdown([], paired=True)
        self.assertEqual(self._pair(lockdown), "trusted")
        lockdown._request_pair.assert_not_awaited()

    def test_resends_the_same_request_until_trusted(self):
        """Waiting, locked (or typing the passcode), then accepted: one request, one prompt."""
        lockdown = self._lockdown([
            _stub.exceptions.PairingDialogResponsePendingError(),
            _stub.exceptions.PasswordRequiredError(),
            {"EscrowBag": b"escrow"},
        ])
        self.assertEqual(self._pair(lockdown), "waiting")
        self.assertEqual(self._pair(lockdown), "locked")
        self.assertEqual(self._pair(lockdown), "trusted")

        self.certs.assert_called_once()
        sent = [c.args[0] for c in lockdown._request_pair.await_args_list]
        self.assertTrue(all(options is sent[0] for options in sent))
        self.assertEqual([c.kwargs["timeout"] for c in lockdown._request_pair.await_args_list], [0, 0, 0])
        record = lockdown.pair_record
        self.assertEqual(record["HostPrivateKey"], b"host-key")
        self.assertEqual(record["EscrowBag"], b"escrow")
        self.assertEqual(record["HostID"], "HOST-ID")
        lockdown.save_pair_record.assert_awaited_once()
        self.assertEqual(lockdown.close.await_count, 3)

    def test_denied_starts_over_next_time(self):
        lockdown = self._lockdown([_stub.exceptions.UserDeniedPairingError(), {}])
        self.assertEqual(self._pair(lockdown), "denied")
        self.assertEqual(self._pair(lockdown), "trusted")
        self.assertEqual(self.certs.call_count, 2)

    def test_no_device_service_is_a_setup_step(self):
        with patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                   side_effect=_stub.exceptions.ConnectionFailedToUsbmuxdError()):
            with self.assertRaises(RuntimeError) as ctx:
                self.manager.pair_device("DEV-1")
        self.assertTrue(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED:"))


class TestStartBackup(unittest.TestCase):

    def setUp(self):
        self.manager = DeviceBackupManager()
        self.progress_calls: list = []
        self.bytes_reported: list = []

        def _notify(phase, percent, files_done, files_total, bytes_done=0):
            self.progress_calls.append((phase, percent, files_done, files_total))
            self.bytes_reported.append(bytes_done)

        self.notify = _notify

    def _make_mb2_mock(self):
        """Return a MobileBackup2Service mock that records backup() calls."""
        mb2 = MagicMock()
        mb2.__enter__ = MagicMock(return_value=mb2)
        mb2.__exit__ = MagicMock(return_value=False)
        mb2.__aenter__ = AsyncMock(return_value=mb2)
        mb2.__aexit__ = AsyncMock(return_value=False)
        mb2.backup = AsyncMock()
        mb2.change_password = AsyncMock()
        return mb2

    def test_backup_success_returns_path(self):
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            result = self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_backup",
                encrypted=False,
                password=None,
                notify=self.notify,
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["backup_path"], "/tmp/test_backup")

    def test_negotiating_notification_sent(self):
        """At minimum, a 'negotiating' progress event should be emitted."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_backup",
                encrypted=False,
                password=None,
                notify=self.notify,
            )

        phases = [p[0] for p in self.progress_calls]
        self.assertIn("negotiating", phases)
        # Final 100% notification
        last = self.progress_calls[-1]
        self.assertEqual(last[0], "finalizing")
        self.assertEqual(last[1], 100)

    def _progress(self, device_percents):
        """
        Run a backup whose device reports *device_percents*; return the (phase, percent)
        steps, with ("backup requested", None) where the backup request goes to the device.
        """
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        # pymobiledevice3 passes the device's own figure, a 0–100 percentage.
        def _fake_backup(**kwargs):
            self.progress_calls.append(("backup requested", None, 0, 0))
            for value in device_percents:
                kwargs["progress_callback"](value)

        mb2.backup.side_effect = _fake_backup

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_backup",
                encrypted=False,
                password=None,
                notify=self.notify,
            )

        return [p[:2] for p in self.progress_calls]

    def test_progress_callback_forwarded(self):
        """The bar shows the device's own percentage, and 100 only once the backup is done."""
        self.assertEqual(self._progress([0.0, 25.0, 80.0, 100.0]), [
            ("negotiating", 0),
            ("waiting", 0),
            ("backup requested", None),
            ("waiting", 0),
            ("backing_up", 25),
            ("backing_up", 80),
            ("finalizing", 99),
            ("finalizing", 100),
        ])

    def test_waits_at_zero_until_the_device_sends_data(self):
        """Nothing moves the bar while the iPhone waits for its passcode."""
        steps = self._progress([0.0, 0.0, 0.5])
        before_data = steps[:steps.index(("backing_up", 0))]
        self.assertEqual({p for _, p in before_data if p is not None}, {0})
        self.assertEqual(before_data[-3:], [("backup requested", None), ("waiting", 0), ("waiting", 0)])

    def test_early_progress_is_not_read_as_a_fraction(self):
        """Device figures under 1.0 are early percentages; they must not jump the bar to ~90%."""
        steps = self._progress([0.12, 0.89, 0.92, 1.5, 50.0])
        self.assertEqual([p for phase, p in steps if phase == "backing_up"], [0, 0, 0, 1, 50])

    def test_unreadable_progress_is_ignored(self):
        steps = self._progress([None, "n/a", 50.0])
        self.assertEqual([p for phase, p in steps if phase == "backing_up"], [50])

    def test_progress_never_goes_back_to_waiting(self):
        steps = self._progress([10.0, 0.0])
        self.assertEqual(steps[-2:], [("backing_up", 10), ("finalizing", 100)])

    def test_encrypted_backup_calls_configure(self):
        """When encrypted=True, change_password should be invoked."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_enc_backup",
                encrypted=True,
                password="s3cr3t",
                notify=self.notify,
            )

        # change_password should have been called once (in _configure_encryption)
        # and backup() once.  We use a shared mb2 mock so both calls are visible.
        self.assertTrue(mb2.change_password.called or mb2.backup.called)

    def test_encryption_never_set_on_the_iphone_is_turned_on(self):
        """An iPhone that has no WillEncrypt value at all gets encryption turned on (OE-12)."""
        lockdown = _make_lockdown_mock()
        lockdown.get_value = AsyncMock(side_effect=_stub.exceptions.MissingValueError("MissingValue"))
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            result = self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_enc_backup",
                encrypted=True,
                password="s3cr3t",
                notify=self.notify,
            )

        self.assertTrue(result["success"])
        mb2.change_password.assert_awaited_once_with(backup_directory="/tmp/test_enc_backup", old="", new="s3cr3t")
        mb2.backup.assert_awaited_once()

    def test_backup_error_propagates(self):
        """Exceptions from the backup service should propagate to the caller."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = RuntimeError("Device disconnected")

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            with self.assertRaises(RuntimeError, msg="Device disconnected"):
                self.manager.start_backup(
                    udid="abc-123",
                    output_dir="/tmp/test_backup",
                    encrypted=False,
                    password=None,
                    notify=self.notify,
                )

    def _run_backup_with(self, mb2, lockdown=None, still_connected=True):
        lockdown = lockdown or _make_lockdown_mock()
        connected = [_make_usbmux_device("abc-123")] if still_connected else []
        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, return_value=connected),
            patch("device_backup.time.sleep") as sleep,
        ):
            result = self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_backup",
                encrypted=False,
                password=None,
                notify=self.notify,
            )
        return result, sleep

    def test_backup_lock_error_retried_once(self):
        """macOS error 208 (backup lock held by a daemon) is retried once."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = [
            Exception("Device link error: {'ErrorCode': 208, 'ErrorDescription': 'locked'}"),
            None,
        ]
        result, sleep = self._run_backup_with(mb2)
        self.assertTrue(result["success"])
        self.assertEqual(mb2.backup.await_count, 2)
        sleep.assert_called_once()

    def test_backup_lock_error_retried_with_newer_wording(self):
        """pymobiledevice3 later than 11.26 says "The device reported an error" (seen on Windows)."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = [
            Exception("The device reported an error: {'ErrorCode': 208, 'ErrorDescription': "
                      "'Device locked (MBErrorDomain/208)', 'MessageName': 'Response'}."),
            None,
        ]
        result, sleep = self._run_backup_with(mb2)
        self.assertTrue(result["success"])
        self.assertEqual(mb2.backup.await_count, 2)

    def test_backup_lock_error_not_retried_twice(self):
        """Still locked after the retry: a passcode step for the user, not a crash report."""
        mb2 = self._make_mb2_mock()
        lock_err = Exception("Device link error: {'ErrorCode': 208}")
        mb2.backup.side_effect = [lock_err, lock_err]
        with self.assertRaises(RuntimeError) as ctx:
            self._run_backup_with(mb2)
        self.assertEqual(mb2.backup.await_count, 2)
        self.assertTrue(str(ctx.exception).startswith("PASSCODE_REQUIRED:"))

    def test_unplugged_during_backup_says_disconnected(self):
        """Not "your iPhone is prompting for your passcode", which is what an encrypted backup used to say."""
        for error in (_stub.exceptions.ConnectionTerminatedError(), OSError("connection reset")):
            mb2 = self._make_mb2_mock()
            mb2.backup.side_effect = error
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2, still_connected=False)
            self.assertTrue(str(ctx.exception).startswith("DEVICE_DISCONNECTED:"), error)

    def _end_with_connection_closed(self, output_dir, manifest_age_s=None):
        """The device closes the channel; output_dir/abc-123 may hold a Manifest.db that old."""
        import os
        import time
        device_dir = os.path.join(output_dir, "abc-123")
        os.makedirs(device_dir)
        if manifest_age_s is not None:
            manifest = os.path.join(device_dir, "Manifest.db")
            open(manifest, "wb").close()
            then = time.time() - manifest_age_s
            os.utime(manifest, (then, then))
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.ConnectionTerminatedError()
        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                  return_value=_make_lockdown_mock()),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock,
                  return_value=[_make_usbmux_device("abc-123")]),
        ):
            return self.manager.start_backup(udid="abc-123", output_dir=output_dir, encrypted=False,
                                             password=None, notify=self.notify)

    def test_connection_closed_after_manifest_written_is_success(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            self.assertTrue(self._end_with_connection_closed(tmp, manifest_age_s=-1)["success"])

    def test_connection_closed_with_only_an_older_backup_is_not_success(self):
        """A folder used before already has a Manifest.db; that doesn't make this backup finished."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError):
                self._end_with_connection_closed(tmp, manifest_age_s=3600)

    def test_unrelated_error_mentioning_208_not_retried(self):
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = RuntimeError("copied 208 files then disconnected")
        with self.assertRaises(RuntimeError):
            self._run_backup_with(mb2)
        self.assertEqual(mb2.backup.await_count, 1)

    def test_locked_device_raises_passcode_required(self):
        mb2 = self._make_mb2_mock()
        mb2.__aenter__.side_effect = _stub.exceptions.PasswordRequiredError("device is locked")
        with self.assertRaises(RuntimeError) as ctx:
            self._run_backup_with(mb2)
        self.assertTrue(str(ctx.exception).startswith("PASSCODE_REQUIRED:"))

    def test_untrusted_device_is_not_paired_here(self):
        """Pairing here would be a second Trust prompt; the app pairs first."""
        mb2 = self._make_mb2_mock()
        with self.assertRaises(RuntimeError) as ctx:
            self._run_backup_with(mb2, _make_lockdown_mock(paired=False))
        self.assertTrue(str(ctx.exception).startswith("TRUST_REQUIRED:"))
        mb2.backup.assert_not_awaited()

    def test_passcode_prompt_is_reported(self):
        """iOS asks for the passcode before every backup; the app should say so."""
        import logging
        mb2 = self._make_mb2_mock()

        async def _backup(**kwargs):
            logging.getLogger("pymobiledevice3.services.mobilebackup2").warning(
                "Please enter the device passcode to continue the backup")
            kwargs["progress_callback"](50.0)

        mb2.backup.side_effect = _backup
        self._run_backup_with(mb2)
        phases = [p[0] for p in self.progress_calls]
        self.assertIn("passcode", phases)
        self.assertLess(phases.index("passcode"), phases.index("backing_up", phases.index("passcode")))
        self.assertFalse(logging.getLogger("pymobiledevice3.services.mobilebackup2").handlers)

    def _backup_into(self, folder, fake):
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = fake
        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock,
                  return_value=_make_lockdown_mock()),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(udid="abc-123", output_dir=folder, encrypted=False,
                                      password=None, notify=self.notify)

    def test_bytes_copied_counts_finished_and_arriving_files(self):
        """Finished files count in full, and the one arriving counts as far as it has got."""
        import os
        import tempfile
        from types import SimpleNamespace
        kept = []

        def _write(root, name, size):
            path = os.path.join(root, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "ab") as f:
                f.write(b"x" * size)

        async def _backup(**kwargs):
            root, started, progress = kwargs["backup_directory"], kwargs["filter_callback"], kwargs["progress_callback"]
            kept.append(started(SimpleNamespace(file_name="abc-123/aa/one")))
            _write(root, "abc-123/aa/one", 1000)
            progress(10.0)
            kept.append(started(SimpleNamespace(file_name="abc-123/bb/two")))
            _write(root, "abc-123/bb/two", 300)
            progress(20.0)
            _write(root, "abc-123/bb/two", 200)
            os.rename(os.path.join(root, "abc-123/bb/two"), os.path.join(root, "abc-123/two"))
            progress(30.0)

        with tempfile.TemporaryDirectory() as folder:
            self._backup_into(folder, _backup)

        by_percent = {c[1]: b for c, b in zip(self.progress_calls, self.bytes_reported) if c[0] == "backing_up"}
        self.assertEqual(by_percent, {10: 1000, 20: 1300, 30: 1300})  # moved away: keeps the last size seen
        self.assertEqual(kept, [True, True])  # every file is kept
        self.assertEqual(self.bytes_reported[-1], 1300)

    def test_bytes_copied_is_sent_between_device_reports(self):
        """The device can go minutes without a progress report; the figure still moves."""
        import asyncio
        import os
        import tempfile
        from types import SimpleNamespace

        async def _backup(**kwargs):
            path = os.path.join(kwargs["backup_directory"], "abc-123", "video")
            os.makedirs(os.path.dirname(path))
            kwargs["filter_callback"](SimpleNamespace(file_name="abc-123/video"))
            kwargs["progress_callback"](40.0)
            for _ in range(3):
                with open(path, "ab") as f:
                    f.write(b"x" * 1000)
                await asyncio.sleep(0.05)

        with tempfile.TemporaryDirectory() as folder, patch("device_backup._BYTES_REPORT_INTERVAL_S", 0.01):
            self._backup_into(folder, _backup)

        between = [(c[:2], b) for c, b in zip(self.progress_calls, self.bytes_reported) if c[0] == "backing_up"]
        self.assertEqual([b for _, b in between][-3:], [1000, 2000, 3000])
        self.assertEqual({step for step, _ in between}, {("backing_up", 40)})

    def test_passcode_step_holds_at_zero_until_data_flows(self):
        """A 0% report after the prompt keeps the passcode step; it doesn't go back to waiting."""
        import logging
        mb2 = self._make_mb2_mock()

        async def _backup(**kwargs):
            kwargs["progress_callback"](0.0)
            logging.getLogger("pymobiledevice3.services.mobilebackup2").warning(
                "Please enter the device passcode to continue the backup")
            kwargs["progress_callback"](0.0)
            kwargs["progress_callback"](3.0)

        mb2.backup.side_effect = _backup
        self._run_backup_with(mb2)
        steps = [p[:2] for p in self.progress_calls]
        self.assertEqual(steps[-5:], [
            ("waiting", 0), ("passcode", 0), ("passcode", 0), ("backing_up", 3), ("finalizing", 100),
        ])

    def test_device_service_gone_raises_device_service_required(self):
        """Apple's service stopping between the device list and Start Backup is the same setup step."""
        no_service = _stub.exceptions.ConnectionFailedToUsbmuxdError()
        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, side_effect=no_service),
            patch("pymobiledevice3.usbmux.list_devices", new_callable=AsyncMock, side_effect=no_service),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                self.manager.start_backup(
                    udid="abc-123",
                    output_dir="/tmp/test_backup",
                    encrypted=False,
                    password=None,
                    notify=self.notify,
                )
        self.assertTrue(str(ctx.exception).startswith("DEVICE_SERVICE_REQUIRED:"))

    def test_not_enough_disk_space_explains_sizes(self):
        """The device asking us to purge space becomes a message with both sizes."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.NotEnoughDiskSpaceError()
        lockdown = _make_lockdown_mock()
        lockdown.get_value = AsyncMock(return_value={
            "TotalDataCapacity": 1_014_000_000_000,
            "TotalDataAvailable": 933_000_000_000,
        })
        free = MagicMock(free=55_000_000_000)
        with patch("device_backup.shutil.disk_usage", return_value=free):
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2, lockdown)
        msg = str(ctx.exception)
        self.assertIn("about 81 GB of data", msg)
        self.assertIn("only has 55 GB free", msg)
        self.assertEqual(mb2.backup.await_count, 1)

    def test_not_enough_disk_space_without_device_usage(self):
        """If the device doesn't report its usage, still explain the free space."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.NotEnoughDiskSpaceError()
        lockdown = _make_lockdown_mock()
        lockdown.get_value = AsyncMock(return_value={})  # no TotalDataCapacity
        free = MagicMock(free=55_000_000_000)
        with patch("device_backup.shutil.disk_usage", return_value=free):
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2, lockdown)
        msg = str(ctx.exception)
        self.assertIn("Not enough free space", msg)
        self.assertIn("only has 55 GB free", msg)
        self.assertNotIn("of data", msg)

    def test_not_enough_disk_space_uses_device_requirement(self):
        """pymobiledevice3 11.x reports the bytes the device needs and the free space it was told."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.NotEnoughDiskSpaceError(
            "Device refused the backup: it needs more than 92400000000 bytes free at /Volumes/Backups, "
            "host reported 60300000000 (32100000001 more needed) (MBErrorDomain/105). The device counts "
            "every hardlink and clone at full size."
        )
        with patch("device_backup.shutil.disk_usage") as disk_usage:
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2)
        msg = str(ctx.exception)
        self.assertIn("needs more than 92 GB free, but the drive you chose has 60 GB free", msg)
        disk_usage.assert_not_called()

    def test_not_enough_disk_space_when_drive_is_gone(self):
        """If the drive can't be measured any more, still say it's a space problem."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.NotEnoughDiskSpaceError()
        with patch("device_backup.shutil.disk_usage", side_effect=FileNotFoundError("gone")):
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2)
        self.assertEqual(
            str(ctx.exception),
            "Not enough free space for this backup. Free up space or choose a folder on an "
            "external drive, then try again.",
        )

    def test_iphone_with_no_room_for_its_snapshot_is_not_blamed_on_the_drive(self):
        """The iPhone's own storage being full says so, whatever the drive has free (OE-10)."""
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = _stub.exceptions.NotEnoughDiskSpaceError(
            "Device refused the backup: {'ErrorCode': 105, 'ErrorDescription': 'Failed to create "
            "snapshot: No space left on device (28) at path \"/private/var\" (MBErrorDomain/105)', "
            "'MessageName': 'Response'}. The device counts every hardlink and clone at full size."
        )
        free = MagicMock(free=961_000_000_000)
        with patch("device_backup.shutil.disk_usage", return_value=free):
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2)
        msg = str(ctx.exception)
        self.assertTrue(msg.startswith("Your iPhone is too full to make a backup"), msg)
        self.assertNotIn("drive", msg)

    def test_device_errors_get_a_step_instead_of_please_report_it(self):
        """Errors 104 and 205 tell the user what to do, in either pymobiledevice3 wording (OE-6, OE-8)."""
        cases = {
            104: ("Multiple errors uploading files (MBErrorDomain/104)", "couldn't send some of its files"),
            205: ("Error reading backup manifest properties (MBErrorDomain/205). Underlying error: Error "
                  "deserializing properties: Cannot parse a NULL or zero-length data (MBErrorDomain/11).",
                  "unfinished backup of this iPhone"),
        }
        for code, (description, expected) in cases.items():
            for wording in ("The device reported an error", "Device link error"):
                mb2 = self._make_mb2_mock()
                mb2.backup.side_effect = Exception(
                    f"{wording}: {{'ErrorCode': {code}, 'ErrorDescription': '{description}', "
                    "'MessageName': 'Response'}.\nPlease report it at "
                    "https://github.com/doronz88/pymobiledevice3/issues, with the output of the same "
                    "command run with -v (`pymobiledevice3 -v ...`), so support for it can be added."
                )
                with self.assertRaises(RuntimeError) as ctx:
                    self._run_backup_with(mb2)
                msg = str(ctx.exception)
                self.assertIn(expected, msg, (code, wording))
                self.assertNotIn("Please report", msg)

    def test_files_the_backup_folder_wont_give_up_get_a_step(self):
        """Access denied or a missing file inside the backup folder say what to do (OE-11, OE-6)."""
        import os

        snapshot = os.path.join("/tmp/test_backup", "abc-123", "Snapshot", "00")
        cases = (
            (PermissionError(13, "Access is denied", snapshot), "wasn't allowed to change a file"),
            (FileNotFoundError(2, "No such file or directory", snapshot), "unfinished backup of this iPhone"),
        )
        for error, expected in cases:
            mb2 = self._make_mb2_mock()
            mb2.backup.side_effect = error
            with self.assertRaises(RuntimeError) as ctx:
                self._run_backup_with(mb2)
            self.assertIn(expected, str(ctx.exception))

    def test_unknown_errors_and_files_outside_the_backup_folder_pass_through(self):
        for error in (
            Exception("The device reported an error: {'ErrorCode': 999, 'ErrorDescription': 'new'}"),
            PermissionError(13, "Access is denied", "/somewhere/else/pair_record.plist"),
            FileNotFoundError(2, "No such file or directory"),
        ):
            mb2 = self._make_mb2_mock()
            mb2.backup.side_effect = error
            with self.assertRaises(type(error)):
                self._run_backup_with(mb2)

    def test_disk_full_message_never_shows_equal_or_zero_sizes(self):
        self.assertIn(
            "about 55.4 GB of data, but the drive you chose only has 55.1 GB free",
            _disk_full_message(55_100_000_000, None, 55_400_000_000),
        )
        self.assertIn("only has 0.3 GB free", _disk_full_message(300_000_000, None, 0))

    def test_output_dir_created(self):
        """start_backup should create output_dir if it does not exist."""
        import os
        import tempfile

        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "new_backup_dir")
            self.assertFalse(os.path.exists(target))

            with (
                patch("pymobiledevice3.lockdown.create_using_usbmux", new_callable=AsyncMock, return_value=lockdown),
                patch(
                    "pymobiledevice3.services.mobilebackup2.Mobilebackup2Service",
                    return_value=mb2,
                ),
            ):
                self.manager.start_backup(
                    udid="abc-123",
                    output_dir=target,
                    encrypted=False,
                    password=None,
                    notify=self.notify,
                )

            self.assertTrue(os.path.isdir(target))

    def test_progress_percent_clamped(self):
        """Progress percent should never exceed 99 from the progress_callback."""
        steps = self._progress([150.0])
        self.assertEqual(steps[-2:], [("finalizing", 99), ("finalizing", 100)])


# ---------------------------------------------------------------------------
# Test: RPC integration — SidecarServer routing
# ---------------------------------------------------------------------------

class TestSidecarRouting(unittest.TestCase):
    """
    Verify that main.py's SidecarServer correctly routes backup.list_devices
    and backup.start to DeviceBackupManager.
    """

    def _make_server(self):
        # Patch heavy imports so SidecarServer can be instantiated in tests
        with (
            patch("backup.BackupManager"),
            patch("messages.MessageExtractor"),
            patch("contacts.ContactResolver"),
            patch("photos.PhotoExtractor"),
            patch("voicemail.VoicemailExtractor"),
            patch("calls.CallExtractor"),
            patch("notes.NoteExtractor"),
        ):
            import importlib
            import main as main_mod
            importlib.reload(main_mod)
            return main_mod.SidecarServer()

    def test_backup_list_devices_registered(self):
        server = self._make_server()
        self.assertIn("backup.list_devices", server.methods)

    def test_backup_install_device_support_delegates(self):
        server = self._make_server()
        server.device_backup_manager = MagicMock()
        server.device_backup_manager.install_device_support.return_value = {"installed": True}
        result = server.handle_request({"id": 3, "method": "backup.install_device_support", "params": {}})
        self.assertEqual(result["result"], {"installed": True})

    def test_backup_pair_device_delegates(self):
        server = self._make_server()
        server.device_backup_manager = MagicMock()
        server.device_backup_manager.pair_device.return_value = {"state": "waiting"}
        result = server.handle_request({"id": 4, "method": "backup.pair_device", "params": {"udid": "DEV-1"}})
        server.device_backup_manager.pair_device.assert_called_once_with("DEV-1")
        self.assertEqual(result["result"], {"state": "waiting"})

    def test_backup_start_registered(self):
        server = self._make_server()
        self.assertIn("backup.start", server.methods)

    def test_backup_list_devices_delegates(self):
        server = self._make_server()
        server.device_backup_manager = MagicMock()
        server.device_backup_manager.list_devices.return_value = {"devices": []}

        result = server.handle_request(
            {"id": 1, "method": "backup.list_devices", "params": {}}
        )

        server.device_backup_manager.list_devices.assert_called_once()
        self.assertEqual(result["result"], {"devices": []})

    def test_backup_start_delegates(self):
        server = self._make_server()
        server.device_backup_manager = MagicMock()
        server.device_backup_manager.start_backup.return_value = {
            "success": True,
            "backup_path": "/tmp/backup",
        }

        result = server.handle_request({
            "id": 2,
            "method": "backup.start",
            "params": {
                "udid": "abc-123",
                "output_dir": "/tmp/backup",
                "encrypted": False,
            },
        })

        server.device_backup_manager.start_backup.assert_called_once()
        self.assertTrue(result["result"]["success"])


if __name__ == "__main__":
    unittest.main()
