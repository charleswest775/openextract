"""WhatsApp invariants for every backup in the corpus.

What the engine's WhatsApp methods return, checked against ChatStorage.sqlite
read directly (``raw_backup.RawBackup``, not ios-backup-core): every chat the
app should list is listed with its real number of rows, every row comes back
exactly once and in arrival order (ZSORT), media is called available exactly
when its file is in the backup, offsets and search lead back to the message,
and no base64 protobuf (WhatsApp 2.23+ stores names and previews that way)
reaches a screen.

Failure messages name ids and counts only, never text from a backup.
"""

import base64
import binascii
import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus

DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
WHATSAPP = (DOMAIN, "ChatStorage.sqlite")
SYSTEM_TYPES = (6, 10, 28, 55)  # rows the app shows as notices; never searched
EARLIEST = datetime(2009, 1, 1, tzinfo=timezone.utc)  # before WhatsApp existed
MAX_APPLE_SECONDS = 4_000_000_000  # beyond it: WhatsApp's "no date" (year 4001)
ATTACHMENT_SAMPLE = 100
# Media copied to open in another app (as_file): fewer, since a video is copied whole.
OPEN_SAMPLE = 12
# Media WhatsApp itself records, which the app must always be able to open in
# another app (documents are whatever the sender sent, so aren't here).
OPENABLE_KINDS = ("image", "video", "audio", "gif")
SEARCH_SAMPLE = 12


def _sample(values, limit=5):
    values = list(values)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


def _latest(ctx) -> datetime:
    return (ctx.backup_date or datetime.now(timezone.utc)) + timedelta(days=1)


def _is_base64_protobuf(text) -> bool:
    """WhatsApp 2.23+ ZPUSHNAME / ZLASTMESSAGETEXT: base64 of a protobuf message (starts with field 1, a varint)."""
    if not isinstance(text, str) or len(text) < 4 or " " in text:
        return False
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return False
    return raw[:1] == b"\x08" and len(raw) >= 2


class Store:
    """ChatStorage.sqlite, read raw: what the app should list."""

    def __init__(self, ctx):
        ctx.require_open()
        conn = ctx.raw.connect(*WHATSAPP)
        if conn is None:
            pytest.skip("no WhatsApp in this backup")
        self.conn = conn
        columns = ctx.raw.columns(conn, "ZWAMESSAGE")
        self.sort = "ZSORT" if "ZSORT" in columns else "ZMESSAGEDATE"
        session_columns = ctx.raw.columns(conn, "ZWACHATSESSION")
        session_type = "COALESCE(s.ZSESSIONTYPE, -1)" if "ZSESSIONTYPE" in session_columns else "-1"
        jid = "LOWER(COALESCE(s.ZCONTACTJID, ''))"
        # Chats with at least one row, status updates left out (they aren't chats).
        self.counts = {
            r["id"]: r["n"] for r in conn.execute(
                f"SELECT s.Z_PK AS id, COUNT(m.Z_PK) AS n FROM ZWACHATSESSION s "
                f"JOIN ZWAMESSAGE m ON m.ZCHATSESSION = s.Z_PK "
                f"WHERE {session_type} != 3 AND {jid} != 'status@broadcast' AND {jid} NOT LIKE '%@status' "
                f"GROUP BY s.Z_PK"
            )
        }
        self.rows = {
            r["Z_PK"]: r for r in conn.execute(
                f"SELECT Z_PK, ZCHATSESSION, {self.sort} AS sort_key, ZMESSAGETYPE, ZMESSAGEDATE, "
                f"(ZTEXT IS NULL OR TRIM(ZTEXT) = '') AS no_text FROM ZWAMESSAGE"
            )
        }

    def order(self, chat_id: int) -> list[int]:
        """The chat's row ids in arrival order, as the app must show them."""
        return [r[0] for r in self.conn.execute(
            f"SELECT Z_PK FROM ZWAMESSAGE WHERE ZCHATSESSION = ? ORDER BY {self.sort}, Z_PK", (chat_id,))]

    def close(self):
        self.conn.close()


@pytest.fixture
def store(ctx):
    s = Store(ctx)
    yield s
    s.close()


