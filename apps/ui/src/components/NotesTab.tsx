import { useEffect, useState } from "react";
import { api, type Note } from "../lib/api";

export default function NotesTab({ session }: { session: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.notes.list(session)
      .then(setNotes)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [session]);

  if (loading) return <div style={{ color: "#8890a6" }}>Loading notes…</div>;
  if (error) return <div style={{ color: "#e05555" }}>{error}</div>;

  return (
    <div style={{ display: "flex", gap: 20, height: "calc(100vh - 120px)" }}>
      <div style={{ width: 260, overflowY: "auto", borderRight: "1px solid #2a2d3a" }}>
        {notes.map((n) => (
          <div
            key={n.id}
            onClick={() => setSelected(n)}
            style={{
              padding: "10px 14px", cursor: "pointer",
              background: selected?.id === n.id ? "#1e2130" : "transparent",
              borderBottom: "1px solid #1e2130",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13 }}>{n.title || "(Untitled)"}</div>
            <div style={{ color: "#555", fontSize: 11 }}>
              {n.modified_at ? new Date(n.modified_at).toLocaleDateString() : ""}
              {" · "}{n.word_count} words
            </div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {selected ? (
          <div>
            <h3 style={{ marginBottom: 8 }}>{selected.title || "(Untitled)"}</h3>
            <div style={{ color: "#8890a6", fontSize: 12, marginBottom: 16 }}>
              {selected.folder && `${selected.folder} · `}
              {selected.word_count} words
            </div>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 }}>
              {selected.body}
            </pre>
          </div>
        ) : (
          <div style={{ color: "#8890a6" }}>Select a note.</div>
        )}
      </div>
    </div>
  );
}
