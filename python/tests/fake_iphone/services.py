"""
The iPhone's side of the services a backup uses, each serving one connection in its own thread.

- com.apple.mobilebackup2: DeviceLink, playing the backup plan (plan.py) step by step and
  answering the way BackupAgent2 does: MBErrorDomain/104 when files couldn't be sent, 105 when
  the computer reports too little free space, whatever the plan or a fault says otherwise.
- com.apple.mobile.notification_proxy: relays notifications such as the passcode prompt.
- com.apple.afc: just enough AFC for pymobiledevice3's backup lock and Info.plist lookups.
- com.apple.mobile.installation_proxy and com.apple.springboardservices: an app list.
"""

from __future__ import annotations

import struct
import threading
import time
import traceback
from typing import TYPE_CHECKING, Optional

from . import plan as plans
from .wire import (
    CODE_ERROR_REMOTE,
    CODE_FILE_DATA,
    CODE_SUCCESS,
    DeviceSocket,
    Dropped,
    HostClosed,
    HostStalled,
)

if TYPE_CHECKING:
    from .device import FakeIPhone

EMPTY = "___EmptyParameterString___"
PURGE_REQUEST_OVERSHOOT = 0x80000000  # BackupAgent2 asks for 2 GiB more than it needs
HEADROOM = 0x8000000  # and needs 128 MiB more than the files it will send

FILES_NOT_SENT = {"ErrorCode": 104, "ErrorDescription": "Multiple errors uploading files (MBErrorDomain/104)"}
UNREADABLE_MANIFEST = {"ErrorCode": 205, "ErrorDescription": "Error reading backup manifest properties (MBErrorDomain/205)"}
NOT_ENOUGH_SPACE = {"ErrorCode": 105, "ErrorDescription": "Insufficient free disk space on drive to back up (MBErrorDomain/105)"}


class Service:
    def __init__(self, phone: "FakeIPhone", sock: DeviceSocket) -> None:
        self.phone = phone
        self.sock = sock

    def run(self) -> None:
        try:
            self.serve()
        except HostClosed:
            self.phone.log(f"{self.sock.name}: the computer closed the connection")
        except Dropped as e:
            self.phone.log(str(e))
            self.phone.dropped(self.sock)
        except HostStalled as e:
            self.phone.log(str(e))
            self.phone.stalled = True
            self.sock.close()
        except Exception:
            if not self.sock.closed:
                self.phone.errors.append(f"{self.sock.name}:\n{traceback.format_exc()}")
        finally:
            self.sock.close()

    def serve(self) -> None:
        raise NotImplementedError


# ── MobileBackup2 ────────────────────────────────────────────────────────────

