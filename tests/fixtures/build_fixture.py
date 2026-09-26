#!/usr/bin/env python3
"""
Build synthetic iPhone-backup fixtures for the regression suite.

Output (gitignored, regenerated on every run):
  tests/fixtures/synthetic_backup/<udid>/            unencrypted, populated
  tests/fixtures/synthetic_backup_encrypted/<udid>/  encrypted flag only

The populated backup mirrors the on-disk layout of a real unencrypted
iTunes/Finder backup: Manifest.db maps (domain, relativePath) to
fileID = sha1("<domain>-<relativePath>"), and each file lives at
<fileID[:2]>/<fileID>. Every database uses the tables and columns that
ios-backup-core and the openextract sidecar actually query.

All people, numbers, and messages are fictional. Numbers use the reserved
555-01xx range; emails use example.com.

The expected values the E2E specs assert on are defined in EXPECTED at the
bottom of this file and written to expected.json next to the backups.

Stdlib only, so any Python 3.9+ can run it:
    python tests/fixtures/build_fixture.py
"""

import gzip
import hashlib
import json
import os
import plistlib
import shutil
import sqlite3
import struct
import zlib
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_ROOT = os.path.join(HERE, "synthetic_backup")
ENCRYPTED_FIXTURE_ROOT = os.path.join(HERE, "synthetic_backup_encrypted")
BACKUP_UDID = "e2e000000000000000000000000000000000001"
ENCRYPTED_UDID = "e2e000000000000000000000000000000000002"
BACKUP_DIR = os.path.join(FIXTURE_ROOT, BACKUP_UDID)
ENCRYPTED_DIR = os.path.join(ENCRYPTED_FIXTURE_ROOT, ENCRYPTED_UDID)

APPLE_EPOCH_UNIX = 978307200


def ts(y, mo, d, h=0, mi=0, s=0) -> float:
    """Unix seconds for a UTC wall-clock time."""
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp()


def apple_s(unix: float) -> float:
    return unix - APPLE_EPOCH_UNIX


def apple_ns(unix: float) -> int:
    # iOS 14+ stores sms.db dates as nanoseconds since 2001-01-01.
    return int(apple_s(unix)) * 1_000_000_000


# ── People ────────────────────────────────────────────────────────────────────

ALICE = "+14155550101"
BOB = "+14155550102"
CAROL = "+14155550103"
DAN = "+14155550104"
ACME = "+14155550199"
UNKNOWN_SMS = "+14155550188"

CONTACTS = [
    # (first, last, org, phones (stored as users type them), emails)
    ("Alice", "Chen", None, ["+1 (415) 555-0101"], ["alice@example.com"]),
    ("Bob", "Martinez", None, ["(415) 555-0102"], []),
    ("Carol", "Okafor", None, ["+14155550103"], ["carol.okafor@example.com"]),
    ("Dan", "Whitfield", "Whitfield Plumbing", ["415-555-0104"], []),
    (None, None, "Acme Dental", ["+1 415 555 0199"], []),
]


# ── Binary helpers ────────────────────────────────────────────────────────────

