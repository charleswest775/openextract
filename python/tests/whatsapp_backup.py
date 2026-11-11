"""A backup with WhatsApp in it, for the engine's tests and for screenshots.

backupgen writes no WhatsApp, so the tests build it here: ChatStorage.sqlite
and LID.sqlite from backupgen's table definitions harvested from real backups
(backupgen/schemas/ios-*/, WhatsApp 2.20 to 2.24), the app-group preferences
plist, and media files with their thumbnails under Message/Media/. Every row
is invented: fictional 555 numbers, made-up names and text. The scenario
follows the shapes the public test backups showed (arrival order that
disagrees with dates and row ids, replies in ZMETADATA, reactions in
ZRECEIPTINFO, calls as type-59 rows, LIDs) without copying any of their data.

Two ways to get a backup out of it:

  * ``make_plain_copy``: a copy of an unencrypted backup (the tests use
    Einstein's, which has Messages) with WhatsApp added to its Manifest.db.
    sms.db's ids and ChatStorage's then collide, as they do on real phones.
  * ``make_encrypted``: a new encrypted backup written by backupgen's
    BackupWriter, holding only WhatsApp.

For screenshots, a plain demo backup with a few more chats:

    python python/tests/whatsapp_backup.py --out DIR [--password PW]

(plain: a copy of the generated Einstein backup plus WhatsApp; with a
password: an encrypted backup with WhatsApp only.)
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import io
import os
import plistlib
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from corpus.synthetic import backupgen_root  # noqa: E402

SHARED_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
PLIST = "Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist"
SCHEMA_VERSION = "17.3"  # WhatsApp 2.24: has LID.sqlite

PLAIN_UDID = "00008120-0000000000DECAF0"
ENCRYPTED_UDID = "00008030-0000000000DECAF1"
PASSWORD = "test"

# Fictional people (555 numbers).
OWNER, RILEY, CASEY, DREW = "12025550100", "12025550101", "12025550102", "12025550103"
OWNER_LID, CASEY_LID, STRANGER_LID = "880000000000001", "880000000000003", "880000000000009"
GROUP_JID = "120363000000000001@g.us"
LIST_JID = "1700000000@broadcast"

# Chats (ZWACHATSESSION.Z_PK) and what they show.
CHAT_RILEY, CHAT_GROUP, CHAT_STATUS, CHAT_STATUS_BROADCAST, CHAT_LIST, CHAT_STRANGER = 1, 2, 3, 4, 5, 7
RILEY_NAME, GROUP_NAME, LIST_NAME = "Riley Sample", "Weekend Plans", "Family list"

# Messages in Riley's chat worth naming (ZWAMESSAGE.Z_PK).
MSG_NOTICE, MSG_HELLO, MSG_REPLY, MSG_IMAGE, MSG_VIDEO_CALL, MSG_VOICE_CALL = 10, 12, 11, 13, 14, 15
MSG_MISSED_CALL, MSG_LOCATION, MSG_LIVE_LOCATION, MSG_MISSING_IMAGE, MSG_DELETED = 16, 17, 18, 21, 22
MSG_DOCUMENT, MSG_VOICE_NOTE, MSG_LAST, MSG_UNKNOWN = 24, 25, 23, 26

# Media rows (ZWAMEDIAITEM.Z_PK), the attachment ids the app asks for.
ATT_IMAGE, ATT_LOCATION, ATT_MISSING_IMAGE, ATT_DOCUMENT, ATT_VOICE_NOTE = 2, 6, 9, 10, 11

HELLO_TEXT = "Hello from Riley"
REPLY_TEXT = "Reply to you"
CAPTION = "Caption here"
LAST_TEXT = "last words 100% _done_"
STATUS_TEXT = "status secret words"
DOCUMENT_TITLE = "Quarterly report.pdf"
PLACE_NAME = "Corner Cafe"

IMAGE_PATH = f"Media/{RILEY}@s.whatsapp.net/a/b/abcd-image.jpg"
THUMB_PATH = f"Media/{RILEY}@s.whatsapp.net/a/b/abcd-image.thumb"
MAP_THUMB_PATH = f"Media/{OWNER}@s.whatsapp.net/c/d/map.thumb"
MISSING_PATH = f"Media/{RILEY}@s.whatsapp.net/e/f/missing.jpg"
DOCUMENT_PATH = f"Media/{RILEY}@s.whatsapp.net/0/1/report.pdf"
VOICE_PATH = f"Media/{RILEY}@s.whatsapp.net/0/1/voice.opus"

PDF_BYTES = b"%PDF-1.4\n% fictional document\n%%EOF\n"
VOICE_BYTES = b"OggS" + b"\x00fictional opus voice note" * 8


def jid(number: str) -> str:
    return f"{number}@s.whatsapp.net"


def apple(iso: str) -> float:
    dt = datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)
    return (dt - datetime(2001, 1, 1, tzinfo=timezone.utc)).total_seconds()


def unix_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


T0 = apple("2024-03-01T12:00:00")


def jpeg(size=(64, 48), color=(37, 211, 102)) -> bytes:
    """A real (tiny) JPEG, so exports can convert and scale it."""
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "JPEG", quality=80)
    return out.getvalue()


# ── protobuf, the way WhatsApp stores replies, reactions and calls ──────────

def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | 0x80 if n else b)
        if not n:
            return bytes(out)


def pb(*fields) -> bytes:
    """Encode ``(number, value)`` pairs: ints as varints, str/bytes length-delimited, lists as nested messages."""
    out = bytearray()
    for number, value in fields:
        if isinstance(value, bool):
            value = int(value)
        if isinstance(value, int):
            out += _varint(number << 3) + _varint(value)
            continue
        if isinstance(value, str):
            value = value.encode("utf-8")
        elif isinstance(value, (list, tuple)):
            value = pb(*value)
        out += _varint(number << 3 | 2) + _varint(len(value)) + value
    return bytes(out)


def call_meta(video: bool, outcome: int, seconds: int) -> bytes:
    """ZMETADATA of a type-59 call row: 87.1 = {1 video, 2 outcome, 3 seconds}."""
    return pb((87, [(1, [(1, video), (2, outcome), (3, seconds), (4, 0), (5, [(1, jid(RILEY)), (2, 0)])]),
                    (2, 0), (3, 1), (4, 0)]))


def reply_meta(stanza: str, sender_jid: Optional[str], text: str) -> bytes:
    """ZMETADATA of a reply: 5 the quoted stanza id, 6 its sender (none = the owner), 19.1 its text."""
    fields = [(5, stanza)]
    if sender_jid:
        fields.append((6, sender_jid))
    fields.append((19, [(1, text)]))
    return pb(*fields)


def reactions_blob(*, others=(), mine=None) -> bytes:
    """ZRECEIPTINFO with reactions: 7.1 others {2 jid, 3 emoji, 4 ms}, 7.2 the owner's {2 emoji, 3 ms}."""
    block = [(1, [(1, "R" * 32), (2, who), (3, emoji), (4, ms)]) for who, emoji, ms in others]
    if mine:
        emoji, ms = mine
        block.append((2, [(1, "3AOWNREACT"), (2, emoji), (3, ms)]))
    return pb((4, 2), (7, block))


