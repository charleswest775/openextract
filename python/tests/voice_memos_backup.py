"""A backup with Voice Memos in it, for the engine's tests.

CloudRecordings.db is built with backupgen's sqlitegen from the table
definitions ios-backup-core harvested (Apple's iOS 26.5 model, and a real
iOS 13.4.1 backup's), so the columns are the real ones; the recordings are
backupgen's silent .m4a files, tagged and with a transcript where a test
needs one. Every recording is invented.

Two layouts, as the Voice Memos app has used them:

  * ``ios26``: the app group ``AppDomainGroup-group.com.apple.VoiceMemos.shared``,
    ``Recordings/``, with favourites, folders and transcripts;
  * ``ios13``: ``MediaDomain``, ``Media/Recordings/``, with none of those
    (no ZSHAREDFLAGS, no ZFOLDER: favourites read as unknown).

The test library holds the cases that matter:

  * a recording in a folder, a favourite, with a transcript (iOS 26 layout);
  * a title starting with ``=`` (a CSV must not let a spreadsheet run it),
    one with ``/`` and ``:`` (a file name can't hold them), one stored as a
    BLOB (it must come back as text, never raw bytes), and one with no title;
  * two recordings with the same title in the same minute (a save names the
    second "(2)");
  * one in Recently Deleted, one kept in iCloud only (no file), and a layered
    recording (a QuickTime .qta file);
  * ZPATH as a bare name, as a full device path, and NULL (found by the
    "<date>-<first 8 of its id>" name).

``Scenario`` says what the engine should read back.
"""

from __future__ import annotations

import importlib
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import whatsapp_backup as wb  # noqa: E402

SHARED_DOMAIN = "AppDomainGroup-group.com.apple.VoiceMemos.shared"
MEDIA_DOMAIN = "MediaDomain"
DATABASE = "CloudRecordings.db"
# layout -> (harvested schema, domain, folder)
LAYOUTS = {"ios26": ("26.5", SHARED_DOMAIN, "Recordings"), "ios13": ("13.4.1", MEDIA_DOMAIN, "Media/Recordings")}
LIBRARY = (SHARED_DOMAIN, f"Recordings/{DATABASE}")
LEGACY_LIBRARY = (MEDIA_DOMAIN, "Media/Recordings/Recordings.db")

PLAIN_UDID = "00008120-0000000000A0D10A"
ENCRYPTED_UDID = "00008030-0000000000A0D10B"
PASSWORD = "test"
DEVICE_NAME = "Voice Memos test iPhone"

PLAYABLE, NEEDS_DOWNLOAD, HAS_TRANSCRIPT, LAYERED = 0x4, 0x2, 0x200 | 0x400, 0x800
FAVORITE = 0x1

_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

# The recordings (Z_PK), the ids the app asks for.
SITE_WALK, FORMULA, SLASHES, TWIN_A, TWIN_B, DELETED, ICLOUD, UNTITLED, BLOB, LAYERED_MEMO = range(1, 11)

FOLDER_NAME = "Site visits"
FOLDER_UUID = "0F0F0F0F-1111-4222-8333-444455556666"
FORMULA_TITLE = "=SUM(A1) idea"
SLASH_TITLE = "Plans / sketches: v2"
TWIN_TITLE = "Twin take"
BLOB_TITLE = "Kitchen idea"
TRANSCRIPT = [("Two", 0.5, 0.8), (" oaks", 0.8, 1.2), (" by", 1.2, 1.4), (" the", 1.4, 1.6), (" gate.", 1.6, 2.1)]
TRANSCRIPT_TEXT = "Two oaks by the gate."


