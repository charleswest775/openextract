"""
FakeIPhone: a scripted iPhone that OpenExtract's engine backs up through the real pymobiledevice3.

While `with phone.plugged_in():` is active, pymobiledevice3's usbmux device list shows the
phone and `create_using_usbmux()` returns a lockdown client for it. Every service that client
starts is a real pymobiledevice3 ServiceConnection over a socket pair, with the iPhone's side
played by services.py. So the engine's start_backup(), Mobilebackup2Service.backup(),
DeviceLink and ServiceConnection all run as they do with a phone on the cable.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from types import SimpleNamespace
from typing import Any, Callable, Iterator, Optional
from unittest.mock import patch

from . import plan as plans
from . import services
from .real_modules import module, real_pymobiledevice3
from .wire import DeviceSocket, socket_pair

DEFAULT_UDID = "00008110-000A1B2C3D4E5F60"


class FakeIPhone:
    """
    Faults, all off by default:

    drop_after_bytes  the iPhone closes the backup connection once it has sent this many bytes
                      (every attempt), as when the link fails partway through
    unplug_on_drop    ...and the iPhone is gone from usbmuxd's list too, as when the cable comes out
    reset_on_drop     drop with a TCP reset rather than a close, where the socket allows it
    drop_everything   every connection drops with the backup one (the backup lock's too), but
                      the iPhone stays plugged in, as when usbmuxd resets the device's links
    stall_timeout    seconds the iPhone waits for the computer to take data before it gives up
                      and closes the connection (a guess at BackupAgent2's behaviour; real value
                      unknown)
    refuse_attempts   {attempt number: ProcessMessage content}: answer that backup request with
                      this error, e.g. {0: {"ErrorCode": 208}} for "backup lock busy" once
    sync_lock_busy    times the iPhone's sync lock answers "would block" (another sync running)
    locked            the iPhone is locked: lockdown refuses to start services
    close_after_finish  the iPhone closes the connection right after its final answer
    pace              replay a recorded trace at its own pace, sped up this many times

    Hooks: phone.before("MoveItems", fn) calls fn(op) in the iPhone's thread just before the
    first MoveItems is sent, e.g. to lock a folder at the moment it matters.
    """

    def __init__(
        self,
        plan: Optional[list[dict]] = None,
        *,
        udid: str = DEFAULT_UDID,
        name: str = "Test iPhone",
        ios_version: str = "18.1",
        product_type: str = "iPhone15,2",
        will_encrypt: bool = False,
        paired: bool = True,
        locked: bool = False,
        drop_after_bytes: Optional[int] = None,
        unplug_on_drop: bool = False,
        reset_on_drop: bool = False,
        drop_everything: bool = False,
        stall_timeout: Optional[float] = None,
        refuse_attempts: Optional[dict[int, dict]] = None,
        sync_lock_busy: int = 0,
        close_after_finish: bool = False,
        pace: Optional[float] = None,
        disk_used: int = 40 * 10**9,
        disk_capacity: int = 128 * 10**9,
    ) -> None:
        self.plan = plan if plan is not None else plans.synthetic_backup()
        self.udid = udid
        self.values = {
            "UniqueDeviceID": udid,
            "DeviceName": name,
            "ProductVersion": ios_version,
            "ProductType": product_type,
            "BuildVersion": "22B83",
            "SerialNumber": "FAKE0SERIAL0",
            "DeviceClass": "iPhone",
            "UniqueChipID": 0x1A2B3C4D5E6F,
            "DevicePublicKey": b"fake public key",
        }
        self.domains: dict[str, dict] = {
            "com.apple.disk_usage": {"TotalDataCapacity": disk_capacity, "TotalDataAvailable": disk_capacity - disk_used},
        }
        self.apps = ["com.example.notes"]
        self.will_encrypt = will_encrypt
        self.paired = paired
        self.locked = locked
        self.drop_after_bytes = drop_after_bytes
        self.unplug_on_drop = unplug_on_drop
        self.reset_on_drop = reset_on_drop
        self.drop_everything = drop_everything
        self.stall_timeout = stall_timeout
        self.refuse_attempts = refuse_attempts or {}
        self.sync_lock_busy = sync_lock_busy
        self.close_after_finish = close_after_finish
        self.pace = pace

        self.connected = True
        self.attempts = 0
        self.stalled = False
        self.host_disconnected = False  # the computer ended the session after an error of its own
        self.drops = 0
        self.errors: list[str] = []  # unexpected failures on the iPhone's side: a harness bug
        self.events: list[tuple[float, str]] = []
        self.sent_files: list[str] = []
        self.statuses: list[list] = []
        self.final_answers: list[dict] = []
        self.posted: list[str] = []
        self.notification_proxies: list[services.NotificationProxy] = []
        self._hooks: list[tuple[str, Callable[[dict], Any]]] = []
        self._sockets: list[DeviceSocket] = []
        self._threads: list[threading.Thread] = []
        self._lock = threading.Lock()
        self._t0 = time.monotonic()

    # ── for tests ──
    def before(self, op_name: str, fn: Callable[[dict], Any]) -> None:
        """Call fn(op) in the iPhone's thread just before the first op of this kind is sent."""
        self._hooks.append((op_name, fn))

    def unplug(self) -> None:
        """The cable comes out: gone from usbmuxd's list, every connection closed."""
        self.log("unplugged")
        self.connected = False
        with self._lock:
            sockets = list(self._sockets)
        for s in sockets:
            s.close()

    def notify(self, name: str, wait: float = 2.0) -> None:
        """Relay a notification to the computer, as springboard does for the passcode prompt."""
        deadline = time.monotonic() + wait
        while True:
            if any(np.relay(name) for np in list(self.notification_proxies)):
                self.log(f"relayed {name}")
                return
            if time.monotonic() > deadline:
                self.log(f"nobody observes {name}")
                return
            time.sleep(0.01)

    def log(self, event: str) -> None:
        self.events.append((round(time.monotonic() - self._t0, 3), event))

    # ── used by services ──
    def start_attempt(self) -> int:
        with self._lock:
            self.attempts += 1
            return self.attempts - 1

    def run_hooks(self, op_name: str, op: dict) -> None:
        for name, fn in list(self._hooks):
            if name == op_name:
                self._hooks.remove((name, fn))
                fn(op)

    def take_sync_lock_busy(self) -> bool:
        with self._lock:
            if self.sync_lock_busy > 0:
                self.sync_lock_busy -= 1
                return True
            return False

    def dropped(self, sock: DeviceSocket) -> None:
        self.drops += 1
        if self.unplug_on_drop:
            self.unplug()
        elif self.drop_everything:
            with self._lock:
                sockets = list(self._sockets)
            for s in sockets:
                s.close(reset=self.reset_on_drop)
        else:
            sock.close(reset=self.reset_on_drop)

    def open_service(self, name: str):
        if name not in services.HANDLERS:
            raise module("pymobiledevice3.exceptions").StartServiceError(name, "InvalidService")
        host, device = socket_pair()
        is_backup = name == "com.apple.mobilebackup2"
        sock = DeviceSocket(
            device, name,
            send_budget=self.drop_after_bytes if is_backup else None,
            stall_timeout=self.stall_timeout if is_backup else None,
        )
        with self._lock:
            self._sockets.append(sock)
            self._threads.append(services.start(self, name, sock))
        self.log(f"started {name}")
        return host

    # ── plugging in ──
    @contextlib.contextmanager
    def plugged_in(self) -> Iterator["FakeIPhone"]:
        """Make pymobiledevice3 see this iPhone on usbmuxd; unplug and tidy up afterwards."""
        with real_pymobiledevice3():
            lockdown_module = module("pymobiledevice3.lockdown")
            usbmux_module = module("pymobiledevice3.usbmux")
            with patch.object(lockdown_module, "create_using_usbmux", self._create_using_usbmux), \
                    patch.object(usbmux_module, "list_devices", self._list_devices):
                try:
                    yield self
                finally:
                    self.close()

    def close(self, timeout: float = 5.0) -> None:
        with self._lock:
            sockets, threads = list(self._sockets), list(self._threads)
        for s in sockets:
            s.close()
        for t in threads:
            t.join(timeout)
            if t.is_alive():
                self.errors.append(f"{t.name} didn't stop within {timeout}s")

    async def _list_devices(self, *args: Any, **kwargs: Any) -> list:
        if not self.connected:
            return []
        return [SimpleNamespace(serial=self.udid, connection_type="USB", devid=1)]

    async def _create_using_usbmux(self, serial: Optional[str] = None, *args: Any, **kwargs: Any):
        exceptions = module("pymobiledevice3.exceptions")
        if not self.connected or (serial is not None and serial != self.udid):
            raise exceptions.NoDeviceConnectedError()
        return make_lockdown_client(self)


class _NoLockdownConnection:
    """Stands in for the lockdownd connection, which the fake lockdown client never uses."""

    mux_device = None

    async def close(self) -> None:
        pass

    aclose = close


def make_lockdown_client(phone: FakeIPhone):
    """A real LockdownClient subclass, so pymobiledevice3 treats it as a lockdown connection."""
    lockdown_module = module("pymobiledevice3.lockdown")
    exceptions = module("pymobiledevice3.exceptions")
    service_connection = module("pymobiledevice3.service_connection")

    class FakeLockdownClient(lockdown_module.LockdownClient):
        def __init__(self) -> None:
            super().__init__(
                _NoLockdownConnection(),
                host_id="00000000-FAKE-HOST-0000-000000000000",
                identifier=phone.udid,
                pair_record={"HostID": "00000000-FAKE-HOST-0000-000000000000", "EscrowBag": b"fake escrow bag"}
                if phone.paired else None,
            )
            self.logger = logging.getLogger("fake_iphone.lockdown")
            self.paired = phone.paired
            self.all_values = dict(phone.values)
            self.udid = phone.udid
            self.unique_chip_id = phone.values["UniqueChipID"]
            self.device_public_key = phone.values["DevicePublicKey"]
            self.product_type = phone.values["ProductType"]

        async def get_value(self, domain: Optional[str] = None, key: Optional[str] = None) -> Any:
            if domain is None and key is None:
                return dict(phone.values)
            if domain == "com.apple.mobile.backup":
                values = {"WillEncrypt": phone.will_encrypt}
            elif domain is None:
                values = phone.values
            else:
                values = phone.domains.get(domain, {})
            if key is None:
                return dict(values)
            if key not in values:
                raise exceptions.MissingValueError(f"{domain}/{key}")
            return values[key]

        async def get_service_connection_attributes(self, name: str, include_escrow_bag: bool = False) -> dict:
            return {"Port": 1, "Service": name}

        async def start_lockdown_service(self, name: str, include_escrow_bag: bool = False):
            if not self.paired:
                raise exceptions.NotPairedError()
            if not phone.connected:
                raise exceptions.ConnectionTerminatedError()
            if phone.locked:
                raise exceptions.PasswordRequiredError(
                    "your device is protected with password, please enter password in device and try again")
            return await _service_connection(service_connection.ServiceConnection, phone.open_service(name))

        async def create_service_connection(self, port: int, *args: Any, **kwargs: Any):
            raise NotImplementedError("the fake lockdown client starts services with start_lockdown_service")

        async def close(self) -> None:
            pass

    return FakeLockdownClient()


async def _service_connection(cls, sock):
    # pymobiledevice3 11.26 wraps a socket directly; later 11.x bind it with from_socket().
    if hasattr(cls, "from_socket"):
        return await cls.from_socket(sock)
    return cls(sock)