def test_whatsapp_absent_is_calm(ctx):
    """A backup without WhatsApp says so, without an error, on the screen and in the counts."""
    ctx.require_open()
    if ctx.raw.has_file(*WHATSAPP):
        pytest.skip("this backup has WhatsApp")
    assert ctx.whatsapp_result == {"conversations": [], "empty_reason": "not_in_backup"}
    o = ctx.stats.get("overview", {})
    assert (o.get("total_whatsapp_chats"), o.get("total_whatsapp_messages"), o.get("whatsapp_status")) == \
        (0, 0, "not_in_backup")


def test_whatsapp_chats_match_chatstorage(ctx, store):
    result = ctx.whatsapp_result
    assert "error" not in result, f"list_whatsapp_chats: {result.get('error')!r}"
    listed = {c["chat_id"]: c["message_count"] for c in ctx.whatsapp_chats}
    assert len(listed) == len(ctx.whatsapp_chats), "a chat is listed twice"
    assert set(listed) == set(store.counts), (
        f"missing chats {_sample(sorted(set(store.counts) - set(listed)))}, "
        f"unexpected chats {_sample(sorted(set(listed) - set(store.counts)))}"
    )
    wrong = {cid: (listed[cid], n) for cid, n in store.counts.items() if listed[cid] != n}
    assert not wrong, f"message_count differs from ChatStorage for chats (listed, rows): {wrong}"
    if not store.counts:
        assert result.get("empty_reason") == "no_records"
    for c in ctx.whatsapp_chats:
        assert c["chat_type"] in ("individual", "group", "broadcast", "channel"), c["chat_id"]
        assert c["is_group"] is (c["chat_type"] == "group"), c["chat_id"]
        handle = c.get("handle")
        assert handle == "" or (handle.startswith("+") and handle[1:].isdigit()), f"chat {c['chat_id']}: odd handle"
        if c["chat_type"] != "individual":
            assert handle == "", f"chat {c['chat_id']}: a {c['chat_type']} has a handle"
    dates = [c["last_message_date"] or "" for c in ctx.whatsapp_chats]
    assert dates == sorted(dates, reverse=True), "chats aren't newest first"


def test_every_whatsapp_message_listed_once_in_arrival_order(ctx, store):
    problems = []
    for chat_id, page in ctx.whatsapp_pages.items():
        if page["error"]:
            problems.append(f"chat {chat_id}: get_whatsapp_messages reported an error")
            continue
        ids = [m["message_id"] for m in page["messages"]]
        if len(ids) != len(set(ids)):
            problems.append(f"chat {chat_id}: {len(ids) - len(set(ids))} message ids came back twice across pages")
        expected = store.order(chat_id)
        if page["total"] != len(expected):
            problems.append(f"chat {chat_id}: total {page['total']} but ChatStorage has {len(expected)} rows")
        missing, extra = set(expected) - set(ids), set(ids) - set(expected)
        if missing:
            problems.append(f"chat {chat_id}: rows missing from the pages: {_sample(sorted(missing))}")
        if extra:
            problems.append(f"chat {chat_id}: rows not in this chat: {_sample(sorted(extra))}")
        if not missing and not extra and ids != expected:
            first = next(i for i, (a, b) in enumerate(zip(ids, expected)) if a != b)
            problems.append(f"chat {chat_id}: not in arrival order from position {first} (ids {ids[first]} vs {expected[first]})")
        if store.sort == "ZSORT":
            wrong_sort = [m["message_id"] for m in page["messages"]
                          if m.get("sort") != store.rows[m["message_id"]]["sort_key"]]
            if wrong_sort:
                problems.append(f"chat {chat_id}: sort differs from ZSORT for {_sample(wrong_sort)}")
    assert not problems, "\n".join(problems[:20])