# ── the scenario ─────────────────────────────────────────────────────────────

@dataclass
class Scenario:
    """What the built store holds, for tests to compare against."""

    files: dict = field(default_factory=dict)            # (domain, relative path) -> bytes
    chats: dict = field(default_factory=dict)            # listed chat id -> (name, chat_type, handle, archived)
    counts: dict = field(default_factory=dict)           # listed chat id -> rows (notices included)
    hidden_chats: tuple = (CHAT_STATUS, CHAT_STATUS_BROADCAST)
    image_bytes: bytes = b""
    thumb_bytes: bytes = b""
    map_bytes: bytes = b""

    @property
    def total_messages(self) -> int:
        return sum(self.counts.values())


def _populate(db, demo: bool, counts: dict) -> None:
    chats, msgs, media, info = (db.table(n) for n in ("ZWACHATSESSION", "ZWAMESSAGE", "ZWAMEDIAITEM", "ZWAMESSAGEINFO"))
    members, groups, push = db.table("ZWAGROUPMEMBER"), db.table("ZWAGROUPINFO"), db.table("ZWAPROFILEPUSHNAME")
    # From WhatsApp 2.23 the chat's last-message text is base64 protobuf: never to be shown.
    protobuf_text = base64.b64encode(pb((1, 1709294400), (4, 0))).decode()

    def chat(pk, contact_jid, session_type, partner="", archived=0):
        chats.insert({"Z_PK": pk, "Z_ENT": 4, "ZCONTACTJID": contact_jid, "ZSESSIONTYPE": session_type,
                      "ZPARTNERNAME": partner, "ZMESSAGECOUNTER": 99, "ZARCHIVED": archived,
                      "ZLASTMESSAGETEXT": protobuf_text, "ZHIDDEN": 0, "ZREMOVED": 0})

    def message(pk, chat_pk, sort, mtype, date, *, event=None, from_me=False, text=None, frm=None, to=None,
                sent=None, member=None, pushname=None, stanza=None, media_pk=None, info_pk=None, starred=0):
        msgs.insert({"Z_PK": pk, "Z_ENT": 9, "ZCHATSESSION": chat_pk, "ZSORT": sort, "ZMESSAGETYPE": mtype,
                     "ZGROUPEVENTTYPE": event if event is not None else (0 if from_me else 2),
                     "ZISFROMME": int(from_me), "ZMESSAGEDATE": date, "ZSENTDATE": sent, "ZTEXT": text,
                     "ZFROMJID": frm, "ZTOJID": to, "ZGROUPMEMBER": member, "ZPUSHNAME": pushname,
                     "ZSTANZAID": stanza or f"3A{pk:018d}", "ZMEDIAITEM": media_pk, "ZMESSAGEINFO": info_pk,
                     "ZMESSAGESTATUS": 8, "ZFLAGS": 0x1000000, "ZSTARRED": starred})
        counts[chat_pk] = counts.get(chat_pk, 0) + 1

    def media_row(pk, msg_pk, **cols):
        media.insert({"Z_PK": pk, "Z_ENT": 8, "ZMESSAGE": msg_pk, **cols})

    def receipt(pk, msg_pk, blob):
        info.insert({"Z_PK": pk, "Z_ENT": 11, "ZMESSAGE": msg_pk, "ZRECEIPTINFO": blob})

    R = jid(RILEY)
    # Riley: row ids deliberately not in arrival (ZSORT) order, and some dates disagree with it.
    chat(CHAT_RILEY, R, 0, partner=RILEY_NAME)
    message(MSG_NOTICE, 1, 1, 10, T0, event=2, frm=R, to=jid(OWNER))
    message(MSG_HELLO, 1, 2, 0, T0 + 60, frm=R, text=HELLO_TEXT, sent=T0 + 65, stanza="3ARILEYHELLO0000001",
            info_pk=1)
    receipt(1, MSG_HELLO, reactions_blob(mine=("❤️", unix_ms("2024-03-01T12:01:30"))))
    message(MSG_REPLY, 1, 3, 0, T0 + 120, from_me=True, text=REPLY_TEXT, to=R, media_pk=1, info_pk=2)
    media_row(1, MSG_REPLY, ZMETADATA=reply_meta("3ARILEYHELLO0000001", R, HELLO_TEXT))
    receipt(2, MSG_REPLY, reactions_blob(others=[(R, "🙏", unix_ms("2024-03-01T12:03:00"))]))
    message(MSG_IMAGE, 1, 4, 1, T0 + 180, frm=R, media_pk=ATT_IMAGE)
    media_row(ATT_IMAGE, MSG_IMAGE, ZMEDIALOCALPATH=IMAGE_PATH, ZXMPPTHUMBPATH=THUMB_PATH, ZLATITUDE=48.0,
              ZLONGITUDE=64.0, ZVCARDSTRING="image/jpeg", ZTITLE=CAPTION, ZMEDIAORIGIN=0)
    message(MSG_VIDEO_CALL, 1, 5, 59, T0 + 240, frm=R, media_pk=3)
    media_row(3, MSG_VIDEO_CALL, ZMETADATA=call_meta(True, 0, 125))
    message(MSG_VOICE_CALL, 1, 6, 59, T0 + 300, from_me=True, to=R, media_pk=4)
    media_row(4, MSG_VOICE_CALL, ZMETADATA=call_meta(False, 0, 0))
    message(MSG_MISSED_CALL, 1, 7, 59, T0 + 360, frm=R, media_pk=5)
    media_row(5, MSG_MISSED_CALL, ZMETADATA=call_meta(False, 1, 0))
    message(MSG_LOCATION, 1, 8, 5, T0 + 420, from_me=True, to=R, media_pk=ATT_LOCATION)
    media_row(ATT_LOCATION, MSG_LOCATION, ZLATITUDE=45.52, ZLONGITUDE=-122.68, ZMEDIAORIGIN=0,
              ZXMPPTHUMBPATH=MAP_THUMB_PATH, ZTITLE=PLACE_NAME)
    message(MSG_LIVE_LOCATION, 1, 9, 5, T0 + 480, frm=R, media_pk=7)
    media_row(7, MSG_LIVE_LOCATION, ZLATITUDE=45.53, ZLONGITUDE=-122.69, ZMEDIAORIGIN=1,
              ZXMPPTHUMBPATH="Media/gone/map.thumb")
    message(MSG_MISSING_IMAGE, 1, 10, 1, T0 + 540, from_me=True, to=R, media_pk=ATT_MISSING_IMAGE)
    media_row(ATT_MISSING_IMAGE, MSG_MISSING_IMAGE, ZMEDIALOCALPATH=MISSING_PATH, ZVCARDSTRING="image/jpeg",
              ZFILESIZE=5000)
    # ZSORT 11 is missing: a message deleted "for me" leaves no row.
    message(MSG_DELETED, 1, 12, 14, T0 + 720, frm=R)
    message(MSG_DOCUMENT, 1, 13, 8, T0 + 730, frm=R, media_pk=ATT_DOCUMENT)
    media_row(ATT_DOCUMENT, MSG_DOCUMENT, ZMEDIALOCALPATH=DOCUMENT_PATH, ZVCARDSTRING="application/pdf",
              ZTITLE=DOCUMENT_TITLE, ZFILESIZE=len(PDF_BYTES))
    message(MSG_VOICE_NOTE, 1, 14, 3, T0 + 740, from_me=True, to=R, media_pk=ATT_VOICE_NOTE)
    media_row(ATT_VOICE_NOTE, MSG_VOICE_NOTE, ZMEDIALOCALPATH=VOICE_PATH, ZVCARDSTRING="audio/ogg; codecs=opus",
              ZMOVIEDURATION=7.0, ZFILESIZE=len(VOICE_BYTES))
    # Arrived last but stamped before the three above (the sender's clock was behind).
    message(MSG_LAST, 1, 15, 0, T0 + 700, frm=R, text=LAST_TEXT, sent=T0 + 750, starred=1)
    message(MSG_UNKNOWN, 1, 16, 99, T0 + 760, frm=R, text="A message type from the future")

    # A group the owner made, with a member WhatsApp knows only by LID.
    chat(CHAT_GROUP, GROUP_JID, 1, partner=GROUP_NAME)
    groups.insert({"Z_PK": 1, "Z_ENT": 5, "ZCHATSESSION": CHAT_GROUP, "ZCREATORJID": jid(OWNER),
                   "ZCREATIONDATE": T0 - 86400})
    members.insert({"Z_PK": 1, "Z_ENT": 6, "ZCHATSESSION": CHAT_GROUP, "ZMEMBERJID": f"{CASEY_LID}@lid",
                    "ZCONTACTNAME": ""})
    members.insert({"Z_PK": 2, "Z_ENT": 6, "ZCHATSESSION": CHAT_GROUP, "ZMEMBERJID": jid(OWNER), "ZCONTACTNAME": ""})
    push.insert({"Z_PK": 1, "Z_ENT": 13, "ZJID": jid(CASEY), "ZPUSHNAME": "Casey"})
    message(30, CHAT_GROUP, 1, 10, T0 - 86400, event=2, frm=GROUP_JID, to=jid(OWNER))
    message(31, CHAT_GROUP, 2, 6, T0 - 86400, event=12, frm=GROUP_JID, to=jid(OWNER))
    message(32, CHAT_GROUP, 3, 6, T0 - 86399, event=2, frm=GROUP_JID, to=jid(OWNER), member=1)
    message(33, CHAT_GROUP, 4, 0, T0 - 80000, frm=GROUP_JID, member=1, text="Hi all")
    message(34, CHAT_GROUP, 5, 0, T0 - 79000, frm=GROUP_JID, pushname="Drew", text="Drew here")
    message(35, CHAT_GROUP, 6, 0, T0 - 78000, from_me=True, to=GROUP_JID, text="Sounds good to me")
    message(36, CHAT_GROUP, 7, 6, T0 - 77000, event=1, frm=GROUP_JID, to=jid(OWNER),
            text='{"subject": "%s", "author": "%s"}' % (GROUP_NAME, jid(CASEY)))

    # Status updates are not chats: never listed, never searched.
    chat(CHAT_STATUS, "0@status", 3, partner="WhatsApp")
    message(40, CHAT_STATUS, 1, 0, T0 + 900, frm=R, text=STATUS_TEXT)
    chat(CHAT_STATUS_BROADCAST, "status@broadcast", 2)
    message(41, CHAT_STATUS_BROADCAST, 1, 0, T0 + 901, from_me=True, text=STATUS_TEXT)
    # A broadcast list, archived; a chat with no messages (not listed); a LID nothing maps to a number.
    chat(CHAT_LIST, LIST_JID, 2, partner=LIST_NAME, archived=1)
    message(50, CHAT_LIST, 1, 0, T0 - 200000, from_me=True, text="Hello family")
    chat(6, jid("12025550109"), 0, partner="Nobody")
    chat(CHAT_STRANGER, f"{STRANGER_LID}@lid", 0)
    message(70, CHAT_STRANGER, 1, 0, T0 - 300000, frm=f"{STRANGER_LID}@lid", text="Who is this")

    if demo:
        _populate_demo(chat, message, media_row, members, groups, counts)