def make_png(width: int, height: int, rgb: tuple) -> bytes:
    """Solid-colour RGB PNG, stdlib only."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    row = b"\x00" + bytes(rgb) * width
    raw = row * height
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def make_amr(seconds: int) -> bytes:
    """AMR-NB file of silent 12.2 kbps frames (50 frames per second)."""
    frame = bytes([0x3C]) + bytes(31)
    return b"#!AMR\n" + frame * (50 * seconds)


def _pb_field(field: int, payload: bytes) -> bytes:
    """Length-delimited protobuf field."""
    tag = (field << 3) | 2
    length = len(payload)
    out = bytearray([tag])
    while True:
        b = length & 0x7F
        length >>= 7
        out.append(b | (0x80 if length else 0))
        if not length:
            break
    return bytes(out) + payload


def make_note_blob(text: str) -> bytes:
    """gzip(NoteStoreProto{document{note{note_text, attribute_run}}}) as in ZICNOTEDATA.

    Real notes carry attribute runs whose varints contain bytes that are not
    valid UTF-8; that is what makes the extractor recurse past the wrapper
    messages instead of mistaking them for text, so include one here.
    """
    attribute_run = _pb_field(5, bytes([0x08, 0xC8, 0x01]))  # field 1 varint = 200
    note = _pb_field(2, text.encode("utf-8")) + attribute_run
    proto = _pb_field(2, _pb_field(3, note))
    return gzip.compress(proto, mtime=0)


# ── Backup writer ─────────────────────────────────────────────────────────────

class BackupWriter:
    def __init__(self, backup_dir: str):
        self.backup_dir = backup_dir
        self.files: list[tuple[str, str, str]] = []  # (fileID, domain, relativePath)

    def _dest(self, domain: str, rel: str) -> str:
        file_id = hashlib.sha1(f"{domain}-{rel}".encode("utf-8")).hexdigest()
        self.files.append((file_id, domain, rel))
        folder = os.path.join(self.backup_dir, file_id[:2])
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, file_id)

    def add_bytes(self, domain: str, rel: str, data: bytes) -> None:
        with open(self._dest(domain, rel), "wb") as f:
            f.write(data)

    def add_sqlite(self, domain: str, rel: str, build) -> None:
        path = self._dest(domain, rel)
        conn = sqlite3.connect(path)
        try:
            build(conn)
            conn.commit()
        finally:
            conn.close()

    def write_manifest(self) -> None:
        conn = sqlite3.connect(os.path.join(self.backup_dir, "Manifest.db"))
        conn.executescript("""
            CREATE TABLE Files (
                fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT,
                flags INTEGER, file BLOB
            );
            CREATE INDEX FilesDomainIdx ON Files(domain);
            CREATE INDEX FilesRelativePathIdx ON Files(relativePath);
        """)
        conn.executemany(
            "INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?, ?, ?, 1, NULL)",
            self.files,
        )
        conn.commit()
        conn.close()


# ── Databases ─────────────────────────────────────────────────────────────────

def build_address_book(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE ABPerson (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, First TEXT, Last TEXT,
            Middle TEXT, Organization TEXT, Department TEXT, Note TEXT,
            Kind INTEGER, CreationDate INTEGER, ModificationDate INTEGER
        );
        CREATE TABLE ABMultiValue (
            UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER,
            identifier INTEGER, label INTEGER, value TEXT
        );
    """)
    for first, last, org, phones, emails in CONTACTS:
        cur = conn.execute(
            "INSERT INTO ABPerson (First, Last, Organization, Kind) VALUES (?, ?, ?, ?)",
            (first, last, org, 1 if org and not first else 0),
        )
        pid = cur.lastrowid
        for i, phone in enumerate(phones):
            conn.execute(
                "INSERT INTO ABMultiValue (record_id, property, identifier, label, value) VALUES (?, 3, ?, 1, ?)",
                (pid, i, phone),
            )
        for i, email in enumerate(emails):
            conn.execute(
                "INSERT INTO ABMultiValue (record_id, property, identifier, label, value) VALUES (?, 4, ?, 1, ?)",
                (pid, i, email),
            )


ATTACHMENT_REL = "Library/SMS/Attachments/4a/10/trail-map.png"
ATTACHMENT_PNG = make_png(96, 64, (46, 139, 87))