def test_whatsapp_fields_are_sane(ctx, store):
    latest = _latest(ctx)
    bad_dates, missing_dates, senders, notices, reactions, protobuf, empty = [], [], [], [], [], [], []
    for m in ctx.whatsapp_messages:
        mid = m["message_id"]
        raw = store.rows[mid]
        when = parse_iso(m.get("date"))
        stamp = raw["ZMESSAGEDATE"]
        has_real_date = isinstance(stamp, (int, float)) and 0 < stamp < MAX_APPLE_SECONDS
        if m.get("date") is None:
            if has_real_date:
                missing_dates.append(mid)
        elif when is None or not EARLIEST <= when <= latest:
            bad_dates.append(mid)
        if m.get("is_reaction") is not False:
            reactions.append(mid)
        if m.get("message_type") == "system":
            if m.get("sender") != "" or m.get("is_from_me") or not m.get("event_text"):
                notices.append(mid)
            if raw["ZMESSAGETYPE"] not in SYSTEM_TYPES:
                notices.append(mid)
        elif m.get("is_from_me"):
            if m.get("sender") != "me":
                senders.append(mid)
        elif not (m.get("sender") or "").strip():
            senders.append(mid)
        names = [m.get("sender"), *(r.get("sender") for r in m.get("reactions") or [])]
        if m.get("quoted"):
            names.append(m["quoted"].get("sender"))
        if any(_is_base64_protobuf(n) for n in names):
            protobuf.append(mid)
        if not ((m.get("text") or "").strip() or m.get("attachments") or m.get("event_text")):
            # Only a plain text row whose text really is empty may show nothing.
            if not (raw["ZMESSAGETYPE"] == 0 and raw["no_text"]):
                empty.append(mid)
    assert not bad_dates, f"messages with impossible dates: {_sample(bad_dates)}"
    assert not missing_dates, f"messages with a date in ChatStorage but none returned: {_sample(missing_dates)}"
    assert not reactions, f"messages not marked is_reaction=False: {_sample(reactions)}"
    assert not notices, f"notices with a sender, no text, or not a notice type: {_sample(notices)}"
    assert not senders, f"messages without a proper sender: {_sample(senders)}"
    assert not protobuf, f"base64 protobuf shown as a name: {_sample(protobuf)}"
    assert not empty, f"messages that would show as an empty bubble: {_sample(empty)}"
    chats = [c["chat_id"] for c in ctx.whatsapp_chats
             if _is_base64_protobuf(c["display_name"]) or _is_base64_protobuf(c["last_message_preview"])]
    assert not chats, f"base64 protobuf shown in the chat list: {_sample(chats)}"


def test_whatsapp_media_is_available_exactly_when_its_file_is_in_the_backup(ctx, store):
    raw = ctx.raw
    problems = []
    attachments = []
    kinds = {}
    for m in ctx.whatsapp_messages:
        for a in m.get("attachments") or []:
            attachments.append(a)
            kinds[a["attachment_id"]] = m.get("message_type")
            filename = a.get("filename")
            if filename is None:
                problems.append(f"attachment {a['attachment_id']}: filename is None")
                continue
            in_backup = bool(filename) and raw.has_file(DOMAIN, filename)
            if bool(a.get("available")) != in_backup:
                problems.append(f"attachment {a['attachment_id']}: available={a.get('available')} but in backup={in_backup}")
            if a.get("thumbnail_path") and not raw.has_file(DOMAIN, a["thumbnail_path"]):
                problems.append(f"attachment {a['attachment_id']}: thumbnail_path not in the backup")
        location = m.get("location") or {}
        if location.get("thumbnail_path") and not raw.has_file(DOMAIN, location["thumbnail_path"]):
            problems.append(f"message {m['message_id']}: map preview not in the backup")
    if not attachments:
        assert not problems, "\n".join(problems[:20])
        pytest.skip("no WhatsApp media in this backup")
    # What the app gets when it asks for one: the file, or a calm "not in the backup".
    for a in attachments[:ATTACHMENT_SAMPLE]:
        result = ctx.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"])
        if a.get("available"):
            if not (result.get("data") or result.get("too_large")):
                problems.append(f"attachment {a['attachment_id']}: available but get_whatsapp_attachment said {result.get('error')!r}")
        elif result.get("empty_reason") != "not_in_backup":
            problems.append(f"attachment {a['attachment_id']}: not available but answered {sorted(result)}")
        if a.get("thumbnail_path"):
            thumb = ctx.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"], thumbnail=True)
            if not thumb.get("data"):
                problems.append(f"attachment {a['attachment_id']}: thumbnail listed but not served")
    # Opening one in another app: a whole copy, which a photo, video or voice note may always open.
    recorded = [a for a in attachments if a.get("available") and kinds[a["attachment_id"]] in OPENABLE_KINDS]
    for a in recorded[:OPEN_SAMPLE]:
        copy = ctx.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"], as_file=True)
        path = Path(copy.get("path") or "")
        if not copy.get("path") or not path.is_file() or path.stat().st_size != copy.get("size"):
            problems.append(f"attachment {a['attachment_id']}: no whole copy to open ({copy.get('error')!r})")
        elif copy.get("openable") is not True:
            problems.append(f"attachment {a['attachment_id']} ({kinds[a['attachment_id']]}): copy not openable")
    assert not problems, "\n".join(problems[:20])


