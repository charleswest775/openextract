"""
Device backup module — create iPhone backups from live connected devices.

Uses pymobiledevice3 for device communication and MobileBackup2 protocol.
"""

import asyncio
import logging
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
# surfaces from pymobiledevice3's device-link loop as ErrorCode 208 ("Device
# locked"). Windows sees it too, right after the passcode prompt (2026-11-03).
# pymobiledevice3 11.26 words it "Device link error: …", later 11.x releases
# "The device reported an error: …".
_BACKUP_LOCK_ERROR_RE = re.compile(r"(?:Device link error|The device reported an error):.*'ErrorCode': 208\b")
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


# "Trust This Computer?" Every pairing request carries a newly generated certificate chain,
# and the iPhone asks again for each new one. pymobiledevice3 pairs as a side effect of
# connecting and gives up as soon as the iPhone is locked or asking for its passcode, so
# each search started a new request and the user tapped Trust once per search (three
# times on Windows, 2026-11-03). Searching now never pairs. pair_device sends one request
# per iPhone and resends that same request until the user has answered it.
async def _new_pair_request(lockdown) -> dict:
    """The Pair request pymobiledevice3's LockdownClient.pair() would send, kept for reuse."""
    from pymobiledevice3.ca import generate_pairing_cert_chain

    device_public_key = await lockdown.get_value("", "DevicePublicKey")
    if not device_public_key:
        raise RuntimeError("Your iPhone didn't answer. Unplug it, plug it back in, then try again.")
    host_cert, host_key, device_cert, root_cert, root_key = generate_pairing_cert_chain(device_public_key)
    return {
        "options": {
            "HostName": socket.gethostname(),
            "PairRecord": {
                "DeviceCertificate": device_cert,
                "HostCertificate": host_cert,
                "HostID": lockdown.host_id,
                "RootCertificate": root_cert,
                "RootPrivateKey": root_key,
                "WiFiMACAddress": lockdown.wifi_mac_address,
                "SystemBUID": lockdown.system_buid,
            },
            "ProtocolVersion": "2",
            "PairingOptions": {"ExtendedPairingErrors": True},
        },
        "host_key": host_key,
    }


class _BackupPasscodeWatcher(logging.Handler):
    """
    Calls on_prompt when the iPhone asks for its passcode to allow the backup (it did before
    each encrypted backup on iOS 27). pymobiledevice3 only logs that notification (NP_LOCAL_AUTH_PRESENTED),
    so we listen for its log line and the app can say why the backup is waiting.
    """

    def __init__(self, on_prompt: Callable[[], None]):
        super().__init__(logging.WARNING)
        self._on_prompt = on_prompt

    def emit(self, record: logging.LogRecord) -> None:
        if "passcode" in record.getMessage():
            self._on_prompt()


# The app shows this as a step, not a bug (src/components/backup/BackupFlow.tsx).
_DEVICE_DISCONNECTED = (
    "DEVICE_DISCONNECTED: Your iPhone was disconnected before the backup finished. Plug it "
    "back in, unlock it, then click Retry."
)


