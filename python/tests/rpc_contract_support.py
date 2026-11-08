"""Engines, generated backups and small checks for test_rpc_contract.py.

Everything here drives the real engine (python/main.py, or the binary named by
``$OPENEXTRACT_SIDECAR``) over JSON-RPC on stdin/stdout, through the corpus
tests' ``SidecarClient``, the way Electron's main process does.

Backups come from ios-backup-core's ``backupgen`` (corpus/synthetic.py): Maren
(every data type filled), Einstein (Messages and Contacts only) and, for
message recovery, a copy of Einstein's backup with a few messages moved to
"Recently Deleted" or orphaned, which backupgen can't write.
"""

from __future__ import annotations

import base64
import contextlib
import csv
import hashlib
import importlib.util
import inspect
import os
import plistlib
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cached_property
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

HERE = Path(__file__).resolve().parent
PYTHON_DIR = HERE.parent
REPO_ROOT = PYTHON_DIR.parent
for _path in (REPO_ROOT, HERE / "corpus", PYTHON_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from corpus.synthetic import (  # noqa: E402
    SyntheticItem,
    backupgen_root,
    ensure_generated,
    load_synthetic,
    persona_available,
)
from sidecar_client import ProtocolError, SidecarClient, SidecarError  # noqa: E402

MAREN = "syn-maren-ios26-plain"
MAREN_ENCRYPTED = "syn-maren-ios26-encrypted"
EINSTEIN = "syn-einstein-ios26-plain"
EINSTEIN_ENCRYPTED = "syn-einstein-ios17-encrypted"

# Set by CI: a backup that can't be generated fails the run instead of skipping it.
REQUIRE_ENV = "OPENEXTRACT_REQUIRE_GENERATED"

# Seconds one call may take before the engine counts as hung. Generous on
# purpose: this is a hang detector, not a speed check (see PERF_BUDGETS).
CALL_TIMEOUT = 120.0

JPEG_MAGIC = b"\xff\xd8\xff"
PDF_MAGIC = b"%PDF-"
AMR_MAGIC = b"#!AMR"

# The prefixes the Back up my iPhone screen turns into a setup step
# (SETUP_PREFIX in src/components/backup/BackupFlow.tsx).
DEVICE_SETUP_PREFIXES = ("TRUST_REQUIRED: ", "PASSCODE_REQUIRED: ", "DEVICE_SERVICE_REQUIRED: ", "DEVICE_DISCONNECTED: ")


# ── The engine's own dispatch table ──────────────────────────────────────────

def load_engine_module():
    """Import python/main.py under its own name, keeping this process's stdout.

    main.py points ``sys.stdout`` at stderr as soon as it is imported (its
    guard against libraries printing into the JSON-RPC channel), so put it
    back afterwards or pytest's own output would move to stderr.
    """
    name = "openextract_engine_main"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, PYTHON_DIR / "main.py")
    module = importlib.util.module_from_spec(spec)
    stdout = sys.stdout
    try:
        spec.loader.exec_module(module)
    finally:
        sys.stdout = stdout
    sys.modules[name] = module
    return module


def engine_methods() -> dict[str, Callable]:
    """``SidecarServer.methods``: every JSON-RPC method name and its handler."""
    return dict(load_engine_module().SidecarServer().methods)


def methods_needing_an_open_backup() -> list[str]:
    """Methods whose handler looks up an opened backup by udid."""
    return sorted(
        name for name, handler in engine_methods().items()
        if "get_open_backup(" in inspect.getsource(handler)
    )


# ── Generated backups ────────────────────────────────────────────────────────

def require_generated() -> bool:
    return os.environ.get(REQUIRE_ENV) == "1"


def skip_or_fail(reason: str) -> None:
    if require_generated():
        pytest.fail(f"{reason}\n({REQUIRE_ENV}=1 makes this a failure instead of a skip.)", pytrace=False)
    pytest.skip(reason)


