"""
Device backup module — create iPhone backups from live connected devices.

Uses pymobiledevice3 for device communication and MobileBackup2 protocol.
"""

import asyncio
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Callable, Optional

_LOG_PATH = os.environ.get('OPENEXTRACT_LOG_PATH') or os.path.join(tempfile.gettempdir(), 'python_log.txt')


def _dev_log(msg: str) -> None:
    """Append a timestamped line to the log file (survives sidecar restarts)."""
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# macOS daemons (AMPDevicesAgent, SecureBackupDaemon) can briefly hold the
# device's backup lock right after the user enters their passcode, which
# surfaces from pymobiledevice3's device-link loop as ErrorCode 208.
_BACKUP_LOCK_ERROR_RE = re.compile(r"Device link error:.*'ErrorCode': 208\b")
_BACKUP_LOCK_RETRY_DELAY_S = 3


def _is_backup_lock_error(exc: Exception) -> bool:
    return bool(_BACKUP_LOCK_ERROR_RE.search(str(exc)))


# pymobiledevice3 reaches iPhones through usbmuxd. macOS always runs it; Windows gets
# it only from Apple's own software (Apple Devices or iTunes), and Linux from the
# usbmuxd package. Without it no iPhone can be found, so this is a setup step, which
# the app shows as one (src/components/backup/BackupFlow.tsx), not a crash.
DEVICE_SERVICE_PREFIX = "DEVICE_SERVICE_REQUIRED:"


def _device_service_error() -> RuntimeError:
    if sys.platform == "win32":
        detail = ("To find your iPhone, OpenExtract needs Apple Devices, Apple's free iPhone app "
                  "for Windows, and it isn't installed. Install it from the Microsoft Store, then "
                  "search again.")
    elif sys.platform == "darwin":
        detail = ("OpenExtract can't reach the part of macOS that talks to iPhones (usbmuxd). "
                  "Restart your Mac, then search again.")
    else:
        detail = ("OpenExtract can't reach usbmuxd, the service that talks to iPhones. Install it "
                  "(on Ubuntu or Debian: sudo apt install usbmuxd), plug in your iPhone, then "
                  "search again.")
    return RuntimeError(f"{DEVICE_SERVICE_PREFIX} {detail}")


# The Microsoft Store's Apple Devices app has no Windows service. Its usbmuxd
# (AppleMobileDeviceProcess.exe, on 127.0.0.1:27015) is started by a launcher that
# Windows runs at sign-in once the app has been opened, so right after Apple Devices
# is installed nothing is listening, and opening the app doesn't change that until the
# next sign-in. We start the launcher ourselves: no window, no admin rights.
# Installing it with winget needs no admin rights either. Both tested on Windows 11 (OE-4).
APPLE_DEVICES_STORE_ID = "9NP83LWLPZ9K"
_WINDOWS_USBMUXD = ("127.0.0.1", 27015)
_START_APPLE_DEVICES_PS = (
    "$p = Get-AppxPackage AppleInc.AppleDevices | Select-Object -First 1; "
    "if (-not $p) { 'missing'; exit }; "
    "Invoke-CommandInDesktopPackage -PackageFamilyName $p.PackageFamilyName -AppId App "
    "-Command (Join-Path $p.InstallLocation 'AppleMobileDeviceLauncher.exe') -PreventBreakaway; "
    "'started'"
)


