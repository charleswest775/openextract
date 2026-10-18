"""
Tests for the Health adapter: summary caching and CSV export.

The core extractor is stubbed, so these run against any ios-backup-core version.
"""

import csv
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from health import OUTDATED_CORE_MESSAGE, HealthExtractor  # noqa: E402

SUMMARY = {
    "available": True, "notice": None, "errors": [],
    "range": {"first": "2024-01-01", "last": "2024-01-03"},
    "daily": [
        {"date": "2024-01-01", "steps": 6000, "distance_km": 4.2, "resting_heart_rate": 58},
        {"date": "2024-01-02", "steps": 3000, "weight_kg": 70.25},
    ],
    "sleep": [
        {"date": "2024-01-02", "asleep_minutes": 330, "in_bed_minutes": 480, "awake_minutes": 30,
         "core_minutes": 180, "deep_minutes": 60, "rem_minutes": 90},
        {"date": "2024-01-03", "asleep_minutes": 400, "in_bed_minutes": 0, "awake_minutes": 0,
         "core_minutes": 0, "deep_minutes": 0, "rem_minutes": 0},
    ],
    "workouts": [
        {"id": 1, "type": "Running", "start": "2024-01-01T07:00:00+00:00",
         "end": "2024-01-01T07:31:00+00:00", "duration_minutes": 30.0, "distance_km": 5.01,
         "energy_kcal": 320, "avg_heart_rate": 150, "max_heart_rate": 180, "indoor": False,
         "source": "Apple Watch"},
        {"id": 2, "type": "Yoga", "start": "2024-01-02T18:00:00+00:00",
         "end": "2024-01-02T18:45:00+00:00", "duration_minutes": 45.0, "distance_km": None,
         "energy_kcal": 120, "avg_heart_rate": None, "max_heart_rate": None, "indoor": None,
         "source": None},
    ],
}


class _StubCore:
    def __init__(self, summary):
        self.summary = summary
        self.calls = 0

    def get_summary(self, backup):
        self.calls += 1
        return self.summary


class _Backup:
    def __init__(self, backup_dir="/backups/abc"):
        self.backup_dir = backup_dir


def _read_csv(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class HealthAdapterTests(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.ext = HealthExtractor()
        self.core = _StubCore(SUMMARY)
        self.ext._inner = self.core

    def test_daily_csv_merges_metrics_and_sleep(self):
        result = self.ext.export_health(_Backup(), self.out)
        self.assertTrue(result["success"])
        self.assertEqual(result["files"], ["health_daily.csv", "workouts.csv"])
        self.assertEqual((result["days"], result["workouts"]), (3, 2))

        rows = _read_csv(os.path.join(self.out, "health_daily.csv"))
        self.assertEqual([r["Date"] for r in rows], ["2024-01-01", "2024-01-02", "2024-01-03"])
        self.assertEqual(rows[0]["Steps"], "6000")
        self.assertEqual(rows[0]["Distance (km)"], "4.2")
        self.assertEqual(rows[0]["Asleep (min)"], "")          # no sleep that night
        self.assertEqual(rows[1]["Weight (kg)"], "70.25")
        self.assertEqual(rows[1]["Deep (min)"], "60")
        self.assertEqual(rows[2]["Steps"], "")                 # sleep-only day
        self.assertEqual(rows[2]["Asleep (min)"], "400")

    def test_workouts_csv(self):
        self.ext.export_health(_Backup(), self.out)
        rows = _read_csv(os.path.join(self.out, "workouts.csv"))
        self.assertEqual(rows[0]["Type"], "Running")
        self.assertEqual(rows[0]["Distance (km)"], "5.01")
        self.assertEqual(rows[0]["Indoor/Outdoor"], "Outdoor")
        self.assertEqual(rows[0]["Source"], "Apple Watch")
        self.assertEqual((rows[1]["Distance (km)"], rows[1]["Indoor/Outdoor"]), ("", ""))

    def test_nothing_to_export_passes_on_the_notice(self):
        self.ext._inner = _StubCore({**SUMMARY, "available": False, "daily": [], "sleep": [],
                                     "workouts": [], "notice": "Needs an encrypted backup."})
        result = self.ext.export_health(_Backup(), self.out)
        self.assertEqual(result, {"success": False, "error": "Needs an encrypted backup."})

    def test_summary_is_cached_per_open_backup(self):
        backup = _Backup()
        self.ext.get_summary(backup)
        self.ext.get_summary(backup)
        self.assertEqual(self.core.calls, 1)
        self.ext.get_summary(_Backup())  # same folder, re-opened → new object
        self.assertEqual(self.core.calls, 2)

    def test_outdated_core(self):
        self.ext._inner = None
        summary = self.ext.get_summary(_Backup())
        self.assertFalse(summary["available"])
        self.assertEqual(summary["errors"][0]["message"], OUTDATED_CORE_MESSAGE)
        self.assertFalse(self.ext.export_health(_Backup(), self.out)["success"])


if __name__ == "__main__":
    unittest.main()