def apple(dt: datetime) -> float:
    return (dt - _APPLE_EPOCH).total_seconds()


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _at(year, month, day, hour, minute, second=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


# (pk, title, recorded, seconds, flags, favorite, folder, deleted, path form, extension)
# path form: "name" (ZPATH is the file's name), "device" (a full device path), None (NULL), "icloud" (no file)
_RECORDINGS = [
    (SITE_WALK, "Site walk", _at(2025, 5, 13, 21, 15, 22), 83.4, PLAYABLE | HAS_TRANSCRIPT, True, True, None,
     "name", "m4a"),
    (FORMULA, FORMULA_TITLE, _at(2025, 6, 1, 8, 0, 5), 12.0, PLAYABLE, False, False, None, None, "m4a"),
    (SLASHES, SLASH_TITLE, _at(2025, 6, 2, 9, 30, 0), 20.0, PLAYABLE, False, False, None, "device", "m4a"),
    (TWIN_A, TWIN_TITLE, _at(2025, 6, 3, 17, 45, 10), 5.0, PLAYABLE, False, False, None, "name", "m4a"),
    (TWIN_B, TWIN_TITLE, _at(2025, 6, 3, 17, 45, 40), 6.0, PLAYABLE, False, False, None, "name", "m4a"),
    (DELETED, "Old draft", _at(2025, 4, 2, 12, 0, 0), 9.0, PLAYABLE, False, False, _at(2025, 6, 20, 10, 0),
     "name", "m4a"),
    (ICLOUD, "Permit call", _at(2025, 3, 3, 15, 0, 0), 300.0, NEEDS_DOWNLOAD, False, False, None, "icloud", None),
    (UNTITLED, None, _at(2025, 2, 14, 7, 5, 0), 3.0, PLAYABLE, False, False, None, "name", "m4a"),
    (BLOB, BLOB_TITLE, _at(2025, 1, 9, 19, 20, 0), 4.0, PLAYABLE, True, False, None, "name", "m4a"),
    (LAYERED_MEMO, "Song sketch", _at(2024, 12, 30, 22, 10, 0), 7.0, PLAYABLE | LAYERED, False, False, None,
     "name", "qta"),
]


@dataclass
class Scenario:
    layout: str                                     # "ios26" or "ios13"
    domain: str = ""
    folder: str = ""
    memos: dict = field(default_factory=dict)       # id -> what list_voice_memos returns for it (a subset)
    audio: dict = field(default_factory=dict)       # id -> the audio file's bytes
    paths: dict = field(default_factory=dict)       # id -> (domain, relative path) of its audio file
    files: dict = field(default_factory=dict)       # (domain, relative path) -> bytes
    folders: list = field(default_factory=list)     # what list_voice_memos returns as folders

    def newest_first(self, ids=None) -> list:
        ids = self.memos if ids is None else ids
        return sorted(ids, key=lambda i: (self.memos[i]["date"], i), reverse=True)

    @property
    def available(self) -> set:
        return {i for i, m in self.memos.items() if m["audio_available"]}

    @property
    def kept(self) -> set:
        """Not in Recently Deleted: what the home screen counts."""
        return {i for i, m in self.memos.items() if not m["is_deleted"]}

    @property
    def kept_seconds(self) -> int:
        return int(round(sum(self.memos[i]["duration_seconds"] for i in self.kept)))


def _uuid(pk: int) -> str:
    return f"{0xA0B0C0D0 + pk:08X}-1234-4ABC-8DEF-{pk:012X}"


def _file_name(recorded: datetime, unique_id: str, ext: str) -> str:
    return f"{recorded:%Y%m%d %H%M%S}-{unique_id[:8]}.{ext}"


def _backupgen_media():
    _, _ = wb._backupgen()
    from backupgen import media

    return media


def _populate(layout: str, s: Scenario, db) -> None:
    media = _backupgen_media()
    recordings = db.table("ZCLOUDRECORDING")
    folders = db.table("ZFOLDER")
    has_shared = recordings.has("ZSHAREDFLAGS")
    if folders is not None:
        folders.insert({"Z_PK": 1, "Z_ENT": 3, "Z_OPT": 1, "ZCOUNTOFRECORDINGS": 1, "ZRANK": 0,
                        "ZENCRYPTEDNAME": FOLDER_NAME, "ZUUID": FOLDER_UUID})
        s.folders = [{"id": FOLDER_UUID, "name": FOLDER_NAME, "rank": 0, "count": 1}]
    for pk, title, recorded, seconds, flags, favorite, in_folder, deleted, form, ext in _RECORDINGS:
        transcript = TRANSCRIPT if flags & HAS_TRANSCRIPT and layout == "ios26" else None
        if layout == "ios13":
            flags &= ~(HAS_TRANSCRIPT | LAYERED)
            if form == "icloud":
                flags = NEEDS_DOWNLOAD
        unique_id = _uuid(pk)
        duration = media.m4a_duration(seconds)
        name = None if form == "icloud" else _file_name(recorded, unique_id, ext)
        zpath = {"name": name, "device": f"/var/mobile/Media/Recordings/{name}", None: None, "icloud": None}[form]
        stored_title = title.encode("utf-8") if pk == BLOB else title
        row = {"Z_PK": pk, "Z_ENT": 2, "Z_OPT": 1, "ZFLAGS": flags, "ZDATE": apple(recorded), "ZDURATION": duration,
               "ZLOCALDURATION": 0.0 if form == "icloud" else duration, "ZCUSTOMLABEL": stored_title,
               "ZCUSTOMLABELFORSORTING": stored_title, "ZENCRYPTEDTITLE": stored_title, "ZPATH": zpath,
               "ZUNIQUEID": unique_id, "ZEVICTIONDATE": apple(deleted) if deleted else None,
               "ZSHAREDFLAGS": FAVORITE if favorite else 0,
               "ZFOLDER": 1 if in_folder and folders is not None else None}
        recordings.insert(row)
        if name:
            data = media.silent_m4a(seconds, int(recorded.timestamp()), title=title, unique_id=unique_id,
                                    transcript=transcript)
            path = (s.domain, f"{s.folder}/{name}")
            s.files[path] = data
            s.audio[pk] = data
            s.paths[pk] = path
        s.memos[pk] = {
            "unique_id": unique_id, "title": title, "date": iso(recorded), "duration_seconds": duration,
            "folder": FOLDER_NAME if in_folder and folders is not None else None,
            "folder_id": FOLDER_UUID if in_folder and folders is not None else None,
            "is_favorite": bool(favorite) if has_shared else None,
            "is_deleted": deleted is not None, "deleted_date": iso(deleted) if deleted else None,
            "in_phone_list": True, "has_transcript": bool(transcript),
            "is_layered": bool(flags & LAYERED),
            "file_name": name, "format": ext, "audio_available": name is not None,
            "audio_missing_reason": "in_icloud_only" if form == "icloud" else None,
            "source": DATABASE,
        }


def build(workdir: Path, layout: str = "ios26") -> Scenario:
    """The test library in ``workdir``; the Scenario holds its files and what should be read back."""
    _, sqlitegen = wb._backupgen()
    schema, domain, folder = LAYOUTS[layout]
    s = Scenario(layout=layout, domain=domain, folder=folder)
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    data = sqlitegen.build(workdir / f"{DATABASE}-{layout}", schema, DATABASE, lambda db: _populate(layout, s, db))
    s.files = {(domain, f"{folder}/{DATABASE}"): data, **s.files}
    return s


def empty_library(workdir: Path, layout: str = "ios26") -> bytes:
    """CloudRecordings.db with its tables but no recordings."""
    _, sqlitegen = wb._backupgen()
    schema = LAYOUTS[layout][0]
    Path(workdir).mkdir(parents=True, exist_ok=True)
    return sqlitegen.build(Path(workdir) / f"{DATABASE}-empty-{layout}", schema, DATABASE, lambda db: None)


def legacy_library(workdir: Path) -> tuple[dict, dict]:
    """An old phone's Recordings.db (table ZRECORDING, the iOS 13 column set) with two recordings, one
    with its file: (files, id -> what list_voice_memos returns for it)."""
    media = _backupgen_media()
    path = Path(workdir) / "Recordings.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE ZRECORDING (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, "
                     "ZITUNESPERSISTENTID INTEGER, ZLABELPRESET INTEGER, ZPENDINGRESTORE INTEGER, "
                     "ZRECORDINGID INTEGER, ZSYNCED INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZCUSTOMLABEL VARCHAR, "
                     "ZPATH VARCHAR, ZUNIQUEID VARCHAR)")
        recorded = _at(2016, 8, 1, 10, 0)
        name = "20160801 100000.m4a"
        conn.execute("INSERT INTO ZRECORDING (Z_PK, Z_ENT, Z_OPT, ZDATE, ZDURATION, ZCUSTOMLABEL, ZPATH) "
                     "VALUES (1, 1, 1, ?, 4.0, 'Old phone memo', ?)", (apple(recorded), f"/var/mobile/Media/Recordings/{name}"))
        conn.execute("INSERT INTO ZRECORDING (Z_PK, Z_ENT, Z_OPT, ZDATE, ZDURATION, ZCUSTOMLABEL, ZPATH) "
                     "VALUES (2, 1, 1, ?, 2.0, 'Gone memo', '20160802 090000.m4a')", (apple(recorded + timedelta(days=1)),))
        conn.commit()
    finally:
        conn.close()
    files = {LEGACY_LIBRARY: path.read_bytes(),
             (MEDIA_DOMAIN, f"Media/Recordings/{name}"): media.silent_m4a(4.0, int(recorded.timestamp()))}
    expected = {
        1: {"title": "Old phone memo", "date": iso(recorded), "audio_available": True, "file_name": name,
            "is_favorite": None, "folder": None, "source": "Recordings.db"},
        2: {"title": "Gone memo", "date": iso(recorded + timedelta(days=1)), "audio_available": False,
            "audio_missing_reason": "not_in_backup", "source": "Recordings.db"},
    }
    return files, expected


