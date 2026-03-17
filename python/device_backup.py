"""
Device backup module — create iPhone backups from live connected devices.

Uses pymobiledevice3 for device communication and MobileBackup2 protocol.
"""

import asyncio
import os
import time
from typing import Callable, Optional


def _dev_log(msg: str) -> None:
    """Append a timestamped line to python_log.txt (survives sidecar restarts)."""
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


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
                if isinstance(e, ConnectionFailedToUsbmuxdError):
                    raise RuntimeError(
                        "Cannot connect to Apple Mobile Device Service. "
                        "On Windows, install iTunes or the Apple Devices app from the "
                        "Microsoft Store, then make sure it is running before searching "
                        "for devices."
                    ) from None
                raise

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
            from pymobiledevice3.exceptions import ConnectionTerminatedError
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
            _tracked_notify("negotiating", 0, 0, 0)

            # Open the lockdown channel to the device (async in pymobiledevice3 v4+).
            # Catch trust/pairing errors early and surface them with a clear message.
            try:
                lockdown = await create_using_usbmux(serial=udid)
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

            _tracked_notify("negotiating", 5, 0, 0)

            if encrypted:
                await self._configure_encryption_async(lockdown, password or "", output_dir)

            _tracked_notify("negotiating", 10, 0, 0)

            async with Mobilebackup2Service(lockdown) as mb2:
                _tracked_notify("backing_up", 11, 0, 0)
                await mb2.backup(
                    full=True,
                    backup_directory=output_dir,
                    progress_callback=_progress_cb,
                )

            _tracked_notify("finalizing", 100, files_done, files_total)

        try:
            asyncio.run(_run_backup())
        except ConnectionTerminatedError as e:
            # iOS often closes the backup channel immediately after all data has been
            # transferred — this is normal end-of-backup behaviour and does NOT mean
            # the backup failed.  If the backup directory already contains a Manifest
            # or Info.plist we treat the run as successful.
            actual = self._resolve_backup_path(output_dir, udid)
            manifest_path = os.path.join(actual, "Manifest.db")
            info_path = os.path.join(actual, "Info.plist")
            if os.path.exists(manifest_path) or os.path.exists(info_path):
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
        from pymobiledevice3.exceptions import ConnectionTerminatedError

        # Check whether backup encryption is already configured on the device.
        # If it is, the backup will use the stored password and no password
        # change (or extra passcode prompt) is needed.
        already_encrypted = lockdown.get_value("com.apple.mobile.backup", "WillEncrypt") or False
        if already_encrypted:
            return

        try:
            async with Mobilebackup2Service(lockdown) as mb2:
                await mb2.change_password(
                    backup_directory=backup_directory,
                    old="",
                    new=password,
                )
        except ConnectionTerminatedError:
            # iOS terminated the connection while waiting for the user to enter
            # their passcode on the device to authorise enabling encryption.
            raise RuntimeError(
                "PASSCODE_REQUIRED: Your iPhone is prompting for your passcode "
                "to allow the backup. Check your iPhone screen, enter your "
                "passcode when prompted, then click Retry."
            )