def build_sms(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE handle (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
            country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT,
            person_centric_id TEXT
        );
        CREATE TABLE chat (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
            style INTEGER, state INTEGER, account_id TEXT, chat_identifier TEXT,
            service_name TEXT, room_name TEXT, display_name TEXT, group_id TEXT,
            is_archived INTEGER DEFAULT 0
        );
        CREATE TABLE message (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
            text TEXT, handle_id INTEGER DEFAULT 0, service TEXT,
            date INTEGER, date_read INTEGER, date_delivered INTEGER,
            is_from_me INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0,
            cache_has_attachments INTEGER DEFAULT 0,
            associated_message_type INTEGER DEFAULT 0,
            attributedBody BLOB, payload_data BLOB, balloon_bundle_id TEXT,
            is_audio_message INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
            share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0
        );
        CREATE TABLE attachment (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL,
            created_date INTEGER, filename TEXT, uti TEXT, mime_type TEXT,
            transfer_name TEXT, total_bytes INTEGER
        );
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
        CREATE TABLE chat_message_join (
            chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0,
            PRIMARY KEY (chat_id, message_id)
        );
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
        CREATE TABLE chat_recoverable_message_join (
            chat_id INTEGER, message_id INTEGER, delete_date INTEGER,
            PRIMARY KEY (chat_id, message_id)
        );
    """)

    handles = {}
    for number, service in [(ALICE, "iMessage"), (BOB, "SMS"), (CAROL, "iMessage"),
                            (DAN, "iMessage"), (UNKNOWN_SMS, "SMS")]:
        cur = conn.execute("INSERT INTO handle (id, country, service) VALUES (?, 'us', ?)", (number, service))
        handles[number] = cur.lastrowid

    def chat(guid, identifier, service, display_name, group_id, members):
        cur = conn.execute(
            "INSERT INTO chat (guid, style, chat_identifier, service_name, display_name, group_id) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (guid, 43 if group_id else 45, identifier, service, display_name, group_id),
        )
        cid = cur.lastrowid
        for m in members:
            conn.execute("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)", (cid, handles[m]))
        return cid

    alice_chat = chat("iMessage;-;" + ALICE, ALICE, "iMessage", None, None, [ALICE])
    bob_chat = chat("SMS;-;" + BOB, BOB, "SMS", None, None, [BOB])
    group_chat = chat("iMessage;+;chat493817265", "chat493817265", "iMessage",
                      "Weekend Hike", "8F3A2C1E-5B7D-4E9A-A0C2-1D6F7E8B9A01", [ALICE, CAROL, DAN])
    unknown_chat = chat("SMS;-;" + UNKNOWN_SMS, UNKNOWN_SMS, "SMS", None, None, [UNKNOWN_SMS])

    seq = [0]

    def msg(chat_id, sender, when, text, service="iMessage", attachment=False, recoverable=None):
        seq[0] += 1
        is_me = sender is None
        cur = conn.execute(
            "INSERT INTO message (guid, text, handle_id, service, date, date_read, is_from_me, "
            "is_read, cache_has_attachments) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
            (f"E2E-MSG-{seq[0]:04d}", text, 0 if is_me else handles[sender], service,
             apple_ns(when), apple_ns(when + 30), 1 if is_me else 0, 1 if attachment else 0),
        )
        mid = cur.lastrowid
        if chat_id is not None and recoverable is None:
            conn.execute("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
                         (chat_id, mid, apple_ns(when)))
        if recoverable is not None:
            conn.execute("INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (?, ?, ?)",
                         (chat_id, mid, apple_ns(recoverable)))
        return mid

    msg(alice_chat, ALICE, ts(2024, 3, 9, 20, 14), "Are we still on for the hike this weekend?")
    msg(alice_chat, None, ts(2024, 3, 9, 20, 16), "Yes! Saturday morning works for me.")
    msg(alice_chat, ALICE, ts(2024, 3, 9, 20, 17), "Perfect. I'll bring snacks")
    map_msg = msg(alice_chat, None, ts(2024, 3, 10, 9, 2), "Here's the trail map", attachment=True)
    msg(alice_chat, ALICE, ts(2024, 3, 10, 9, 5), "Looks great, see you at 7")
    msg(alice_chat, None, ts(2024, 3, 10, 9, 10), "This one was deleted",
        recoverable=ts(2024, 3, 12, 8, 0))

    msg(bob_chat, BOB, ts(2024, 3, 11, 9, 15), "Sorry I missed your call, in a meeting", service="SMS")
    msg(bob_chat, None, ts(2024, 3, 11, 9, 40), "No worries, talk later", service="SMS")

    msg(group_chat, CAROL, ts(2024, 3, 15, 18, 0), "Meet at the trailhead parking lot at 7am")
    msg(group_chat, DAN, ts(2024, 3, 15, 18, 2), "I can drive, have room for three")
    msg(group_chat, None, ts(2024, 3, 15, 18, 5), "Count me in")
    msg(group_chat, ALICE, ts(2024, 3, 15, 18, 6), "Same here!")

    msg(unknown_chat, UNKNOWN_SMS, ts(2024, 3, 16, 10, 5), "Your package has been delivered", service="SMS")

    # Orphaned: survives in `message` with no chat join (the Recover tab's other source).
    msg(None, BOB, ts(2024, 3, 1, 12, 0), "Orphaned message text", service="SMS")

    cur = conn.execute(
        "INSERT INTO attachment (guid, created_date, filename, uti, mime_type, transfer_name, total_bytes) "
        "VALUES (?, ?, ?, 'public.png', 'image/png', 'trail-map.png', ?)",
        ("E2E-ATT-0001", int(apple_s(ts(2024, 3, 10, 9, 2))), "~/" + ATTACHMENT_REL, len(ATTACHMENT_PNG)),
    )
    conn.execute("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)",
                 (map_msg, cur.lastrowid))


def build_call_history(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE ZCALLRECORD (
            Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZANSWERED INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER,
            ZFACE_TIME_DATA INTEGER, ZNUMBER_AVAILABILITY INTEGER,
            ZORIGINATED INTEGER, ZREAD INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT,
            ZADDRESS VARCHAR, ZDEVICE_ID VARCHAR, ZISO_COUNTRY_CODE VARCHAR,
            ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR,
            ZIS_VIDEO INTEGER
        );
    """)
    telephony = "com.apple.Telephony"
    facetime = "com.apple.FaceTime"
    calls = [
        # address, when, duration, originated, answered, provider, video
        (ALICE, ts(2024, 3, 10, 18, 5), 312.0, 1, 1, telephony, 0),
        (BOB, ts(2024, 3, 11, 9, 12), 0.0, 0, 0, telephony, 0),
        (CAROL, ts(2024, 3, 12, 20, 40), 734.0, 0, 1, telephony, 0),
        (ALICE, ts(2024, 3, 14, 19, 0), 1260.0, 1, 1, facetime, 1),
        # Missed call that Carol followed with a voicemail in the same minute —
        # the extractor must dedupe the voicemail's synthetic call against it.
        (CAROL, ts(2024, 3, 15, 12, 30, 5), 0.0, 0, 0, telephony, 0),
        (UNKNOWN_SMS, ts(2024, 3, 16, 10, 0), 45.0, 0, 1, telephony, 0),
    ]
    for i, (addr, when, dur, orig, ans, provider, video) in enumerate(calls, start=1):
        conn.execute(
            "INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, Z_OPT, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZREAD, "
            "ZDATE, ZDURATION, ZADDRESS, ZISO_COUNTRY_CODE, ZSERVICE_PROVIDER, ZUNIQUE_ID, ZIS_VIDEO) "
            "VALUES (?, 2, 1, ?, ?, ?, 1, ?, ?, ?, 'us', ?, ?, ?)",
            (i, ans, 16 if provider == facetime else 1, orig, apple_s(when), dur, addr,
             provider, f"E2E-CALL-{i:04d}", video),
        )


