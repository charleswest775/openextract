"""Main Analyzer: orchestrates all analysis passes over a backup."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator

from openextract.core import Backup
from openextract.core.events import Event
from openextract.core.models import (
    Call,
    Contact,
    Conversation,
    Message,
    Note,
    Voicemail,
)

from .communication import build_activity_patterns, build_relationship_graph
from .models import AnalysisResult
from .report import render_html, render_pdf, save_report
from .synthesis import build_synthesis
from .timeline import build_topic_analysis


class Analyzer:
    """Run all analysis passes over an iPhone backup.

    Usage::

        analyzer = Analyzer("/path/to/backup", password="optional")
        async for event in analyzer.run():
            print(event.message, event.progress)

        result = analyzer.result()
        html = analyzer.report_html()
        chunks = analyzer.ai_chunks(budget=80_000)

    The run() method must be awaited before accessing results.
    """

    def __init__(self, backup_path: str | Path, password: str | None = None):
        self._backup_path = Path(backup_path)
        self._password = password
        self._result: AnalysisResult | None = None

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    async def run(self, token_budget: int = 100_000) -> AsyncGenerator[Event, None]:
        """Run all analysis passes. Yields progress events."""

        def _evt(stage: str, progress: float, message: str, **detail) -> Event:
            return Event(
                component="analyzer",
                stage=stage,
                progress=progress,
                message=message,
                detail=dict(detail),
            )

        yield _evt("loading", 0.02, "Opening backup…")

        with Backup.open(str(self._backup_path), self._password) as backup:

            # ── Load contacts ──────────────────────────────────────────────
            yield _evt("loading", 0.05, "Loading contacts…")
            try:
                contacts: list[Contact] = backup.contacts.list_contacts()
            except Exception:
                contacts = []
            yield _evt("loading", 0.10, f"Loaded {len(contacts)} contacts.")

            # ── Load conversations ─────────────────────────────────────────
            yield _evt("loading", 0.12, "Loading conversations…")
            try:
                conversations: list[Conversation] = backup.messages.list_conversations()
            except Exception:
                conversations = []
            yield _evt("loading", 0.16, f"Found {len(conversations)} conversations.")

            # ── Load messages (paginated per conversation) ─────────────────
            yield _evt("loading", 0.18, "Loading messages…")
            messages_by_chat: dict[int, list[Message]] = {}
            total_loaded = 0
            for i, convo in enumerate(conversations):
                try:
                    msgs = backup.messages.get_messages(convo.id, limit=2000)
                    messages_by_chat[convo.id] = msgs
                    total_loaded += len(msgs)
                except Exception:
                    messages_by_chat[convo.id] = []
                progress = 0.18 + (i / max(len(conversations), 1)) * 0.20
                if i % 10 == 0:
                    yield _evt("loading", progress, f"Loading messages… {total_loaded:,} so far")
            yield _evt("loading", 0.38, f"Loaded {total_loaded:,} messages across {len(conversations)} conversations.")

            # ── Load calls ─────────────────────────────────────────────────
            yield _evt("loading", 0.40, "Loading call history…")
            try:
                calls: list[Call] = backup.calls.list_calls(limit=5000)
            except Exception:
                calls = []
            yield _evt("loading", 0.43, f"Loaded {len(calls)} call records.")

            # ── Load voicemails ────────────────────────────────────────────
            yield _evt("loading", 0.44, "Loading voicemails…")
            try:
                voicemails: list[Voicemail] = backup.voicemail.list_voicemails()
            except Exception:
                voicemails = []

            # ── Load notes ─────────────────────────────────────────────────
            yield _evt("loading", 0.46, "Loading notes…")
            try:
                notes: list[Note] = backup.notes.list_notes()
            except Exception:
                notes = []
            yield _evt("loading", 0.48, f"Loaded {len(notes)} notes.")

        # ── Analysis passes (outside backup context — data is in memory) ───

        yield _evt("analyzing", 0.50, "Building relationship graph…")
        relationship_graph = build_relationship_graph(conversations, messages_by_chat)
        yield _evt(
            "analyzing", 0.60,
            f"Identified {len(relationship_graph.contacts)} contacts in communication data.",
            top_contact=relationship_graph.contacts[0].display_name if relationship_graph.contacts else None,
        )

        yield _evt("analyzing", 0.62, "Computing activity patterns…")
        activity_patterns = build_activity_patterns(messages_by_chat)

        yield _evt("analyzing", 0.65, "Clustering topics and building timeline…")
        topic_analysis = build_topic_analysis(conversations, messages_by_chat, notes)
        yield _evt(
            "analyzing", 0.75,
            f"Found {len(topic_analysis.topics)} topic clusters, "
            f"{len(topic_analysis.timeline_events)} timeline events.",
        )

        yield _evt("synthesizing", 0.78, "Distilling data for AI synthesis…")
        synthesis = build_synthesis(
            conversations=conversations,
            messages_by_chat=messages_by_chat,
            contacts=contacts,
            calls=calls,
            notes=notes,
            graph=relationship_graph,
            token_budget=token_budget,
        )
        yield _evt(
            "synthesizing", 0.92,
            f"Synthesis complete: {synthesis.total_token_estimate:,} tokens across {len(synthesis.chunks)} chunks.",
            token_estimate=synthesis.total_token_estimate,
            chunks=len(synthesis.chunks),
        )

        self._result = AnalysisResult(
            backup_path=str(self._backup_path),
            completed_at=datetime.now(tz=timezone.utc),
            relationship_graph=relationship_graph,
            activity_patterns=activity_patterns,
            topic_analysis=topic_analysis,
            synthesis=synthesis,
        )

        yield _evt("complete", 1.0, "Analysis complete.", backup_path=str(self._backup_path))

    # ------------------------------------------------------------------
    # Result accessors
    # ------------------------------------------------------------------

    def result(self) -> AnalysisResult:
        if self._result is None:
            raise RuntimeError("run() must be awaited before accessing results.")
        return self._result

    def ai_chunks(self, budget: int = 100_000) -> list:
        """Return LLM-ready chunks, optionally re-filtered to a token budget."""
        synthesis = self.result().synthesis
        if synthesis is None:
            return []
        total = 0
        filtered = []
        for chunk in synthesis.chunks:
            if total + chunk.token_estimate > budget:
                break
            filtered.append(chunk)
            total += chunk.token_estimate
        return filtered

    def report_html(self) -> str:
        return render_html(self.result())

    def report_pdf(self) -> bytes:
        return render_pdf(self.result())

    def save_report(self, path: str | Path, fmt: str = "html") -> Path:
        return save_report(self.result(), path, fmt)
