"""Read-only SQLite helper functions.

Provides safe, read-only access to SQLite databases found in iPhone backups.
All connections are opened in read-only mode with WAL journal support.
"""

import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("openextract.sqlite_helpers")


def open_readonly(path: Path) -> sqlite3.Connection:
    """Open a SQLite database in read-only mode with WAL journal support.

    Args:
        path: Path to the SQLite database file.

    Returns:
        A sqlite3.Connection with row_factory set to sqlite3.Row.

    Raises:
        sqlite3.Error: If the database cannot be opened.
        FileNotFoundError: If the database file does not exist.
    """
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path}")

    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    # Enable WAL reading without requiring write access
    try:
        conn.execute("PRAGMA journal_mode=wal")
    except sqlite3.OperationalError:
        pass  # Read-only mode may prevent setting journal mode; that's fine
    return conn


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    """Check if a table exists in the database.

    Args:
        conn: An open SQLite connection.
        table_name: Name of the table to check.

    Returns:
        True if the table exists, False otherwise.
    """
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (table_name,),
    )
    return cur.fetchone() is not None


def column_exists(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    """Check if a column exists in a table.

    Args:
        conn: An open SQLite connection.
        table_name: Name of the table.
        column_name: Name of the column to check.

    Returns:
        True if the column exists in the table, False otherwise.
    """
    try:
        cur = conn.execute(f"PRAGMA table_info({table_name})")
        columns = [row[1] for row in cur.fetchall()]
        return column_name in columns
    except sqlite3.Error:
        return False


def safe_query(
    conn: sqlite3.Connection,
    sql: str,
    params: Optional[tuple[Any, ...]] = None,
) -> list[dict[str, Any]]:
    """Execute a query and return results as a list of dicts.

    On any error, logs a warning and returns an empty list rather than
    raising an exception. This is useful for extractors that should
    degrade gracefully when encountering schema differences across
    iOS versions.

    Args:
        conn: An open SQLite connection.
        sql: SQL query to execute.
        params: Optional tuple of query parameters.

    Returns:
        A list of dictionaries, one per row. Empty list on error.
    """
    if params is None:
        params = ()
    try:
        cur = conn.execute(sql, params)
        rows = cur.fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error as e:
        log.warning("Query failed: %s — %s", sql.strip()[:120], e)
        return []