@contextlib.contextmanager
def _exclusive(lock: Path, timeout: float = 1800.0):
    """Hold ``lock`` (a file created exclusively) so pytest-xdist workers don't generate one item at once."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > timeout:  # left behind by a killed run
                    lock.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(f"waited {timeout:.0f}s for {lock}") from None
            time.sleep(0.5)
    try:
        yield
    finally:
        os.close(fd)
        with contextlib.suppress(FileNotFoundError):
            lock.unlink()


_generated: dict[str, tuple[SyntheticItem, Path]] = {}
_generation_errors: dict[str, str] = {}


def generated_backup(key: str) -> tuple[SyntheticItem, Path]:
    """The item and its backup folder, generated into the corpus cache if needed; skips (or fails) if it can't be."""
    if key in _generated:
        return _generated[key]
    if key in _generation_errors:
        skip_or_fail(_generation_errors[key])
    item = load_synthetic()[key]
    reason = None
    backup_dir = None
    if not persona_available(item.persona):
        root = backupgen_root()
        found = ("ios-backup-core's backupgen wasn't found" if root is None
                 else f"the ios-backup-core checkout at {root} has no '{item.persona}' persona")
        reason = (f"{key} can't be generated: {found}. Set OPENEXTRACT_IOS_BACKUP_CORE to an up-to-date "
                  "checkout of https://github.com/charleswest775/ios-backup-core")
    else:
        try:
            with _exclusive(item.item_dir().parent / f"{key}.lock"):
                backup_dir = ensure_generated(item)
        except Exception as e:  # e.g. backupgen.media.MediaError
            reason = (f"{key} couldn't be generated: {type(e).__name__}: {e}. Maren's photos are downloaded "
                      "from Wikimedia Commons the first time (into ~/.cache/backupgen/media, or "
                      "$BACKUPGEN_MEDIA_CACHE), so the first run needs a network connection")
        else:
            if backup_dir is None:
                reason = f"{key} can't be generated: backupgen wrote no backup folder"
    if reason:
        _generation_errors[key] = reason
        skip_or_fail(reason)
    _generated[key] = item, backup_dir
    return item, backup_dir


# ── Engines ──────────────────────────────────────────────────────────────────

class Engine:
    """One engine process, started and spoken to the way Electron does it."""

    def __init__(self, name: str):
        self.name = name
        self.client = SidecarClient()
        self.broken = False
        started = time.perf_counter()
        try:
            self.client.start()
        except Exception:
            self.client.close()
            raise
        self.start_seconds = time.perf_counter() - started

    def call(self, method: str, params: Optional[dict] = None, timeout: float = CALL_TIMEOUT) -> Any:
        """The method's ``result``; raises SidecarError for a JSON-RPC error response."""
        try:
            return self.client.call(method, params or {}, timeout=timeout)
        except ProtocolError:
            # A stray or late line would confuse every later call: start a new engine next time.
            self.broken = True
            raise

    def error(self, method: str, params: Optional[dict] = None, timeout: float = CALL_TIMEOUT) -> SidecarError:
        """Call a method that must answer with a JSON-RPC error; check the error and that the engine survived."""
        try:
            result = self.call(method, params, timeout)
        except SidecarError as e:
            err = e
        else:
            pytest.fail(f"{method} should answer with a JSON-RPC error, but returned {str(result)[:300]}")
        assert isinstance(err.code, int), f"{method}: error code {err.code!r} isn't an integer"
        assert isinstance(err.message, str) and err.message.strip(), f"{method}: the error has no message"
        assert "Traceback (most recent call last)" not in err.message, f"{method}: a traceback leaked into the message"
        self.assert_alive()
        return err

    def send_raw(self, line: str, timeout: float = 60) -> Any:
        """Write one raw line (bypassing the client's id bookkeeping) and return the next message."""
        try:
            return self.client.send_raw(line, timeout=timeout)
        except ProtocolError:
            self.broken = True
            raise

    def assert_alive(self) -> None:
        assert self.call("ping", timeout=30).get("status") == "ok", f"{self.name}: the engine stopped answering ping"

    @property
    def protocol_errors(self) -> list[str]:
        return self.client.protocol_errors

    @property
    def notifications(self) -> list[dict]:
        return self.client.notifications

    def close(self) -> None:
        self.client.close()


class BackupEngine(Engine):
    """An engine with one backup opened, plus the reads several tests share."""

    def __init__(self, name: str, backup_dir: Path, udid: str, password: Optional[str] = None,
                 expected: Optional[dict] = None):
        super().__init__(name)
        self.backup_dir = Path(backup_dir)
        self.udid = udid
        self.password = password
        self.expected = expected or {}
        self.encrypted = password is not None
        self._message_pages: dict[int, list[dict]] = {}
        try:
            self.open_result = self.open()
        except Exception:
            self.close()
            raise
        assert self.open_result.get("status") == "open", f"{name}: open_backup returned {self.open_result}"

    def open(self, **overrides) -> dict:
        params = {"udid": self.udid, "password": self.password, "backup_dir": str(self.backup_dir), **overrides}
        return self.call("open_backup", params)

    def rpc(self, method: str, timeout: float = CALL_TIMEOUT, **params) -> Any:
        """Call a method on this engine's backup (adds ``udid``)."""
        return self.call(method, {"udid": self.udid, **params}, timeout)

    # Shared reads. Nothing in the tests changes the backup, so they're cached.

    @cached_property
    def conversations(self) -> list[dict]:
        return self.rpc("list_conversations")["conversations"]

    @cached_property
    def biggest_conversation(self) -> dict:
        return max(self.conversations, key=lambda c: c["message_count"])

    def messages_of(self, chat_id: int) -> list[dict]:
        """Every message in a conversation, oldest first, read page by page as the app does."""
        if chat_id not in self._message_pages:
            pages, offset = [], 0
            while True:
                page = self.rpc("get_messages", chat_id=chat_id, offset=offset, limit=200)
                pages.append(page["messages"])
                if not page["messages"] or page["next_offset"] >= page["total"]:
                    break
                offset = page["next_offset"]
            # Each page is the next-older batch, oldest first within itself.
            self._message_pages[chat_id] = [m for page in reversed(pages) for m in page]
        return self._message_pages[chat_id]

    @cached_property
    def attachments(self) -> list[tuple[int, dict, dict]]:
        """(chat_id, message, attachment) for every attachment in every conversation."""
        return [
            (c["chat_id"], m, a)
            for c in self.conversations
            for m in self.messages_of(c["chat_id"])
            for a in m.get("attachments") or []
        ]

    @cached_property
    def photos(self) -> list[dict]:
        out, offset = [], 0
        while True:
            page = self.rpc("list_photos", offset=offset, limit=200)
            out.extend(page["photos"])
            offset += 200
            if offset >= page["total"]:
                return out

    @cached_property
    def voicemails(self) -> list[dict]:
        return self.rpc("list_voicemails")["voicemails"]

    @cached_property
    def notes(self) -> list[dict]:
        return self.rpc("list_notes")["notes"]


