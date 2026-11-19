"""
FakeIPhone: a scripted iPhone that OpenExtract's engine backs up through the real pymobiledevice3.

While `with phone.plugged_in():` is active, pymobiledevice3's usbmux device list shows the
phone and `create_using_usbmux()` returns a lockdown client for it. Every service that client
starts is a real pymobiledevice3 ServiceConnection over a socket pair, with the iPhone's side
played by services.py. So the engine's start_backup(), Mobilebackup2Service.backup(),
DeviceLink and ServiceConnection all run as they do with a phone on the cable.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
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
    stops_answering   "handshake": the iPhone takes the connection but never answers lockdown's
                      handshake; "questions": it answers that, then never answers a question
                      (lockdown get_value); "pairing": it answers both, then never answers the
                      Pair request (pair_device's "Trust This Computer?"). Either way it waits
                      until it's unplugged (OE-37)
    close_after_finish  the iPhone closes the connection right after its final answer
    pace              replay a recorded trace at its own pace, sped up this many times
    size_cap          send at most this many bytes of each file, to replay a big trace quickly

    Trusting: an iPhone made with paired=False answers each Pair request by `phone.trust`:
    "pending" (showing "Trust This Computer?"), "locked" (locked, or asking for the passcode),
    "denied" (the user tapped Don't Trust: answered once, then it asks again) or "trusted" (the
    user tapped Trust: it accepts, and is paired from then on). A test changes it between
    pair_device calls, as the user would. Every request is kept in `phone.pair_requests`.

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
        trust: str = "pending",
        locked: bool = False,
        stops_answering: Optional[str] = None,
        drop_after_bytes: Optional[int] = None,
        unplug_on_drop: bool = False,
        reset_on_drop: bool = False,
        drop_everything: bool = False,
        stall_timeout: Optional[float] = None,
        refuse_attempts: Optional[dict[int, dict]] = None,
        sync_lock_busy: int = 0,
        close_after_finish: bool = False,
        pace: Optional[float] = None,
        size_cap: Optional[int] = None,
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
            "DevicePublicKey": _device_public_key(),
            "WiFiAddress": "aa:bb:cc:dd:ee:ff",
        }
        self.domains: dict[str, dict] = {
            "com.apple.disk_usage": {"TotalDataCapacity": disk_capacity, "TotalDataAvailable": disk_capacity - disk_used},
        }
        self.apps = ["com.example.notes"]
        self.will_encrypt = will_encrypt
        # Every ChangePassword request the computer sent (OldPassword, NewPassword, ...).
        self.password_changes: list[dict] = []
        self.paired = paired
        assert trust in ("pending", "locked", "denied", "trusted"), trust
        self.trust = trust
        self.pair_requests: list[dict] = []  # every Pair request the computer sent
        self.pair_record: Optional[dict] = None  # the record the computer saved once trusted
        self.locked = locked
        assert stops_answering in (None, "handshake", "questions", "pairing"), stops_answering
        self.stops_answering = stops_answering
        self.drop_after_bytes = drop_after_bytes
        self.unplug_on_drop = unplug_on_drop
        self.reset_on_drop = reset_on_drop
        self.drop_everything = drop_everything
        self.stall_timeout = stall_timeout
        self.refuse_attempts = refuse_attempts or {}
        self.sync_lock_busy = sync_lock_busy
        self.close_after_finish = close_after_finish
        self.pace = pace
        self.size_cap = size_cap

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
        self.gone = threading.Event()  # set once unplugged or closed: ends the phone's waits

    # ── for tests ──
    def before(self, op_name: str, fn: Callable[[dict], Any]) -> None:
        """Call fn(op) in the iPhone's thread just before the first op of this kind is sent."""
        self._hooks.append((op_name, fn))

    def unplug(self) -> None:
        """The cable comes out: gone from usbmuxd's list, every connection closed."""
        self.log("unplugged")
        self.connected = False
        self.gone.set()
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

    async def never_answer(self, what: str) -> None:
        """Leave the computer waiting for `what`, as an iPhone that has stopped answering does."""
        self.log(f"{what}: no answer")
        while not self.gone.is_set():
            await asyncio.sleep(0.05)
        raise module("pymobiledevice3.exceptions").ConnectionTerminatedError()

    def log(self, event: str) -> None:
        self.events.append((round(time.monotonic() - self._t0, 3), event))

    def size_of(self, f: dict) -> int:
        """Bytes the iPhone sends for a file in the plan."""
        return f["size"] if self.size_cap is None else min(f["size"], self.size_cap)

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

    async def answer_pair(self, request: dict) -> dict:
        """lockdownd's answer to a Pair request, by `trust` (see the class docstring)."""
        self.pair_requests.append(request)
        if self.stops_answering == "pairing":
            await self.never_answer("lockdown Pair")
        answer = {"Request": "Pair"}
        if self.trust == "trusted":
            self.paired = True
            self.log("Pair: trusted")
            return {**answer, "EscrowBag": b"fake escrow bag"}
        self.log(f"Pair: {self.trust}")
        error = {"pending": "PairingDialogResponsePending", "locked": "PasswordProtected",
                 "denied": "UserDeniedPairing"}[self.trust]
        if self.trust == "denied":
            self.trust = "pending"  # the next request shows "Trust This Computer?" again
        return {**answer, "Error": error}

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
        self.gone.set()
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
        if self.stops_answering == "handshake":
            await self.never_answer("lockdown handshake")
        return make_lockdown_client(self)


@functools.lru_cache(maxsize=None)
def _device_public_key() -> bytes:
    """An RSA public key in the form an iPhone gives it, so pairing certificates can be made for it."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
    return key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.PKCS1)


class _LockdownConnection:
    """
    The lockdownd connection. The fake lockdown client answers most requests itself; a Pair
    request comes through here, so pymobiledevice3's own _request_pair and _request read the
    iPhone's answer and its errors.
    """

    mux_device = None

    def __init__(self, phone: FakeIPhone) -> None:
        self.phone = phone

    async def send_recv_plist(self, message: dict) -> dict:
        if message.get("Request") == "Pair":
            return await self.phone.answer_pair(dict(message))
        raise NotImplementedError(f"the fake lockdownd doesn't answer {message.get('Request')}")

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
                _LockdownConnection(phone),
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
            if phone.stops_answering == "questions":
                await phone.never_answer(f"lockdown get_value {domain}/{key}")
            if not domain and key is None:
                return dict(phone.values)
            if domain == "com.apple.mobile.backup":
                values = {"WillEncrypt": phone.will_encrypt}
            elif not domain:  # None, or "" as pair_device asks for DevicePublicKey
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

        async def save_pair_record(self) -> None:
            # The computer keeps the record; here, the fake iPhone does, for tests to look at.
            phone.pair_record = dict(self.pair_record)
            phone.log("pair record saved")

        async def validate_pairing(self) -> bool:
            # The real one starts a session with the saved record: it works once the iPhone has
            # accepted a Pair request with that record's HostID.
            ok = phone.paired and self.pair_record is not None and any(
                r.get("PairRecord", {}).get("HostID") == self.pair_record.get("HostID")
                for r in phone.pair_requests)
            self.paired = ok
            return ok

        async def close(self) -> None:
            pass

    return FakeLockdownClient()


async def _service_connection(cls, sock):
    # pymobiledevice3 11.26 wraps a socket directly; later 11.x bind it with from_socket().
    if hasattr(cls, "from_socket"):
        return await cls.from_socket(sock)
    return cls(sock)
