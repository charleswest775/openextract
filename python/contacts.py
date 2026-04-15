"""
Contact resolution.

Thin shim over ``ios_backup_core.contacts``. The library's ``ContactResolver``
already implements per-UDID caching and ``clear_cache``, so we re-export it as-is
along with the module-level ``resolve_contact`` helper.
"""

from ios_backup_core.contacts import (
    ContactResolver,
    resolve_contact,
    normalize_phone,
)

__all__ = ["ContactResolver", "resolve_contact", "normalize_phone"]
