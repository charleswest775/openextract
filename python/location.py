"""
Location data extraction from iPhone backups.

Sources:
  - Geotagged photos (Photos.sqlite ZLATITUDE/ZLONGITUDE)
  - Significant locations (com.apple.routined Local.sqlite)
  - Maps app saved places / favorites (com.apple.Maps MapDataShared.db)
"""

import csv
import datetime
import json
import os
import sqlite3


_APPLE_EPOCH = datetime.datetime(2001, 1, 1, tzinfo=datetime.timezone.utc)


def _apple_ts(ts) -> str | None:
    """Convert Apple CoreData timestamp (seconds since 2001-01-01) to ISO 8601."""
    if ts is None:
        return None
    try:
        dt = _APPLE_EPOCH + datetime.timedelta(seconds=float(ts))
        return dt.isoformat()
    except Exception:
        return None


class LocationExtractor:
    PHOTOS_DB = "Media/PhotoData/Photos.sqlite"
    ROUTINED_DB = "Library/Caches/com.apple.routined/Local.sqlite"
    ROUTINED_DB_ALT = "Library/Caches/com.apple.routined/Cache.sqlite"
    MAPS_DB = "Library/Maps/MapDataShared.db"
    MAPS_DB_ALT = "Library/Maps/MapsSync_0.0.1"

    # ── Photo locations ───────────────────────────────────────────────────────

    def list_photo_locations(self, backup) -> dict:
        """Return photos that carry GPS metadata."""
        db_path = backup.get_file(self.PHOTOS_DB, domain="CameraRollDomain")
        if not db_path:
            return {"points": [], "error": "Photos database not found"}

        points = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            rows = cursor.execute("""
                SELECT
                    ZUUID,
                    ZFILENAME,
                    ZLATITUDE,
                    ZLONGITUDE,
                    ZDATECREATED
                FROM ZASSET
                WHERE ZLATITUDE  IS NOT NULL
                  AND ZLONGITUDE IS NOT NULL
                  AND ZLATITUDE  != 0
                  AND ZLONGITUDE != 0
                ORDER BY ZDATECREATED DESC
            """).fetchall()

            for row in rows:
                points.append({
                    "source": "photo",
                    "latitude": float(row["ZLATITUDE"]),
                    "longitude": float(row["ZLONGITUDE"]),
                    "date": _apple_ts(row["ZDATECREATED"]),
                    "label": row["ZFILENAME"] or row["ZUUID"],
                    "uuid": row["ZUUID"],
                    "address": None,
                })

            conn.close()
        except Exception as e:
            return {"points": [], "error": str(e)}

        return {"points": points, "total": len(points)}

    # ── Significant locations ─────────────────────────────────────────────────

    def list_significant_locations(self, backup) -> dict:
        """Return significant / frequent locations tracked by iOS routined."""
        db_path = backup.get_file(self.ROUTINED_DB, domain="HomeDomain")
        if not db_path:
            db_path = backup.get_file(self.ROUTINED_DB_ALT, domain="HomeDomain")
        if not db_path:
            return {
                "points": [],
                "error": (
                    "Significant locations database not found. "
                    "This data requires an encrypted backup."
                ),
            }

        points = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = {r[0] for r in cursor.fetchall()}

            if "ZRTLEARNEDLOCATIONOFINTERESTMO" in tables:
                rows = cursor.execute("""
                    SELECT
                        ZLATITUDE,
                        ZLONGITUDE,
                        ZLOCATIONNAME,
                        ZENTRYDATE,
                        ZEXITDATE
                    FROM ZRTLEARNEDLOCATIONOFINTERESTMO
                    WHERE ZLATITUDE IS NOT NULL AND ZLONGITUDE IS NOT NULL
                """).fetchall()
                for row in rows:
                    points.append({
                        "source": "significant_location",
                        "latitude": float(row["ZLATITUDE"]),
                        "longitude": float(row["ZLONGITUDE"]),
                        "date": _apple_ts(row["ZENTRYDATE"]),
                        "label": row["ZLOCATIONNAME"] or "Significant Location",
                        "address": None,
                    })

            elif "ZRTVISITMO" in tables:
                rows = cursor.execute("""
                    SELECT
                        ZLATITUDE,
                        ZLONGITUDE,
                        ZARRIVALDATE,
                        ZDEPARTUREDATE
                    FROM ZRTVISITMO
                    WHERE ZLATITUDE IS NOT NULL AND ZLONGITUDE IS NOT NULL
                    ORDER BY ZARRIVALDATE DESC
                """).fetchall()
                for row in rows:
                    points.append({
                        "source": "visit",
                        "latitude": float(row["ZLATITUDE"]),
                        "longitude": float(row["ZLONGITUDE"]),
                        "date": _apple_ts(row["ZARRIVALDATE"]),
                        "label": "Visited Location",
                        "address": None,
                    })

            conn.close()
        except Exception as e:
            return {"points": [], "error": str(e)}

        return {"points": points, "total": len(points)}

    # ── Maps saved places ─────────────────────────────────────────────────────

    def list_map_favorites(self, backup) -> dict:
        """Return saved places and favorites from the Apple Maps app."""
        db_path = backup.get_file(self.MAPS_DB, domain="AppDomain-com.apple.Maps")
        if not db_path:
            db_path = backup.get_file(self.MAPS_DB_ALT, domain="AppDomain-com.apple.Maps")
        if not db_path:
            return {"points": [], "error": "Maps database not found"}

        points = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = {r[0] for r in cursor.fetchall()}

            if "ZMAPDATAPLACEMARK" in tables:
                rows = cursor.execute("""
                    SELECT ZLATITUDE, ZLONGITUDE, ZNAME, ZADDRESS, ZCREATIONDATE
                    FROM ZMAPDATAPLACEMARK
                    WHERE ZLATITUDE IS NOT NULL AND ZLONGITUDE IS NOT NULL
                """).fetchall()
                for row in rows:
                    points.append({
                        "source": "maps_favorite",
                        "latitude": float(row["ZLATITUDE"]),
                        "longitude": float(row["ZLONGITUDE"]),
                        "date": _apple_ts(row["ZCREATIONDATE"]),
                        "label": row["ZNAME"] or row["ZADDRESS"] or "Saved Place",
                        "address": row["ZADDRESS"],
                    })

            elif "Placemark" in tables:
                # Older iOS schema
                cursor.execute("PRAGMA table_info(Placemark)")
                cols = {r[1] for r in cursor.fetchall()}
                date_col = "creationDate" if "creationDate" in cols else "NULL"
                addr_col = "addressString" if "addressString" in cols else "NULL"
                rows = cursor.execute(f"""
                    SELECT latitude, longitude, name, {addr_col} AS address, {date_col} AS date
                    FROM Placemark
                    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
                """).fetchall()
                for row in rows:
                    points.append({
                        "source": "maps_favorite",
                        "latitude": float(row["latitude"]),
                        "longitude": float(row["longitude"]),
                        "date": _apple_ts(row["date"]),
                        "label": row["name"] or row["address"] or "Saved Place",
                        "address": row["address"],
                    })

            conn.close()
        except Exception as e:
            return {"points": [], "error": str(e)}

        return {"points": points, "total": len(points)}

    # ── Aggregate ─────────────────────────────────────────────────────────────

    def list_all_locations(self, backup) -> dict:
        """Aggregate location data from all available sources."""
        photo_result = self.list_photo_locations(backup)
        sig_result = self.list_significant_locations(backup)
        maps_result = self.list_map_favorites(backup)

        all_points = (
            photo_result.get("points", [])
            + sig_result.get("points", [])
            + maps_result.get("points", [])
        )

        errors: dict = {}
        if photo_result.get("error"):
            errors["photos"] = photo_result["error"]
        if sig_result.get("error"):
            errors["significant_locations"] = sig_result["error"]
        if maps_result.get("error"):
            errors["maps"] = maps_result["error"]

        return {
            "points": all_points,
            "total": len(all_points),
            "counts": {
                "photos": len(photo_result.get("points", [])),
                "significant_locations": len(sig_result.get("points", [])),
                "maps_favorites": len(maps_result.get("points", [])),
            },
            "errors": errors if errors else None,
        }

    # ── Export ────────────────────────────────────────────────────────────────

    def export_locations(self, backup, output_dir: str, fmt: str = "csv") -> dict:
        """Export all location data to CSV or GeoJSON."""
        result = self.list_all_locations(backup)
        points = result.get("points", [])

        if not points:
            return {"success": False, "error": "No location data found."}

        os.makedirs(output_dir, exist_ok=True)

        if fmt == "geojson":
            path = os.path.join(output_dir, "locations_export.geojson")
            features = [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [p["longitude"], p["latitude"]],
                    },
                    "properties": {
                        "source": p.get("source"),
                        "label": p.get("label"),
                        "date": p.get("date"),
                        "address": p.get("address"),
                    },
                }
                for p in points
            ]
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"type": "FeatureCollection", "features": features}, f, indent=2)
        else:
            path = os.path.join(output_dir, "locations_export.csv")
            with open(path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Source", "Label", "Latitude", "Longitude", "Date", "Address"])
                for p in points:
                    writer.writerow([
                        p.get("source", ""),
                        p.get("label", ""),
                        p.get("latitude", ""),
                        p.get("longitude", ""),
                        p.get("date", ""),
                        p.get("address", ""),
                    ])

        return {"success": True, "path": path, "count": len(points)}
