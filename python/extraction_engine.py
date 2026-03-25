"""Extraction pipeline orchestrator.

The ExtractionEngine runs all registered extractors against an iPhone backup,
stores results in the ExtractionDB, and reports progress via an optional
notification callback.
"""

import logging
from pathlib import Path
from typing import Callable, Optional

from extraction_db import ExtractionDB
from models.base import BaseArtifact

log = logging.getLogger("openextract.engine")


class ExtractionEngine:
    """Runs all extractors against a backup and stores results.

    Usage:
        db = ExtractionDB(Path("extraction.db"))
        engine = ExtractionEngine(db)
        engine.register_extractor("messages", MessagesExtractor)
        engine.register_extractor("contacts", ContactsExtractor)
        total = engine.extract_all(backup_path, udid, date, ios_version)
    """

    def __init__(self, extraction_db: ExtractionDB):
        """Initialize the extraction engine.

        Args:
            extraction_db: The ExtractionDB instance to store results in.
        """
        self.db = extraction_db
        self._extractor_registry: list[tuple[str, type]] = []

    def register_extractor(self, name: str, extractor_cls: type) -> None:
        """Register an extractor class to be run during extraction.

        Extractors are run in the order they are registered.

        Args:
            name: Human-readable name for the extractor (e.g. "messages").
            extractor_cls: The extractor class (must be an ArtifactExtractor subclass).
        """
        self._extractor_registry.append((name, extractor_cls))

    def get_extractor_order(self) -> list[tuple[str, type]]:
        """Return the current list of registered extractors in order.

        Returns:
            A list of (name, extractor_class) tuples.
        """
        return list(self._extractor_registry)

    def extract_all(
        self,
        backup_path: Path,
        backup_udid: str,
        backup_date: str,
        ios_version: Optional[str] = None,
        notify: Optional[Callable] = None,
    ) -> int:
        """Run all registered extractors, store results, return total artifact count.

        Each extractor is instantiated and run in order. Failures in individual
        extractors are logged but do not stop the pipeline (graceful degradation).

        Args:
            backup_path: Root path of the iPhone backup directory.
            backup_udid: The UDID of the backup being extracted.
            backup_date: The date of the backup (ISO format string).
            ios_version: The iOS version of the device, if known.
            notify: Optional callback(event_name, data_dict) for progress updates.

        Returns:
            Total number of artifacts extracted across all extractors.
        """
        # Clear previous extraction data for this device so we don't duplicate
        cleared = self.db.clear_device(backup_udid)
        if cleared:
            log.info("Cleared %d previous artifacts for %s", cleared, backup_udid)

        run_id = self.db.create_run(backup_udid, backup_date, ios_version)
        total = 0
        extractors = self.get_extractor_order()

        for idx, (name, extractor_cls) in enumerate(extractors):
            if notify:
                notify("extraction.progress", {
                    "phase": name,
                    "extractor_index": idx,
                    "extractor_count": len(extractors),
                    "artifacts_so_far": total,
                })

            try:
                extractor = extractor_cls(
                    backup_path=backup_path,
                    ios_version=ios_version,
                )

                if not extractor.is_supported():
                    log.info("Skipping %s: iOS %s not supported", name, ios_version)
                    continue

                artifacts = extractor.extract()
                if artifacts:
                    self.db.store_artifacts(run_id, artifacts)
                    total += len(artifacts)
                log.info("Extracted %d %s artifacts", len(artifacts), name)
            except Exception as e:
                log.warning("Extractor '%s' failed: %s", name, e, exc_info=True)
                # Continue — graceful degradation

        status = "completed"
        self.db.complete_run(run_id, total, status)

        if notify:
            notify("extraction.complete", {
                "run_id": run_id,
                "total_artifacts": total,
                "status": status,
            })

        log.info("Extraction complete: %d artifacts in run %d", total, run_id)
        return total
