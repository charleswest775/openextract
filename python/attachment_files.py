"""
A message's attachment, handed to the app: shared by Messages (messages.py) and WhatsApp (whatsapp.py).

Each adapter finds the file its own way (sms.db and the backup's file list;
ChatStorage.sqlite). From there the app wants the same things:

  * the bytes, as base64, for a picture, a voice note or a small document.
    A file bigger than MAX_INLINE_BYTES comes back as ``too_large`` instead:
    base64 makes it a third bigger, and the whole answer is one JSON line that
    Electron holds in memory, so a long video is better opened from a copy.
  * a photo browsers can't show (HEIC, HEIF, TIFF) as an upright JPEG.
  * a small JPEG of a picture for a chat bubble or a card (thumbnail), made
    here: backups keep no preview images for Messages.
  * a copy named with its real extension, for another app to open or the app
    to play (app_copies.py).

app_copies imports messages, so messages.py imports this module inside the
methods that use it, never at its top.
"""

import base64
import io
import mimetypes
import os
import sys
from collections import OrderedDict
from typing import Callable, Iterable, Optional

from app_copies import AppCopies, NotEnoughSpace, is_openable, join_name, openable_extension, split_name

# Biggest file sent inline as base64 (see above).
MAX_INLINE_BYTES = 25 * 1024 * 1024

# Longest side of a thumbnail, and its JPEG quality: sharp in a 200-pixel tile
# on a high-density screen, and a few tens of kilobytes.
THUMBNAIL_PX = 400
THUMBNAIL_QUALITY = 80

# Longest side, and quality, of the JPEG a HEIC, HEIF or TIFF photo is sent
# as. A 48-megapixel photo would be 8064 pixels across: more than any screen
# shows, and a far bigger answer.
JPEG_MAX_PX = 4096
JPEG_QUALITY = 90

# Thumbnails kept in memory (each about 30 KB of base64).
THUMBNAIL_CACHE_SIZE = 500

# What the app is told, in words for people.
FILE_NOT_IN_BACKUP = "This file isn't in the backup"
FILE_UNREADABLE = "This file couldn't be read from the backup"
FILE_NOT_COPIED = "This file couldn't be copied to open it"
NO_ROOM_TO_COPY = ("This computer doesn't have enough free space to copy this file out of the backup: "
                   "it is {size}, and {free} is free. Free up some space and try again.")

# The file types messages carry, both ways. Python's mimetypes reads the
# system's own table, which on Windows lacks some of these (.webp, .opus), so
# look here first.
MIME_BY_EXTENSION = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".thumb": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".3gp": "video/3gpp",
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".aac": "audio/aac", ".amr": "audio/amr", ".caf": "audio/x-caf", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".txt": "text/plain", ".vcf": "text/vcard",
}
EXTENSION_BY_MIME = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
    "image/heic": ".heic", "image/heif": ".heif", "image/bmp": ".bmp", "image/tiff": ".tiff",
    "video/mp4": ".mp4", "video/quicktime": ".mov", "video/x-m4v": ".m4v", "video/3gpp": ".3gp",
    "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/mp4": ".m4a", "audio/mpeg": ".mp3",
    "audio/aac": ".aac", "audio/amr": ".amr", "audio/x-caf": ".caf", "audio/wav": ".wav",
    "application/pdf": ".pdf", "text/plain": ".txt",
}

# Photos browsers can't show, sent as JPEG.
_JPEG_TYPES = frozenset({"image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", "image/tiff"})
_JPEG_EXTENSIONS = (".heic", ".heif", ".tif", ".tiff")

# EXIF orientations that turn a picture a quarter turn, so its width and height swap.
_QUARTER_TURNS = (5, 6, 7, 8)

_heif_ready = False

# on_progress(bytes copied so far, bytes in all)
CopyProgress = Callable[[int, int], None]


def not_in_backup() -> dict:
    """The answer for a file the backup hasn't got: common (never downloaded, left out of the backup), not a failure."""
    return {"error": FILE_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}


def size_words(size: int) -> str:
    """A file size as people say it: "4.2 GB", "310 MB"."""
    if size >= 1000 ** 3:
        return f"{size / 1000 ** 3:.1f} GB"
    return f"{max(1, round(size / 1000 ** 2))} MB"


# ── Types and names ──────────────────────────────────────────────────────────

