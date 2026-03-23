"""iPhone device-to-disk backup agent.

Wraps pymobiledevice3 to create encrypted or unencrypted backups.
All progress is surfaced via async generator — the caller decides
how to forward events (SSE, stdout, WebSocket, etc.).

Usage::

    agent = BackupAgent(output_dir="/backups")
    async for event in agent.create(udid="abc123", encrypted=True, password="s3cr3t"):
        print(event)
    print("Backup saved to:", agent.result_path)
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator

from openextract.core.events import Event


@dataclass
class DeviceInfo:
    udid: str
    name: str | None = None
    ios_version: str | None = None
    product_type: str | None = None
    connection_type: str = "unknown"
    """'usb', 'wifi', or 'rsd'."""


@dataclass
class BackupProgress:
    phase: str
    """'negotiating' | 'backing_up' | 'finalizing' | 'complete' | 'error'."""
    percent: float = 0.0
    current_file: str | None = None
    error: str | None = None


class BackupAgent:
    """Creates iPhone backups from connected devices."""

    def __init__(self, output_dir: str | Path):
        self._output_dir = Path(output_dir)
        self.result_path: Path | None = None

    # ------------------------------------------------------------------
    # Device discovery
    # ------------------------------------------------------------------

    def list_devices(self) -> list[DeviceInfo]:
        """Return all connected iPhone/iPad devices."""
        devices: dict[str, DeviceInfo] = {}

        # usbmuxd devices (USB + legacy Wi-Fi)
        try:
            from pymobiledevice3.usbmux import select_devices_by_connection_type
            from pymobiledevice3.lockdown import LockdownClient

            for usbmux_device in select_devices_by_connection_type(connection_type="USB"):
                try:
                    client = LockdownClient(serial=usbmux_device.serial)
                    info = DeviceInfo(
                        udid=usbmux_device.serial,
                        name=client.display_name,
                        ios_version=client.product_version,
                        product_type=client.product_type,
                        connection_type="usb",
                    )
                    devices[usbmux_device.serial] = info
                except Exception:
                    devices[usbmux_device.serial] = DeviceInfo(
                        udid=usbmux_device.serial,
                        connection_type="usb",
                    )

            for usbmux_device in select_devices_by_connection_type(connection_type="Network"):
                serial = usbmux_device.serial
                if serial not in devices:
                    try:
                        client = LockdownClient(serial=serial)
                        devices[serial] = DeviceInfo(
                            udid=serial,
                            name=client.display_name,
                            ios_version=client.product_version,
                            product_type=client.product_type,
                            connection_type="wifi",
                        )
                    except Exception:
                        devices[serial] = DeviceInfo(udid=serial, connection_type="wifi")
        except ImportError:
            pass
        except Exception:
            pass

        # iOS 17+ RSD devices (mDNS / QUIC tunnel)
        try:
            from pymobiledevice3.remote.remote_service_discovery import (
                RemoteServiceDiscoveryService,
            )
            from pymobiledevice3.remote.tunnel_service import get_core_device_tunnel_services

            for service in get_core_device_tunnel_services():
                try:
                    with RemoteServiceDiscoveryService(
                        (service.address, service.port)
                    ) as rsd:
                        udid = rsd.udid
                        if udid not in devices:
                            devices[udid] = DeviceInfo(
                                udid=udid,
                                name=rsd.product_type,
                                ios_version=rsd.product_version,
                                product_type=rsd.product_type,
                                connection_type="rsd",
                            )
                except Exception:
                    continue
        except (ImportError, Exception):
            pass

        return list(devices.values())

    # ------------------------------------------------------------------
    # Backup creation
    # ------------------------------------------------------------------

    async def create(
        self,
        udid: str,
        encrypted: bool = False,
        password: str | None = None,
    ) -> AsyncGenerator[Event, None]:
        """Create a backup. Yields Event objects as progress is made."""
        self._output_dir.mkdir(parents=True, exist_ok=True)

        yield Event(
            component="backup",
            stage="negotiating",
            progress=0.0,
            message="Connecting to device…",
        )

        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            from pymobiledevice3.services.mobilebackup2 import Mobilebackup2Service

            client = create_using_usbmux(serial=udid)

            if encrypted and password:
                yield Event(
                    component="backup",
                    stage="negotiating",
                    progress=0.05,
                    message="Configuring backup encryption…",
                )
                try:
                    from pymobiledevice3.services.afc import AfcService
                    from pymobiledevice3.services.backup import BackupClient

                    bk = BackupClient(client)
                    bk.change_backup_password(old_password="", new_password=password)
                except Exception as e:
                    yield Event(
                        component="backup",
                        stage="error",
                        progress=0.0,
                        message=f"Failed to set backup password: {e}",
                        detail={"error": str(e)},
                    )
                    return

            backup_service = Mobilebackup2Service(lockdown=client)

            yield Event(
                component="backup",
                stage="backing_up",
                progress=0.1,
                message="Backup started…",
            )

            loop = asyncio.get_event_loop()
            progress_queue: asyncio.Queue[BackupProgress] = asyncio.Queue()
            result: dict = {"path": None, "error": None}

            def _progress_callback(progress: float, current_file: str | None = None):
                asyncio.run_coroutine_threadsafe(
                    progress_queue.put(
                        BackupProgress(
                            phase="backing_up",
                            percent=min(progress, 0.99),
                            current_file=current_file,
                        )
                    ),
                    loop,
                )

            def _run_backup():
                try:
                    backup_service.backup(
                        full=True,
                        backup_directory=str(self._output_dir),
                        progress_callback=_progress_callback,
                    )
                    result["path"] = self._output_dir / udid
                except Exception as e:
                    result["error"] = str(e)
                finally:
                    asyncio.run_coroutine_threadsafe(
                        progress_queue.put(BackupProgress(phase="done", percent=1.0)),
                        loop,
                    )

            import concurrent.futures

            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            future = loop.run_in_executor(executor, _run_backup)

            while True:
                try:
                    prog = await asyncio.wait_for(progress_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    if future.done():
                        break
                    continue

                if prog.phase == "done":
                    break

                yield Event(
                    component="backup",
                    stage="backing_up",
                    progress=0.1 + prog.percent * 0.85,
                    message=prog.current_file or "Backing up…",
                    detail={"file": prog.current_file, "percent": prog.percent},
                )

            await future

            if result["error"]:
                yield Event(
                    component="backup",
                    stage="error",
                    progress=0.0,
                    message=f"Backup failed: {result['error']}",
                    detail={"error": result["error"]},
                )
                return

            yield Event(
                component="backup",
                stage="finalizing",
                progress=0.97,
                message="Finalizing backup…",
            )

            self.result_path = result["path"]

            yield Event(
                component="backup",
                stage="complete",
                progress=1.0,
                message="Backup complete.",
                detail={"path": str(self.result_path)},
            )

        except ImportError:
            yield Event(
                component="backup",
                stage="error",
                progress=0.0,
                message="pymobiledevice3 is not installed. Run: pip install pymobiledevice3",
                detail={"error": "missing_dependency"},
            )
        except Exception as exc:
            yield Event(
                component="backup",
                stage="error",
                progress=0.0,
                message=f"Backup error: {exc}",
                detail={"error": str(exc)},
            )
