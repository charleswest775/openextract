"""Apple timestamp conversion utilities.

Handles the various timestamp formats found in iOS backup databases:
- Cocoa/Core Data epoch (seconds since 2001-01-01) — most common in iOS
- Unix epoch (seconds since 1970-01-01)
- Unix epoch in milliseconds
- WebKit/Chrome epoch (microseconds since 1601-01-01)

All functions return datetime objects in UTC, or None for null/zero inputs.
"""

from datetime import datetime, timezone
from typing import Optional

# Epoch offsets
COCOA_EPOCH_OFFSET = 978307200  # Seconds between Unix epoch and Cocoa epoch (2001-01-01)
WEBKIT_EPOCH_OFFSET = 11644473600  # Seconds between 1601-01-01 and Unix epoch

# Reasonable iOS timestamp range (iPhone launch 2007 through 2030)
_MIN_REASONABLE = datetime(2007, 1, 1, tzinfo=timezone.utc)
_MAX_REASONABLE = datetime(2030, 12, 31, 23, 59, 59, tzinfo=timezone.utc)


def _is_reasonable(dt: datetime) -> bool:
    """Check if a datetime falls within a reasonable iOS-era range (2007-2030)."""
    return _MIN_REASONABLE <= dt <= _MAX_REASONABLE


def from_cocoa(timestamp: Optional[float]) -> Optional[datetime]:
    """Convert a Cocoa/Core Data timestamp to a UTC datetime.

    Cocoa timestamps count seconds since 2001-01-01 00:00:00 UTC.
    This is the most common format in iOS SQLite databases.

    Args:
        timestamp: Seconds since 2001-01-01, or None/0.

    Returns:
        A timezone-aware UTC datetime, or None if input is null/zero.
    """
    if timestamp is None or timestamp == 0:
        return None
    unix_ts = timestamp + COCOA_EPOCH_OFFSET
    try:
        dt = datetime.fromtimestamp(unix_ts, tz=timezone.utc)
        return dt if _is_reasonable(dt) else None
    except (OSError, OverflowError, ValueError):
        return None


def from_unix(timestamp: Optional[float]) -> Optional[datetime]:
    """Convert a Unix timestamp (seconds since 1970-01-01) to a UTC datetime.

    Args:
        timestamp: Seconds since Unix epoch, or None/0.

    Returns:
        A timezone-aware UTC datetime, or None if input is null/zero.
    """
    if timestamp is None or timestamp == 0:
        return None
    try:
        dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        return dt if _is_reasonable(dt) else None
    except (OSError, OverflowError, ValueError):
        return None


def from_unix_ms(timestamp: Optional[float]) -> Optional[datetime]:
    """Convert a Unix timestamp in milliseconds to a UTC datetime.

    Args:
        timestamp: Milliseconds since Unix epoch, or None/0.

    Returns:
        A timezone-aware UTC datetime, or None if input is null/zero.
    """
    if timestamp is None or timestamp == 0:
        return None
    return from_unix(timestamp / 1000.0)


def from_webkit(timestamp: Optional[float]) -> Optional[datetime]:
    """Convert a WebKit/Chrome timestamp to a UTC datetime.

    WebKit timestamps count microseconds since 1601-01-01 00:00:00 UTC.

    Args:
        timestamp: Microseconds since 1601-01-01, or None/0.

    Returns:
        A timezone-aware UTC datetime, or None if input is null/zero.
    """
    if timestamp is None or timestamp == 0:
        return None
    unix_ts = (timestamp / 1_000_000) - WEBKIT_EPOCH_OFFSET
    try:
        dt = datetime.fromtimestamp(unix_ts, tz=timezone.utc)
        return dt if _is_reasonable(dt) else None
    except (OSError, OverflowError, ValueError):
        return None


def auto_convert(timestamp: Optional[float]) -> Optional[datetime]:
    """Auto-detect the timestamp format based on magnitude and convert to UTC datetime.

    Heuristic thresholds:
    - > 1e16  : WebKit/Chrome microseconds since 1601
    - > 1e12  : Unix milliseconds
    - > 1e9   : Unix seconds (post-2001)
    - otherwise: Cocoa seconds (since 2001)

    The function validates that the result falls within a reasonable iOS range
    (2007-2030). If the first guess fails validation, it tries other formats.

    Args:
        timestamp: A numeric timestamp in an unknown format, or None/0.

    Returns:
        A timezone-aware UTC datetime, or None if input is null/zero or
        no format produces a reasonable date.
    """
    if timestamp is None or timestamp == 0:
        return None

    abs_ts = abs(timestamp)

    # Order attempts by magnitude-based likelihood
    if abs_ts > 1e16:
        # Very large — likely WebKit microseconds
        attempts = [from_webkit, from_unix_ms, from_unix, from_cocoa]
    elif abs_ts > 1e12:
        # Large — likely Unix milliseconds
        attempts = [from_unix_ms, from_webkit, from_unix, from_cocoa]
    elif abs_ts > 1e9:
        # Medium — likely Unix seconds
        attempts = [from_unix, from_cocoa, from_unix_ms, from_webkit]
    else:
        # Smaller values — likely Cocoa seconds
        attempts = [from_cocoa, from_unix, from_unix_ms, from_webkit]

    for converter in attempts:
        result = converter(timestamp)
        if result is not None:
            return result

    return None
