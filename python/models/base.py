"""Base Pydantic models for extracted artifacts.

All extractors produce instances of BaseArtifact (or subclasses). Each artifact
carries forensic provenance metadata so that every extracted data point can be
traced back to its source database, table, and row.
"""

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class Provenance(BaseModel):
    """Forensic chain-of-custody metadata.

    Records exactly where an artifact was extracted from so that results
    can be independently verified against the original backup.
    """

    source_db: str
    source_table: str
    source_row_id: Optional[int] = None


class BaseArtifact(BaseModel):
    """Base class for all extracted artifacts.

    Every piece of data pulled from an iPhone backup is represented as a
    BaseArtifact. Subclasses may extend this with type-specific fields,
    but the core fields here ensure a uniform schema for storage and search.
    """

    artifact_type: str
    timestamp: Optional[datetime] = None
    timestamp_end: Optional[datetime] = None
    provenance: Provenance
    contact_name: Optional[str] = None
    contact_identifier: Optional[str] = None
    text_content: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    bundle_id: Optional[str] = None
    data: dict[str, Any] = {}