class MobileBackup2(Service):
    def serve(self) -> None:
        s = self.sock
        s.send_plist(["DLMessageVersionExchange", 300, 0])
        reply = s.recv_plist()
        assert reply[:2] == ["DLMessageVersionExchange", "DLVersionsOk"], reply
        s.send_plist(["DLMessageDeviceReady"])
        hello = s.recv_plist()
        assert hello[0] == "DLMessageProcessMessage" and hello[1]["MessageName"] == "Hello", hello
        s.send_plist(["DLMessageProcessMessage", {"ErrorCode": 0, "ProtocolVersion": 2.1}])

        request = self.recv_message()
        assert request[0] == "DLMessageProcessMessage", request
        name = request[1]["MessageName"]
        if name == "Backup":
            self.backup()
        elif name == "ChangePassword":
            self.change_password(request[1])
        else:
            self.finish({"ErrorCode": 1, "ErrorDescription": f"fake iPhone: unsupported request {name}"})
        if not s.closed:
            self.wait_for_disconnect()

    def wait_for_disconnect(self) -> None:
        if self.phone.close_after_finish:
            return
        while True:
            message = self.sock.recv_plist()
            if message and message[0] == "DLMessageDisconnect":
                return

    # The backup itself
    def backup(self) -> None:
        attempt = self.phone.start_attempt()
        refusal = self.phone.refuse_attempts.get(attempt)
        if refusal is not None:
            self.finish(refusal)
            return
        self.failed_files = 0
        started = time.monotonic()
        for op in self.phone.plan:
            self.phone.run_hooks(op["op"], op)
            if self.phone.pace and "t" in op:
                delay = op["t"] / self.phone.pace - (time.monotonic() - started)
                if delay > 0:
                    time.sleep(delay)
            handler = getattr(self, "op_" + op["op"])
            if handler(plans.with_udid(op, self.phone.udid)) is False:
                return

    def change_password(self, request: dict) -> None:
        # The iPhone reads the backup's Manifest.plist to re-key it. A 0-byte one, which every
        # backup try leaves until it finishes, fails with MBErrorDomain/205 (OE-6;
        # libimobiledevice #1582). A missing one is a new backup.
        path = f"{self.phone.udid}/Manifest.plist"
        if self.op_DownloadFiles({"paths": [path]})[path] == b"":
            self.finish(UNREADABLE_MANIFEST)
            return
        self.phone.will_encrypt = bool(request.get("NewPassword"))
        self.finish({"ErrorCode": 0})

    def finish(self, content: dict) -> bool:
        self.sock.send_plist(["DLMessageProcessMessage", content])
        self.phone.final_answers.append(content)
        return False

    def status(self) -> list:
        status = self.recv_message()
        assert status[0] == "DLMessageStatusResponse", status
        self.phone.statuses.append(status)
        return status

    def recv_message(self) -> list:
        message = self.sock.recv_plist()
        if message and message[0] == "DLMessageDisconnect":
            # What pymobiledevice3 sends when something failed on the computer's side.
            self.phone.host_disconnected = True
            raise HostClosed(f"{self.sock.name}: the computer ended the session")
        return message

    def op_UploadFiles(self, op: dict) -> Optional[bool]:
        s = self.sock
        s.send_plist(["DLMessageUploadFiles", {}, float(op.get("progress", 0))])
        for f in op["files"]:
            s.send_prefixed(f.get("device_name", f["path"]).encode())
            s.send_prefixed(f["path"].encode())
            if f.get("error"):
                self.failed_files += 1
                s.send_frame(CODE_ERROR_REMOTE, f["error"].encode())
                continue
            for chunk in self.contents(f):
                s.send_frame(CODE_FILE_DATA, chunk)
            s.send_frame(CODE_SUCCESS)
            self.phone.sent_files.append(f["path"])
        s.sendall(b"\x00\x00\x00\x00")  # no more files
        status = self.status()
        if status[1] != 0:
            # The computer couldn't save something: the iPhone gives up on the backup.
            return self.finish(FILES_NOT_SENT)
        return None

    def contents(self, f: dict):
        kind = f.get("generate")
        if kind is None:  # a recorded trace: make up the metadata files, whatever size they were
            kind = {"Manifest.db": "manifest_db", "Manifest.plist": "manifest_plist", "Status.plist": "status_plist"}.get(
                f["path"].rsplit("/", 1)[-1])
        if kind == "manifest_db":
            data = plans.manifest_db(plans.with_udid(plans.uploaded_files(self.phone.plan), self.phone.udid), self.phone.udid)
        elif kind == "manifest_plist":
            data = plans.manifest_plist(self.phone.values)
        elif kind == "status_plist":
            data = plans.status_plist(f.get("state", "finished"))
        else:
            yield from plans.filler(f["path"], self.phone.size_of(f))
            return
        for i in range(0, len(data), plans.CHUNK):
            yield data[i:i + plans.CHUNK]

    def op_DownloadFiles(self, op: dict) -> dict:
        """Ask the computer for files; returns {path: contents, or None if it couldn't send it}."""
        s = self.sock
        s.send_plist(["DLMessageDownloadFiles", op["paths"], {}, float(op.get("progress", 0))])
        received: dict[str, Optional[bytes]] = {}
        for _ in op["paths"]:
            name = s.recv_prefixed().decode()
            data = bytearray()
            while True:
                code, chunk = s.recv_frame()
                if code != CODE_FILE_DATA:
                    break
                data += chunk
            received[name] = bytes(data) if code == CODE_SUCCESS else None
        terminator = s.recvall(4)
        assert terminator == b"\x00\x00\x00\x00", terminator
        self.status()
        return received

    def op_GetFreeDiskSpace(self, op: dict) -> Optional[bool]:
        self.sock.send_plist(["DLMessageGetFreeDiskSpace", EMPTY])
        reported = self.status()[3]
        if "needs_more_than_reported" in op:
            required = reported + op["needs_more_than_reported"]
        else:
            payload = sum(self.phone.size_of(f) for f in plans.uploaded_files(self.phone.plan)
                          if not f.get("generate") and not f.get("error"))
            required = op.get("required", payload + HEADROOM)
        if reported > required:
            return None
        self.sock.send_plist(["DLMessagePurgeDiskSpace", required - reported + PURGE_REQUEST_OVERSHOOT, 4])
        self.status()
        return self.finish(NOT_ENOUGH_SPACE)

    def op_PurgeDiskSpace(self, op: dict) -> None:
        self.sock.send_plist(["DLMessagePurgeDiskSpace", op.get("amount") or 0, op.get("urgency") or 4])
        self.status()

    def op_Unknown(self, op: dict) -> None:
        self.phone.log(f"skipped a message the recorder didn't know: {op}")

    def op_CreateDirectory(self, op: dict) -> None:
        self.sock.send_plist(["DLMessageCreateDirectory", op["path"], {}, float(op.get("progress", 0))])
        self.status()

    def op_MoveItems(self, op: dict) -> None:
        self.sock.send_plist(["DLMessageMoveItems", op["items"], {}, float(op.get("progress", 0))])
        self.status()

    def op_RemoveItems(self, op: dict) -> None:
        self.sock.send_plist(["DLMessageRemoveItems", op["paths"], {}, float(op.get("progress", 0))])
        self.status()

    def op_CopyItem(self, op: dict) -> None:
        self.sock.send_plist(["DLMessageCopyItem", op["src"], op["dst"], {}, float(op.get("progress", 0))])
        self.status()

    def op_ContentsOfDirectory(self, op: dict) -> None:
        self.sock.send_plist(["DLContentsOfDirectory", op["path"], {}])
        self.status()

    def op_ProcessMessage(self, op: dict) -> bool:
        content = dict(op.get("content", {"ErrorCode": 0}))
        if content.get("ErrorCode", 0) == 0 and self.failed_files:
            content = FILES_NOT_SENT
        return self.finish(content)

    def op_Notify(self, op: dict) -> None:
        self.phone.notify(op["name"])

    def op_Sleep(self, op: dict) -> None:
        if self.phone.gone.wait(op["seconds"]):
            raise HostClosed(f"{self.sock.name}: unplugged while waiting")

    def op_Drop(self, op: dict) -> bool:
        raise Dropped(f"{self.sock.name}: dropped by the plan")

    def op_Unplug(self, op: dict) -> bool:
        self.phone.unplug()
        return False