def library_problem() -> Optional[str]:
    """Why the Voice Memos tests can't build or read a library here, or None when they can."""
    try:
        module = importlib.import_module("ios_backup_core.extractors.voice_memos")
    except ImportError:
        module = None
    if module is None or not hasattr(module, "VoiceMemoExtractor"):
        return ("this ios-backup-core has no Voice Memos extractor; set PYTHONPATH to a checkout that has it")
    root = wb.backupgen_root()
    if root is None:
        return "ios-backup-core's backupgen wasn't found; set OPENEXTRACT_IOS_BACKUP_CORE"
    for schema, _, _ in LAYOUTS.values():
        if not (root / "backupgen" / "schemas" / f"ios-{schema}" / f"{DATABASE}.json").is_file():
            return f"the ios-backup-core checkout at {root} has no harvested {DATABASE} schema for iOS {schema}"
    try:
        _backupgen_media().silent_m4a
    except (ImportError, AttributeError):
        return f"the ios-backup-core checkout at {root} has no backupgen.media.silent_m4a; update it"
    return None


# ── Backups ──────────────────────────────────────────────────────────────────

def make_minimal(dest: Path, files: dict, udid: str = PLAIN_UDID) -> Path:
    """A bare plain backup holding only ``files`` ((domain, relative path) -> bytes)."""
    return wb.make_minimal_plain(dest, files, udid)


def make_einstein_copy(source: Path, dest: Path, scenario, udid: str = PLAIN_UDID,
                       device_name: str = DEVICE_NAME) -> Path:
    """A copy of an unencrypted backup (Einstein's) with the scenario's files added, under a new UDID."""
    return wb.make_plain_copy(source, dest, scenario, udid=udid, device_name=device_name)


def make_encrypted(out_parent: Path, scenario, password: str = PASSWORD, udid: str = ENCRYPTED_UDID) -> Path:
    """A new encrypted backup holding only the scenario's files (backupgen's BackupWriter); returns its folder."""
    container, _ = wb._backupgen()
    device = container.Device(name=DEVICE_NAME, product_type="iPhone15,2", product_name="iPhone 14 Pro",
                              ios="26.5", build="23F77", phone_number="+1 202 555 0100", udid=udid)
    writer = container.BackupWriter(Path(out_parent), device, datetime(2025, 7, 2, tzinfo=timezone.utc),
                                    wb.SCHEMA_VERSION, password=password, seed=13)
    for (domain, rel), data in scenario.files.items():
        writer.add_file(domain, rel, data)
    return writer.finalize()
