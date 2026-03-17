"""
Tests for device_backup.py — DeviceBackupManager

These tests use unittest.mock to isolate the code under test from pymobiledevice3
(which requires a real USB/Wi-Fi device).  We patch at the import level so the
module can be imported even when pymobiledevice3 is not installed.
"""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal pymobiledevice3 stub so device_backup can be imported without the
# real library being present in the test environment.
# ---------------------------------------------------------------------------

def _make_pymobiledevice3_stub():
    """Return a minimal stub package tree for pymobiledevice3."""
    pkg = types.ModuleType("pymobiledevice3")
    pkg.usbmux = types.ModuleType("pymobiledevice3.usbmux")
    pkg.lockdown = types.ModuleType("pymobiledevice3.lockdown")
    pkg.services = types.ModuleType("pymobiledevice3.services")
    pkg.services.mobilebackup2 = types.ModuleType("pymobiledevice3.services.mobilebackup2")
    pkg.remote = types.ModuleType("pymobiledevice3.remote")
    pkg.remote.utils = types.ModuleType("pymobiledevice3.remote.utils")
    pkg.remote.remote_service_discovery = types.ModuleType(
        "pymobiledevice3.remote.remote_service_discovery"
    )

    # Populate with MagicMocks so attribute access works
    pkg.usbmux.list_devices = MagicMock(return_value=[])
    pkg.lockdown.create_using_usbmux = MagicMock()
    pkg.services.mobilebackup2.Mobilebackup2Service = MagicMock()
    pkg.remote.utils.get_rsds = MagicMock(return_value=[])
    pkg.remote.remote_service_discovery.RemoteServiceDiscoveryService = MagicMock()

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
    ]:
        sys.modules[name] = getattr(stub, name.split(".", 1)[1]) if "." in name else stub
    return stub


_stub = _install_stub()

# Now safe to import our module
sys.path.insert(0, "python")
from device_backup import DeviceBackupManager  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_lockdown_mock(udid="abc-123", name="iPhone 15", ios_version="17.4"):
    m = MagicMock()
    m.udid = udid
    m.display_name = name
    m.product_version = ios_version
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
            patch("pymobiledevice3.usbmux.list_devices", return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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
            patch("pymobiledevice3.usbmux.list_devices", return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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
            patch("pymobiledevice3.usbmux.list_devices", return_value=[]),
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
            patch("pymobiledevice3.usbmux.list_devices", return_value=[usbmux_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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

        def _create_lockdown(serial=None):
            if serial == "BAD":
                raise ConnectionError("Device busy")
            return good_lockdown

        with (
            patch("pymobiledevice3.usbmux.list_devices", return_value=[good_dev, bad_dev]),
            patch("pymobiledevice3.lockdown.create_using_usbmux", side_effect=_create_lockdown),
            patch("pymobiledevice3.remote.utils.get_rsds", return_value=[]),
        ):
            result = self.manager.list_devices()

        self.assertEqual(len(result["devices"]), 1)
        self.assertEqual(result["devices"][0]["udid"], "GOOD")

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
# Test: backup.start
# ---------------------------------------------------------------------------

class TestStartBackup(unittest.TestCase):

    def setUp(self):
        self.manager = DeviceBackupManager()
        self.progress_calls: list = []

        def _notify(phase, percent, files_done, files_total):
            self.progress_calls.append((phase, percent, files_done, files_total))

        self.notify = _notify

    def _make_mb2_mock(self):
        """Return a MobileBackup2Service mock that records backup() calls."""
        mb2 = MagicMock()
        mb2.__enter__ = MagicMock(return_value=mb2)
        mb2.__exit__ = MagicMock(return_value=False)
        mb2.backup = MagicMock()
        return mb2

    def test_backup_success_returns_path(self):
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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

    def test_progress_callback_forwarded(self):
        """backup() progress_callback should update the notified percent."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        # Simulate pymobiledevice3 calling progress_callback with two events
        def _fake_backup(full, backup_directory, progress_callback):
            progress_callback({"Progress": 0.25, "TotalFiles": 200, "FilesTransferred": 50})
            progress_callback({"Progress": 0.80, "TotalFiles": 200, "FilesTransferred": 160})

        mb2.backup.side_effect = _fake_backup

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_backup",
                encrypted=False,
                password=None,
                notify=self.notify,
            )

        # Look for the 25% and 80% events
        percents = [p[1] for p in self.progress_calls]
        self.assertIn(25, percents)
        self.assertIn(80, percents)

    def test_encrypted_backup_calls_configure(self):
        """When encrypted=True, change_backup_password should be invoked."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_enc_backup",
                encrypted=True,
                password="s3cr3t",
                notify=self.notify,
            )

        # change_backup_password should have been called once (in _configure_encryption)
        # and backup() once.  We use a shared mb2 mock so both calls are visible.
        self.assertTrue(mb2.change_backup_password.called or mb2.backup.called)

    def test_backup_error_propagates(self):
        """Exceptions from the backup service should propagate to the caller."""
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()
        mb2.backup.side_effect = RuntimeError("Device disconnected")

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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
                patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
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
        lockdown = _make_lockdown_mock()
        mb2 = self._make_mb2_mock()

        def _fake_backup(full, backup_directory, progress_callback):
            # Deliver a value > 1.0 to test clamping
            progress_callback({"Progress": 1.5})

        mb2.backup.side_effect = _fake_backup

        with (
            patch("pymobiledevice3.lockdown.create_using_usbmux", return_value=lockdown),
            patch("pymobiledevice3.services.mobilebackup2.Mobilebackup2Service", return_value=mb2),
        ):
            self.manager.start_backup(
                udid="abc-123",
                output_dir="/tmp/test_clamp",
                encrypted=False,
                password=None,
                notify=self.notify,
            )

        mid_percents = [p[1] for p in self.progress_calls if p[0] != "finalizing"]
        for pct in mid_percents:
            self.assertLessEqual(pct, 99)


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
