"""Per-item test context: one sidecar per backup, opened once, results cached for the session."""

from __future__ import annotations

import os
import plistlib
from functools import cached_property
from pathlib import Path
from typing import Optional

import pytest

from corpus.facts import ExtractedData
from corpus.manifest import Item, load_manifest
from raw_backup import RawBackup
from sidecar_client import SidecarClient, SidecarError

PAGE = 500


def require_fetched() -> bool:
    """When set, a missing item fails the run instead of being skipped (used by the weekly job)."""
    return os.environ.get("OPENEXTRACT_CORPUS_REQUIRE") == "1"


def selected_keys(items: dict[str, Item]) -> list[str]:
    """Items named in $OPENEXTRACT_CORPUS_ITEMS, or else every item already fetched."""
    raw = os.environ.get("OPENEXTRACT_CORPUS_ITEMS", "").strip()
    if not raw:
        return [key for key, item in items.items() if item.backup_dir() is not None]
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    unknown = [k for k in keys if k not in items]
    if unknown:
        raise pytest.UsageError(f"OPENEXTRACT_CORPUS_ITEMS names unknown items: {unknown}")
    return keys


class ItemContext:
    """Everything the tests need for one corpus item. Built lazily and shared across tests."""

    def __init__(self, item: Item, backup_dir: Path):
        self.item = item
        self.backup_dir = backup_dir
        with open(backup_dir / "Info.plist", "rb") as f:
            info = plistlib.load(f)
        self.udid = item.udid or info.get("Unique Identifier") or backup_dir.name
        self.client = SidecarClient().start()
        self.open_result: Optional[dict] = None
        if not item.encrypted or item.password:
            self.open_result = self.client.call(
                "open_backup", {"udid": self.udid, "password": item.password, "backup_dir": str(backup_dir)}
            )

    def close(self) -> None:
        self.client.close()
        if "raw" in self.__dict__:
            self.raw.close()

    # ── helpers ──────────────────────────────────────────────────────────────

    @property
    def is_open(self) -> bool:
        return bool(self.open_result) and self.open_result.get("status") == "open"

    def require_open(self) -> None:
        if not self.is_open:
            pytest.skip(f"{self.item.key}: backup can't be opened (encrypted, password not published)")

    def rpc(self, method: str, **params):
        return self.client.call(method, {"udid": self.udid, **params})

    @cached_property
    def raw(self) -> RawBackup:
        self.require_open()
        return RawBackup(self.backup_dir, self.item.password)

    @cached_property
    def backup_date(self):
        return self.item.backup_date()

    # ── extracted data, fully paged ──────────────────────────────────────────

    @cached_property
    def conversations_result(self) -> dict:
        return self.rpc("list_conversations")

    @cached_property
    def conversations(self) -> list[dict]:
        return self.conversations_result.get("conversations", [])

    @cached_property
    def message_pages(self) -> dict[int, dict]:
        """chat_id → {"messages": [...], "total": n} with every page fetched."""
        out = {}
        for conversation in self.conversations:
            chat_id = conversation["chat_id"]
            messages, offset, total = [], 0, 0
            while True:
                page = self.rpc("get_messages", chat_id=chat_id, offset=offset, limit=PAGE)
                messages.extend({**m, "chat_id": chat_id} for m in page.get("messages", []))
                total = page.get("total", 0)
                next_offset = page.get("next_offset", offset + PAGE)
                if next_offset >= total or next_offset <= offset:
                    break
                offset = next_offset
            out[chat_id] = {"messages": messages, "total": total}
        return out

    @cached_property
    def messages(self) -> list[dict]:
        return [m for page in self.message_pages.values() for m in page["messages"]]

    def _paged(self, method: str, key: str, **params) -> dict:
        items, offset = [], 0
        while True:
            page = self.rpc(method, offset=offset, limit=PAGE, **params)
            batch = page.get(key, [])
            items.extend(batch)
            total = page.get("total", len(items))
            offset += PAGE
            if not batch or offset >= total:
                return {**page, key: items, "total": total}

    @cached_property
    def calls_result(self) -> dict:
        return self._paged("list_calls", "calls")

    @cached_property
    def photos_result(self) -> dict:
        return self._paged("list_photos", "photos")

    @cached_property
    def albums_result(self) -> dict:
        return self.rpc("list_albums")

    @cached_property
    def contacts(self) -> list[dict]:
        return self.rpc("list_contacts").get("contacts", [])

    @cached_property
    def notes_result(self) -> dict:
        return self.rpc("list_notes")

    @cached_property
    def voicemails_result(self) -> dict:
        return self.rpc("list_voicemails")

    @cached_property
    def browser_result(self) -> dict:
        return self.rpc("list_browser_history", browser="all", offset=0, limit=0)

    @cached_property
    def stats(self) -> dict:
        return self.rpc("get_backup_stats")

    def result_or_empty(self, name: str) -> dict:
        """A cached result, or {} if the RPC failed (test_no_extractor_errors reports the failure)."""
        try:
            return getattr(self, name)
        except SidecarError:
            return {}

    @cached_property
    def _extracted(self) -> ExtractedData:
        data, errors = {}, {}
        sources = {
            "messages": lambda: self.messages,
            "calls": lambda: self.calls_result.get("calls", []),
            "notes": lambda: self.notes_result.get("notes", []),
            "visits": lambda: self.browser_result.get("visits", []),
            "photos": lambda: self.photos_result.get("photos", []),
            "albums": lambda: self.albums_result.get("albums", []),
        }
        for name, fetch in sources.items():
            try:
                data[name] = fetch()
            except SidecarError as e:
                data[name], errors[name] = [], str(e)
        return ExtractedData(**data, errors=errors)

    def extracted_data(self) -> ExtractedData:
        return self._extracted


class CorpusRuntime:
    def __init__(self):
        self.items = load_manifest()
        self._contexts: dict[str, ItemContext] = {}

    def context(self, key: str) -> ItemContext:
        if key not in self._contexts:
            item = self.items[key]
            backup_dir = item.backup_dir()
            if backup_dir is None:
                message = f"{key} is not fetched; run: python -m corpus.fetch fetch {key}"
                if require_fetched():
                    pytest.fail(message)
                pytest.skip(message)
            self._contexts[key] = ItemContext(item, backup_dir)
        return self._contexts[key]

    def close(self) -> None:
        for ctx in self._contexts.values():
            ctx.close()
        self._contexts.clear()
