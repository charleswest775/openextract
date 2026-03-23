import { useEffect, useState } from "react";
import { api, type Call } from "../lib/api";

const DIRECTION_COLOR: Record<string, string> = {
  incoming: "#4caf7d",
  outgoing: "#6c8ebf",
  missed: "#e05555",
  blocked: "#8890a6",
};

export default function CallsTab({ session }: { session: string }) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.calls.list(session)
      .then(setCalls)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [session]);

  if (loading) return <div style={{ color: "#8890a6" }}>Loading calls…</div>;
  if (error) return <div style={{ color: "#e05555" }}>{error}</div>;

  return (
    <div>
      <p style={{ color: "#8890a6", marginBottom: 16 }}>{calls.length} call records</p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Direction", "Contact", "Duration", "Date", "Service"].map((h) => (
              <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: "#8890a6", fontSize: 12, borderBottom: "1px solid #2a2d3a" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td style={{ padding: "8px 12px", borderBottom: "1px solid #1e2130" }}>
                <span style={{ color: DIRECTION_COLOR[c.direction] || "#e0e4ef", fontSize: 12 }}>{c.direction}</span>
              </td>
              <td style={{ padding: "8px 12px", borderBottom: "1px solid #1e2130" }}>{c.contact_name || c.address}</td>
              <td style={{ padding: "8px 12px", borderBottom: "1px solid #1e2130", fontSize: 13, color: "#8890a6" }}>
                {Math.floor(c.duration_seconds / 60)}:{String(Math.floor(c.duration_seconds % 60)).padStart(2, "0")}
              </td>
              <td style={{ padding: "8px 12px", borderBottom: "1px solid #1e2130", fontSize: 12, color: "#8890a6" }}>
                {new Date(c.timestamp).toLocaleDateString()}
              </td>
              <td style={{ padding: "8px 12px", borderBottom: "1px solid #1e2130", fontSize: 12, color: "#555" }}>{c.service ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
