"""Analysis routes with SSE streaming progress."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from openextract.analyzer import Analyzer

from ..state import state

router = APIRouter(prefix="/analysis", tags=["analysis"])


@router.get("/{session_key:path}/run")
async def run_analysis(
    session_key: str,
    token_budget: int = Query(100_000, ge=1000, le=2_000_000),
):
    """Stream analysis progress via Server-Sent Events.

    Connect to this endpoint and consume the event stream. When the final
    'complete' event arrives, results are available via GET /analysis/{key}.

    Example (curl)::

        curl -N "http://localhost:8000/analysis/run?session=/path/to/backup"
    """
    # Validate session exists
    try:
        state.get_backup(session_key)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No open session: {session_key}")

    async def event_stream():
        analyzer = Analyzer(backup_path=session_key)
        try:
            async for event in analyzer.run(token_budget=token_budget):
                yield event.as_sse()
                if event.stage == "complete":
                    # Store result for later retrieval
                    state.store_analysis(session_key, analyzer.result())
        except Exception as exc:
            error_payload = json.dumps({
                "component": "analyzer",
                "stage": "error",
                "progress": 0.0,
                "message": str(exc),
            })
            yield f"data: {error_payload}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/{session_key:path}")
def get_analysis(session_key: str):
    """Return the stored analysis result for a session."""
    result = state.get_analysis(session_key)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail="No analysis result found. Run /analysis/{key}/run first.",
        )
    return result.model_dump()


@router.get("/{session_key:path}/ai-chunks")
def get_ai_chunks(
    session_key: str,
    budget: int = Query(100_000, ge=1000, le=2_000_000),
):
    """Return LLM-ready text chunks filtered to a token budget."""
    result = state.get_analysis(session_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Run analysis first.")
    if result.synthesis is None:
        return {"chunks": []}
    total = 0
    chunks = []
    for chunk in result.synthesis.chunks:
        if total + chunk.token_estimate > budget:
            break
        chunks.append(chunk.model_dump())
        total += chunk.token_estimate
    return {"total_tokens": total, "chunks": chunks}


@router.get("/{session_key:path}/report.html")
def get_report_html(session_key: str):
    """Return the analysis as a self-contained HTML report."""
    from fastapi.responses import HTMLResponse
    from openextract.analyzer.report import render_html

    result = state.get_analysis(session_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Run analysis first.")
    return HTMLResponse(content=render_html(result))


@router.get("/{session_key:path}/report.pdf")
def get_report_pdf(session_key: str):
    """Return the analysis as a PDF (requires weasyprint)."""
    from fastapi.responses import Response
    from openextract.analyzer.report import render_pdf

    result = state.get_analysis(session_key)
    if result is None:
        raise HTTPException(status_code=404, detail="Run analysis first.")
    try:
        pdf_bytes = render_pdf(result)
        return Response(content=pdf_bytes, media_type="application/pdf")
    except ImportError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
