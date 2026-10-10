"""Unit tests for the corpus tooling. They run in the normal PR job and need no downloaded data."""

import hashlib
import http.server
import io
import json
import plistlib
import tarfile
import threading
import zipfile
from pathlib import Path

import pytest

from corpus import remote
from corpus.facts import ExtractedData, evaluate, load_facts, normalize_phone, phone_sha256, text_sha256
from corpus.fetch import HashMismatch, ManualFetchRequired, fetch_item, is_fetched
from corpus.manifest import FACTS_DIR, Fetch, Item, ManifestError, load_manifest
from sidecar_client import SidecarClient, SidecarError

UDID = "0123456789abcdef0123456789abcdef01234567"


# ── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def http_root(tmp_path):
    """A local HTTP server with Range support, serving files from a temp folder."""
    root = tmp_path / "www"
    root.mkdir()
    ranges: list[str] = []
    drops: dict[str, int] = {}  # file name → how many responses to cut off halfway

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self._respond(send_body=False)

        def do_GET(self):
            self._respond(send_body=True)

        def _respond(self, send_body):
            path = root / self.path.lstrip("/")
            if not path.is_file():
                self.send_error(404)
                return
            data = path.read_bytes()
            requested = self.headers.get("Range")
            if requested:
                ranges.append(requested)
                start_text, _, end_text = requested.removeprefix("bytes=").partition("-")
                start = int(start_text)
                end = int(end_text) if end_text else len(data) - 1
                if start >= len(data):
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{len(data)}")
                    self.end_headers()
                    return
                body = data[start:end + 1]
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{start + len(body) - 1}/{len(data)}")
            else:
                body = data
                self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            if not send_body:
                return
            if drops.get(path.name, 0) > 0 and len(body) > 1:
                drops[path.name] -= 1
                self.wfile.write(body[: len(body) // 2])  # then hang up mid-body
                self.close_connection = True
                return
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield root, f"http://127.0.0.1:{server.server_address[1]}", ranges, drops
    server.shutdown()
    server.server_close()


def _backup_zip_bytes() -> bytes:
    """A zip holding a minimal backup folder, the way creators publish them."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{UDID}/Manifest.plist", plistlib.dumps({"IsEncrypted": False, "Version": "10.0"}))
        zf.writestr(f"{UDID}/Info.plist", plistlib.dumps({"Unique Identifier": UDID, "Product Version": "17.0"}))
        zf.writestr(f"{UDID}/ab/ab12", b"x" * 5000)
    return buffer.getvalue()


def _item(fetch: Fetch, **overrides) -> Item:
    fields = dict(
        key="test-item", layer="pub", ios="17.0", build=None, product_type=None, host="finder",
        encrypted=False, password=None, udid=UDID, fetch=fetch, creator="test", source_page="https://example.com",
        terms="test", verified="read",
    )
    fields.update(overrides)
    return Item(**fields)


# ── manifest and facts files ─────────────────────────────────────────────────


def test_manifest_is_valid():
    items = load_manifest()
    assert "pub-hickman-15.3.1" in items
    for item in items.values():
        if item.tiers:
            assert item.fetch.sha256, f"{item.key} runs in a tier, so its SHA-256 must be pinned"
            assert item.fetch.method != "manual", f"{item.key} runs in a tier, so it must be fetchable unattended"
        if item.encrypted and item.password:
            assert item.password_source, f"{item.key}: say where the password was published"


@pytest.mark.parametrize("change, message", [
    (lambda item: item["fetch"].update(method="ftp"), "unknown method"),
    (lambda item: item["fetch"].update(sha256="ABC"), "sha256"),
    (lambda item: item.update(layer="other"), "unknown layer"),
    (lambda item: item["fetch"].pop("url"), "missing 'url'"),
    (lambda item: item.update(tiers=["hourly"]), "unknown tiers"),
])
def test_manifest_rejects_bad_entries(tmp_path, change, message):
    item = {
        "key": "x", "layer": "pub", "ios": "17.0", "host": "finder", "encrypted": False,
        "fetch": {"method": "direct", "url": "https://example.com/x.zip", "artifact": "x.zip", "archive": "zip"},
        "creator": "c", "source_page": "https://example.com", "terms": "t", "verified": "read",
    }
    change(item)
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"schema_version": 1, "items": [item]}))
    with pytest.raises(ManifestError, match=message):
        load_manifest(path)


def test_manifest_rejects_duplicate_keys(tmp_path):
    item = {
        "key": "x", "layer": "pub", "ios": "17.0", "host": "finder", "encrypted": False,
        "fetch": {"method": "direct", "url": "https://example.com/x.zip", "artifact": "x.zip", "archive": "zip"},
        "creator": "c", "source_page": "https://example.com", "terms": "t", "verified": "read",
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"schema_version": 1, "items": [item, item]}))
    with pytest.raises(ManifestError, match="duplicate"):
        load_manifest(path)


def test_facts_files_are_valid():
    items = load_manifest()
    paths = sorted(FACTS_DIR.glob("*.json"))
    assert paths, "expected at least one facts file"
    for path in paths:
        facts = load_facts(path)
        assert facts.item in items, f"{path.name} refers to unknown item {facts.item}"
        assert path.stem == facts.item


# ── normalization and fact evaluation ────────────────────────────────────────


def test_text_hash_ignores_quotes_case_and_spacing():
    assert text_sha256("It’s  done.\n") == text_sha256("it's done.")
    assert text_sha256("Hello") != text_sha256("Hello!")


def test_phone_normalization():
    assert normalize_phone("+1 (555) 555-0100") == "5555550100"
    assert normalize_phone(22000) == "22000"
    assert phone_sha256("555-555-0100") == phone_sha256("+15555550100")


def _facts(tmp_path, facts) -> dict:
    path = tmp_path / "test-item.json"
    path.write_text(json.dumps({
        "schema_version": 1, "item": "test-item", "source_utc_offset": "-04:00",
        "defaults": {"time_tolerance_s": 120}, "facts": facts,
    }))
    return load_facts(path).by_id()


def test_message_facts(tmp_path):
    facts = _facts(tmp_path, [
        {"id": "sent", "kind": "message", "source_ref": "log", "at": "2023-05-09T20:03",
         "expect": {"is_from_me": True, "text_sha256": text_sha256("Hello there")}},
        {"id": "gone", "kind": "message_absent", "source_ref": "log", "expect": {"text_sha256": text_sha256("deleted")}},
    ])
    data = ExtractedData(messages=[
        {"date": "2023-05-10T00:03:40+00:00", "is_from_me": True, "text": "hello  there", "attachments": []},
    ])
    assert evaluate(facts["sent"], data)[0]
    assert evaluate(facts["gone"], data)[0]
    late = ExtractedData(messages=[{**data.messages[0], "date": "2023-05-10T00:10:00+00:00"}])
    ok, detail = evaluate(facts["sent"], late)
    assert not ok and "no message" in detail
    assert not evaluate(facts["gone"], ExtractedData(messages=[{"date": None, "text": "Deleted"}]))[0]


def test_fact_reports_extraction_errors(tmp_path):
    facts = _facts(tmp_path, [{"id": "c", "kind": "call", "source_ref": "log", "at": "2023-05-09T20:39", "expect": {}}])
    ok, detail = evaluate(facts["c"], ExtractedData(errors={"calls": "list_calls: boom"}))
    assert not ok and "boom" in detail


def test_browser_absence_window(tmp_path):
    facts = _facts(tmp_path, [{
        "id": "private", "kind": "browser_visit_absent", "source_ref": "log",
        "window": ["2023-05-10T10:16", "2023-05-10T10:27"], "expect": {"domain_suffix": "example.org"},
    }])
    outside = ExtractedData(visits=[{"domain": "www.example.org", "visit_date": "2023-05-10T15:00:00+00:00"}])
    inside = ExtractedData(visits=[{"domain": "www.example.org", "visit_date": "2023-05-10T14:20:00+00:00"}])
    assert evaluate(facts["private"], outside)[0]
    assert not evaluate(facts["private"], inside)[0]


# ── remote access ────────────────────────────────────────────────────────────


def test_download_resumes_with_a_range_request(http_root, tmp_path):
    root, base, ranges, _ = http_root
    payload = bytes(range(256)) * 400
    (root / "file.bin").write_bytes(payload)
    dest = tmp_path / "out" / "file.bin"
    dest.parent.mkdir()
    (dest.parent / "file.bin.part").write_bytes(payload[:1000])
    remote.download(f"{base}/file.bin", dest, expected_size=len(payload))
    assert dest.read_bytes() == payload
    assert ranges == ["bytes=1000-"]


def test_zip_member_over_http_downloads_only_that_member(http_root, tmp_path):
    root, base, ranges, _ = http_root
    inner = _backup_zip_bytes()
    with zipfile.ZipFile(root / "outer.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Extraction/huge.bin", b"\0" * 300_000)
        zf.writestr("Extraction/iTunes Backup/backup.zip", inner)
    dest = remote.extract_zip_member(f"{base}/outer.zip", "Extraction/iTunes Backup/backup.zip", tmp_path / "b.zip")
    assert dest.read_bytes() == inner
    assert ranges, "expected range requests"


def test_zip_member_missing_names_alternatives(tmp_path):
    with zipfile.ZipFile(tmp_path / "outer.zip", "w") as zf:
        zf.writestr("a/backup.zip", b"x")
    with pytest.raises(remote.FetchError, match="Did you mean"):
        remote.extract_zip_member(str(tmp_path / "outer.zip"), "b/backup.zip", tmp_path / "out.zip")


@pytest.mark.parametrize("over_http", [False, True])
def test_targz_member(http_root, tmp_path, over_http):
    root, base, _, _ = http_root
    inner = _backup_zip_bytes()
    with tarfile.open(root / "image.tar.gz", "w:gz") as tf:
        for name, data in [("iOS_17/Backup/backup.zip", inner), ("iOS_17/Extraction/ffs.tar", b"\0" * 50_000)]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    src = f"{base}/image.tar.gz" if over_http else str(root / "image.tar.gz")
    dest = remote.extract_targz_member(src, "iOS_17/Backup/backup.zip", tmp_path / "out.zip")
    assert dest.read_bytes() == inner


@pytest.fixture
def no_backoff(monkeypatch):
    monkeypatch.setattr(remote.time, "sleep", lambda seconds: None)


def test_download_survives_dropped_connections(http_root, tmp_path, no_backoff):
    root, base, ranges, drops = http_root
    payload = bytes(range(256)) * 400
    (root / "file.bin").write_bytes(payload)
    drops["file.bin"] = 2
    dest = remote.download(f"{base}/file.bin", tmp_path / "file.bin", expected_size=len(payload))
    assert dest.read_bytes() == payload
    assert len(ranges) == 2, "each reconnect should resume with a Range request"


def test_zip_member_survives_dropped_connections(http_root, tmp_path, no_backoff):
    root, base, _, drops = http_root
    inner = _backup_zip_bytes()
    with zipfile.ZipFile(root / "outer.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Extraction/huge.bin", bytes(range(256)) * 2000)
        zf.writestr("Extraction/iTunes Backup/backup.zip", inner)
    drops["outer.zip"] = 3
    dest = remote.extract_zip_member(f"{base}/outer.zip", "Extraction/iTunes Backup/backup.zip", tmp_path / "b.zip")
    assert dest.read_bytes() == inner


def test_targz_stream_survives_dropped_connections(http_root, tmp_path, no_backoff):
    root, base, _, drops = http_root
    inner = _backup_zip_bytes()
    with tarfile.open(root / "image.tar.gz", "w:gz") as tf:
        info = tarfile.TarInfo("iOS_17/Backup/backup.zip")
        info.size = len(inner)
        tf.addfile(info, io.BytesIO(inner))
    drops["image.tar.gz"] = 2
    dest = remote.extract_targz_member(f"{base}/image.tar.gz", "iOS_17/Backup/backup.zip", tmp_path / "out.zip")
    assert dest.read_bytes() == inner


def test_missing_file_is_not_retried(http_root, tmp_path, monkeypatch):
    _, base, _, _ = http_root
    monkeypatch.setattr(remote.time, "sleep", lambda seconds: pytest.fail("a 404 must not be retried"))
    with pytest.raises(remote.urllib.error.HTTPError):
        remote.download(f"{base}/missing.bin", tmp_path / "missing.bin")


def test_unpack_refuses_paths_outside_the_cache(tmp_path):
    with zipfile.ZipFile(tmp_path / "evil.zip", "w") as zf:
        zf.writestr("../escaped.txt", b"x")
    with pytest.raises(remote.FetchError, match="outside"):
        remote.unpack(tmp_path / "evil.zip", "zip", tmp_path / "dest")
    assert not (tmp_path / "escaped.txt").exists()


# ── fetch_item ───────────────────────────────────────────────────────────────


def test_fetch_item_end_to_end(http_root, tmp_path):
    root, base, _, _ = http_root
    data = _backup_zip_bytes()
    (root / "backup.zip").write_bytes(data)
    item = _item(Fetch(method="direct", url=f"{base}/backup.zip", artifact="backup.zip", archive="zip",
                       size=len(data), sha256=hashlib.sha256(data).hexdigest()))
    cache = tmp_path / "cache"
    backup_dir = fetch_item(item, cache, log=lambda *_: None)
    assert backup_dir == cache / "test-item" / "backup" / UDID
    assert (backup_dir / "Manifest.plist").is_file()
    assert is_fetched(item, cache)
    lines = []
    fetch_item(item, cache, log=lines.append)
    assert lines == ["test-item: already fetched"]


def test_fetch_item_rejects_a_hash_mismatch(http_root, tmp_path):
    root, base, _, _ = http_root
    (root / "backup.zip").write_bytes(_backup_zip_bytes())
    item = _item(Fetch(method="direct", url=f"{base}/backup.zip", artifact="backup.zip", archive="zip", sha256="0" * 64))
    cache = tmp_path / "cache"
    with pytest.raises(HashMismatch):
        fetch_item(item, cache, log=lambda *_: None)
    assert (cache / "test-item" / "download" / "backup.zip.mismatch").exists()
    assert not is_fetched(item, cache)


def test_manual_item_says_where_to_put_the_file(tmp_path):
    item = _item(Fetch(method="manual", artifact="backup.zip", archive="zip", instructions="Download it by hand."))
    with pytest.raises(ManualFetchRequired, match="Download it by hand") as excinfo:
        fetch_item(item, tmp_path, log=lambda *_: None)
    assert str(Path(tmp_path) / "test-item" / "download" / "backup.zip") in str(excinfo.value)


# ── sidecar driver ───────────────────────────────────────────────────────────


def test_sidecar_round_trip():
    with SidecarClient() as client:
        assert client.call("ping")["status"] == "ok"
        with pytest.raises(SidecarError) as excinfo:
            client.call("no_such_method")
        assert excinfo.value.code == -32601
        reply = client.send_raw("{not json")
        assert reply["id"] is None and reply["error"]["code"] == -32700
        assert client.call("ping")["status"] == "ok"
        assert not client.protocol_errors
