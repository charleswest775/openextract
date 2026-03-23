"""Message and conversation routes."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..state import state

router = APIRouter(prefix="/messages", tags=["messages"])


def _get_backup(session_key: str):
    try:
        return state.get_backup(session_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No open session: {session_key}")


@router.get("/conversations")
def list_conversations(session: str):
    """List all conversations in an open backup."""
    backup = _get_backup(session)
    try:
        convos = backup.messages.list_conversations()
        return [c.model_dump() for c in convos]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/conversations/{chat_id}")
def get_messages(
    chat_id: int,
    session: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
):
    """Get paginated messages for a conversation."""
    backup = _get_backup(session)
    try:
        messages = backup.messages.get_messages(
            chat_id=chat_id,
            offset=offset,
            limit=limit,
            date_from=date_from,
            date_to=date_to,
        )
        return [m.model_dump() for m in messages]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/search")
def search_messages(
    session: str,
    q: str,
    chat_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    """Full-text message search."""
    backup = _get_backup(session)
    try:
        results = backup.messages.search_messages(query=q, chat_id=chat_id, limit=limit)
        return [m.model_dump() for m in results]
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/attachments/{attachment_id}")
def get_attachment(attachment_id: int, session: str):
    """Return attachment bytes as base64."""
    import base64

    backup = _get_backup(session)
    data = backup.messages.get_attachment_bytes(attachment_id)
    if data is None:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    return {"data": base64.b64encode(data).decode(), "size_bytes": len(data)}