class ContractRuntime:
    """The session's engines: one per backup, started on first use and shared by every test."""

    def __init__(self, tmp_factory):
        self._tmp_factory = tmp_factory
        self._engines: dict[str, Engine] = {}
        self._failures: dict[str, str] = {}
        self._recovery_plan: Optional[RecoveryPlan] = None

    def _get(self, name: str, start: Callable[[], Engine]) -> Engine:
        if name in self._failures:  # don't wait for a hung engine again in every test
            pytest.fail(f"{name}: the engine couldn't start or open its backup earlier in this run: "
                        f"{self._failures[name]}", pytrace=False)
        engine = self._engines.get(name)
        if engine is not None and engine.broken:
            engine.close()
            engine = None
        if engine is None:
            try:
                engine = self._engines[name] = start()
            except Exception as e:
                self._failures[name] = f"{type(e).__name__}: {e}"
                raise
        return engine

    def engine(self, name: str) -> Engine:
        """A shared engine with no backup open (or only what its tests open)."""
        return self._get(name, lambda: Engine(name))

    def fresh(self, name: str) -> Engine:
        """A new engine of its own, for a test that needs a clean state. Closed with the others."""
        key = f"{name}#{len(self._engines)}"
        return self._get(key, lambda: Engine(key))

    def backup(self, key: str) -> BackupEngine:
        """The shared engine with synthetic item ``key`` open (skips or fails if it can't be generated)."""
        item, backup_dir = generated_backup(key)
        return self._get(key, lambda: BackupEngine(key, backup_dir, item.udid, item.password, item.expected()))

    def recovery_plan(self) -> "RecoveryPlan":
        if self._recovery_plan is None:
            _, source = generated_backup(EINSTEIN)
            folder = self._tmp_factory.mktemp("recovery") / RECOVERY_UDID
            self._recovery_plan = make_recovery_copy(source, folder)
        return self._recovery_plan

    def recovery(self) -> BackupEngine:
        """An engine with the doctored Einstein copy open (see make_recovery_copy)."""
        plan = self.recovery_plan()
        engine = self._get("recovery", lambda: BackupEngine("recovery", plan.backup_dir, plan.udid))
        engine.plan = plan
        return engine

    def live_engines(self) -> list[Engine]:
        return [e for e in self._engines.values() if not e.broken]

    def close(self) -> None:
        for engine in self._engines.values():
            with contextlib.suppress(Exception):
                engine.close()
        self._engines.clear()


# ── A backup with messages to recover ────────────────────────────────────────

RECOVERY_UDID = "00008120-0000000000C0FFEE"
SMS_DB_ID = hashlib.sha1(b"HomeDomain-Library/SMS/sms.db").hexdigest()
_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
DELETED_AT = datetime(2026, 6, 10, 12, 0, tzinfo=timezone.utc)


@dataclass
class RecoveryPlan:
    backup_dir: Path
    udid: str
    deleted_chat_id: int                      # its last 3 text messages are in Recently Deleted
    deleted: list[tuple[int, str]]            # (message_id, text), oldest first
    orphan_chat_id: int                       # its chat_message_join rows for 2 messages are gone
    orphan_handle: str
    orphaned: list[tuple[int, str]]
    message_rows: int                         # rows in the message table (all still there)
    original_counts: dict[int, int]           # chat_id -> visible messages before the change


