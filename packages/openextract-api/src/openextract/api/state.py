"""Server-side session state: open backups and analysis results."""
from __future__ import annotations

from pathlib import Path

from openextract.core import Backup
from openextract.analyzer.models import AnalysisResult


class AppState:
    """In-memory state for the lifetime of the API server process."""

    def __init__(self):
        self._backups: dict[str, Backup] = {}
        self._analysis: dict[str, AnalysisResult] = {}

    # ------------------------------------------------------------------
    # Backup sessions
    # ------------------------------------------------------------------

    def open_backup(self, path: str, password: str | None = None) -> str:
        """Open a backup and return its session key (the backup path)."""
        backup = Backup.open(path, password)
        key = str(Path(path).resolve())
        # Close any existing session for same path
        if key in self._backups:
            self._backups[key].close()
        self._backups[key] = backup
        return key

    def get_backup(self, key: str) -> Backup:
        backup = self._backups.get(key)
        if backup is None:
            raise KeyError(f"No open backup session for: {key}")
        return backup

    def close_backup(self, key: str):
        backup = self._backups.pop(key, None)
        if backup:
            backup.close()

    def list_open_sessions(self) -> list[str]:
        return list(self._backups.keys())

    # ------------------------------------------------------------------
    # Analysis results
    # ------------------------------------------------------------------

    def store_analysis(self, key: str, result: AnalysisResult):
        self._analysis[key] = result

    def get_analysis(self, key: str) -> AnalysisResult | None:
        return self._analysis.get(key)


# Module-level singleton — created once when the server starts
state = AppState()
