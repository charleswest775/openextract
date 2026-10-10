"""Download helpers: resumable downloads, single zip members and tar.gz members.

Each source can be an ``http(s)://`` URL or a local path / ``file://`` URL; local
sources are what the unit tests use. Remote zip members are fetched with HTTP
range requests, so pulling a 400 MB member out of a 9 GB archive downloads
~400 MB. Tar.gz members are streamed and the connection is dropped as soon as
the member has been read, so a member near the start of a 20 GB archive costs
only the bytes before and inside it.

Every remote read goes through ``ResumableStream``, which reconnects with a
Range request after a dropped connection and carries on from the same byte, so
long transfers survive network hiccups.
"""

from __future__ import annotations

import http.client
import io
import os
import shutil
import struct
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path
from typing import BinaryIO, Callable, Optional

USER_AGENT = "openextract-corpus-fetch/1"
CHUNK = 1 << 20
TIMEOUT = 60
RETRIES = 8

Progress = Optional[Callable[[int, Optional[int]], None]]


class FetchError(RuntimeError):
    """A download or extraction failed."""


def is_remote(src: str) -> bool:
    return src.startswith(("http://", "https://"))


def local_path(src: str) -> Path:
    if src.startswith("file://"):
        return Path(urllib.parse.unquote(urllib.parse.urlparse(src).path))
    return Path(src)


def _open_url(url: str, headers: Optional[dict] = None, method: str = "GET"):
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, **(headers or {})}, method=method
    )
    return urllib.request.urlopen(request, timeout=TIMEOUT)


def _retryable(error: BaseException) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code >= 500 or error.code in (408, 429)
    return isinstance(error, (OSError, http.client.HTTPException))


class ResumableStream(io.RawIOBase):
    """Sequential reader over HTTP bytes [start, end] that reconnects after network errors."""

    def __init__(self, url: str, start: int = 0, end: Optional[int] = None, retries: int = RETRIES):
        super().__init__()
        self.url, self.pos, self.end = url, start, end
        self.retries = retries
        self._response = None

    def readable(self) -> bool:
        return True

    def _connect(self) -> None:
        ranged = self.pos > 0 or self.end is not None
        headers = {"Range": f"bytes={self.pos}-{'' if self.end is None else self.end}"} if ranged else {}
        response = _open_url(self.url, headers)
        if ranged and response.status != 206:
            response.close()
            raise FetchError(f"{self.url}: server ignored the Range header (HTTP {response.status})")
        self._response = response

    def _disconnect(self) -> None:
        if self._response is not None:
            try:
                self._response.close()
            except OSError:
                pass
            self._response = None

    def readinto(self, buffer) -> int:
        if self.end is not None:
            remaining = self.end - self.pos + 1
            if remaining <= 0:
                return 0
            buffer = memoryview(buffer)[: min(len(buffer), remaining)]
        for attempt in range(self.retries + 1):
            try:
                if self._response is None:
                    self._connect()
                n = self._response.readinto(buffer)
                # http.client returns 0 rather than raising when the server hangs up
                # early, so compare against the range we asked for / Content-Length.
                unread = self._response.length
                if n == 0 and (self.end is not None or (unread is not None and unread > 0)):
                    raise http.client.IncompleteRead(b"", unread)
                self.pos += n
                return n
            except Exception as error:  # classified by _retryable
                self._disconnect()
                if not _retryable(error) or attempt == self.retries:
                    raise
                time.sleep(min(2 ** attempt, 30))
        return 0  # unreachable

    def close(self) -> None:
        self._disconnect()
        super().close()


class HTTPRangeFile(io.RawIOBase):
    """A read-only, seekable file over HTTP range requests (used to read zip directories)."""

    def __init__(self, url: str):
        super().__init__()
        self.url = url
        self.pos = 0
        with _open_url(url, method="HEAD") as response:
            length = response.headers.get("Content-Length")
        if length is None:
            with _open_url(url, {"Range": "bytes=0-0"}) as response:
                length = response.headers.get("Content-Range", "").rpartition("/")[2]
        if not str(length).isdigit():
            raise FetchError(f"{url}: could not determine the file size")
        self.size = int(length)

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self.pos = offset
        elif whence == io.SEEK_CUR:
            self.pos += offset
        elif whence == io.SEEK_END:
            self.pos = self.size + offset
        else:
            raise ValueError(f"bad whence {whence}")
        return self.pos

    def readinto(self, buffer) -> int:
        n = min(len(buffer), self.size - self.pos)
        if n <= 0:
            return 0
        with ResumableStream(self.url, self.pos, self.pos + n - 1) as stream:
            view, done = memoryview(buffer), 0
            while done < n:
                got = stream.readinto(view[done:n])
                if not got:
                    break
                done += got
        self.pos += done
        return done


def open_source(src: str) -> BinaryIO:
    """Open a URL or local path as a seekable binary file."""
    if is_remote(src):
        return io.BufferedReader(HTTPRangeFile(src), buffer_size=1 << 16)
    return open(local_path(src), "rb")


def _copy(reader: BinaryIO, writer: BinaryIO, total: Optional[int], progress: Progress, done: int = 0) -> int:
    while True:
        chunk = reader.read(CHUNK)
        if not chunk:
            return done
        writer.write(chunk)
        done += len(chunk)
        if progress:
            progress(done, total)


def _part(dest: Path) -> Path:
    return dest.with_name(dest.name + ".part")


