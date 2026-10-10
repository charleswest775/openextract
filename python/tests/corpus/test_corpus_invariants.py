"""Invariants that must hold for every backup in the corpus.

Each test compares what the sidecar returns over JSON-RPC with the raw SQLite
data, read independently by ``raw_backup.RawBackup``. The tests don't need to
know what's *in* a backup: they check that nothing is silently dropped, that
screens agree with each other, and that no value is impossible.
"""

import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from corpus.facts import parse_iso
from sidecar_client import SidecarClient, SidecarError

pytestmark = pytest.mark.corpus

SMS = ("HomeDomain", "Library/SMS/sms.db")
ADDRESS_BOOK = ("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb")
CALL_HISTORY = ("HomeDomain", "Library/CallHistoryDB/CallHistory.storedata")
NOTE_STORE = ("AppDomainGroup-group.com.apple.notes", "NoteStore.sqlite")
PHOTOS = ("CameraRollDomain", "Media/PhotoData/Photos.sqlite")
VOICEMAIL = ("HomeDomain", "Library/Voicemail/voicemail.db")
SAFARI = ("HomeDomain", "Library/Safari/History.db")

EARLIEST = datetime(2007, 6, 29, tzinfo=timezone.utc)  # first iPhone
ATTACHMENT_SAMPLE = 200
TEXT_RESIDUE = ("￼", "streamtyped", "NSAttributedString", "NSMutableString", "__kIM")


def _latest(ctx) -> datetime:
    return (ctx.backup_date or datetime.now(timezone.utc)) + timedelta(days=1)


def _sample(values, limit=5):
    values = list(values)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


# ── opening the backup ───────────────────────────────────────────────────────


def test_backup_is_listed(ctx):
    listed = ctx.client.call("list_backups", {"path": str(ctx.item.unpack_dir())})
    backups = [b for b in listed.get("backups", []) if b.get("udid") == ctx.udid]
    assert backups, f"list_backups didn't find {ctx.udid}: {listed}"
    info = backups[0]
    assert info.get("product_version") == ctx.item.ios
    if ctx.item.product_type:
        assert info.get("product_type") == ctx.item.product_type
    assert bool(info.get("encrypted")) == ctx.item.encrypted


def test_password_handling(ctx):
    if not ctx.item.encrypted:
        pytest.skip("not encrypted")
    params = {"udid": ctx.udid, "backup_dir": str(ctx.backup_dir)}
    with SidecarClient() as fresh:
        assert fresh.call("open_backup", params).get("status") == "password_required"
        wrong = fresh.call("validate_password", {**params, "password": "definitely-not-the-password"})
        assert wrong.get("valid") is False and wrong.get("error")
        if ctx.item.password:
            assert fresh.call("validate_password", {**params, "password": ctx.item.password}).get("valid") is True
        assert not fresh.protocol_errors


def test_backup_opens(ctx):
    ctx.require_open()
    assert ctx.open_result["status"] == "open"


# ── nothing reports an error for data that exists ───────────────────────────


def test_no_extractor_errors(ctx):
    ctx.require_open()
    raw = ctx.raw
    checks = [
        ("list_conversations", lambda: ctx.conversations_result, SMS),
        ("list_calls", lambda: ctx.calls_result, CALL_HISTORY),
        ("list_photos", lambda: ctx.photos_result, PHOTOS),
        ("list_albums", lambda: ctx.albums_result, PHOTOS),
        ("list_notes", lambda: ctx.notes_result, NOTE_STORE),
        ("list_voicemails", lambda: ctx.voicemails_result, VOICEMAIL),
        ("list_browser_history", lambda: ctx.browser_result, SAFARI),
    ]
    problems = []
    for method, fetch, (domain, path) in checks:
        present = raw.has_file(domain, path)
        try:
            result = fetch()
        except SidecarError as e:
            problems.append(f"{method} raised {e}")
            continue
        error = result.get("error") or result.get("fallback_reason")
        if error and present:
            problems.append(f"{method} reported {error!r} although {domain}/{path} is in the backup")
    stats_errors = ctx.stats.get("errors") or []
    if stats_errors:
        problems.append(f"get_backup_stats reported errors: {stats_errors}")
    assert not problems, "\n".join(problems)


# ── messages ─────────────────────────────────────────────────────────────────