def clean_mime(mime) -> str:
    """A MIME type without parameters, lower case: "audio/ogg; codecs=opus" is "audio/ogg".

    The app puts it in a data: URL, where a space doesn't belong.
    """
    return (mime or "").split(";")[0].strip().lower() if isinstance(mime, str) else ""


def mime_for(name: str) -> Optional[str]:
    """The MIME type a file name says, the same on every system."""
    ext = os.path.splitext(name or "")[1].lower()
    return MIME_BY_EXTENSION.get(ext) or mimetypes.guess_type(name or "")[0]


def extension_for(mime: str) -> str:
    mime = clean_mime(mime)
    if not mime:
        return ""
    return EXTENSION_BY_MIME.get(mime) or mimetypes.guess_extension(mime) or ""


def name_for_app(name: str, mime: str, default_stem: str, *, retype: bool = False,
                 retype_extensions: Iterable[str] = ()) -> str:
    """A file name another app will open: the file's own name, safe on every system, with a real extension.

    A name without an extension (or with one of ``retype_extensions``, or any
    when ``retype``) gets one from the MIME type, but only one of app_copies'
    OPENABLE_EXTENSIONS: the sender declared that type, and "Invoice" sent as
    a program must not become "Invoice.exe".
    """
    stem, ext = split_name(name)
    if retype or not ext or ext.lower() in retype_extensions:
        guessed = extension_for(mime)
        if openable_extension(guessed):
            ext = guessed
    return join_name(stem, ext, default_stem)


def is_picture(mime: str, name: str = "") -> bool:
    """Whether a file is a picture a thumbnail can be made of (SVG isn't: it's a document that can run code)."""
    mime = clean_mime(mime)
    if mime:
        return mime.startswith("image/") and mime != "image/svg+xml"
    return (mime_for(name) or "").startswith("image/")


def shows_as_jpeg(mime: str, name: str = "") -> bool:
    """Whether a photo is one browsers can't show (HEIC, HEIF, TIFF), so it is sent as JPEG.

    By its type when it has one, so a JPEG is never re-encoded for its name; by its name when not.
    """
    mime = clean_mime(mime)
    if mime and mime != "application/octet-stream":
        return mime in _JPEG_TYPES
    return (name or "").lower().endswith(_JPEG_EXTENSIONS)


# ── Pictures ─────────────────────────────────────────────────────────────────

def _pillow():
    """(Image, ImageOps) with HEIC/HEIF support when pillow-heif is there; None without Pillow."""
    global _heif_ready
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    if not _heif_ready:
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        _heif_ready = True
    return Image, ImageOps


def _flatten(Image, img):
    """``img`` as RGB (or greyscale) for a JPEG: transparency goes onto white, as a chat shows it."""
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat
    if img.mode not in ("RGB", "L"):
        return img.convert("RGB")
    return img


def _render_jpeg(source, max_px: int, quality: int) -> Optional[tuple]:
    """(JPEG bytes, width, height) of a picture, upright, at most ``max_px`` on its longest side; None if it can't be read.

    ``source`` is a path or the file's bytes. Only the first frame of a GIF or
    an animated WebP. ``width`` and ``height`` are the whole picture's, as it
    is shown (after its EXIF orientation), not the JPEG's.
    """
    pillow = _pillow()
    if pillow is None:
        return None
    Image, ImageOps = pillow
    try:
        with Image.open(io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source) as opened:
            # HEIC has been turned upright as it was opened, and a TIFF's size already allows for its turn.
            width, height = opened.size
            source_mode = opened.mode
            icc = opened.info.get("icc_profile")
            img = opened
            if img.mode in ("P", "1"):
                # A palette or 1-bit picture scales by dropping pixels; in colour it scales smoothly.
                img = img.convert("RGBA" if img.mode == "P" else "L")
            # Scales a JPEG down while decoding it, which is most of the speed.
            img.thumbnail((max_px, max_px))
            # Read after decoding: by then a TIFF has turned itself and dropped its tag, so
            # this is only the turn exif_transpose is still to make (a JPEG's, say).
            if img.getexif().get(0x0112, 1) in _QUARTER_TURNS:
                width, height = height, width
            img = _flatten(Image, ImageOps.exif_transpose(img))
            # Keep the colour profile (iPhone photos are Display P3) when it still describes the
            # pixels: not a CMYK or greyscale one on pixels now RGB.
            same_colours = (img.mode == "RGB" and source_mode in ("RGB", "RGBA", "RGBX", "P")) or \
                (img.mode == "L" and source_mode == "L")
            out = io.BytesIO()
            if icc and same_colours:
                img.save(out, "JPEG", quality=quality, icc_profile=icc)
            else:
                img.save(out, "JPEG", quality=quality)
            return out.getvalue(), width, height
    except Exception:
        return None