def _run_hidden(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    # winget draws progress bars, so don't decode its output as the ANSI code page.
    return subprocess.run(args, capture_output=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _find_winget() -> Optional[str]:
    alias = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WindowsApps", "winget.exe")
    return shutil.which("winget") or (alias if os.path.exists(alias) else None)


def _windows_usbmuxd_listening() -> bool:
    try:
        with socket.create_connection(_WINDOWS_USBMUXD, timeout=1):
            return True
    except OSError:
        return False


def _start_apple_devices(wait_s: float = 20) -> str:
    """Start Apple Devices' usbmuxd: "running", "missing" (not installed) or "failed"."""
    powershell = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                              "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    try:
        out = _run_hidden([powershell, "-NoProfile", "-NonInteractive", "-Command",
                           _START_APPLE_DEVICES_PS], timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        _dev_log(f"couldn't start Apple Devices: {e!r}")
        return "failed"
    _dev_log(f"starting Apple Devices: {out!r}")
    if out.endswith("missing"):
        return "missing"
    deadline = time.monotonic() + wait_s
    while not _windows_usbmuxd_listening():
        if time.monotonic() >= deadline:
            return "failed"
        time.sleep(0.5)
    return "running"


# Opening the app doesn't start usbmuxd; opening it once makes Windows run the launcher at
# sign-in, so a restart is the fallback.
_APPLE_DEVICES_DID_NOT_START = (
    "Apple Devices is installed but didn't start. Open Apple Devices once, restart your PC, "
    "then try again."
)


# pymobiledevice3 11.x words the device's refusal (MBErrorDomain/105) as "... it needs
# more than <required> bytes free at <path>, host reported <reported> ...". Older
# releases raised NotEnoughDiskSpaceError() with an empty message.
_DISK_SPACE_DETAIL_RE = re.compile(r"needs more than (\d+) bytes free .*?host reported (\d+)", re.S)


def _disk_space_from_error(exc: Exception) -> tuple[Optional[int], Optional[int]]:
    """(bytes the device requires, bytes we reported free), or (None, None) if the error doesn't say."""
    match = _DISK_SPACE_DETAIL_RE.search(str(exc))
    return (int(match[1]), int(match[2])) if match else (None, None)


def _free_bytes(path: str) -> Optional[int]:
    try:
        return shutil.disk_usage(path).free
    except OSError as e:  # e.g. the external drive was unplugged
        _dev_log(f"disk_usage({path!r}) failed: {e}")
        return None


def _gb(*sizes: int) -> list[str]:
    """Decimal GB, matching how Finder and iPhone Storage report sizes.

    Whole GB, unless that would show 0 GB or make two different sizes look equal.
    """
    whole = [round(size / 1e9) for size in sizes]
    digits = 1 if 0 in whole or len(set(whole)) < len(whole) else 0
    return [f"{size / 1e9:.{digits}f}" for size in sizes]


def _disk_full_message(free_bytes: Optional[int], needed_bytes: Optional[int], phone_used_bytes: int) -> str:
    if free_bytes is None:
        detail = ""
    elif needed_bytes is not None:
        needed, free = _gb(needed_bytes, free_bytes)
        detail = f" It needs more than {needed} GB free, but the drive you chose has {free} GB free."
    elif phone_used_bytes > free_bytes:
        used, free = _gb(phone_used_bytes, free_bytes)
        detail = (f" Your iPhone has about {used} GB of data, but the drive you chose only "
                  f"has {free} GB free.")
    else:
        (free,) = _gb(free_bytes)
        detail = f" The drive you chose only has {free} GB free."
    return (f"Not enough free space for this backup.{detail} Free up space or choose a "
            "folder on an external drive, then try again.")


class DeviceBackupManager:
    """Manages live-device detection and backup operations via pymobiledevice3."""

    def list_devices(self) -> dict:
        """
        Detect all connected iPhone/iPad devices via USB and Wi-Fi.

        Returns a list of device dicts: { udid, name, ios_version, connection_type }.

        Two discovery paths are used:

        1. usbmuxd  — reports devices connected by USB cable, plus any device
           that has "Wi-Fi Sync" enabled in Finder/iTunes (iOS ≤ 16).

        2. RSD (Remote Service Discovery, iOS 17+)  — Apple replaced the legacy
           Wi-Fi-sync protocol with an mDNS-advertised CoreDevice tunnel service
           (_remoted._tcp.local, port 58783).  pymobiledevice3 probes for these
           records with get_rsds(), performs a QUIC handshake authenticated via
           the existing pairing record, and exposes a standard lockdown interface
           inside the encrypted tunnel.  Devices found this way are reported with
           connection_type="wifi" even if they have never had Wi-Fi Sync turned on
           in Finder, as long as the device was paired on this Mac.
        """
        try:
            from pymobiledevice3.usbmux import list_devices
            from pymobiledevice3.lockdown import create_using_usbmux
        except ImportError:
            raise RuntimeError(
                "pymobiledevice3 is not installed. Run: pip install pymobiledevice3"
            )

        devices = []
        seen_udids: set = set()

        async def _collect_usb_devices():
            # ── Path 1: usbmuxd (USB cable + legacy Wi-Fi sync) ──────────────────
            try:
                usb_devs = await list_devices()
            except Exception as e:
                from pymobiledevice3.exceptions import ConnectionFailedToUsbmuxdError
                if not isinstance(e, ConnectionFailedToUsbmuxdError):
                    raise
                status = _start_apple_devices() if sys.platform == "win32" else "missing"
                if status == "missing":
                    raise _device_service_error() from None
                if status == "failed":
                    raise RuntimeError(_APPLE_DEVICES_DID_NOT_START) from None
                usb_devs = await list_devices()

            for dev in usb_devs:
                try:
                    lockdown = await create_using_usbmux(serial=dev.serial)
                    udid = lockdown.udid
                    if udid in seen_udids:
                        continue
                    seen_udids.add(udid)
                    # usbmuxd exposes connection_type as "USB" or "Network"
                    conn_raw = getattr(dev, "connection_type", "USB").upper()
                    conn_type = "wifi" if conn_raw in ("NETWORK", "WIFI") else "usb"
                    devices.append({
                        "udid": udid,
                        "name": lockdown.display_name or udid,
                        "ios_version": lockdown.product_version or "",
                        "connection_type": conn_type,
                    })
                except Exception:
                    pass

            # ── Path 2: iOS 17+ RSD over Wi-Fi ───────────────────────────────────
            #
            # Starting with iOS 17, Apple introduced the CoreDevice framework and
            # Remote Service Discovery (RSD) as the replacement for the legacy
            # lockdown-over-mDNS (port 62078) Wi-Fi protocol.
            #
            # Devices already seen via usbmuxd are de-duplicated by UDID so that
            # a cable-connected device isn't listed twice.
            try:
                from pymobiledevice3.remote.utils import get_rsds
                from pymobiledevice3.remote.remote_service_discovery import (
                    RemoteServiceDiscoveryService,
                )

                rsds = get_rsds()
                # get_rsds may be async or sync depending on the version
                if asyncio.iscoroutine(rsds):
                    rsds = await rsds

                for rsd in rsds:
                    try:
                        with RemoteServiceDiscoveryService(
                            (rsd.hostname, rsd.port)
                        ) as rsd_service:
                            udid = rsd_service.udid
                            if udid in seen_udids:
                                continue
                            seen_udids.add(udid)
                            devices.append({
                                "udid": udid,
                                "name": rsd_service.get_value("DeviceName") or udid,
                                "ios_version": rsd_service.get_value("ProductVersion") or "",
                                "connection_type": "wifi",
                            })
                    except Exception:
                        pass
            except (ImportError, Exception):
                # RSD discovery is optional; missing Bonjour/Avahi or old pymobiledevice3
                # versions that lack the remote sub-package are not fatal.
                pass

        asyncio.run(_collect_usb_devices())
        return {"devices": devices}

    def install_device_support(self) -> dict:
        """
        Windows: install Apple Devices from the Microsoft Store with winget and start it,
        so the user never has to leave OpenExtract. Returns { "installed": True } once
        Apple's usbmuxd answers; raises with what to do instead if it can't.
        """
        if sys.platform != "win32":
            raise RuntimeError("Only Windows needs Apple Devices.")
        status = _start_apple_devices()
        if status == "missing":
            winget = _find_winget()
            if winget is None:
                raise RuntimeError(
                    "OpenExtract couldn't install Apple Devices because this PC doesn't have the "
                    "Windows Package Manager (winget). Get Apple Devices from the Microsoft Store "
                    "instead, then click Check again."
                )
            try:
                result = _run_hidden(
                    [winget, "install", "--id", APPLE_DEVICES_STORE_ID, "--source", "msstore",
                     "--exact", "--silent", "--accept-package-agreements",
                     "--accept-source-agreements", "--disable-interactivity"],
                    timeout=600,
                )
                outcome = f"winget error {result.returncode & 0xFFFFFFFF:#010x}"
                _dev_log(f"winget install Apple Devices: exit {result.returncode}\n"
                         f"{result.stdout[-2000:]}{result.stderr[-1000:]}")
            except (OSError, subprocess.SubprocessError) as e:
                outcome = "winget didn't finish"
                _dev_log(f"winget install Apple Devices failed: {e!r}")
            status = _start_apple_devices()
            if status == "missing":
                raise RuntimeError(
                    f"Apple Devices couldn't be installed ({outcome}). Get it from the Microsoft "
                    "Store instead, then click Check again."
                )
        if status == "failed":
            raise RuntimeError(_APPLE_DEVICES_DID_NOT_START)
        return {"installed": True}

    def start_backup(
        self,
        udid: str,
        output_dir: str,
        encrypted: bool,
        password: Optional[str],
        notify: Callable[[str, int, int, int], None],
    ) -> dict:
        """
        Initiate a full backup of the device identified by *udid*.

        :param udid:        Device UDID (from list_devices).
        :param output_dir:  Destination directory; created if it does not exist.
        :param encrypted:   Whether to request an encrypted backup.
        :param password:    Encryption password (required when encrypted=True).
        :param notify:      Progress callback: notify(phase, percent, files_done, files_total).
                            Called repeatedly during the backup.  Safe to call from
                            the same thread — this method is synchronous.
        :returns:           { "success": True, "backup_path": <resolved dir> }
        """
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service
            from pymobiledevice3.exceptions import (
                ConnectionFailedToUsbmuxdError,
                ConnectionTerminatedError,
                NotEnoughDiskSpaceError,
                PasswordRequiredError,
            )
        except ImportError:
            raise RuntimeError(
                "pymobiledevice3 is not installed. Run: pip install pymobiledevice3"
            )

        os.makedirs(output_dir, exist_ok=True)

        # high-water mark shared by ALL notification paths so that the hardcoded
        # negotiating / backing_up milestones (0 → 5 → 10) are never overwritten
        # by an early 0% callback from pymobiledevice3.
        last_pct = [0]
        # The milestones above use 0–11; the device's own progress fills 11–99,
        # and 100 waits until the backup has actually finished.
        transfer_start_pct = 11
        # Bytes in use on the iPhone, so a disk-full error can say how much room
        # the backup needs.  0 when the device didn't report it.
        phone_used_bytes = 0

        def _tracked_notify(phase: str, pct: int, fd: int, ft: int) -> None:
            """Emit a progress notification, enforcing monotone progress."""
            pct = max(last_pct[0], pct)
            last_pct[0] = pct
            notify(phase, pct, fd, ft)

        def _progress_cb(device_pct) -> None:
            """
            Translate the device's progress into our percent.

            pymobiledevice3 passes the figure iOS sends with each batch of files:
            how much of the backup is done, as a percentage from 0 to 100 (its own
            CLI feeds it straight into a 100-step bar).  A value under 1.0 is an
            early percentage, not a fraction; reading it as one sent the bar to
            ~90% during the first 1% and held it there for most of the backup.
            """
            try:
                device_pct = min(100.0, max(0.0, float(device_pct)))
            except (TypeError, ValueError):
                return
            pct = transfer_start_pct + int(device_pct * (99 - transfer_start_pct) / 100)
            _tracked_notify("backing_up", pct, 0, 0)

        async def _run_backup():
            nonlocal phone_used_bytes
            _tracked_notify("negotiating", 0, 0, 0)

            # Open the lockdown channel to the device (async in pymobiledevice3 v4+).
            # Catch trust/pairing errors early and surface them with a clear message.
            try:
                lockdown = await create_using_usbmux(serial=udid)
            except ConnectionFailedToUsbmuxdError:
                # Apple's service stopped after the device list was shown.
                raise _device_service_error() from None
            except Exception as e:
                err_type = type(e).__name__
                if "PairingDialogResponsePending" in err_type:
                    raise RuntimeError(
                        "TRUST_REQUIRED: Your iPhone is showing a 'Trust This Computer?' "
                        "prompt. Tap Trust on your device and enter your passcode, "
                        "then click Retry."
                    ) from None
                if "NotTrusted" in err_type or "UserDeniedPairing" in err_type:
                    raise RuntimeError(
                        "TRUST_REQUIRED: Your iPhone did not trust this computer. "
                        "Disconnect and reconnect your iPhone, then tap Trust "
                        "when prompted."
                    ) from None
                raise

            try:
                usage = await lockdown.get_value("com.apple.disk_usage")
                phone_used_bytes = usage["TotalDataCapacity"] - usage["TotalDataAvailable"]
            except Exception as e:
                _dev_log(f"couldn't read the iPhone's disk usage: {e!r}")

            _tracked_notify("negotiating", 5, 0, 0)

            if encrypted:
                await self._configure_encryption_async(lockdown, password or "", output_dir)

            _tracked_notify("negotiating", 10, 0, 0)

            async with Mobilebackup2Service(lockdown) as mb2:
                _tracked_notify("backing_up", transfer_start_pct, 0, 0)
                await mb2.backup(
                    full=True,
                    backup_directory=output_dir,
                    progress_callback=_progress_cb,
                )

            _tracked_notify("finalizing", 100, 0, 0)

        def _run_with_lock_retry():
            try:
                asyncio.run(_run_backup())
            except Exception as e:
                if not _is_backup_lock_error(e):
                    raise
                _dev_log(f"backup lock held by another process (error 208), retrying in "
                         f"{_BACKUP_LOCK_RETRY_DELAY_S}s: {e}")
                time.sleep(_BACKUP_LOCK_RETRY_DELAY_S)
                asyncio.run(_run_backup())

        try:
            _run_with_lock_retry()
        except PasswordRequiredError as e:
            # Raised by lockdown StartService when the device is locked.
            raise RuntimeError(
                "PASSCODE_REQUIRED: Your iPhone is locked. Unlock it with your "
                "passcode, keep it unlocked while the backup starts, then click Retry."
            ) from e
        except NotEnoughDiskSpaceError as e:
            # The device compares its backup size against the free space we report
            # and refuses when it won't fit. pymobiledevice3 11.x says how many bytes
            # it needed and how many we reported (on macOS that figure counts
            # purgeable space, like Finder); older releases raise with an empty
            # message, which the UI would show as "Unknown error", after reporting
            # plain statvfs free space, which is what disk_usage returns.
            needed_bytes, free_bytes = _disk_space_from_error(e)
            if free_bytes is None:
                free_bytes = _free_bytes(output_dir)
            _dev_log(f"not enough disk space: {e} | needed={needed_bytes} free={free_bytes} "
                     f"phone_used={phone_used_bytes} output_dir={output_dir!r}")
            raise RuntimeError(_disk_full_message(free_bytes, needed_bytes, phone_used_bytes)) from e
        except ConnectionTerminatedError as e:
            # iOS often closes the backup channel immediately after all data has been
            # transferred — this is normal end-of-backup behaviour and does NOT mean
            # the backup failed.  If the backup directory already contains a Manifest
            # or Info.plist we treat the run as successful.
            actual = self._resolve_backup_path(output_dir, udid)
            manifest_path = os.path.join(actual, "Manifest.db")
            info_path = os.path.join(actual, "Info.plist")
            if os.path.exists(manifest_path) or os.path.exists(info_path):
                _tracked_notify("finalizing", 100, 0, 0)
            elif encrypted:
                raise RuntimeError(
                    "PASSCODE_REQUIRED: Your iPhone is prompting for your passcode "
                    "to allow the backup. Check your iPhone screen, enter your "
                    "passcode when prompted, then click Retry."
                ) from e
            else:
                raise RuntimeError(
                    "The connection to your iPhone was terminated unexpectedly. "
                    "Make sure you have tapped 'Trust' on the device when prompted, "
                    "and that the cable is securely connected. Then try again."
                ) from e
        actual_backup_path = self._resolve_backup_path(output_dir, udid)
        _dev_log(f"backup complete. output_dir={output_dir!r} resolved={actual_backup_path!r}")
        return {"success": True, "backup_path": actual_backup_path}

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _resolve_backup_path(self, output_dir: str, udid: str) -> str:
        """
        Return the actual directory that contains the backup files (Manifest.db).

        pymobiledevice3 may write backup files directly into *output_dir* or into
        a UDID-named subdirectory — behaviour varies by iOS version and
        pymobiledevice3 release.  When multiple candidates exist (e.g. the user
        reuses a folder for successive backups) we pick the most recently modified
        Manifest.db so we always open the freshly-created backup.
        """
        _dev_log(f"[_resolve_backup_path] output_dir={output_dir!r} udid={udid!r}")

        # Case 1: files written directly into output_dir
        if os.path.exists(os.path.join(output_dir, "Manifest.db")):
            _dev_log(f"[_resolve_backup_path] case 1 match (direct): {output_dir!r}")
            return output_dir

        # Case 2: well-known UDID subfolder variants (with/without dashes)
        for candidate_name in [udid, udid.replace("-", "")]:
            candidate = os.path.join(output_dir, candidate_name)
            if os.path.isdir(candidate) and os.path.exists(
                os.path.join(candidate, "Manifest.db")
            ):
                _dev_log(f"[_resolve_backup_path] case 2 match (UDID subdir): {candidate!r}")
                return candidate

        # Case 3: scan one level deep; prefer the most recently modified Manifest.db
        # so that a freshly-created backup is chosen over stale ones.
        try:
            best_mtime = -1.0
            best_path = None
            subdirs_found = []
            for entry in os.scandir(output_dir):
                if not entry.is_dir():
                    continue
                manifest = os.path.join(entry.path, "Manifest.db")
                if os.path.exists(manifest):
                    mtime = os.path.getmtime(manifest)
                    subdirs_found.append((entry.name, mtime))
                    if mtime > best_mtime:
                        best_mtime = mtime
                        best_path = entry.path
            _dev_log(
                f"[_resolve_backup_path] case 3 scan: found {len(subdirs_found)} "
                f"candidate(s): {subdirs_found!r}  best={best_path!r}"
            )
            if best_path:
                return best_path
        except Exception as exc:
            _dev_log(f"[_resolve_backup_path] case 3 scan error: {exc}")

        # Fallback: return output_dir unchanged (open_backup will surface any error)
        _dev_log(f"[_resolve_backup_path] fallback → {output_dir!r}")
        return output_dir

    async def _configure_encryption_async(
        self, lockdown, password: str, backup_directory: str
    ) -> None:
        """
        Enable encrypted backups on the device if not already active.

        If encryption is already enabled we skip change_password entirely —
        calling it would open a second MobileBackup2 connection, causing iOS
        to show an extra passcode prompt before the backup even starts.

        Raises RuntimeError with a PASSCODE_REQUIRED prefix if iOS terminates
        the connection while waiting for the user to enter their passcode.
        """
        from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service
        from pymobiledevice3.exceptions import ConnectionTerminatedError, PasswordRequiredError

        # Check whether backup encryption is already configured on the device.
        # If it is, the backup will use the stored password and no password
        # change (or extra passcode prompt) is needed.
        already_encrypted = await lockdown.get_value("com.apple.mobile.backup", "WillEncrypt") or False
        print(f"[encryption] WillEncrypt={already_encrypted}", file=sys.stderr, flush=True)
        if already_encrypted:
            print("[encryption] already enabled, skipping change_password", file=sys.stderr, flush=True)
            return

        try:
            print(f"[encryption] calling change_password (backup_directory={backup_directory})", file=sys.stderr, flush=True)
            async with Mobilebackup2Service(lockdown) as mb2:
                await mb2.change_password(
                    backup_directory=backup_directory,
                    old="",
                    new=password,
                )
            print("[encryption] change_password succeeded", file=sys.stderr, flush=True)
        except (ConnectionTerminatedError, PasswordRequiredError):
            # iOS terminated the connection while waiting for the user to enter
            # their passcode on the device to authorise enabling encryption,
            # or refused to start the backup service because the device is locked.
            raise RuntimeError(
                "PASSCODE_REQUIRED: Your iPhone is prompting for your passcode "
                "to allow the backup. Check your iPhone screen, enter your "
                "passcode when prompted, then click Retry."
            )
        except Exception as e:
            print(f"[encryption] change_password failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            raise

        # Verify encryption was actually enabled
        will_encrypt_now = await lockdown.get_value("com.apple.mobile.backup", "WillEncrypt") or False
        print(f"[encryption] post-change WillEncrypt={will_encrypt_now}", file=sys.stderr, flush=True)
        if not will_encrypt_now:
            print("[encryption] WARNING: WillEncrypt still False after change_password", file=sys.stderr, flush=True)