# ── Notification proxy ───────────────────────────────────────────────────────

class NotificationProxy(Service):
    def __init__(self, phone: "FakeIPhone", sock: DeviceSocket) -> None:
        super().__init__(phone, sock)
        self.observed: set[str] = set()

    def serve(self) -> None:
        self.phone.notification_proxies.append(self)
        while True:
            message = self.sock.recv_plist()
            command = message.get("Command")
            if command == "ObserveNotification":
                self.observed.add(message["Name"])
            elif command == "PostNotification":
                self.phone.posted.append(message["Name"])
            elif command == "Shutdown":
                self.sock.send_plist({"Command": "ProxyDeath"})
                return

    def relay(self, name: str) -> bool:
        if name not in self.observed or self.sock.closed:
            return False
        self.sock.send_plist({"Command": "RelayNotification", "Name": name})
        return True


# ── AFC (for the backup lock and the files Info.plist reads) ─────────────────

AFC_MAGIC = b"CFA6LPAA"
AFC_HEADER = struct.Struct("<8sQQQQ")
AFC_STATUS, AFC_GET_FILE_INFO, AFC_FILE_OPEN, AFC_FILE_OPEN_RES, AFC_FILE_CLOSE, AFC_FILE_LOCK = 0x01, 0x0A, 0x0D, 0x0E, 0x14, 0x1B
AFC_SUCCESS, AFC_OBJECT_NOT_FOUND, AFC_OP_NOT_SUPPORTED, AFC_OP_WOULD_BLOCK = 0, 8, 15, 19
AFC_LOCK_EX = 2 | 4