VOICEMAILS = [
    # rowid, sender, unix date, duration, flags (bit 0 = read), transcript
    (1, CAROL, ts(2024, 3, 15, 12, 30, 40), 38, 1,
     "Hi, it's Carol. Call me back about Saturday's hike."),
    (2, ACME, ts(2024, 3, 18, 8, 15), 21, 0,
     "This is Acme Dental confirming your cleaning on Thursday at 3pm."),
]


def build_voicemail(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE voicemail (
            ROWID INTEGER PRIMARY KEY AUTOINCREMENT, remote_uid INTEGER, date INTEGER,
            token TEXT, sender TEXT, callback_num TEXT, duration INTEGER,
            expiration INTEGER, trashed_date INTEGER, flags INTEGER, transcript TEXT
        );
    """)
    for rowid, sender, when, dur, flags, transcript in VOICEMAILS:
        conn.execute(
            "INSERT INTO voicemail (ROWID, remote_uid, date, token, sender, callback_num, duration, "
            "expiration, trashed_date, flags, transcript) VALUES (?, ?, ?, 'Complete', ?, ?, ?, 0, 0, ?, ?)",
            (rowid, 100 + rowid, int(when), sender, sender, dur, flags, transcript),
        )


def build_safari(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE history_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE,
            domain_expansion TEXT NULL, visit_count INTEGER NOT NULL,
            daily_visit_counts BLOB NOT NULL, weekly_visit_counts BLOB NULL,
            should_recompute_derived_visit_counts INTEGER NOT NULL
        );
        CREATE TABLE history_visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,
            visit_time REAL NOT NULL, title TEXT NULL,
            load_successful BOOLEAN NOT NULL DEFAULT 1,
            http_non_get BOOLEAN NOT NULL DEFAULT 0,
            synthesized BOOLEAN NOT NULL DEFAULT 0,
            redirect_source INTEGER NULL, redirect_destination INTEGER NULL,
            origin INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
            attributes INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0
        );
    """)
    items = [
        ("https://en.wikipedia.org/wiki/Big_Sur", "en.wikipedia", "Big Sur - Wikipedia",
         [ts(2024, 3, 9, 21, 0), ts(2024, 3, 12, 8, 0)]),
        ("https://www.nps.gov/pinn/index.htm", "nps", "Pinnacles National Park",
         [ts(2024, 3, 13, 22, 15)]),
        ("https://www.example.com/recipes/sourdough", "example", "Easy Sourdough Bread",
         [ts(2024, 3, 17, 16, 45)]),
    ]
    for url, dom, title, visits in items:
        cur = conn.execute(
            "INSERT INTO history_items (url, domain_expansion, visit_count, daily_visit_counts, "
            "should_recompute_derived_visit_counts) VALUES (?, ?, ?, x'', 0)",
            (url, dom, len(visits)),
        )
        for when in visits:
            conn.execute("INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)",
                         (cur.lastrowid, apple_s(when), title))


