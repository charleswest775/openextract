"""Apple Wallet / Passes extractor.

Parses passes23.sqlite for Wallet passes (boarding passes, loyalty cards, etc.)
and payment transaction history if available.
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class WalletExtractor(ArtifactExtractor):
    """Extract Apple Wallet passes and payment transactions."""

    ARTIFACT_TYPE = "wallet"
    SUPPORTED_IOS_VERSIONS = range(11, 19)

    DB_DOMAIN = "HomeDomain"
    DB_RELATIVE_PATH = "Library/Passes/passes23.sqlite"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        db_path = self.resolve_db_path(self.DB_DOMAIN, self.DB_RELATIVE_PATH)
        if db_path is None:
            self.log.info("passes23.sqlite not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            db_name = str(db_path)

            artifacts.extend(self._extract_passes(conn, db_name))
            artifacts.extend(self._extract_transactions(conn, db_name))

            self.log.info("Extracted %d wallet artifacts", len(artifacts))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract wallet data: %s", e)
            return []
        finally:
            conn.close()

    def _extract_passes(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZPASS"):
            self.log.info("ZPASS table not found")
            return []

        # Query available columns — schema varies across iOS versions
        columns = self._get_columns(conn, "ZPASS")

        select_cols = ["Z_PK"]
        if "ZPASSTYPEID" in columns:
            select_cols.append("ZPASSTYPEID")
        if "ZORGANIZATIONNAME" in columns:
            select_cols.append("ZORGANIZATIONNAME")
        if "ZSERIALNUMBER" in columns:
            select_cols.append("ZSERIALNUMBER")
        if "ZINGESTEDDATE" in columns:
            select_cols.append("ZINGESTEDDATE")
        if "ZMODIFIEDDATE" in columns:
            select_cols.append("ZMODIFIEDDATE")
        if "ZENCODEDSPASS" in columns:
            # Skip binary blob columns
            pass

        query = f"SELECT {', '.join(select_cols)} FROM ZPASS"

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("ZPASS query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            row_dict = dict(row)

            # Use ingested or modified date as timestamp
            ts_val = row_dict.get("ZINGESTEDDATE") or row_dict.get("ZMODIFIEDDATE")
            ts = from_cocoa(ts_val) if ts_val is not None else None

            org_name = row_dict.get("ZORGANIZATIONNAME", "")
            pass_type = row_dict.get("ZPASSTYPEID", "")
            serial = row_dict.get("ZSERIALNUMBER", "")

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZPASS",
                    source_row_id=row_dict["Z_PK"],
                ),
                text_content=org_name if org_name else None,
                data={
                    "category": "pass",
                    "pass_type_id": pass_type,
                    "organization_name": org_name,
                    "serial_number": serial,
                },
            ))

        return artifacts

    def _extract_transactions(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZPAYMENTTRANSACTION"):
            self.log.info("ZPAYMENTTRANSACTION table not found — may not exist on this device")
            return []

        columns = self._get_columns(conn, "ZPAYMENTTRANSACTION")

        select_cols = ["Z_PK"]
        if "ZAMOUNT" in columns:
            select_cols.append("ZAMOUNT")
        if "ZTRANSACTIONDATE" in columns:
            select_cols.append("ZTRANSACTIONDATE")
        if "ZMERCHANTNAME" in columns:
            select_cols.append("ZMERCHANTNAME")
        if "ZTRANSACTIONSTATUS" in columns:
            select_cols.append("ZTRANSACTIONSTATUS")
        if "ZCURRENCYCODE" in columns:
            select_cols.append("ZCURRENCYCODE")

        query = f"SELECT {', '.join(select_cols)} FROM ZPAYMENTTRANSACTION"

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Payment transaction query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            row_dict = dict(row)

            ts_val = row_dict.get("ZTRANSACTIONDATE")
            ts = from_cocoa(ts_val) if ts_val is not None else None

            merchant = row_dict.get("ZMERCHANTNAME", "")
            amount = row_dict.get("ZAMOUNT")
            status = row_dict.get("ZTRANSACTIONSTATUS", "")
            currency = row_dict.get("ZCURRENCYCODE", "")

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZPAYMENTTRANSACTION",
                    source_row_id=row_dict["Z_PK"],
                ),
                text_content=merchant if merchant else None,
                contact_name=merchant if merchant else None,
                data={
                    "category": "transaction",
                    "amount": amount,
                    "currency": currency,
                    "merchant": merchant,
                    "status": status,
                },
            ))

        return artifacts

    @staticmethod
    def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
        try:
            cur = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                (table_name,),
            )
            return cur.fetchone() is not None
        except sqlite3.Error:
            return False

    @staticmethod
    def _get_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
        try:
            cur = conn.execute(f"PRAGMA table_info({table_name})")
            return {row[1] for row in cur.fetchall()}
        except sqlite3.Error:
            return set()