def test_conversations_match_sms_db(ctx):
    ctx.require_open()
    rows = ctx.raw.query(*SMS, """
        SELECT cmj.chat_id, COUNT(DISTINCT cmj.message_id) AS n
        FROM chat_message_join cmj
        JOIN chat c ON c.ROWID = cmj.chat_id
        JOIN message m ON m.ROWID = cmj.message_id
        GROUP BY cmj.chat_id
    """)
    if rows is None:
        pytest.skip("no sms.db in this backup")
    expected = {r["chat_id"]: r["n"] for r in rows}
    listed = {c["chat_id"]: c["message_count"] for c in ctx.conversations}
    assert set(listed) == set(expected), (
        f"missing chats {sorted(set(expected) - set(listed))}, unexpected chats {sorted(set(listed) - set(expected))}"
    )
    wrong = {cid: (listed[cid], n) for cid, n in expected.items() if listed[cid] != n}
    assert not wrong, f"message_count differs from sms.db for chats (listed, actual): {wrong}"


def test_no_plain_message_dropped(ctx):
    ctx.require_open()
    conn = ctx.raw.connect(*SMS)
    if conn is None:
        pytest.skip("no sms.db in this backup")
    has_balloon = "balloon_bundle_id" in ctx.raw.columns(conn, "message")
    balloon = "m.balloon_bundle_id" if has_balloon else "NULL"
    problems = []
    for chat_id, page in ctx.message_pages.items():
        rows = conn.execute(
            f"SELECT DISTINCT m.ROWID AS id, {balloon} AS balloon FROM chat_message_join cmj "
            "JOIN message m ON m.ROWID = cmj.message_id WHERE cmj.chat_id = ?",
            (chat_id,),
        ).fetchall()
        sql_ids = {r["id"] for r in rows}
        ids = [m["message_id"] for m in page["messages"]]
        if len(ids) != len(set(ids)):
            problems.append(f"chat {chat_id}: duplicate message ids across pages")
        if page["total"] != len(sql_ids):
            problems.append(f"chat {chat_id}: total {page['total']} but sms.db has {len(sql_ids)}")
        dropped = [r["id"] for r in rows if r["id"] not in set(ids) and not r["balloon"]]
        if dropped:
            problems.append(f"chat {chat_id}: plain messages missing from get_messages: {_sample(dropped)}")
        extra = set(ids) - sql_ids
        if extra:
            problems.append(f"chat {chat_id}: messages not in this chat: {_sample(extra)}")
    conn.close()
    assert not problems, "\n".join(problems)


def test_message_fields_are_sane(ctx):
    ctx.require_open()
    latest = _latest(ctx)
    bad_dates, bad_senders, residue = [], [], []
    for m in ctx.messages:
        when = parse_iso(m.get("date"))
        if when is None or not EARLIEST <= when <= latest:
            bad_dates.append((m["message_id"], m.get("date")))
        if m.get("is_from_me"):
            if m.get("sender") != "me":
                bad_senders.append(m["message_id"])
        elif not (m.get("sender") or "").strip():
            bad_senders.append(m["message_id"])
        if any(token in (m.get("text") or "") for token in TEXT_RESIDUE):
            residue.append(m["message_id"])
    assert not bad_dates, f"messages with missing or impossible dates: {_sample(bad_dates)}"
    assert not bad_senders, f"messages without a sender: {_sample(bad_senders)}"
    assert not residue, f"message text with attributedBody/typedstream residue: {_sample(residue)}"


def _relative_attachment_path(filename: str) -> str:
    for prefix in ("~/", "/private/var/mobile/", "/var/mobile/"):
        if filename.startswith(prefix):
            return filename[len(prefix):]
    return filename


def test_attachments_resolve_or_are_really_missing(ctx):
    ctx.require_open()
    attachments = [a for m in ctx.messages for a in m.get("attachments") or []]
    if not attachments:
        pytest.skip("no message attachments in this backup")
    problems = []
    for attachment in attachments[:ATTACHMENT_SAMPLE]:
        result = ctx.rpc("get_attachment", attachment_id=attachment["attachment_id"])
        if "data" in result:
            if not result["data"] or not base64.b64decode(result["data"]):
                problems.append(f"attachment {attachment['attachment_id']}: empty data")
            continue
        error = result.get("error")
        relative = _relative_attachment_path(attachment.get("filename") or "")
        in_backup = relative and (ctx.raw.has_file("MediaDomain", relative) or ctx.raw.has_file("HomeDomain", relative))
        if in_backup:
            problems.append(f"attachment {attachment['attachment_id']}: reported {error!r} but the file is in the backup")
    assert not problems, "\n".join(problems)


# ── other data types ─────────────────────────────────────────────────────────