NOTES = [
    ("Grocery list", "Eggs, oat milk, sourdough bread, fresh basil, parmesan",
     ts(2024, 3, 2, 10, 0), ts(2024, 3, 17, 9, 30)),
    ("Trip ideas", "Big Sur in October. Check campsite availability at Pfeiffer and Kirk Creek.",
     ts(2024, 2, 20, 21, 0), ts(2024, 3, 13, 22, 20)),
    ("Book club picks", "The Overstory, Braiding Sweetgrass, A Psalm for the Wild-Built",
     ts(2024, 1, 5, 19, 0), ts(2024, 1, 5, 19, 10)),
]


def build_notestore(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE ZICCLOUDSYNCINGOBJECT (
            Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZMARKEDFORDELETION INTEGER, ZFOLDER INTEGER, ZNOTEDATA INTEGER,
            ZCREATIONDATE TIMESTAMP, ZCREATIONDATE1 TIMESTAMP,
            ZMODIFICATIONDATE1 TIMESTAMP, ZSNIPPET VARCHAR,
            ZTITLE1 VARCHAR, ZTITLE2 VARCHAR, ZIDENTIFIER VARCHAR
        );
        CREATE TABLE ZICNOTEDATA (
            Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZNOTE INTEGER, ZDATA BLOB
        );
    """)
    # Folder row: ZTITLE1 is NULL so the extractor must skip it.
    conn.execute("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, Z_OPT, ZTITLE2, ZIDENTIFIER) "
                 "VALUES (1, 14, 1, 'Notes', 'DefaultFolder-CloudKit')")
    for i, (title, body, created, modified) in enumerate(NOTES):
        note_pk = 10 + i
        data_pk = 100 + i
        conn.execute(
            "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, Z_OPT, ZMARKEDFORDELETION, ZFOLDER, "
            "ZNOTEDATA, ZCREATIONDATE, ZCREATIONDATE1, ZMODIFICATIONDATE1, ZSNIPPET, ZTITLE1, ZIDENTIFIER) "
            "VALUES (?, 12, 1, 0, 1, ?, ?, ?, ?, ?, ?, ?)",
            (note_pk, data_pk, apple_s(created), apple_s(created), apple_s(modified),
             body[:40], title, f"E2E-NOTE-{i:04d}"),
        )
        conn.execute("INSERT INTO ZICNOTEDATA (Z_PK, Z_ENT, Z_OPT, ZNOTE, ZDATA) VALUES (?, 11, 1, ?, ?)",
                     (data_pk, note_pk, make_note_blob(f"{title}\n{body}")))


PHOTOS = [
    # filename, colour, created, favorite, (lat, lon), in Vacation album, trashed
    ("IMG_0001.PNG", (220, 120, 60), ts(2024, 3, 16, 7, 45), 1, (36.2704, -121.8081), True, 0),
    ("IMG_0002.PNG", (70, 130, 180), ts(2024, 3, 16, 9, 10), 0, (36.2365, -121.7760), True, 0),
    ("IMG_0003.PNG", (240, 200, 80), ts(2024, 3, 17, 16, 50), 0, None, False, 0),
    ("IMG_0004.PNG", (128, 128, 128), ts(2024, 3, 18, 12, 0), 0, None, False, 1),
]
PHOTO_DIR = "100APPLE"


def build_photos(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
        CREATE TABLE ZASSET (
            Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZUUID VARCHAR, ZDIRECTORY VARCHAR, ZFILENAME VARCHAR, ZKIND INTEGER,
            ZDATECREATED TIMESTAMP, ZDATEMODIFIED TIMESTAMP,
            ZWIDTH INTEGER, ZHEIGHT INTEGER, ZDURATION FLOAT,
            ZFAVORITE INTEGER, ZHIDDEN INTEGER, ZHASADJUSTMENTS INTEGER,
            ZBURSTUUID VARCHAR, ZLATITUDE FLOAT, ZLONGITUDE FLOAT,
            ZTRASHEDSTATE INTEGER
        );
        CREATE TABLE ZGENERICALBUM (
            Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER,
            ZKIND INTEGER, ZTITLE VARCHAR, ZUUID VARCHAR
        );
        CREATE TABLE Z_28ASSETS (Z_28ALBUMS INTEGER, Z_3ASSETS INTEGER, Z_FOK_3ASSETS INTEGER,
                                 PRIMARY KEY (Z_28ALBUMS, Z_3ASSETS));
    """)
    conn.executemany("INSERT INTO Z_PRIMARYKEY VALUES (?, ?, 0, ?)",
                     [(3, "Asset", len(PHOTOS)), (28, "GenericAlbum", 1)])
    conn.execute("INSERT INTO ZGENERICALBUM VALUES (1, 28, 1, 2, 'Vacation', 'E2E-ALBUM-VACATION')")
    for i, (name, _rgb, created, fav, loc, in_album, trashed) in enumerate(PHOTOS, start=1):
        lat, lon = loc if loc else (None, None)
        conn.execute(
            "INSERT INTO ZASSET VALUES (?, 3, 1, ?, ?, ?, 0, ?, ?, 64, 48, 0, ?, 0, 0, NULL, ?, ?, ?)",
            (i, f"E2E-ASSET-{i:04d}", PHOTO_DIR, name, apple_s(created), apple_s(created),
             fav, lat, lon, trashed),
        )
        if in_album:
            conn.execute("INSERT INTO Z_28ASSETS VALUES (1, ?, ?)", (i, i))


