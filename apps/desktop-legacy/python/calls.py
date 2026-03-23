"""
Call history extraction from CallHistory.storedata.
"""

import sqlite3
import csv
import os
from messages import apple_date_to_iso


class CallExtractor:
    """Extracts call history from iOS backups."""

    CALL_HISTORY_PATH = "Library/CallHistoryDB/CallHistory.storedata"

    def _clean_phone_number(self, address: str) -> str:
        """Strip non-numeric characters for better matching, except +."""
        if not address:
            return ""
        return ''.join(c for c in address if c.isdigit() or c == '+')

    def _resolve_contact(self, address: str, contacts: dict) -> str:
        if not address:
            return "Unknown"
        
        # Exact match
        if address in contacts:
            return contacts[address]
        
        clean_address = self._clean_phone_number(address)
        if not clean_address:
            # Maybe it's an email (FaceTime)
            if "@" in address and address.lower() in contacts:
                return contacts[address.lower()]
            return address

        # Clean match
        if clean_address in contacts:
            return contacts[clean_address]
        
        # Try US country code variants
        if len(clean_address) == 10 and f"+1{clean_address}" in contacts:
            return contacts[f"+1{clean_address}"]
        if clean_address.startswith("+1") and clean_address[2:] in contacts:
            return contacts[clean_address[2:]]
        
        return address

    def list_calls(self, backup, contacts: dict,
                   offset: int = 0, limit: int = 200) -> dict:
        """List call history records."""
        db_path = backup.get_file(self.CALL_HISTORY_PATH, domain="HomeDomain")
        if not db_path:
            db_path = backup.get_file(self.CALL_HISTORY_PATH, domain="WirelessDomain")
        if not db_path:
            # Maybe iOS 10- path
            db_path = backup.get_file("Library/CallHistory/call_history.db", domain="WirelessDomain")
        
        if not db_path:
            return {"calls": [], "error": "Call history not found. Apple requires backups to be encrypted to include call logs. Please enable 'Encrypt local backup' in iTunes/Finder and back up your device again."}

        calls = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            try:
                # The schema varies by iOS version - try the newer format first
                # Check column availability
                cursor.execute("PRAGMA table_info(ZCALLRECORD)")
                columns = [info[1] for info in cursor.fetchall()]
                
                service_col = "ZSERVICE_PROVIDER" if "ZSERVICE_PROVIDER" in columns else "NULL"
                video_col = "ZIS_VIDEO" if "ZIS_VIDEO" in columns else "NULL"

                query = f"""
                    SELECT
                        Z_PK,
                        ZADDRESS AS address,
                        ZDATE AS date,
                        ZDURATION AS duration,
                        ZCALLTYPE AS call_type,
                        ZORIGINATED AS originated,
                        ZANSWERED AS answered,
                        {service_col} AS service_provider,
                        {video_col} AS is_video
                    FROM ZCALLRECORD
                    ORDER BY ZDATE DESC
                    LIMIT ? OFFSET ?
                """
                rows = cursor.execute(query, (limit, offset)).fetchall()
                total = cursor.execute("SELECT COUNT(*) FROM ZCALLRECORD").fetchone()[0]
            except sqlite3.Error:
                # Try older iOS format
                rows = cursor.execute("""
                    SELECT
                        ROWID AS Z_PK,
                        address,
                        date,
                        duration,
                        flags AS call_type,
                        read AS answered,
                        NULL AS originated,
                        NULL AS service_provider,
                        NULL AS is_video
                    FROM call
                    ORDER BY date DESC
                    LIMIT ? OFFSET ?
                """, (limit, offset)).fetchall()
                total = cursor.execute("SELECT COUNT(*) FROM call").fetchone()[0]

            for row in rows:
                address = row["address"] or ""
                contact_name = self._resolve_contact(address, contacts)

                originated = row["originated"]
                answered = row["answered"]

                # Determine direction
                if originated is not None:
                    direction = "outgoing" if originated else "incoming"
                else:
                    direction = "outgoing" if row.get("call_type", 0) == 5 else "incoming"

                # Determine status
                if answered is not None:
                    status = "answered" if answered else "missed"
                else:
                    if direction == "incoming":
                        status = "answered" if row.get("duration", 0) > 0 else "missed"
                    else:
                        status = "answered"

                # App determination
                provider = row["service_provider"]
                app_name = "Phone"
                if provider:
                    p_lower = provider.lower()
                    if "facetime" in p_lower:
                        app_name = "FaceTime Video" if row["is_video"] else "FaceTime Audio"
                    elif "whatsapp" in p_lower:
                        app_name = "WhatsApp"
                    elif "skype" in p_lower:
                        app_name = "Skype"
                    elif "messenger" in p_lower:
                        app_name = "Messenger"
                    elif "telegram" in p_lower:
                        app_name = "Telegram"
                    elif "viber" in p_lower:
                        app_name = "Viber"
                    elif "signal" in p_lower:
                        app_name = "Signal"
                    elif "instagram" in p_lower:
                        app_name = "Instagram"
                    elif "telephony" not in p_lower:
                        app_name = provider  # fallback generic

                calls.append({
                    "call_id": row["Z_PK"],
                    "address": address,
                    "contact_name": contact_name,
                    "date": apple_date_to_iso(row["date"]),
                    "duration": row["duration"],
                    "direction": direction,
                    "status": status,
                    "app": app_name,
                })

            conn.close()
        except Exception as e:
             return {"calls": [], "error": str(e)}

        return {
            "calls": calls,
            "total": total if 'total' in locals() else len(calls),
            "offset": offset,
            "limit": limit,
        }

    def export_calls_csv(self, backup, contacts: dict, output_dir: str) -> dict:
        """Export all calls to a CSV file."""
        # Get all calls by ignoring limit
        result = self.list_calls(backup, contacts, limit=999999)
        calls = result.get("calls", [])
        
        if not calls:
            return {"success": False, "error": "No calls found to export."}
        
        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "calls_export.csv")
            
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Contact Name", "Phone/Email", "Direction", "Status", "Duration (s)", "App/Service"])
                for call in calls:
                    writer.writerow([
                        call["date"],
                        call["contact_name"],
                        call["address"],
                        call["direction"].capitalize(),
                        call["status"].capitalize(),
                        call["duration"],
                        call["app"]
                    ])
                    
            return {"success": True, "path": output_path, "count": len(calls)}
        except Exception as e:
            return {"success": False, "error": str(e)}
