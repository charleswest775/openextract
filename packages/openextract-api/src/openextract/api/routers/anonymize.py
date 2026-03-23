"""Anonymization routes: redact/pseudonymize data, expose diff for review."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from openextract.anonymize import Anonymizer

from ..state import state

router = APIRouter(prefix="/anonymize", tags=["anonymize"])

# In-memory store for active anonymization results (keyed by session + domain)
_anon_store: dict[str, dict] = {}


class AnonymizeRequest(BaseModel):
    strategy: Literal["redact", "pseudonymize"] = "pseudonymize"
    domain: Literal["messages", "contacts", "notes", "conversations"] = "messages"
    chat_id: int | None = None
    """Required when domain='messages'."""
    limit: int = 500


def _store_key(session: str, domain: str, chat_id: int | None) -> str:
    return f"{session}::{domain}::{chat_id or 'all'}"


@router.post("/{session_key:path}/process")
def process(session_key: str, req: AnonymizeRequest):
    """Run anonymization on the specified data domain.

    Returns the diff manifest. Original and anonymized data are held
    in memory until /approve or /discard is called.
    """
    try:
        backup = state.get_backup(session_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No open session: {session_key}")

    contacts = []
    try:
        contacts = backup.contacts.list_contacts()
    except Exception:
        pass

    anon = Anonymizer(strategy=req.strategy, contacts=contacts)
    store_key = _store_key(session_key, req.domain, req.chat_id)

    try:
        if req.domain == "messages":
            if req.chat_id is None:
                raise HTTPException(
                    status_code=400,
                    detail="chat_id is required for domain='messages'",
                )
            data = backup.messages.get_messages(req.chat_id, limit=req.limit)
            result = anon.process_messages(data)

        elif req.domain == "contacts":
            data = contacts
            result = anon.process_contacts(data)

        elif req.domain == "notes":
            data = backup.notes.list_notes()
            result = anon.process_notes(data)

        elif req.domain == "conversations":
            data = backup.messages.list_conversations()
            result = anon.process_conversations(data)

        else:
            raise HTTPException(status_code=400, detail=f"Unknown domain: {req.domain}")

    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    _anon_store[store_key] = {
        "result": result,
        "original": data,
        "strategy": req.strategy,
        "domain": req.domain,
    }

    return {
        "store_key": store_key,
        "summary": result.summary(),
        "diff": [e.model_dump() for e in result.diff[:200]],  # first 200 for preview
    }


@router.get("/{session_key:path}/diff")
def get_diff(session_key: str, domain: str, chat_id: int | None = None):
    """Return the full diff manifest for a previous anonymization run."""
    key = _store_key(session_key, domain, chat_id)
    stored = _anon_store.get(key)
    if stored is None:
        raise HTTPException(status_code=404, detail="No anonymization result found. Call /process first.")
    result = stored["result"]
    return {
        "summary": result.summary(),
        "diff": [e.model_dump() for e in result.diff],
    }


@router.post("/{session_key:path}/approve")
def approve(session_key: str, domain: str, chat_id: int | None = None, field_path: str | None = None):
    """Approve all or a specific diff entry."""
    key = _store_key(session_key, domain, chat_id)
    stored = _anon_store.get(key)
    if stored is None:
        raise HTTPException(status_code=404, detail="No anonymization result found.")
    result = stored["result"]
    if field_path:
        result.approve(field_path)
    else:
        result.approve_all()
    return {"approved": result.approved, "summary": result.summary()}


@router.get("/{session_key:path}/anonymized")
def get_anonymized(session_key: str, domain: str, chat_id: int | None = None):
    """Return the anonymized data set (after approval)."""
    key = _store_key(session_key, domain, chat_id)
    stored = _anon_store.get(key)
    if stored is None:
        raise HTTPException(status_code=404, detail="No anonymization result found.")
    result = stored["result"]
    if not result.approved:
        raise HTTPException(
            status_code=403,
            detail="Anonymized data not yet approved. Call /approve first.",
        )
    anon_data = getattr(result, "_anonymized", [])
    return [
        item.model_dump() if hasattr(item, "model_dump") else item
        for item in anon_data
    ]


@router.get("/{session_key:path}/compare")
def compare_side_by_side(session_key: str, domain: str, chat_id: int | None = None):
    """Return original and anonymized data side-by-side for review."""
    key = _store_key(session_key, domain, chat_id)
    stored = _anon_store.get(key)
    if stored is None:
        raise HTTPException(status_code=404, detail="No anonymization result found.")

    result = stored["result"]
    original = stored["original"]
    anonymized = getattr(result, "_anonymized", [])

    pairs = []
    for orig, anon in zip(original, anonymized):
        pairs.append({
            "original": orig.model_dump() if hasattr(orig, "model_dump") else orig,
            "anonymized": anon.model_dump() if hasattr(anon, "model_dump") else anon,
        })

    return {
        "domain": domain,
        "strategy": stored["strategy"],
        "summary": result.summary(),
        "pairs": pairs,
    }