def test_whatsapp_offsets_lead_back_to_the_message(ctx, store):
    problems = []
    for chat_id, page in ctx.whatsapp_pages.items():
        messages = page["messages"]
        for i in sorted({0, len(messages) // 2, len(messages) - 1}):
            if not messages:
                break
            target = messages[i]
            result = ctx.rpc("get_whatsapp_message_offset", chat_id=chat_id, message_id=target["message_id"])
            if result != {"offset": len(messages) - 1 - i, "found": True}:
                problems.append(f"chat {chat_id} message {target['message_id']}: {result}, expected offset {len(messages) - 1 - i}")
                continue
            got = ctx.rpc("get_whatsapp_messages", chat_id=chat_id, offset=result["offset"], limit=1)["messages"]
            if [m["message_id"] for m in got] != [target["message_id"]]:
                problems.append(f"chat {chat_id} message {target['message_id']}: the page at its offset starts elsewhere")
    assert not problems, "\n".join(problems[:20])


def test_whatsapp_search_finds_a_message_by_its_own_text(ctx, store):
    candidates = [m for m in ctx.whatsapp_messages
                  if m.get("message_type") in ("text", "link") and len((m.get("text") or "").strip()) >= 12
                  and store.rows[m["message_id"]]["ZMESSAGETYPE"] not in SYSTEM_TYPES]
    if not candidates:
        pytest.skip("no WhatsApp text messages long enough to search for")
    step = max(1, len(candidates) // SEARCH_SAMPLE)
    missed = []
    for m in candidates[::step][:SEARCH_SAMPLE]:
        text = m["text"].strip()
        query = text[len(text) // 4: len(text) // 4 + 8]
        if not query.strip():
            continue
        result = ctx.rpc("search_whatsapp_messages", query=query, chat_id=m["chat_id"], limit=100000)
        if m["message_id"] not in {r["message_id"] for r in result.get("results", [])}:
            missed.append(m["message_id"])
    assert not missed, f"search_whatsapp_messages didn't find these messages by their own text: {_sample(missed)}"


def test_whatsapp_export_round_trip(ctx, store, tmp_path):
    if not ctx.whatsapp_chats:
        pytest.skip("no WhatsApp chats")
    biggest = max(ctx.whatsapp_chats, key=lambda c: c["message_count"])
    shown = len(ctx.whatsapp_pages[biggest["chat_id"]]["messages"])
    result = ctx.rpc("export_whatsapp_chat", chat_id=biggest["chat_id"], format="csv", output_dir=str(tmp_path))
    assert "error" not in result, result
    with open(result["file"], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    assert result["message_count"] == shown == len(rows) - 1, (
        f"exported {result['message_count']} messages in {len(rows) - 1} rows, the app shows {shown}")
    result = ctx.rpc("export_whatsapp_chat", chat_id=biggest["chat_id"], format="html", output_dir=str(tmp_path))
    assert "error" not in result, result
    page = Path(result["file"]).read_text(encoding="utf-8")
    # Count, don't assert `not in page`: pytest would print the export.
    assert page.count("[Attachment]") == 0, "the export calls a WhatsApp message a bare [Attachment]"
    assert page.count('class="msg ') + page.count('class="system"') == shown