# ── Plists ────────────────────────────────────────────────────────────────────

def write_plists(backup_dir: str, udid: str, device_name: str, encrypted: bool) -> None:
    with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
        plistlib.dump({
            "Unique Identifier": udid.upper(),
            "Device Name": device_name,
            "Display Name": device_name,
            "Product Type": "iPhone14,2",
            "Product Version": "17.0",
            "Serial Number": "E2ETEST0001",
            "Phone Number": "+1 (415) 555-0100",
            "Last Backup Date": datetime(2024, 3, 20, 12, 0, 0),
            "iTunes Version": "12.0",
        }, f)
    with open(os.path.join(backup_dir, "Manifest.plist"), "wb") as f:
        plistlib.dump({
            "IsEncrypted": encrypted,
            "Version": "10.0",
            "Date": datetime(2024, 3, 20, 12, 0, 0),
            "SystemDomainsVersion": "20.0",
            "WasPasscodeSet": encrypted,
        }, f)


# ── Expected values (read by the E2E specs) ───────────────────────────────────

EXPECTED = {
    "udid": BACKUP_UDID.upper(),
    "device_name": "E2E Test iPhone",
    "contacts": ["Alice Chen", "Bob Martinez", "Carol Okafor", "Dan Whitfield", "Acme Dental"],
    "conversations": {
        "Alice Chen": 5,
        "Bob Martinez": 2,
        "Weekend Hike": 4,
        UNKNOWN_SMS: 1,
    },
    "total_messages": 12,
    "search": {"query": "trailhead", "text": "Meet at the trailhead parking lot at 7am"},
    "attachment": {"conversation": "Alice Chen", "transfer_name": "trail-map.png",
                   "bytes": len(ATTACHMENT_PNG)},
    # 6 call records + 1 synthetic call from the Acme voicemail. Carol's voicemail
    # lands in the same minute as her missed call and must be deduped.
    "total_calls": 7,
    "facetime_calls": 1,
    "notes": [n[0] for n in NOTES],
    "note_body_fragment": "campsite availability at Pfeiffer",
    "photos": [p[0] for p in PHOTOS if not p[6]],
    "trashed_photo": PHOTOS[3][0],
    "album": {"title": "Vacation", "count": 2},
    "voicemails": {"Carol Okafor": VOICEMAILS[0][5], "Acme Dental": VOICEMAILS[1][5]},
    "browser_titles": ["Big Sur - Wikipedia", "Pinnacles National Park", "Easy Sourdough Bread"],
    "browser_visits": 4,
    "recently_deleted": "This one was deleted",
    "orphaned": "Orphaned message text",
}