def test_every_call_record_listed(ctx):
    ctx.require_open()
    rows = ctx.raw.query(*CALL_HISTORY, "SELECT Z_PK FROM ZCALLRECORD")
    if rows is None:
        pytest.skip("no CallHistory.storedata in this backup")
    result = ctx.calls_result
    calls = result.get("calls", [])
    assert result.get("total") == len(calls), "list_calls total doesn't match the number of calls returned"
    listed = {c["call_id"] for c in calls}
    missing = {r["Z_PK"] for r in rows} - listed
    assert not missing, f"call records missing from list_calls: {_sample(sorted(missing))}"


def test_calls_agree_with_call_history(ctx):
    """Direction, FaceTime audio/video and answered status follow the raw ZCALLRECORD row."""
    ctx.require_open()
    conn = ctx.raw.connect(*CALL_HISTORY)
    if conn is None:
        pytest.skip("no CallHistory.storedata in this backup")
    rows = {r["Z_PK"]: r for r in conn.execute(
        "SELECT Z_PK, ZORIGINATED, ZANSWERED, ZDURATION, ZCALLTYPE, ZSERVICE_PROVIDER FROM ZCALLRECORD"
    )}
    conn.close()
    problems = []
    for call in ctx.result_or_empty("calls_result").get("calls", []):
        row = rows.get(call["call_id"])
        if row is None:
            continue  # FaceTime-from-Messages and voicemail entries have string ids
        if row["ZORIGINATED"] is not None:
            direction = "outgoing" if row["ZORIGINATED"] else "incoming"
            if call["direction"] != direction:
                problems.append(f"call {row['Z_PK']}: direction {call['direction']}, ZORIGINATED says {direction}")
        connected = (row["ZDURATION"] or 0) > 0
        if connected and call["status"] != "answered":
            problems.append(f"call {row['Z_PK']}: lasted {row['ZDURATION']:.0f}s but status is {call['status']}")
        if "facetime" in (row["ZSERVICE_PROVIDER"] or "").lower() and row["ZCALLTYPE"] in (8, 16):
            app = "FaceTime Video" if row["ZCALLTYPE"] == 8 else "FaceTime Audio"
            if call["app"] != app:
                problems.append(f"call {row['Z_PK']}: app {call['app']}, ZCALLTYPE {row['ZCALLTYPE']} means {app}")
    assert not problems, "\n".join(problems[:20])


def test_contacts_match_address_book(ctx):
    ctx.require_open()
    rows = ctx.raw.query(*ADDRESS_BOOK, "SELECT ROWID FROM ABPerson")
    if rows is None:
        pytest.skip("no AddressBook.sqlitedb in this backup")
    expected = {r["ROWID"] for r in rows}
    listed = {c["id"] for c in ctx.contacts}
    assert listed == expected, f"missing {_sample(sorted(expected - listed))}, unexpected {_sample(sorted(listed - expected))}"


def test_every_note_listed_with_its_dates(ctx):
    ctx.require_open()
    conn = ctx.raw.connect(*NOTE_STORE)
    if conn is None:
        pytest.skip("no NoteStore.sqlite in this backup")
    columns = ctx.raw.columns(conn, "ZICCLOUDSYNCINGOBJECT")
    created_cols = [c for c in ("ZCREATIONDATE3", "ZCREATIONDATE2", "ZCREATIONDATE1", "ZCREATIONDATE") if c in columns]
    created = f"COALESCE({', '.join(created_cols)})" if created_cols else "NULL"
    rows = conn.execute(f"SELECT Z_PK, {created} AS created FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1 IS NOT NULL").fetchall()
    conn.close()
    notes = {n["note_id"]: n for n in ctx.notes_result.get("notes", [])}
    missing = [r["Z_PK"] for r in rows if r["Z_PK"] not in notes]
    assert not missing, f"notes missing from list_notes: {_sample(missing)}"
    undated = [r["Z_PK"] for r in rows if r["created"] and not notes[r["Z_PK"]].get("created")]
    assert not undated, f"notes with a creation date in NoteStore but none in list_notes: {_sample(undated)}"


def _asset_table(raw, conn):
    tables = raw.tables(conn)
    return "ZASSET" if "ZASSET" in tables else "ZGENERICASSET"


