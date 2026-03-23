import { useState } from "react";
import { api, type AnalysisResult } from "../lib/api";

interface Props { session: string; }

interface ProgressEvent {
  component: string;
  stage: string;
  progress: number;
  message: string;
}

export default function AnalysisPage({ session }: Props) {
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenBudget, setTokenBudget] = useState(100_000);

  function runAnalysis() {
    setRunning(true);
    setEvents([]);
    setResult(null);
    setError(null);

    const es = api.analysis.runStream(session, tokenBudget);

    es.onmessage = (e) => {
      const evt: ProgressEvent = JSON.parse(e.data);
      setEvents((prev) => [...prev.slice(-50), evt]);

      if (evt.stage === "complete") {
        es.close();
        setRunning(false);
        api.analysis.get(session).then(setResult).catch((err) => setError(String(err)));
      }
      if (evt.stage === "error") {
        es.close();
        setRunning(false);
        setError(evt.message);
      }
    };

    es.onerror = () => {
      es.close();
      setRunning(false);
      setError("Connection to analysis stream failed.");
    };
  }

  const latest = events[events.length - 1];

  return (
    <div style={{ maxWidth: 800 }}>
      <h2 style={{ marginBottom: 8 }}>Analysis</h2>
      <p style={{ color: "#8890a6", marginBottom: 24 }}>
        Run a full analysis pass: relationship graph, topic clustering, timeline events, and AI synthesis.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 24 }}>
        <label style={{ color: "#8890a6", fontSize: 13 }}>
          Token budget:
          <input
            type="number"
            value={tokenBudget}
            onChange={(e) => setTokenBudget(Number(e.target.value))}
            style={{ marginLeft: 8, width: 100, padding: "4px 8px", borderRadius: 4, background: "#1a1d27", border: "1px solid #2a2d3a", color: "#e0e4ef" }}
          />
        </label>
        <button
          onClick={runAnalysis}
          disabled={running}
          style={{ padding: "8px 20px", borderRadius: 6, background: "#6c8ebf", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
        >
          {running ? "Analysing…" : "Run Analysis"}
        </button>
      </div>

      {/* Progress */}
      {(running || events.length > 0) && (
        <div style={{ background: "#1a1d27", borderRadius: 10, padding: 20, marginBottom: 24 }}>
          {latest && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: "#8890a6" }}>{latest.stage}</span>
                <span style={{ fontSize: 13, color: "#6c8ebf" }}>{Math.round(latest.progress * 100)}%</span>
              </div>
              <div style={{ background: "#2a2d3a", borderRadius: 4, height: 6, marginBottom: 12 }}>
                <div style={{ background: "#6c8ebf", height: 6, borderRadius: 4, width: `${latest.progress * 100}%`, transition: "width .3s" }} />
              </div>
              <div style={{ fontSize: 13, color: "#e0e4ef" }}>{latest.message}</div>
            </>
          )}
        </div>
      )}

      {error && <p style={{ color: "#e05555", marginBottom: 16 }}>{error}</p>}

      {/* Results */}
      {result && (
        <div>
          <h3 style={{ marginBottom: 16 }}>Results</h3>

          {/* Summary cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Messages", value: result.relationship_graph.total_messages.toLocaleString() },
              { label: "Conversations", value: result.relationship_graph.total_conversations },
              { label: "Top Contacts", value: result.relationship_graph.contacts.length },
              { label: "Topics", value: result.topic_analysis.topics.length },
              { label: "Timeline Events", value: result.topic_analysis.timeline_events.length },
              { label: "AI Tokens", value: result.synthesis?.total_token_estimate.toLocaleString() ?? "—" },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: "#1a1d27", border: "1px solid #2a2d3a", borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: "1.6rem", fontWeight: 700, color: "#6c8ebf" }}>{value}</div>
                <div style={{ fontSize: 11, color: "#8890a6", textTransform: "uppercase", marginTop: 4 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Top contacts */}
          <h4 style={{ marginBottom: 10 }}>Top Contacts</h4>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
            <thead>
              <tr>
                {["#", "Name", "Messages", "Last Contact", "Avg Response"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#8890a6", fontSize: 12, borderBottom: "1px solid #2a2d3a" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.relationship_graph.contacts.slice(0, 15).map((c, i) => (
                <tr key={c.identifier}>
                  <td style={tdStyle}>{i + 1}</td>
                  <td style={tdStyle}>{c.display_name ?? c.identifier}</td>
                  <td style={tdStyle}>{c.total_messages}</td>
                  <td style={tdStyle}>{c.last_contact ? new Date(c.last_contact).toLocaleDateString() : "—"}</td>
                  <td style={tdStyle}>
                    {c.avg_response_seconds ? `${Math.round(c.avg_response_seconds / 60)}m` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Topics */}
          <h4 style={{ marginBottom: 10 }}>Topic Clusters</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
            {result.topic_analysis.topics.map((t) => (
              <span key={t.label} style={{ background: "#1a1d27", border: "1px solid #2a2d3a", borderRadius: 20, padding: "4px 14px", fontSize: 13 }}>
                {t.label} <span style={{ color: "#8890a6" }}>({t.message_count})</span>
              </span>
            ))}
          </div>

          {/* Export links */}
          <div style={{ display: "flex", gap: 12 }}>
            <a
              href={api.analysis.reportHtmlUrl(session)}
              target="_blank"
              rel="noreferrer"
              style={{ padding: "8px 18px", borderRadius: 6, background: "#1a1d27", border: "1px solid #2a2d3a", color: "#6c8ebf", textDecoration: "none", fontSize: 13 }}
            >
              View HTML Report ↗
            </a>
            <a
              href={api.analysis.reportPdfUrl(session)}
              target="_blank"
              rel="noreferrer"
              style={{ padding: "8px 18px", borderRadius: 6, background: "#1a1d27", border: "1px solid #2a2d3a", color: "#6c8ebf", textDecoration: "none", fontSize: 13 }}
            >
              Download PDF Report ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #2a2d3a",
  fontSize: 13,
};