# Extra fictional chats for the screenshot backup (python whatsapp_backup.py --out).
_DEMO_LINES = [
    (False, "Are we still on for Saturday?"), (True, "Yes! 10am at the trailhead?"),
    (False, "Perfect. I'll bring coffee"), (True, "You're the best"),
    (False, "Weather says sunny, finally"), (True, "Packing the big camera then"),
    (False, "Don't forget the snacks this time 😄"), (True, "Never again, promise"),
]


def _populate_demo(chat, message, media_row, members, groups, counts) -> None:
    jordan = jid("12025550104")
    chat(20, jordan, 0, partner="Jordan Rivera")
    for i, (from_me, text) in enumerate(_DEMO_LINES):
        message(200 + i, 20, i + 1, 0, T0 + 3600 * 24 + i * 300, from_me=from_me, text=text,
                frm=None if from_me else jordan, to=jordan if from_me else None)
    message(220, 20, 20, 1, T0 + 3600 * 24 + 4000, frm=jordan, media_pk=220)
    media_row(220, 220, ZMEDIALOCALPATH="Media/12025550104@s.whatsapp.net/1/2/trail.jpg",
              ZVCARDSTRING="image/jpeg", ZTITLE="The view from the top", ZLATITUDE=48.0, ZLONGITUDE=64.0)

    club = "120363000000000021@g.us"
    chat(21, club, 1, partner="Book club")
    groups.insert({"Z_PK": 21, "Z_ENT": 5, "ZCHATSESSION": 21, "ZCREATORJID": jid(DREW)})
    members.insert({"Z_PK": 21, "Z_ENT": 6, "ZCHATSESSION": 21, "ZMEMBERJID": jid(DREW), "ZCONTACTNAME": "Drew Park"})
    members.insert({"Z_PK": 22, "Z_ENT": 6, "ZCHATSESSION": 21, "ZMEMBERJID": jid(RILEY), "ZCONTACTNAME": ""})
    message(230, 21, 1, 6, T0 + 3600 * 30, event=12, frm=club, to=jid(OWNER))
    message(231, 21, 2, 6, T0 + 3600 * 30 + 1, event=2, frm=club, to=jid(OWNER))
    for i, (who, text) in enumerate([(DREW, "Next pick: something short, please"),
                                     (RILEY, "Seconded. Last one took me a month"),
                                     (None, "How about a mystery?"),
                                     (DREW, "Mystery it is. Meeting on the 14th")]):
        message(232 + i, 21, 3 + i, 0, T0 + 3600 * 31 + i * 600, from_me=who is None, text=text,
                frm=None if who is None else club, member=None if who is None else (21 if who == DREW else 22),
                to=club if who is None else None)