# ── Entry point ───────────────────────────────────────────────────────────────

def build_populated_backup() -> None:
    if os.path.exists(FIXTURE_ROOT):
        shutil.rmtree(FIXTURE_ROOT)
    os.makedirs(BACKUP_DIR)
    w = BackupWriter(BACKUP_DIR)

    w.add_sqlite("HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", build_address_book)
    w.add_sqlite("HomeDomain", "Library/SMS/sms.db", build_sms)
    w.add_bytes("MediaDomain", ATTACHMENT_REL, ATTACHMENT_PNG)
    w.add_sqlite("HomeDomain", "Library/CallHistoryDB/CallHistory.storedata", build_call_history)
    w.add_sqlite("HomeDomain", "Library/Voicemail/voicemail.db", build_voicemail)
    for rowid, _s, _w, dur, _f, _t in VOICEMAILS:
        w.add_bytes("HomeDomain", f"Library/Voicemail/{rowid}.amr", make_amr(min(dur, 3)))
    w.add_sqlite("HomeDomain", "Library/Safari/History.db", build_safari)
    w.add_sqlite("AppDomainGroup-group.com.apple.notes", "NoteStore.sqlite", build_notestore)
    w.add_sqlite("CameraRollDomain", "Media/PhotoData/Photos.sqlite", build_photos)
    for name, rgb, *_ in PHOTOS:
        w.add_bytes("CameraRollDomain", f"Media/DCIM/{PHOTO_DIR}/{name}", make_png(64, 48, rgb))

    w.write_manifest()
    write_plists(BACKUP_DIR, BACKUP_UDID, EXPECTED["device_name"], encrypted=False)

    with open(os.path.join(FIXTURE_ROOT, "expected.json"), "w", encoding="utf-8") as f:
        json.dump(EXPECTED, f, indent=2)


def build_encrypted_backup() -> None:
    # Only the encrypted flag is real — enough to drive the password prompt.
    # A genuinely decryptable fixture needs keybag generation (future work).
    if os.path.exists(ENCRYPTED_FIXTURE_ROOT):
        shutil.rmtree(ENCRYPTED_FIXTURE_ROOT)
    os.makedirs(ENCRYPTED_DIR)
    BackupWriter(ENCRYPTED_DIR).write_manifest()
    write_plists(ENCRYPTED_DIR, ENCRYPTED_UDID, "E2E Encrypted iPhone", encrypted=True)


def main() -> None:
    build_populated_backup()
    print(f"Wrote populated fixture to {BACKUP_DIR}")
    build_encrypted_backup()
    print(f"Wrote encrypted fixture to {ENCRYPTED_DIR}")


if __name__ == "__main__":
    main()