def download(src: str, dest: Path, *, expected_size: Optional[int] = None, progress: Progress = None) -> Path:
    """Download ``src`` to ``dest``, resuming from ``dest.part`` when it exists."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = _part(dest)
    if not is_remote(src):
        with open(local_path(src), "rb") as reader, open(part, "wb") as writer:
            _copy(reader, writer, expected_size, progress)
        os.replace(part, dest)
        return dest

    start = part.stat().st_size if part.exists() else 0
    if expected_size is not None and start > expected_size:
        start = 0
    if expected_size is None or start < expected_size:
        try:
            with ResumableStream(src, start=start) as stream, open(part, "ab" if start else "wb") as writer:
                _copy(stream, writer, expected_size, progress, done=start)
        except urllib.error.HTTPError as e:
            if not (e.code == 416 and start):  # 416 on a resume: the .part file is already complete
                raise
    if expected_size is not None and part.stat().st_size != expected_size:
        raise FetchError(f"{src}: expected {expected_size} bytes, got {part.stat().st_size}")
    os.replace(part, dest)
    return dest


def extract_zip_member(src: str, member: str, dest: Path, *, progress: Progress = None) -> Path:
    """Copy one member of a (possibly remote) zip archive to ``dest``, checking its CRC."""
    with open_source(src) as f:
        archive = zipfile.ZipFile(f)
        try:
            info = archive.getinfo(member)
        except KeyError:
            near = [n for n in archive.namelist() if Path(n).name == Path(member).name][:5]
            hint = f" Did you mean one of {near}?" if near else ""
            raise FetchError(f"{src}: no member '{member}'.{hint}") from None
        if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise FetchError(f"{member}: unsupported compression type {info.compress_type}")
        f.seek(info.header_offset)
        header = f.read(30)
        if header[:4] != b"PK\x03\x04":
            raise FetchError(f"{member}: bad local file header")
        name_len, extra_len = struct.unpack("<HH", header[26:30])
        data_start = info.header_offset + 30 + name_len + extra_len

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = _part(dest)
    remaining = info.compress_size
    if is_remote(src):
        reader = ResumableStream(src, data_start, data_start + remaining - 1)
    else:
        reader = open(local_path(src), "rb")
        reader.seek(data_start)
    inflater = zlib.decompressobj(-15) if info.compress_type == zipfile.ZIP_DEFLATED else None
    crc = 0
    written = 0
    try:
        with open(part, "wb") as writer:
            while remaining > 0:
                chunk = reader.read(min(CHUNK, remaining))
                if not chunk:
                    raise FetchError(f"{member}: archive ended early")
                remaining -= len(chunk)
                data = inflater.decompress(chunk) if inflater else chunk
                if data:
                    writer.write(data)
                    crc = zlib.crc32(data, crc)
                    written += len(data)
                if progress:
                    progress(info.compress_size - remaining, info.compress_size)
            if inflater:
                tail = inflater.flush()
                writer.write(tail)
                crc = zlib.crc32(tail, crc)
                written += len(tail)
    finally:
        reader.close()
    if written != info.file_size or crc != info.CRC:
        raise FetchError(f"{member}: size/CRC mismatch after extraction (archive may be corrupt)")
    os.replace(part, dest)
    return dest


def extract_targz_member(src: str, member: str, dest: Path, *, progress: Progress = None) -> Path:
    """Stream a .tar.gz from the start and copy out one member, then stop reading."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = _part(dest)
    if is_remote(src):
        stream = io.BufferedReader(ResumableStream(src), buffer_size=CHUNK)
    else:
        stream = open(local_path(src), "rb")
    try:
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for info in archive:
                if info.name != member:
                    continue
                if not info.isfile():
                    raise FetchError(f"{src}: '{member}' is not a regular file")
                reader = archive.extractfile(info)
                with open(part, "wb") as writer:
                    _copy(reader, writer, info.size, progress)
                break
            else:
                raise FetchError(f"{src}: no member '{member}'")
    finally:
        stream.close()
    os.replace(part, dest)
    return dest


def _safe_target(root: Path, name: str) -> Path:
    target = (root / name).resolve()
    if target != root and root not in target.parents:
        raise FetchError(f"refusing to unpack '{name}' outside {root}")
    return target


def unpack(artifact: Path, archive: str, dest: Path) -> Path:
    """Unpack ``artifact`` into ``dest`` (replacing it), refusing paths that escape it."""
    if archive == "tar.xz":
        try:
            import lzma  # noqa: F401
        except ImportError:
            raise FetchError(
                "this Python was built without lzma (xz) support, so it can't unpack .tar.xz; "
                "use a Python with lzma (the python.org and CI builds have it)"
            ) from None
    staging = dest.with_name(dest.name + ".unpacking")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    root = staging.resolve()
    if archive == "zip":
        with zipfile.ZipFile(artifact) as zf:
            for info in zf.infolist():
                target = _safe_target(root, info.filename)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as reader, open(target, "wb") as writer:
                    shutil.copyfileobj(reader, writer, CHUNK)
    elif archive == "tar.xz":
        with tarfile.open(artifact, "r:xz") as tf:
            for info in tf:
                target = _safe_target(root, info.name)
                if info.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                elif info.isfile():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with tf.extractfile(info) as reader, open(target, "wb") as writer:
                        shutil.copyfileobj(reader, writer, CHUNK)
                # links and devices are skipped on purpose
    else:
        raise FetchError(f"unknown archive kind '{archive}'")
    if dest.exists():
        shutil.rmtree(dest)
    os.replace(staging, dest)
    return dest
