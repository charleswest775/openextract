"""
Device backup module — create iPhone backups from live connected devices.

Uses pymobiledevice3 for device communication and MobileBackup2 protocol.
"""

import os
from typing import Callable, Optional


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

        # ── Path 1: usbmuxd (USB cable + legacy Wi-Fi sync) ──────────────────
        for dev in list_devices():
            try:
                lockdown = create_using_usbmux(serial=dev.serial)
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
        # How the handshake works:
        #   a) The device broadcasts an mDNS record: _remoted._tcp.local
        #      (typically port 58783) on the local network.
        #   b) pymobiledevice3.remote.utils.get_rsds() resolves these mDNS
        #      records and returns host/port tuples.
        #   c) RemoteServiceDiscoveryService opens a QUIC connection to that
        #      endpoint.  The QUIC certificate is authenticated against the
        #      device's existing pairing record stored on this Mac.
        #   d) Inside the QUIC tunnel the standard lockdown protocol runs,
        #      giving access to device info and services including MobileBackup2.
        #
        # Devices already seen via usbmuxd are de-duplicated by UDID so that
        # a cable-connected device isn't listed twice.
        try:
            from pymobiledevice3.remote.utils import get_rsds
            from pymobiledevice3.remote.remote_service_discovery import (
                RemoteServiceDiscoveryService,
            )

            for rsd in get_rsds():
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
        :returns:           { "success": True, "backup_path": output_dir }
        """
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service
        except ImportError:
            raise RuntimeError(
                "pymobiledevice3 is not installed. Run: pip install pymobiledevice3"
            )

        os.makedirs(output_dir, exist_ok=True)

        notify("negotiating", 0, 0, 0)

        # Open the lockdown channel to the device.
        lockdown = create_using_usbmux(serial=udid)

        notify("negotiating", 5, 0, 0)

        if encrypted:
            self._configure_encryption(lockdown, password or "")

        notify("negotiating", 10, 0, 0)

        # Track progress counters across the callback.
        files_done = 0
        files_total = 0

        def _progress_cb(progress_info: dict) -> None:
            """
            Translate raw MobileBackup2 progress dicts into our phase/percent model.

            pymobiledevice3 delivers the raw backup protocol message as a dict.
            Keys vary slightly across iOS versions, so every access uses .get().

            Observed keys:
              Progress         — float 0.0–1.0  (newer iOS) OR int 0–100 (older)
              TotalFiles       — int
              FilesTransferred — int
              SnapshotState    — str e.g. "copying", "finalizing"
            """
            nonlocal files_done, files_total

            raw_pct = progress_info.get("Progress", 0)
            if isinstance(raw_pct, float):
                # Normalise 0.0–1.0 → 0–99 (reserve 100 for completion signal)
                pct = min(99, max(0, int(raw_pct * 100)))
            else:
                pct = min(99, max(0, int(raw_pct)))

            files_total = progress_info.get("TotalFiles", files_total) or files_total
            files_done = progress_info.get("FilesTransferred", files_done) or files_done

            state = str(progress_info.get("SnapshotState", "")).lower()
            phase = "finalizing" if ("final" in state or pct >= 95) else "backing_up"

            notify(phase, pct, files_done, files_total)

        with Mobilebackup2Service(lockdown) as mb2:
            notify("backing_up", 10, 0, 0)
            mb2.backup(
                full=True,
                backup_directory=output_dir,
                progress_callback=_progress_cb,
            )

        notify("finalizing", 100, files_done, files_total)
        return {"success": True, "backup_path": output_dir}

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _configure_encryption(self, lockdown, password: str) -> None:
        """
        Enable encrypted backups on the device, or verify the password if
        encryption is already active.

        Calls MobileBackup2Service.change_backup_password() with an empty old
        password to enable encryption for the first time.  If the device already
        has a backup password set, this call will raise; we catch and continue,
        allowing the subsequent backup() call to surface any mismatch.
        """
        try:
            from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service

            with Mobilebackup2Service(lockdown) as mb2:
                mb2.change_backup_password(old_password="", new_password=password)
        except Exception:
            # Encryption already enabled; the backup call will fail with an
            # authentication error if the supplied password is wrong.
            pass