def jpeg_copy(source, max_px: Optional[int] = None, quality: Optional[int] = None) -> Optional[bytes]:
    """A photo (HEIC, TIFF...) as an upright JPEG no bigger than ``max_px`` (JPEG_MAX_PX); None if it can't be converted."""
    made = _render_jpeg(source, max_px or JPEG_MAX_PX, quality or JPEG_QUALITY)
    return made[0] if made else None


def thumbnail(source, max_px: Optional[int] = None) -> Optional[tuple]:
    """(small JPEG bytes, width, height) of a picture, at most ``max_px`` (THUMBNAIL_PX); None if it can't be read.

    See _render_jpeg.
    """
    return _render_jpeg(source, max_px or THUMBNAIL_PX, THUMBNAIL_QUALITY)


class ThumbnailCache:
    """The last THUMBNAIL_CACHE_SIZE thumbnails made, by key; the least recently used goes first."""

    def __init__(self, size: Optional[int] = None):
        self._size = size or THUMBNAIL_CACHE_SIZE
        self._items: OrderedDict = OrderedDict()

    def get(self, key) -> Optional[dict]:
        item = self._items.get(key)
        if item is None:
            return None
        self._items.move_to_end(key)
        return dict(item)

    def put(self, key, value: dict) -> None:
        self._items[key] = dict(value)
        self._items.move_to_end(key)
        while len(self._items) > self._size:
            self._items.popitem(last=False)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


# ── Answers ──────────────────────────────────────────────────────────────────

def inline_answer(path: str, mime: str, name: str, size: int, max_bytes: Optional[int] = None,
                  convert: bool = True, log_label: str = "attachment") -> dict:
    """The file for the app as ``{data (base64), mime_type, filename, size}``.

    ``size`` is the file's own. A HEIC, HEIF or TIFF photo comes as JPEG (when
    ``convert``), checked against ``max_bytes`` after converting, so a big
    photo still shows. Anything else is sent byte for byte, unless it is over
    ``max_bytes`` (MAX_INLINE_BYTES): then ``{too_large: True, mime_type,
    filename, size}`` with no data, and the app opens a copy instead.
    """
    limit = MAX_INLINE_BYTES if max_bytes is None else max_bytes
    too_large = {"too_large": True, "mime_type": mime, "filename": name, "size": size}
    if convert and shows_as_jpeg(mime, name):
        jpeg = jpeg_copy(path)
        if jpeg is not None:
            if len(jpeg) > limit:
                return too_large
            return {"data": base64.b64encode(jpeg).decode("ascii"), "mime_type": "image/jpeg",
                    "filename": name, "size": size}
        # Can't be converted (no pillow-heif, or damaged): the file as it is.
    if size > limit:
        return too_large
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        print(f"[{log_label}] could not read {name!r}: {e}", file=sys.stderr, flush=True)
        return {"error": FILE_UNREADABLE}
    return {"data": base64.b64encode(raw).decode("ascii"), "mime_type": mime, "filename": name, "size": size}


def copy_for_app(copies: AppCopies, src: str, parts: Iterable, file_name: str,
                 on_progress: Optional[CopyProgress] = None, log_label: str = "attachment") -> dict:
    """Copy ``src`` out of the backup as ``file_name`` (app_copies.py): ``{path, openable}``, or ``{error}``.

    ``openable`` is True only for a photo, video, audio file or document,
    which the app may open in another app; anything else it only shows in
    its folder. ``on_progress(bytes copied, bytes in all)`` is called while a
    big copy is made.
    """
    try:
        dest = copies.copy(src, parts, file_name, on_progress)
    except NotEnoughSpace as e:
        print(f"[{log_label}] no room to copy {file_name!r} to open it: {e}", file=sys.stderr, flush=True)
        return {"error": NO_ROOM_TO_COPY.format(size=size_words(e.needed), free=size_words(e.free))}
    except OSError as e:
        print(f"[{log_label}] could not copy {file_name!r} to open it: {e}", file=sys.stderr, flush=True)
        return {"error": FILE_NOT_COPIED}
    return {"path": dest, "openable": is_openable(file_name)}