def _populate_lid(db) -> None:
    pairs = db.table("ZWAPHONENUMBERLIDPAIR")
    pairs.insert({"Z_PK": 1, "Z_ENT": 3, "ZLID": CASEY_LID, "ZPHONENUMBER": CASEY, "ZTIMESTAMP": 2.0})
    pairs.insert({"Z_PK": 2, "Z_ENT": 3, "ZLID": OWNER_LID, "ZPHONENUMBER": OWNER, "ZTIMESTAMP": 3.0})


def backupgen_problem() -> Optional[str]:
    """Why a WhatsApp backup can't be built here, or None when it can."""
    if importlib.util.find_spec("ios_backup_core.extractors.whatsapp") is None:
        return ("this ios-backup-core has no WhatsApp extractor (ios-backup-core#28); set PYTHONPATH to a "
                "checkout that has it")
    root = backupgen_root()
    if root is None:
        return "ios-backup-core's backupgen wasn't found; set OPENEXTRACT_IOS_BACKUP_CORE"
    if not (root / "backupgen" / "schemas" / f"ios-{SCHEMA_VERSION}" / "ChatStorage.sqlite.json").is_file():
        return f"the ios-backup-core checkout at {root} has no harvested ChatStorage.sqlite schema; update it"
    return None


def _backupgen():
    root = backupgen_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from backupgen import container, sqlitegen

    return container, sqlitegen