class Afc(Service):
    def serve(self) -> None:
        handles = 0
        while True:
            magic, entire, _this, packet, operation = AFC_HEADER.unpack(self.sock.recvall(AFC_HEADER.size))
            assert magic == AFC_MAGIC, magic
            data = self.sock.recvall(entire - AFC_HEADER.size)
            if operation == AFC_FILE_OPEN:
                handles += 1
                self.reply(packet, AFC_FILE_OPEN_RES, struct.pack("<Q", handles))
            elif operation == AFC_FILE_LOCK:
                _handle, op = struct.unpack("<QQ", data[:16])
                if op == AFC_LOCK_EX and self.phone.take_sync_lock_busy():
                    self.status(packet, AFC_OP_WOULD_BLOCK)  # another sync holds the iPhone's lock
                else:
                    self.status(packet, AFC_SUCCESS)
            elif operation == AFC_FILE_CLOSE:
                self.status(packet, AFC_SUCCESS)
            elif operation == AFC_GET_FILE_INFO:
                self.status(packet, AFC_OBJECT_NOT_FOUND)  # no iTunes_Control files, no iBooks data
            else:
                self.status(packet, AFC_OP_NOT_SUPPORTED)

    def reply(self, packet: int, operation: int, data: bytes) -> None:
        size = AFC_HEADER.size + len(data)
        self.sock.sendall(AFC_HEADER.pack(AFC_MAGIC, size, size, packet, operation) + data)

    def status(self, packet: int, code: int) -> None:
        self.reply(packet, AFC_STATUS, struct.pack("<Q", code))


# ── Installation proxy and SpringBoard ───────────────────────────────────────

class InstallationProxy(Service):
    def serve(self) -> None:
        while True:
            message = self.sock.recv_plist()
            if message.get("Command") == "Browse":
                apps = [{"CFBundleIdentifier": bundle_id} for bundle_id in self.phone.apps]
                self.sock.send_plist({"Status": "BrowsingApplications", "CurrentList": apps, "CurrentAmount": len(apps)})
                self.sock.send_plist({"Status": "Complete"})
            else:
                self.sock.send_plist({"Error": "UnknownCommand"})


class SpringBoard(Service):
    def serve(self) -> None:
        while True:
            message = self.sock.recv_plist()
            if message.get("command") == "getIconPNGData":
                self.sock.send_plist({"pngData": b""})
            else:
                self.sock.send_plist({})


HANDLERS: dict[str, type[Service]] = {
    "com.apple.mobilebackup2": MobileBackup2,
    "com.apple.mobile.notification_proxy": NotificationProxy,
    "com.apple.afc": Afc,
    "com.apple.mobile.installation_proxy": InstallationProxy,
    "com.apple.springboardservices": SpringBoard,
}


def start(phone: "FakeIPhone", name: str, sock: DeviceSocket) -> threading.Thread:
    service = HANDLERS[name](phone, sock)
    thread = threading.Thread(target=service.run, name=f"fake-iphone {name}", daemon=True)
    thread.start()
    return thread

