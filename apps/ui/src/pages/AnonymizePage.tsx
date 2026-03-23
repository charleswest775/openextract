import { useState } from "react";
import { api, type DiffEntry } from "../lib/api";

interface Props { session: string; }

type Domain = "messages" | "contacts" | "notes" | "conversations";
type Strategy = "redact" | "pseudonymize";

export default function AnonymizePage({ session }: Props) {
  const [domain, setDomain] = useState<Domain>("messages");
  const [strategy, setStrategy] = useState<Strategy>("pseudonymize");
  const [chatId, setChatId] = useState("");
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [storeKey, setStoreKey] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [approved, setApproved] = useState(false);
  const [pairs, setPairs] = useState<Array<{ original: unknown; anonymized: unknown }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function process() {
    setLoading(true);
    setError(null);
    setDiff(null);
    setPairs(null);
    setApproved(false);
    try {
      const res = await api.anonymize.process(
        session, domain, strategy,
        domain === "messages" && chatId ? Number(chatId) : undefined
      );
      setStoreKey(res.store_key);
      setDiff(res.diff);
      setSummary(res.summary as Record<string, unknown>);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setLoading(false);
    }
  }

  async function approveAll() {
    if (!storeKey) return;
    try {
      await api.anonymize.approve(session, domain, domain === "messages" && chatId ? Number(chatId) : undefined);
      setApproved(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    }
  }

  async function compare() {
    try {
      const res = await api.anonymize.compare(
        session, domain,
        domain === "messages" && chatId ? Number(chatId) : undefined
      );
      setPairs(res.pairs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Compare failed.");
    }
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h2 style={{ marginBottom: 8 }}>Anonymize</h2>
      <p style={{ color: "#8890a6", marginBottom: 24 }}>
        Remove or replace PII from backup data. Review the diff before approving.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        <select value={domain} onChange={(e) => setDomain(e.target.value as Domain)} style={selectStyle}>
          <option value="messages">Messages</option>
          <option value="contacts">Contacts</option>
          <option value="notes">Notes</option>
          <option value="conversations">Conversations</option>
        </select>

        <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)} style={selectStyle}>
          <option value="pseudonymize">Pseudonymize</option>
          <option value="redact">Redact</option>
        </select>

        {domain === "messages" && (
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Chat ID"
            style={{ ...selectStyle, width: 100 }}
          />
        )}

        <button onClick={process} disabled={loading} style={btnStyle}>
          {loading ? "Processing…" : "Process"}
        </button>
      </div>

      {error && <p style={{ color: "#e05555", marginBottom: 16 }}>{error}</p>}

      {summary && (
        <div style={{ background: "#1a1d27", borderRadius: 10, padding: 16, marginBottom: 24 }}>
          <strong>Summary:</strong>
          <ul style={{ color: "#8890a6", marginTop: 8, paddingLeft: 16 }}>
            {Object.entries(summary).map(([k, v]) => (
              <li key={k}>{k}: {JSON.stringify(v)}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button onClick={approveAll} disabled={approved} style={{ ...btnStyle, background: approved ? "#4caf7d" : "#6c8ebf" }}>
              {approved ? "Approved ✓" : "Approve All"}
            </button>
            <button onClick={compare} style={{ ...btnStyle, background: "transparent", border: "1px solid #6c8ebf", color: "#6c8ebf" }}>
              Side-by-Side Compare
            </button>
          </div>
        </div>
      )}

      {/* Diff table */}
      {diff && diff.length > 0 && (
        <>
          <h4 style={{ marginBottom: 10 }}>Diff Manifest ({diff.length} replacements)</h4>
          <div style={{ background: "#1a1d27", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Type", "Original", "Anonymized", "Field", "Approved"].map((h) => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "#8890a6", fontSize: 11, borderBottom: "1px solid #2a2d3a", textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diff.slice(0, 100).map((entry, i) => (
                  <tr key={i}>
                    <td style={tdStyle}><span style={{ background: "#2a2d3a", borderRadius: 4, padding: "2px 6px", fontSize: 11 }}>{entry.entity_type}</span></td>
                    <td style={{ ...tdStyle, color: "#e05555" }}>{entry.original_value}</td>
                    <td style={{ ...tdStyle, color: "#4caf7d" }}>{entry.anonymized_value}</td>
                    <td style={{ ...tdStyle, color: "#555", fontSize: 11 }}>{entry.field_path}</td>
                    <td style={tdStyle}>{entry.approved ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Side-by-side compare */}
      {pairs && pairs.length > 0 && (
        <>
          <h4 style={{ marginBottom: 10 }}>Side-by-Side Comparison</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
            <div style={{ background: "#1a1d27", padding: 12, fontSize: 11, color: "#8890a6", fontWeight: 600 }}>ORIGINAL</div>
            <div style={{ background: "#1a1d27", padding: 12, fontSize: 11, color: "#8890a6", fontWeight: 600 }}>ANONYMIZED</div>
            {pairs.slice(0, 20).map((pair, i) => (
              <>
                <div key={`orig-${i}`} style={{ background: "#130e0e", padding: 12, borderTop: "1px solid #2a2d3a", fontSize: 12 }}>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#e0e4ef" }}>
                    {JSON.stringify(pair.original, null, 2)}
                  </pre>
                </div>
                <div key={`anon-${i}`} style={{ background: "#0e1310", padding: 12, borderTop: "1px solid #2a2d3a", fontSize: 12 }}>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#e0e4ef" }}>
                    {JSON.stringify(pair.anonymized, null, 2)}
                  </pre>
                </div>
              </>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 6,
  background: "#1a1d27", border: "1px solid #2a2d3a",
  color: "#e0e4ef", outline: "none", fontSize: 14,
};

const btnStyle: React.CSSProperties = {
  padding: "8px 18px", borderRadius: 6, background: "#6c8ebf",
  color: "#fff", border: "none", cursor: "pointer", fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 14px", borderBottom: "1px solid #1e2130", fontSize: 13,
};
