"""Exportable report generation (HTML).

Optional PDF rendering via weasyprint (install with openextract-analyzer[reports]).
HTML output works with zero optional dependencies.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .models import AnalysisResult

_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenExtract Analysis Report</title>
<style>
  :root {{
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --accent: #6c8ebf;
    --text: #e0e4ef;
    --text-muted: #8890a6;
    --green: #4caf7d;
    --yellow: #f0c040;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; padding: 40px; }}
  h1 {{ font-size: 2rem; font-weight: 700; margin-bottom: 8px; color: var(--accent); }}
  h2 {{ font-size: 1.2rem; font-weight: 600; margin: 32px 0 16px; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 8px; }}
  h3 {{ font-size: 1rem; font-weight: 600; margin-bottom: 8px; color: var(--text-muted); }}
  .subtitle {{ color: var(--text-muted); margin-bottom: 40px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }}
  .stat-card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }}
  .stat-value {{ font-size: 2rem; font-weight: 700; color: var(--accent); }}
  .stat-label {{ font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }}
  .contact-table {{ width: 100%; border-collapse: collapse; }}
  .contact-table th, .contact-table td {{ padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }}
  .contact-table th {{ color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; }}
  .contact-table tr:hover td {{ background: var(--surface); }}
  .bar {{ height: 8px; background: var(--accent); border-radius: 4px; }}
  .bar-track {{ background: var(--border); border-radius: 4px; margin-top: 4px; }}
  .topic-chip {{ display: inline-block; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 4px 12px; margin: 4px; font-size: 0.85rem; }}
  .event-item {{ border-left: 3px solid var(--accent); padding: 10px 16px; margin-bottom: 12px; }}
  .event-date {{ font-size: 0.8rem; color: var(--text-muted); }}
  .heatmap {{ display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; }}
  .heatmap-cell {{ height: 20px; border-radius: 3px; }}
  footer {{ margin-top: 60px; color: var(--text-muted); font-size: 0.8rem; text-align: center; }}
</style>
</head>
<body>
<h1>OpenExtract Analysis</h1>
<p class="subtitle">Generated {generated_at} &nbsp;·&nbsp; Backup: {backup_path}</p>

<h2>Overview</h2>
<div class="grid">
  <div class="stat-card"><div class="stat-value">{total_messages}</div><div class="stat-label">Messages</div></div>
  <div class="stat-card"><div class="stat-value">{total_conversations}</div><div class="stat-label">Conversations</div></div>
  <div class="stat-card"><div class="stat-value">{total_contacts}</div><div class="stat-label">Contacts</div></div>
  <div class="stat-card"><div class="stat-value">{total_calls}</div><div class="stat-label">Calls</div></div>
  <div class="stat-card"><div class="stat-value">{date_range_years}</div><div class="stat-label">Years of data</div></div>
</div>

<h2>Top Contacts</h2>
<table class="contact-table">
<thead><tr><th>#</th><th>Name</th><th>Messages</th><th>Last Contact</th><th>Volume</th></tr></thead>
<tbody>
{contact_rows}
</tbody>
</table>

<h2>Topics</h2>
<div style="margin-bottom:32px">
{topic_chips}
</div>

<h2>Activity by Hour of Day</h2>
<div class="heatmap" style="margin-bottom:8px">
{hour_cells}
</div>
<div style="display:flex;justify-content:space-between;color:var(--text-muted);font-size:0.75rem">
  <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
</div>

<h2>Significant Timeline Events</h2>
{timeline_events}

<footer>
  OpenExtract &mdash; open-source iPhone backup analysis &mdash;
  <a href="https://github.com/charleswest775/openextract" style="color:var(--accent)">github.com/charleswest775/openextract</a>
</footer>
</body>
</html>
"""


def _contact_rows(result: AnalysisResult) -> str:
    max_vol = max((c.total_messages for c in result.relationship_graph.contacts), default=1)
    rows = []
    for i, c in enumerate(result.relationship_graph.contacts[:30], 1):
        name = c.display_name or c.identifier
        last = c.last_contact.strftime("%Y-%m-%d") if c.last_contact else "—"
        pct = int(c.total_messages / max_vol * 100)
        rows.append(
            f'<tr><td>{i}</td><td>{name}</td><td>{c.total_messages}</td><td>{last}</td>'
            f'<td><div class="bar-track"><div class="bar" style="width:{pct}%"></div></div></td></tr>'
        )
    return "\n".join(rows)


def _topic_chips(result: AnalysisResult) -> str:
    chips = []
    for t in result.topic_analysis.topics:
        chips.append(
            f'<span class="topic-chip">{t.label} <span style="color:#8890a6">({t.message_count})</span></span>'
        )
    return "\n".join(chips)


def _hour_cells(result: AnalysisResult) -> str:
    hour_data = result.activity_patterns.hour_of_day
    max_val = max(hour_data.values(), default=1)
    cells = []
    for h in range(24):
        v = hour_data.get(h, 0)
        opacity = round(0.1 + (v / max_val) * 0.9, 3)
        cells.append(
            f'<div class="heatmap-cell" title="{h}:00 — {v} messages" '
            f'style="background:rgba(108,142,191,{opacity})"></div>'
        )
    return "\n".join(cells)


def _timeline_html(result: AnalysisResult) -> str:
    items = []
    for ev in result.topic_analysis.timeline_events[:50]:
        date = ev.date.strftime("%Y-%m-%d") if ev.date else "?"
        items.append(
            f'<div class="event-item">'
            f'<div class="event-date">{date} &ndash; {ev.event_type.replace("_", " ").title()}</div>'
            f'<div>{ev.description}</div>'
            f'</div>'
        )
    return "\n".join(items) if items else "<p style='color:var(--text-muted)'>No notable events detected.</p>"


def _date_range_years(result: AnalysisResult) -> str:
    g = result.relationship_graph
    if g.date_range_start and g.date_range_end:
        delta = (g.date_range_end - g.date_range_start).days / 365
        return f"{delta:.1f}"
    return "?"


def render_html(result: AnalysisResult) -> str:
    """Render a self-contained HTML report from an AnalysisResult."""
    synthesis = result.synthesis
    overview = synthesis.summary_json.get("overview", {}) if synthesis else {}

    return _HTML_TEMPLATE.format(
        generated_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        backup_path=result.backup_path,
        total_messages=overview.get("total_messages", result.relationship_graph.total_messages),
        total_conversations=overview.get("total_conversations", result.relationship_graph.total_conversations),
        total_contacts=overview.get("total_contacts", len(result.relationship_graph.contacts)),
        total_calls=overview.get("total_calls", "—"),
        date_range_years=_date_range_years(result),
        contact_rows=_contact_rows(result),
        topic_chips=_topic_chips(result),
        hour_cells=_hour_cells(result),
        timeline_events=_timeline_html(result),
    )


def render_pdf(result: AnalysisResult) -> bytes:
    """Render an HTML report as PDF bytes. Requires weasyprint."""
    try:
        from weasyprint import HTML
    except ImportError as exc:
        raise ImportError(
            "PDF export requires weasyprint. "
            "Install with: pip install openextract-analyzer[reports]"
        ) from exc

    html_str = render_html(result)
    return HTML(string=html_str).write_pdf()


def save_report(result: AnalysisResult, output_path: str | Path, fmt: str = "html") -> Path:
    """Save a report to disk. fmt is 'html' or 'pdf'."""
    output_path = Path(output_path)
    if fmt == "pdf":
        output_path.write_bytes(render_pdf(result))
    else:
        output_path.write_text(render_html(result), encoding="utf-8")
    return output_path