def build_files(workdir: Path, demo: bool = False) -> Scenario:
    """Build the WhatsApp files in ``workdir``; the Scenario holds their bytes by (domain, relative path)."""
    _, sqlitegen = _backupgen()
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    counts: dict = {}
    chat_db = sqlitegen.build(workdir / "ChatStorage.sqlite", SCHEMA_VERSION, "ChatStorage.sqlite",
                              lambda db: _populate(db, demo, counts))
    lid_db = sqlitegen.build(workdir / "LID.sqlite", SCHEMA_VERSION, "LID.sqlite", _populate_lid)
    s = Scenario(image_bytes=jpeg((64, 48)), thumb_bytes=jpeg((16, 12), (20, 120, 60)),
                 map_bytes=jpeg((40, 40), (200, 220, 240)))
    prefs = {"OwnJabberID": jid(OWNER), "lid": f"{OWNER_LID}@lid", "FullUserName": "Pat Owner"}
    s.files = {
        (SHARED_DOMAIN, "ChatStorage.sqlite"): chat_db,
        (SHARED_DOMAIN, "LID.sqlite"): lid_db,
        (SHARED_DOMAIN, PLIST): plistlib.dumps(prefs, fmt=plistlib.FMT_BINARY),
        (SHARED_DOMAIN, "Message/" + IMAGE_PATH): s.image_bytes,
        (SHARED_DOMAIN, "Message/" + THUMB_PATH): s.thumb_bytes,
        (SHARED_DOMAIN, "Message/" + MAP_THUMB_PATH): s.map_bytes,
        (SHARED_DOMAIN, "Message/" + DOCUMENT_PATH): PDF_BYTES,
        (SHARED_DOMAIN, "Message/" + VOICE_PATH): VOICE_BYTES,
    }
    if demo:
        s.files[(SHARED_DOMAIN, "Message/Media/12025550104@s.whatsapp.net/1/2/trail.jpg")] = jpeg((96, 64), (90, 140, 200))
    s.counts = {c: n for c, n in counts.items() if c not in s.hidden_chats}
    s.chats = {
        CHAT_RILEY: (RILEY_NAME, "individual", "+" + RILEY, False),
        CHAT_GROUP: (GROUP_NAME, "group", "", False),
        CHAT_LIST: (LIST_NAME, "broadcast", "", True),
        CHAT_STRANGER: ("Unknown contact", "individual", "", False),
    }
    if demo:
        s.chats[20] = ("Jordan Rivera", "individual", "+12025550104", False)
        s.chats[21] = ("Book club", "group", "", False)
    return s