def make_recovery_copy(source: Path, dest: Path) -> RecoveryPlan:
    """Copy Einstein's (unencrypted) backup and hide a few messages the way iOS does.

    The 3 newest text messages of the busiest conversation move from
    chat_message_join to chat_recoverable_message_join ("Recently Deleted",
    iOS 16+), and 2 text messages of the next 1:1 conversation lose their
    chat_message_join rows (orphaned). The copy gets its own UDID so it can be
    open beside the original.
    """
    shutil.copytree(source, dest)
    info_path = dest / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["Unique Identifier"] = RECOVERY_UDID
    info["Device Name"] = "Recovery test copy"
    info_path.write_bytes(plistlib.dumps(info))

    db_path = dest / SMS_DB_ID[:2] / SMS_DB_ID
    conn = sqlite3.connect(str(db_path))
    try:
        # iOS's triggers call functions only Messages defines; a test copy doesn't need them.
        for (trigger,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'").fetchall():
            conn.execute(f'DROP TRIGGER "{trigger}"')
        original_counts = dict(conn.execute("SELECT chat_id, COUNT(*) FROM chat_message_join GROUP BY chat_id"))
        one_to_one = [
            chat_id for (chat_id,) in conn.execute(
                """SELECT j.chat_id FROM chat_message_join j
                   WHERE (SELECT COUNT(*) FROM chat_handle_join h WHERE h.chat_id = j.chat_id) = 1
                   GROUP BY j.chat_id ORDER BY COUNT(*) DESC, j.chat_id"""
            )
        ]
        deleted_chat, orphan_chat = one_to_one[0], one_to_one[1]

        def newest_texts(chat_id: int, n: int) -> list[tuple[int, str, str]]:
            rows = conn.execute(
                """SELECT m.ROWID, m.text, h.id FROM message m
                   JOIN chat_message_join j ON j.message_id = m.ROWID
                   JOIN handle h ON h.ROWID = m.handle_id
                   WHERE j.chat_id = ? AND TRIM(COALESCE(m.text, '')) != ''
                     AND COALESCE(m.associated_message_type, 0) = 0
                     AND (SELECT COUNT(*) FROM chat_message_join k WHERE k.message_id = m.ROWID) = 1
                   ORDER BY m.ROWID DESC LIMIT ?""",
                (chat_id, n),
            ).fetchall()
            assert len(rows) == n, f"chat {chat_id} has too few text messages for the recovery copy"
            return sorted(rows)

        deleted = newest_texts(deleted_chat, 3)
        orphaned = newest_texts(orphan_chat, 2)
        delete_date = int((DELETED_AT - _APPLE_EPOCH).total_seconds()) * 1_000_000_000
        for message_id, _, _ in deleted:
            conn.execute("DELETE FROM chat_message_join WHERE message_id = ?", (message_id,))
            conn.execute(
                "INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (?, ?, ?)",
                (deleted_chat, message_id, delete_date),
            )
        for message_id, _, _ in orphaned:
            conn.execute("DELETE FROM chat_message_join WHERE message_id = ?", (message_id,))
        message_rows = conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
        conn.commit()
        # The engine opens backup files "immutable", so nothing may stay in a -wal file.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    for suffix in ("-wal", "-shm"):
        with contextlib.suppress(FileNotFoundError):
            os.remove(f"{db_path}{suffix}")

    return RecoveryPlan(
        backup_dir=dest,
        udid=RECOVERY_UDID,
        deleted_chat_id=deleted_chat,
        deleted=[(m, t) for m, t, _ in deleted],
        orphan_chat_id=orphan_chat,
        orphan_handle=orphaned[0][2],
        orphaned=[(m, t) for m, t, _ in orphaned],
        message_rows=message_rows,
        original_counts=original_counts,
    )


# ── Small checks ─────────────────────────────────────────────────────────────

def decoded(result: dict, what: str = "data") -> bytes:
    """The base64 ``data`` of a result, decoded strictly."""
    assert "error" not in result, f"{what}: {result.get('error')}"
    data = result.get("data")
    assert isinstance(data, str) and data, f"{what}: no base64 data in {sorted(result)}"
    return base64.b64decode(data, validate=True)


def read_csv(path: Path) -> list[list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def files_under(folder: Path) -> list[Path]:
    return sorted(p for p in Path(folder).rglob("*") if p.is_file()) if Path(folder).exists() else []


def same_path(a, b) -> bool:
    return os.path.normcase(os.path.realpath(str(a))) == os.path.normcase(os.path.realpath(str(b)))


def local_day(iso: str) -> str:
    """The local YYYY-MM-DD of an ISO 8601 time; the engine is this process's child, so same time zone."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()


def assert_error_dict(result: Any, contains: str = "") -> None:
    """A result-level error ({"error": "..."}), the shape the UI shows instead of crashing."""
    assert isinstance(result, dict) and isinstance(result.get("error"), str) and result["error"], result
    assert contains.lower() in result["error"].lower(), result