def _photo_rows(ctx):
    """Non-trashed assets as (uuid, has_date, original_in_backup)."""
    conn = ctx.raw.connect(*PHOTOS)
    if conn is None:
        pytest.skip("no Photos.sqlite in this backup")
    table = _asset_table(ctx.raw, conn)
    where = "WHERE ZTRASHEDSTATE = 0" if "ZTRASHEDSTATE" in ctx.raw.columns(conn, table) else ""
    rows = conn.execute(f"SELECT ZUUID, ZDATECREATED, ZDIRECTORY, ZFILENAME FROM {table} {where}").fetchall()
    conn.close()
    out = []
    for r in rows:
        directory, filename = (r["ZDIRECTORY"] or "").strip("/"), r["ZFILENAME"] or ""
        candidates = [f"Media/{directory}/{filename}", f"Media/DCIM/{directory}/{filename}"]
        in_backup = bool(directory and filename) and any(ctx.raw.has_file("CameraRollDomain", c) for c in candidates)
        out.append((r["ZUUID"], r["ZDATECREATED"] is not None, in_backup))
    return out


def test_every_photo_listed(ctx):
    """Every asset whose original is in the backup is listed once, with its date."""
    ctx.require_open()
    rows = _photo_rows(ctx)
    result = ctx.photos_result
    assert result.get("source") == "photos_sqlite", (
        f"list_photos used {result.get('source')!r} although Photos.sqlite is in the backup"
    )
    photos = {p.get("uuid"): p for p in result.get("photos", [])}
    assert len(photos) == len(result.get("photos", [])), "duplicate photos across pages"
    missing = [uuid for uuid, _, in_backup in rows if in_backup and uuid not in photos]
    assert not missing, f"photos with their original in the backup missing from list_photos: {_sample(missing)}"
    undated = [uuid for uuid, has_date, _ in rows if has_date and uuid in photos and not photos[uuid].get("date_created")]
    assert not undated, f"photos with a date in Photos.sqlite but none in list_photos: {_sample(undated)}"


def test_photo_total_matches_listing(ctx):
    """The count the UI shows equals the number of photos it can actually page through."""
    ctx.require_open()
    result = ctx.photos_result
    listed = len(result.get("photos", []))
    assert result.get("total") == listed, f"list_photos says total {result.get('total')} but pages contain {listed}"


def test_photo_details_agree_with_list(ctx):
    """The detail view (get_photo_metadata) opens and shows the same date as the grid."""
    ctx.require_open()
    photos = [p for p in ctx.photos_result.get("photos", []) if p.get("uuid")][:20]
    if ctx.photos_result.get("source") != "photos_sqlite" or not photos:
        pytest.skip("no Photos.sqlite listing to compare against")
    problems = []
    for photo in photos:
        details = ctx.rpc("get_photo_metadata", asset_uuid=photo["uuid"])
        if details.get("error"):
            problems.append(f"{photo['uuid']}: {details['error']}")
        elif details.get("date_created") != photo.get("date_created"):
            problems.append(f"{photo['uuid']}: details {details.get('date_created')} vs list {photo.get('date_created')}")
    assert not problems, "\n".join(problems)


def test_albums_match_photos_db(ctx):
    ctx.require_open()
    rows = ctx.raw.query(*PHOTOS, "SELECT ZTITLE FROM ZGENERICALBUM WHERE ZTITLE IS NOT NULL")
    if rows is None:
        pytest.skip("no Photos.sqlite in this backup")
    titles = {a.get("title") for a in ctx.albums_result.get("albums", [])}
    missing = sorted({r["ZTITLE"] for r in rows} - titles)
    assert not missing, f"{len(missing)} album(s) in Photos.sqlite missing from list_albums"


def test_every_voicemail_listed(ctx):
    ctx.require_open()
    rows = ctx.raw.query(*VOICEMAIL, "SELECT ROWID FROM voicemail WHERE trashed_date = 0 OR trashed_date IS NULL")
    if rows is None:
        pytest.skip("no voicemail.db in this backup")
    listed = {v["id"] for v in ctx.voicemails_result.get("voicemails", [])}
    missing = {r["ROWID"] for r in rows} - listed
    assert not missing, f"voicemails missing from list_voicemails: {_sample(sorted(missing))}"


