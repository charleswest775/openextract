"""AI synthesis: distill backup data into LLM-ready chunks.

No external ML/LLM dependencies. All distillation is deterministic:
  - Token estimation via word-count heuristic (~1.3 tokens/word)
  - Priority scoring based on recency + contact frequency
  - Structured JSON summary for downstream consumption
  - Pre-chunked text blocks ready to pass to any LLM API
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from openextract.core.models import (
    Call,
    Contact,
    Conversation,
    Message,
    Note,
    Voicemail,
)

from .models import AIChunk, AISynthesisResult, RelationshipGraph


# ── Token estimation ─────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """Approximate token count. Rule of thumb: ~1.3 tokens per word."""
    words = len(re.findall(r"\S+", text))
    return int(words * 1.3) + 1


# ── Priority scoring ──────────────────────────────────────────────────────────

def _message_priority(msg: Message, contact_rank: dict[str, int]) -> float:
    """Higher score = more important to include in distillation."""
    score = 0.0

    # Recency: messages in last 90 days score higher
    if msg.timestamp:
        age_days = (datetime.now(tz=timezone.utc) - msg.timestamp).days
        score += max(0, 1.0 - age_days / 365)

    # Contact rank: more frequent contacts score higher
    rank = contact_rank.get(msg.sender, 999)
    score += max(0, 1.0 - rank / 50)

    # Content richness: longer messages score higher (up to a cap)
    if msg.text:
        score += min(len(msg.text) / 500, 0.5)

    # Has attachments
    if msg.attachments:
        score += 0.2

    return score


# ── Conversation summariser ───────────────────────────────────────────────────

def _summarise_conversation(
    convo: Conversation,
    messages: list[Message],
    max_messages: int = 20,
) -> str:
    """Convert a conversation to a readable text summary."""
    name = (
        convo.display_name
        or (convo.participant_names[0] if convo.participant_names else convo.participants[0] if convo.participants else "Unknown")
    )
    lines = [f"=== Conversation with {name} ==="]
    lines.append(f"Total messages: {convo.message_count}")
    if convo.last_message_at:
        lines.append(f"Last active: {convo.last_message_at.strftime('%Y-%m-%d')}")
    lines.append("")

    for msg in messages[-max_messages:]:
        speaker = "Me" if msg.is_from_me else (msg.sender_name or msg.sender)
        ts = msg.timestamp.strftime("%Y-%m-%d %H:%M") if msg.timestamp else "?"
        text = msg.text or "[attachment]"
        lines.append(f"[{ts}] {speaker}: {text[:200]}")

    return "\n".join(lines)


def _summarise_calls(calls: list[Call], top_n: int = 50) -> str:
    lines = ["=== Call History (recent) ==="]
    for call in calls[:top_n]:
        name = call.contact_name or call.address
        ts = call.timestamp.strftime("%Y-%m-%d") if call.timestamp else "?"
        dur = f"{int(call.duration_seconds // 60)}m {int(call.duration_seconds % 60)}s"
        lines.append(f"{ts} | {call.direction.value} | {name} | {dur}")
    return "\n".join(lines)


def _summarise_notes(notes: list[Note], max_body: int = 300) -> str:
    lines = ["=== Notes ==="]
    for note in notes[:30]:
        title = note.title or "(Untitled)"
        date = note.modified_at.strftime("%Y-%m-%d") if note.modified_at else "?"
        body = (note.body or "")[:max_body]
        lines.append(f"\n--- {title} ({date}) ---\n{body}")
    return "\n".join(lines)


def _summarise_contacts(contacts: list[Contact], graph: RelationshipGraph) -> str:
    """Top contacts with communication volume."""
    rank_map = {s.identifier: i for i, s in enumerate(graph.contacts)}
    lines = ["=== Top Contacts ==="]
    for contact in sorted(contacts, key=lambda c: rank_map.get(c.phones[0].number if c.phones else "", 999))[:50]:
        phone = contact.phones[0].number if contact.phones else ""
        email = contact.emails[0].address if contact.emails else ""
        stats = next((s for s in graph.contacts if s.identifier == phone or s.identifier == email), None)
        volume = stats.total_messages if stats else 0
        lines.append(f"{contact.display_name} | {phone or email} | {volume} messages")
    return "\n".join(lines)


# ── Public API ────────────────────────────────────────────────────────────────

def build_synthesis(
    conversations: list[Conversation],
    messages_by_chat: dict[int, list[Message]],
    contacts: list[Contact],
    calls: list[Call],
    notes: list[Note],
    graph: RelationshipGraph,
    token_budget: int = 100_000,
    chunk_size: int = 8_000,
) -> AISynthesisResult:
    """Distill all backup data into token-budgeted LLM-ready chunks."""

    contact_rank = {s.identifier: i for i, s in enumerate(graph.contacts)}
    chunks: list[AIChunk] = []
    total_tokens = 0
    chunk_index = 0

    # ── 1. Structured summary (always included) ──────────────────────────────
    summary_json = _build_summary_json(conversations, contacts, calls, notes, graph)
    import json
    summary_text = f"=== Backup Summary ===\n{json.dumps(summary_json, indent=2, default=str)}"
    t = estimate_tokens(summary_text)
    chunks.append(AIChunk(
        index=chunk_index,
        source="summary",
        token_estimate=t,
        content=summary_text,
        metadata={"type": "structured_summary"},
    ))
    total_tokens += t
    chunk_index += 1
    budget_remaining = token_budget - total_tokens

    # ── 2. Contacts ──────────────────────────────────────────────────────────
    contacts_text = _summarise_contacts(contacts, graph)
    t = estimate_tokens(contacts_text)
    if t <= budget_remaining:
        chunks.append(AIChunk(
            index=chunk_index,
            source="contacts",
            token_estimate=t,
            content=contacts_text,
            metadata={"contact_count": len(contacts)},
        ))
        total_tokens += t
        budget_remaining -= t
        chunk_index += 1

    # ── 3. Conversations: prioritised and chunked ────────────────────────────
    # Sort conversations by recency and contact rank
    ranked_convos = sorted(
        conversations,
        key=lambda c: (
            -(c.last_message_at.timestamp() if c.last_message_at else 0),
            contact_rank.get(c.participants[0] if c.participants else "", 999),
        ),
    )

    current_chunk_lines: list[str] = []
    current_chunk_tokens = 0

    for convo in ranked_convos:
        if budget_remaining <= 0:
            break
        msgs = messages_by_chat.get(convo.id, [])
        if not msgs:
            continue

        convo_text = _summarise_conversation(convo, msgs)
        t = estimate_tokens(convo_text)

        if current_chunk_tokens + t > chunk_size:
            # Flush current chunk
            if current_chunk_lines:
                chunk_text = "\n\n".join(current_chunk_lines)
                ct = estimate_tokens(chunk_text)
                chunks.append(AIChunk(
                    index=chunk_index,
                    source="messages",
                    token_estimate=ct,
                    content=chunk_text,
                ))
                total_tokens += ct
                budget_remaining -= ct
                chunk_index += 1
            current_chunk_lines = [convo_text]
            current_chunk_tokens = t
        else:
            current_chunk_lines.append(convo_text)
            current_chunk_tokens += t

    if current_chunk_lines and budget_remaining > 0:
        chunk_text = "\n\n".join(current_chunk_lines)
        ct = estimate_tokens(chunk_text)
        chunks.append(AIChunk(
            index=chunk_index,
            source="messages",
            token_estimate=ct,
            content=chunk_text,
        ))
        total_tokens += ct
        chunk_index += 1

    budget_remaining = token_budget - total_tokens

    # ── 4. Notes ─────────────────────────────────────────────────────────────
    if notes and budget_remaining > 0:
        notes_text = _summarise_notes(notes)
        t = estimate_tokens(notes_text)
        if t <= budget_remaining:
            chunks.append(AIChunk(
                index=chunk_index,
                source="notes",
                token_estimate=t,
                content=notes_text,
                metadata={"note_count": len(notes)},
            ))
            total_tokens += t
            chunk_index += 1
            budget_remaining -= t

    # ── 5. Calls ──────────────────────────────────────────────────────────────
    if calls and budget_remaining > 0:
        calls_text = _summarise_calls(calls)
        t = estimate_tokens(calls_text)
        if t <= budget_remaining:
            chunks.append(AIChunk(
                index=chunk_index,
                source="calls",
                token_estimate=t,
                content=calls_text,
                metadata={"call_count": len(calls)},
            ))
            total_tokens += t
            chunk_index += 1

    return AISynthesisResult(
        total_token_estimate=total_tokens,
        chunks=chunks,
        summary_json=summary_json,
    )


def _build_summary_json(
    conversations: list[Conversation],
    contacts: list[Contact],
    calls: list[Call],
    notes: list[Note],
    graph: RelationshipGraph,
) -> dict:
    """Build the structured JSON summary."""
    top_contacts = [
        {
            "name": s.display_name or s.identifier,
            "identifier": s.identifier,
            "total_messages": s.total_messages,
            "last_contact": s.last_contact.isoformat() if s.last_contact else None,
        }
        for s in graph.contacts[:20]
    ]

    total_call_minutes = sum(c.duration_seconds for c in calls) / 60

    return {
        "overview": {
            "total_conversations": graph.total_conversations,
            "total_messages": graph.total_messages,
            "total_contacts": len(contacts),
            "total_calls": len(calls),
            "total_call_minutes": round(total_call_minutes, 1),
            "total_notes": len(notes),
            "date_range": {
                "start": graph.date_range_start.isoformat() if graph.date_range_start else None,
                "end": graph.date_range_end.isoformat() if graph.date_range_end else None,
            },
        },
        "top_contacts": top_contacts,
        "communication_stats": {
            "avg_message_length": round(
                sum(s.avg_message_length for s in graph.contacts) / max(len(graph.contacts), 1), 1
            ),
            "group_conversations": sum(1 for c in conversations if c.is_group),
            "one_on_one_conversations": sum(1 for c in conversations if not c.is_group),
        },
    }
