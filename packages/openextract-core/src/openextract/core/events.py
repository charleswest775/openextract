"""Shared event model used across all openextract components."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class Event:
    """Progress/status event emitted by long-running operations.

    Consumers iterate over async generators of Event objects, enabling
    any transport layer (SSE, WebSocket, stdout) to forward them.
    """

    component: str
    """Package that emitted this event, e.g. 'backup', 'analyzer'."""

    stage: str
    """Component-defined stage name, e.g. 'loading', 'clustering'."""

    progress: float
    """Completion fraction 0.0 – 1.0."""

    message: str
    """Human-readable status string."""

    detail: dict[str, Any] = field(default_factory=dict)
    """Optional structured payload (component-specific)."""

    timestamp: datetime = field(default_factory=datetime.utcnow)

    def as_sse(self) -> str:
        """Render as a Server-Sent Events data line."""
        import json

        payload = {
            "component": self.component,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "message": self.message,
            "detail": self.detail,
            "timestamp": self.timestamp.isoformat(),
        }
        return f"data: {json.dumps(payload)}\n\n"