def test_every_safari_visit_listed(ctx):
    """Each visit is listed, or folded into a listed visit with the same title within 120 s.

    list_browser_history deliberately folds rapid same-title visits (redirect
    chains, in-page navigation) into one entry; anything else is a drop.
    """
    ctx.require_open()
    rows = ctx.raw.query(*SAFARI, """
        SELECT hv.id, hi.url, hv.title, hv.visit_time
        FROM history_visits hv JOIN history_items hi ON hv.history_item = hi.id
    """)
    if rows is None:
        pytest.skip("no Safari History.db in this backup")
    listed = [v for v in ctx.browser_result.get("visits", []) if v.get("browser") == "safari"]
    listed_ids = {v.get("visit_id") for v in listed}
    by_title: dict[str, list[datetime]] = {}
    for v in listed:
        if v.get("title") and (when := parse_iso(v.get("visit_date"))):
            by_title.setdefault(v["title"], []).append(when)
    apple_epoch = datetime(2001, 1, 1, tzinfo=timezone.utc)
    dropped = []
    for r in rows:
        if f"s_{r['id']}" in listed_ids:
            continue
        when = apple_epoch + timedelta(seconds=r["visit_time"] or 0)
        folded = any(abs((when - kept).total_seconds()) < 120 for kept in by_title.get(r["title"] or "", []))
        if not folded:
            dropped.append(r["id"])
    assert not dropped, f"Safari visits missing from list_browser_history: {_sample(dropped)}"


# ── screens agree with each other ────────────────────────────────────────────


def test_stats_agree_with_lists(ctx):
    ctx.require_open()
    overview = ctx.stats.get("overview", {})
    message_stats = ctx.stats.get("messages", {})
    expected = {
        "overview.total_conversations": (overview.get("total_conversations"), len(ctx.conversations)),
        "overview.total_messages": (overview.get("total_messages"), sum(c["message_count"] for c in ctx.conversations)),
        "messages.group_conversations": (
            message_stats.get("group_conversations"), sum(1 for c in ctx.conversations if c.get("is_group"))
        ),
        "messages.one_on_one_conversations": (
            message_stats.get("one_on_one_conversations"), sum(1 for c in ctx.conversations if not c.get("is_group"))
        ),
        "overview.total_contacts": (overview.get("total_contacts"), len(ctx.contacts)),
        "overview.total_notes": (overview.get("total_notes"), len(ctx.notes_result.get("notes", []))),
        "overview.total_voicemails": (overview.get("total_voicemails"), len(ctx.voicemails_result.get("voicemails", []))),
        "overview.total_photos + total_videos": (
            (overview.get("total_photos") or 0) + (overview.get("total_videos") or 0), ctx.photos_result.get("total")
        ),
    }
    try:
        expected["overview.total_calls"] = (overview.get("total_calls"), ctx.calls_result.get("total"))
    except SidecarError:
        pass  # reported by test_no_extractor_errors
    mismatches = {name: f"stats={a} list={b}" for name, (a, b) in expected.items() if a != b}
    assert not mismatches, f"stats disagree with the list screens: {mismatches}"


def test_timestamps_plausible(ctx):
    ctx.require_open()
    latest = _latest(ctx)
    sources = {
        "calls.date": [c.get("date") for c in ctx.result_or_empty("calls_result").get("calls", [])],
        "notes.created": [n.get("created") for n in ctx.notes_result.get("notes", [])],
        "notes.modified": [n.get("modified") for n in ctx.notes_result.get("notes", [])],
        "photos.date_created": [p.get("date_created") for p in ctx.photos_result.get("photos", [])],
        "browser.visit_date": [v.get("visit_date") for v in ctx.browser_result.get("visits", [])],
        "voicemails.date_received": [v.get("date_received") for v in ctx.voicemails_result.get("voicemails", [])],
    }
    problems = {}
    for name, values in sources.items():
        bad = [v for v in values if v is not None and not ((d := parse_iso(v)) and EARLIEST <= d <= latest)]
        if bad:
            problems[name] = _sample(bad)
    assert not problems, f"impossible timestamps (allowed {EARLIEST.date()} to {latest.date()}): {problems}"


def test_export_conversation_round_trip(ctx, tmp_path):
    ctx.require_open()
    if not ctx.conversations:
        pytest.skip("no conversations")
    biggest = max(ctx.conversations, key=lambda c: c["message_count"])
    result = ctx.rpc("export_conversation", chat_id=biggest["chat_id"], format="txt", output_dir=str(tmp_path))
    assert "error" not in result, result
    exported = Path(result["file"])
    if not exported.is_absolute():
        exported = tmp_path / exported
    assert exported.is_file() and exported.stat().st_size > 0, f"export didn't produce a file: {result}"
    shown = len(ctx.message_pages[biggest["chat_id"]]["messages"])
    assert result["message_count"] == shown, f"exported {result['message_count']} messages, the app shows {shown}"


# Keep last: protocol problems anywhere above would show up here too.
def test_protocol_stayed_clean(ctx):
    assert not ctx.client.protocol_errors, ctx.client.protocol_errors
    assert not ctx.client.notifications, f"unexpected notifications: {ctx.client.notifications[:3]}"