def _device_connected(udid: str) -> bool:
    """False once usbmuxd no longer lists the iPhone, as after it's unplugged."""
    from pymobiledevice3.usbmux import list_devices

    try:
        return any(dev.serial == udid for dev in asyncio.run(list_devices()))
    except Exception as e:
        _dev_log(f"couldn't check whether {udid} is still connected: {e!r}")
        return True  # can't tell, so leave the other explanations to the caller


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

    def __init__(self) -> None:
        # The Pair request each untrusted iPhone may be showing "Trust This Computer?" for,
        # by UDID, so that pair_device resends it instead of making the iPhone ask again.
        self._pair_requests: dict[str, dict] = {}

    def list_devices(self) -> dict:
        """
        Detect all connected iPhone/iPad devices via USB and Wi-Fi.

        Returns a list of device dicts: { udid, name, ios_version, connection_type, trusted }.
        A device that doesn't trust this computer yet is listed with trusted=False, and
        searching doesn't ask it to: pair_device does.

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
                    # autopair=False: searching never shows "Trust This Computer?" (see
                    # _new_pair_request). The model and iOS version don't need pairing.
                    lockdown = await create_using_usbmux(serial=dev.serial, autopair=False)
                    try:
                        udid = lockdown.udid or dev.serial
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
                            "trusted": bool(lockdown.paired),
                        })
                    finally:
                        await lockdown.close()
                except Exception as e:
                    _dev_log(f"skipped device {getattr(dev, 'serial', '?')}: {e!r}")

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
                                # RSD only connects with an existing pairing.
                                "trusted": True,
                            })
                    except Exception:
                        pass
            except (ImportError, Exception):
                # RSD discovery is optional; missing Bonjour/Avahi or old pymobiledevice3
                # versions that lack the remote sub-package are not fatal.
                pass

        asyncio.run(_collect_usb_devices())
        return {"devices": devices}

    def pair_device(self, udid: str) -> dict:
        """
        Ask the iPhone to trust this computer, without waiting for the answer. Returns
        { "state": "trusted" | "waiting" | "locked" | "denied" }: "waiting" while it shows
        "Trust This Computer?", "locked" while it's locked or asking for the passcode. The
        app calls this every couple of seconds until it gets "trusted" or "denied"; every
        call sends the same request, so the iPhone asks once.
        """
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.exceptions import (
            ConnectionFailedToUsbmuxdError,
            PairingDialogResponsePendingError,
            PasswordRequiredError,
            UserDeniedPairingError,
        )

        async def _pair() -> str:
            try:
                lockdown = await create_using_usbmux(serial=udid, autopair=False)
            except ConnectionFailedToUsbmuxdError:
                raise _device_service_error() from None
            try:
                if lockdown.paired:
                    self._pair_requests.pop(udid, None)
                    return "trusted"
                request = self._pair_requests.get(udid)
                if request is None:
                    request = self._pair_requests[udid] = await _new_pair_request(lockdown)
                    _dev_log(f"pair_device {udid}: new pair request")
                try:
                    # timeout=0: send it once and report back rather than hold up the engine.
                    response = await lockdown._request_pair(request["options"], timeout=0)
                except PairingDialogResponsePendingError:
                    return "waiting"
                except PasswordRequiredError:
                    return "locked"
                except UserDeniedPairingError:
                    del self._pair_requests[udid]
                    return "denied"
                record = {**request["options"]["PairRecord"], "HostPrivateKey": request["host_key"]}
                if response.get("EscrowBag") is not None:
                    record["EscrowBag"] = response["EscrowBag"]
                lockdown.pair_record = record
                await lockdown.save_pair_record()
                del self._pair_requests[udid]
                if not await lockdown.validate_pairing():
                    raise RuntimeError(
                        "Your iPhone trusted this computer but then wouldn't connect. Unplug it, "
                        "plug it back in, then try again."
                    )
                return "trusted"
            finally:
                await lockdown.close()

        state = asyncio.run(_pair())
        _dev_log(f"pair_device {udid}: {state}")
        return {"state": state}

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

        # Shared mutable state across the nested helpers.
        files_done = 0
        files_total = 0
        # high-water mark shared by ALL notification paths so that the hardcoded
        # negotiating / backing_up milestones (0 → 5 → 10) are never overwritten
        # by an early 0% callback from pymobiledevice3.
        last_pct = [0]
        # Bytes in use on the iPhone, so a disk-full error can say how much room
        # the backup needs.  0 when the device didn't report it.
        phone_used_bytes = 0

        def _tracked_notify(phase: str, pct: int, fd: int, ft: int) -> None:
            """Emit a progress notification, enforcing monotone progress."""
            pct = max(last_pct[0], pct)
            last_pct[0] = pct
            notify(phase, pct, fd, ft)

        def _progress_cb(progress_info) -> None:
            """
            Translate raw MobileBackup2 progress into our phase/percent model.

            pymobiledevice3 may deliver either:
              - a dict with keys: Progress, TotalFiles, FilesTransferred, SnapshotState
              - a raw float (0.0–1.0) on some iOS versions / pymobiledevice3 builds
            """
            nonlocal files_done, files_total

            if not isinstance(progress_info, dict):
                # Raw float progress value
                raw_pct = float(progress_info) if progress_info is not None else 0.0
                pct = min(99, int(raw_pct * 100 if raw_pct <= 1.0 else raw_pct))
                _tracked_notify("backing_up", pct, files_done, files_total)
                return

            raw_pct = progress_info.get("Progress", 0)
            if isinstance(raw_pct, float):
                pct = min(99, int(raw_pct * 100))
            else:
                pct = min(99, int(raw_pct))

            files_total = progress_info.get("TotalFiles", files_total) or files_total
            files_done = progress_info.get("FilesTransferred", files_done) or files_done

            state = str(progress_info.get("SnapshotState", "")).lower()
            phase = "finalizing" if "final" in state else "backing_up"

            _tracked_notify(phase, pct, files_done, files_total)

        async def _run_backup():
            nonlocal phone_used_bytes
            _tracked_notify("negotiating", 0, 0, 0)

            # Open the lockdown channel to the device (async in pymobiledevice3 v4+).
            # Catch trust/pairing errors early and surface them with a clear message.
            try:
                # autopair=False: pairing here would make a new Trust prompt and wait on it
                # with no word to the user. The app pairs first (pair_device).
                lockdown = await create_using_usbmux(serial=udid, autopair=False)
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
            if not lockdown.paired:
                await lockdown.close()
                raise RuntimeError(
                    "TRUST_REQUIRED: Your iPhone doesn't trust this computer yet. Unlock it, tap "
                    "Trust when it asks, and enter your passcode."
                )

            try:
                usage = await lockdown.get_value("com.apple.disk_usage")
                phone_used_bytes = usage["TotalDataCapacity"] - usage["TotalDataAvailable"]
            except Exception as e:
                _dev_log(f"couldn't read the iPhone's disk usage: {e!r}")

            _tracked_notify("negotiating", 5, 0, 0)

            if encrypted:
                await self._configure_encryption_async(lockdown, password or "", output_dir)

            _tracked_notify("negotiating", 10, 0, 0)

            def _on_passcode_prompt() -> None:
                _dev_log("the iPhone is asking for its passcode to allow the backup")
                _tracked_notify("passcode", last_pct[0], files_done, files_total)

            mb2_logger = logging.getLogger("pymobiledevice3.services.mobilebackup2")
            passcode_watcher = _BackupPasscodeWatcher(_on_passcode_prompt)
            mb2_logger.addHandler(passcode_watcher)
            try:
                async with Mobilebackup2Service(lockdown) as mb2:
                    _tracked_notify("backing_up", 11, 0, 0)
                    await mb2.backup(
                        full=True,
                        backup_directory=output_dir,
                        progress_callback=_progress_cb,
                    )
            finally:
                mb2_logger.removeHandler(passcode_watcher)

            _tracked_notify("finalizing", 100, files_done, files_total)

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

        started_at = time.time()
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
            # Unplugging the iPhone ends here too, and is neither of the cases below.
            if not _device_connected(udid):
                raise RuntimeError(_DEVICE_DISCONNECTED) from e
            # iOS often closes the backup channel immediately after all data has been
            # transferred — this is normal end-of-backup behaviour and does NOT mean
            # the backup failed. The device sends Manifest.db at the end, so one written
            # during this run means it finished. (pymobiledevice3 writes Info.plist
            # first, and a folder used before has an older Manifest.db.)
            actual = self._resolve_backup_path(output_dir, udid)
            manifest_path = os.path.join(actual, "Manifest.db")
            if os.path.exists(manifest_path) and os.path.getmtime(manifest_path) >= started_at:
                _tracked_notify("finalizing", 100, files_done, files_total)
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
        except Exception as e:
            if not _device_connected(udid):
                raise RuntimeError(_DEVICE_DISCONNECTED) from e
            # Still locked after the retry: a step for the user, not pymobiledevice3's
            # "please report it" text.
            if not _is_backup_lock_error(e):
                raise
            raise RuntimeError(
                "PASSCODE_REQUIRED: Your iPhone was locked when the backup started. Unlock it, "
                "enter your passcode when it asks, keep it unlocked, then click Retry."
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