def file_id(domain: str, relative_path: str) -> str:
    return hashlib.sha1(f"{domain}-{relative_path}".encode("utf-8")).hexdigest()


def make_plain_copy(source: Path, dest: Path, scenario: Scenario, udid: str = PLAIN_UDID,
                    device_name: str = "WhatsApp test copy") -> Path:
    """Copy an unencrypted backup to ``dest`` and add the scenario's files to it, under a new UDID."""
    source, dest = Path(source), Path(dest)
    shutil.copytree(source, dest)
    info_path = dest / "Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["Unique Identifier"] = udid
    info["Device Name"] = device_name
    info_path.write_bytes(plistlib.dumps(info))
    manifest = dest / "Manifest.db"
    conn = sqlite3.connect(str(manifest))
    try:
        for (domain, rel), data in scenario.files.items():
            fid = file_id(domain, rel)
            target = dest / fid[:2] / fid
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            conn.execute("INSERT OR REPLACE INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, 1, NULL)",
                         (fid, domain, rel))
        conn.commit()
        # The engine opens backup files "immutable", so nothing may stay in a -wal file.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    for suffix in ("-wal", "-shm"):
        with contextlib.suppress(FileNotFoundError):
            os.remove(f"{manifest}{suffix}")
    return dest


def make_minimal_plain(dest: Path, files: dict, udid: str = PLAIN_UDID) -> Path:
    """A bare unencrypted backup holding only ``files`` ((domain, relative path) -> bytes)."""
    dest = Path(dest)
    dest.mkdir(parents=True)
    (dest / "Info.plist").write_bytes(plistlib.dumps({"Unique Identifier": udid, "Device Name": "Test iPhone",
                                                      "Product Version": SCHEMA_VERSION}))
    (dest / "Manifest.plist").write_bytes(plistlib.dumps({"IsEncrypted": False}))
    conn = sqlite3.connect(str(dest / "Manifest.db"))
    try:
        conn.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
        for (domain, rel), data in files.items():
            fid = file_id(domain, rel)
            (dest / fid[:2]).mkdir(exist_ok=True)
            (dest / fid[:2] / fid).write_bytes(data)
            conn.execute("INSERT INTO Files VALUES (?, ?, ?, 1, NULL)", (fid, domain, rel))
        conn.commit()
    finally:
        conn.close()
    return dest


