"""Backup discovery and session management routes."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from openextract.core import discover_backups
from openextract.core.backup import BackupReader

from ..state import state

router = APIRouter(prefix="/backups", tags=["backups"])


class OpenBackupRequest(BaseModel):
    path: str
    password: str | None = None


class OpenBackupResponse(BaseModel):
    session_key: str
    message: str = "Backup opened."


@router.get("/discover")
def discover(search_path: str | None = None):
    """Discover iPhone backups in the default or specified directory."""
    path = Path(search_path) if search_path else None
    backups = discover_backups(path)
    return [b.model_dump() if hasattr(b, "model_dump") else b.__dict__ for b in backups]


@router.post("/open", response_model=OpenBackupResponse)
def open_backup(req: OpenBackupRequest):
    """Open a backup (encrypted or unencrypted) and start a session."""
    try:
        key = state.open_backup(req.path, req.password)
        return OpenBackupResponse(session_key=key)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        msg = str(exc)
        if "password_required" in msg:
            raise HTTPException(status_code=401, detail="Backup is encrypted. Provide a password.")
        if "wrong_password" in msg:
            raise HTTPException(status_code=403, detail="Incorrect backup password.")
        raise HTTPException(status_code=400, detail=msg)


@router.post("/validate-password")
def validate_password(path: str, password: str):
    """Check whether a password is correct for an encrypted backup without opening a session."""
    try:
        valid = BackupReader.validate_password(path, password)
        return {"valid": valid}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/sessions")
def list_sessions():
    """List all currently open backup sessions."""
    return {"sessions": state.list_open_sessions()}


@router.delete("/sessions/{session_key:path}")
def close_session(session_key: str):
    """Close an open backup session and free resources."""
    state.close_backup(session_key)
    return {"message": "Session closed."}
