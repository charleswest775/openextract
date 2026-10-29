"""
Apple Health adapter.

Delegates to ``ios_backup_core.extractors.health.HealthExtractor``. The summary
is cached per open backup: decrypting and aggregating a large Health database
can take a while, and the Health tab asks for it on every visit. Adds CSV
export.
"""

import csv
import os

try:
    from ios_backup_core.extractors.health import HealthExtractor as _CoreHealthExtractor
except ImportError:  # an ios-backup-core checkout from before Health support
    _CoreHealthExtractor = None

OUTDATED_CORE_MESSAGE = (
    "Health needs a newer version of ios-backup-core. "
    "Update it and restart OpenExtract."
)

_DAILY_COLUMNS = [
    ("Steps", "steps"),
    ("Distance (km)", "distance_km"),
    ("Flights Climbed", "flights"),
    ("Active Energy (kcal)", "active_energy_kcal"),
    ("Resting Heart Rate (bpm)", "resting_heart_rate"),
    ("Heart Rate Min (bpm)", "heart_rate_min"),
    ("Heart Rate Avg (bpm)", "heart_rate_avg"),
    ("Heart Rate Max (bpm)", "heart_rate_max"),
    ("Weight (kg)", "weight_kg"),
]
_SLEEP_COLUMNS = [
    ("Asleep (min)", "asleep_minutes"),
    ("In Bed (min)", "in_bed_minutes"),
    ("Awake (min)", "awake_minutes"),
    ("Core (min)", "core_minutes"),
    ("Deep (min)", "deep_minutes"),
    ("REM (min)", "rem_minutes"),
]
_WORKOUT_COLUMNS = [
    ("Start", "start"),
    ("End", "end"),
    ("Type", "type"),
    ("Duration (min)", "duration_minutes"),
    ("Distance (km)", "distance_km"),
    ("Active Energy (kcal)", "energy_kcal"),
    ("Avg Heart Rate (bpm)", "avg_heart_rate"),
    ("Max Heart Rate (bpm)", "max_heart_rate"),
    ("Source", "source"),
]


def _empty_summary(message: str) -> dict:
    return {"available": False, "notice": None, "errors": [{"message": message}],
            "range": None, "daily": [], "sleep": [], "workouts": []}


def _cell(value):
    return "" if value is None else value


class HealthExtractor:
    """Adapter wrapping the ios-backup-core HealthExtractor."""

    def __init__(self):
        self._inner = _CoreHealthExtractor() if _CoreHealthExtractor else None
        self._cache: dict = {}  # backup folder → (backup object, summary)

    def get_summary(self, backup) -> dict:
        if self._inner is None:
            return _empty_summary(OUTDATED_CORE_MESSAGE)
        key = getattr(backup, "backup_dir", None) or id(backup)
        cached = self._cache.get(key)
        # Re-opening a backup creates a new object; only reuse results for this one.
        if cached and cached[0] is backup:
            return cached[1]
        summary = self._inner.get_summary(backup)
        self._cache[key] = (backup, summary)
        return summary

    # ── openextract-only: export to disk ─────────────────────────────────────

    def export_health(self, backup, output_dir: str) -> dict:
        """Write health_daily.csv (daily metrics + sleep) and workouts.csv."""
        summary = self.get_summary(backup)
        if not (summary["daily"] or summary["sleep"] or summary["workouts"]):
            return {"success": False,
                    "error": summary.get("notice") or "No Health data found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            files = []

            days = {d["date"]: d for d in summary["daily"]}
            nights = {s["date"]: s for s in summary["sleep"]}
            dates = sorted(set(days) | set(nights))
            if dates:
                with open(os.path.join(output_dir, "health_daily.csv"), "w",
                          newline="", encoding="utf-8") as f:
                    writer = csv.writer(f)
                    writer.writerow(["Date"] + [h for h, _ in _DAILY_COLUMNS + _SLEEP_COLUMNS])
                    for date in dates:
                        day, night = days.get(date, {}), nights.get(date, {})
                        writer.writerow(
                            [date]
                            + [_cell(day.get(k)) for _, k in _DAILY_COLUMNS]
                            + [_cell(night.get(k)) for _, k in _SLEEP_COLUMNS]
                        )
                files.append("health_daily.csv")

            if summary["workouts"]:
                with open(os.path.join(output_dir, "workouts.csv"), "w",
                          newline="", encoding="utf-8") as f:
                    writer = csv.writer(f)
                    writer.writerow([h for h, _ in _WORKOUT_COLUMNS] + ["Indoor/Outdoor"])
                    for w in summary["workouts"]:
                        place = {True: "Indoor", False: "Outdoor"}.get(w.get("indoor"), "")
                        writer.writerow([_cell(w.get(k)) for _, k in _WORKOUT_COLUMNS] + [place])
                files.append("workouts.csv")

            return {"success": True, "path": output_dir, "files": files,
                    "days": len(dates), "workouts": len(summary["workouts"])}
        except OSError as e:
            return {"success": False, "error": f"Export failed: {e}"}