def make_encrypted(out_parent: Path, scenario: Scenario, password: str = PASSWORD,
                   udid: str = ENCRYPTED_UDID) -> Path:
    """A new encrypted backup holding only the scenario's files; returns its folder (named after the UDID)."""
    container, _ = _backupgen()
    device = container.Device(name="WhatsApp test iPhone", product_type="iPhone12,1", product_name="iPhone 11",
                              ios=SCHEMA_VERSION, build="21D50", phone_number="+1 202 555 0100", udid=udid)
    writer = container.BackupWriter(Path(out_parent), device, datetime(2024, 3, 2, tzinfo=timezone.utc),
                                    SCHEMA_VERSION, password=password, seed=7)
    for (domain, rel), data in scenario.files.items():
        writer.add_file(domain, rel, data)
    return writer.finalize()


# ── command line: a demo backup for screenshots ──────────────────────────────

def _einstein_dir() -> Path:
    from corpus.synthetic import ensure_generated, load_synthetic

    item = load_synthetic()["syn-einstein-ios26-plain"]
    backup_dir = ensure_generated(item)
    if backup_dir is None:
        raise SystemExit("Einstein's backup couldn't be generated: set OPENEXTRACT_IOS_BACKUP_CORE")
    return backup_dir


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Write a fictional backup with WhatsApp chats in it.")
    parser.add_argument("--out", required=True, help="folder to write the backup into (made if missing)")
    parser.add_argument("--password", help="write an encrypted backup (WhatsApp only) with this password")
    args = parser.parse_args(argv)
    problem = backupgen_problem()
    if problem:
        print(problem, file=sys.stderr)
        return 1
    out = Path(args.out).resolve()
    target = out / (ENCRYPTED_UDID if args.password else PLAIN_UDID)
    if target.exists():
        print(f"{target} already exists: remove it, or pick another --out folder", file=sys.stderr)
        return 1
    out.mkdir(parents=True, exist_ok=True)
    scenario = build_files(out / ".whatsapp-parts", demo=True)
    try:
        if args.password:
            backup_dir = make_encrypted(out, scenario, args.password)
        else:
            backup_dir = make_plain_copy(_einstein_dir(), out / PLAIN_UDID, scenario,
                                         device_name="WhatsApp demo iPhone")
    finally:
        shutil.rmtree(out / ".whatsapp-parts", ignore_errors=True)
    print(f"{backup_dir}\n{len(scenario.chats)} WhatsApp chats, {scenario.total_messages} messages"
          + (f", password {args.password!r}" if args.password else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
