"""Abstract base class for all artifact extractors.

Every extractor (messages, contacts, photos, etc.) inherits from
ArtifactExtractor and implements the extract() method. The base class
provides common utilities for resolving database paths within a backup,
opening SQLite databases read-only, and checking iOS version compatibility.
"""

import abc
import hashlib
import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

from models.base import BaseArtifact, Provenance


class ArtifactExtractor(abc.ABC):
    """Abstract base for all artifact extractors.

    Subclasses must set ARTIFACT_TYPE and implement extract().
    """

    ARTIFACT_TYPE: str = ""  # Override in subclass
    SUPPORTED_IOS_VERSIONS: range = range(8, 19)  # Default: iOS 8-18

    def __init__(
        self,
        backup_path: Path,
        ios_version: Optional[str] = None,
        manifest_db: Optional[Any] = None,
    ):
        """Initialize the extractor.

        Args:
            backup_path: Root path of the iPhone backup directory.
            ios_version: iOS version string (e.g. "17.4.1"), or None if unknown.
            manifest_db: Optional pre-opened Manifest.db connection for path lookups.
        """
        self.backup_path = backup_path
        self.ios_version_str = ios_version
        self.ios_major = self._parse_major_version(ios_version)
        self.manifest_db = manifest_db
        self.log = logging.getLogger(f"openextract.{self.ARTIFACT_TYPE}")

    def _parse_major_version(self, version_str: Optional[str]) -> int:
        """Parse the major version number from an iOS version string.

        Args:
            version_str: A version string like "17.4.1", or None.

        Returns:
            The major version as an int. Defaults to 17 if parsing fails.
        """
        if not version_str:
            return 17  # Default to recent
        try:
            return int(version_str.split(".")[0])
        except (ValueError, IndexError):
            return 17

    @abc.abstractmethod
    def extract(self) -> list[BaseArtifact]:
        """Extract all artifacts of this type. Must be implemented by subclass."""
        ...

    def resolve_db_path(self, domain: str, relative_path: str) -> Optional[Path]:
        """Resolve a backup database path via SHA-1 hash lookup.

        iPhone backups store files using SHA-1 hashes of
        "{domain}-{relative_path}" as filenames. This method checks for the
        file in both the two-character prefix subdirectory structure (iOS 10+)
        and the flat structure (older backups), as well as direct paths for
        development/testing.

        Args:
            domain: The backup domain (e.g. "HomeDomain", "MediaDomain").
            relative_path: The relative path within the domain
                (e.g. "Library/SMS/sms.db").

        Returns:
            The resolved Path if the database file exists, or None.
        """
        # Compute the SHA-1 hash that iOS uses as the filename
        file_hash = hashlib.sha1(f"{domain}-{relative_path}".encode()).hexdigest()

        # Two-character prefix subdirectory (iOS 10+)
        candidate = self.backup_path / file_hash[:2] / file_hash
        if candidate.exists():
            return candidate

        # Flat structure (older backups)
        candidate = self.backup_path / file_hash
        if candidate.exists():
            return candidate

        # Direct path (development/testing)
        direct = self.backup_path / relative_path
        if direct.exists():
            return direct

        self.log.debug("Database not found: %s/%s", domain, relative_path)
        return None

    def open_db(self, db_path: Path) -> Optional[sqlite3.Connection]:
        """Open a SQLite database in read-only mode.

        Args:
            db_path: Path to the SQLite database file.

        Returns:
            A sqlite3.Connection with Row factory, or None on failure.
        """
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            return conn
        except Exception as e:
            self.log.warning("Failed to open %s: %s", db_path, e)
            return None

    def is_supported(self) -> bool:
        """Check if the current iOS version is supported by this extractor.

        Returns:
            True if the detected iOS major version falls within
            SUPPORTED_IOS_VERSIONS.
        """
        return self.ios_major in self.SUPPORTED_IOS_VERSIONS
