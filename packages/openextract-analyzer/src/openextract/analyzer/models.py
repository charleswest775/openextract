"""Pydantic models for all analysis outputs."""
from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


# ── Relationship graph ──────────────────────────────────────────────────────

class ContactSummary(BaseModel):
    identifier: str
    """Phone/email."""
    display_name: str | None = None
    messages_sent: int = 0
    messages_received: int = 0
    total_messages: int = 0
    first_contact: datetime | None = None
    last_contact: datetime | None = None
    avg_response_seconds: float | None = None
    avg_message_length: float = 0.0
    top_hours: list[int] = []
    """Hours of day (0-23) this contact is most active."""


class RelationshipGraph(BaseModel):
    contacts: list[ContactSummary]
    total_conversations: int
    total_messages: int
    date_range_start: datetime | None = None
    date_range_end: datetime | None = None


# ── Activity patterns ───────────────────────────────────────────────────────

class ActivityPattern(BaseModel):
    hour_of_day: dict[int, int]
    """Hour (0-23) → message count."""
    day_of_week: dict[int, int]
    """Weekday (0=Mon, 6=Sun) → message count."""
    month_of_year: dict[int, int]
    """Month (1-12) → message count."""
    daily_counts: dict[str, int]
    """ISO date string → message count. For heatmap rendering."""


# ── Timeline & topics ───────────────────────────────────────────────────────

class TimelineEvent(BaseModel):
    date: datetime
    event_type: str
    """'message_burst', 'new_contact', 'media_heavy', 'silence', 'high_activity'."""
    description: str
    participants: list[str] = []
    magnitude: float = 1.0
    """Relative significance 0–1."""


class Topic(BaseModel):
    label: str
    keywords: list[str]
    message_count: int
    representative_phrases: list[str] = []
    first_seen: datetime | None = None
    last_seen: datetime | None = None


class ConversationCluster(BaseModel):
    conversation_id: int
    display_name: str | None
    primary_topics: list[str]
    message_count: int
    date_range_start: datetime | None
    date_range_end: datetime | None


class TopicAnalysis(BaseModel):
    topics: list[Topic]
    conversation_clusters: list[ConversationCluster]
    timeline_events: list[TimelineEvent]


# ── AI synthesis ────────────────────────────────────────────────────────────

class AIChunk(BaseModel):
    index: int
    source: str
    """Data domain: 'messages', 'calls', 'notes', etc."""
    token_estimate: int
    content: str
    """Pre-formatted text block ready for LLM context."""
    metadata: dict = {}


class AISynthesisResult(BaseModel):
    total_token_estimate: int
    chunks: list[AIChunk]
    summary_json: dict
    """Structured JSON summary of the backup owner's digital life."""


# ── Full analysis result ────────────────────────────────────────────────────

class AnalysisResult(BaseModel):
    backup_path: str
    completed_at: datetime
    relationship_graph: RelationshipGraph
    activity_patterns: ActivityPattern
    topic_analysis: TopicAnalysis
    synthesis: AISynthesisResult | None = None
