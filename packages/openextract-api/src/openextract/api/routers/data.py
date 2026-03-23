"""Contacts, calls, voicemail, notes, and photos routes."""
from __future__ import annotations

import base64

from fastapi import APIRouter, HTTPException, Query

from ..state import state

router = APIRouter(tags=["data"])


def _get_backup(session: str):
    try:
        return state.get_backup(session)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No open session: {session}")


# ── Contacts ─────────────────────────────────────────────────────────────────

@router.get("/contacts", tags=["contacts"])
def list_contacts(session: str):
    backup = _get_backup(session)
    try:
        return [c.model_dump() for c in backup.contacts.list_contacts()]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Calls ─────────────────────────────────────────────────────────────────────

@router.get("/calls", tags=["calls"])
def list_calls(
    session: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
):
    backup = _get_backup(session)
    try:
        return [c.model_dump() for c in backup.calls.list_calls(offset=offset, limit=limit)]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Voicemail ─────────────────────────────────────────────────────────────────

@router.get("/voicemail", tags=["voicemail"])
def list_voicemails(session: str):
    backup = _get_backup(session)
    try:
        return [v.model_dump() for v in backup.voicemail.list_voicemails()]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/voicemail/{voicemail_id}/audio", tags=["voicemail"])
def get_voicemail_audio(voicemail_id: int, session: str):
    backup = _get_backup(session)
    data = backup.voicemail.get_audio_bytes(voicemail_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Audio not found.")
    return {"data": base64.b64encode(data).decode(), "size_bytes": len(data)}


# ── Notes ─────────────────────────────────────────────────────────────────────

@router.get("/notes", tags=["notes"])
def list_notes(session: str):
    backup = _get_backup(session)
    try:
        return [n.model_dump() for n in backup.notes.list_notes()]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── Photos ────────────────────────────────────────────────────────────────────

@router.get("/photos/albums", tags=["photos"])
def list_albums(session: str):
    backup = _get_backup(session)
    try:
        return [a.model_dump() for a in backup.photos.list_albums()]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/photos/assets", tags=["photos"])
def list_assets(
    session: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    album_id: int | None = None,
):
    backup = _get_backup(session)
    try:
        return [a.model_dump() for a in backup.photos.list_assets(
            offset=offset, limit=limit, album_id=album_id
        )]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/photos/assets/{file_hash}/thumbnail", tags=["photos"])
def get_thumbnail(file_hash: str, session: str, size: int = Query(256, ge=32, le=1024)):
    from fastapi.responses import Response
    backup = _get_backup(session)
    data = backup.photos.get_thumbnail_bytes(file_hash, size=size)
    if data is None:
        raise HTTPException(status_code=404, detail="Asset not found.")
    return Response(content=data, media_type="image/jpeg")


@router.get("/photos/assets/{file_hash}/raw", tags=["photos"])
def get_asset_raw(file_hash: str, session: str):
    from fastapi.responses import Response
    backup = _get_backup(session)
    data = backup.photos.get_asset_bytes(file_hash)
    if data is None:
        raise HTTPException(status_code=404, detail="Asset not found.")
    return Response(content=data, media_type="application/octet-stream")
