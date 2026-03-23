import { useEffect, useState } from "react";
import { api, type Conversation, type Message } from "../lib/api";

interface Props { session: string; }

export default function ConversationsTab({ session }: Props) {
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.messages.conversations(session)
      .then(setConvos)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [session]);

  async function selectConvo(c: Conversation) {
    setSelected(c);
    const msgs = await api.messages.get(session, c.id, { limit: 100 });
    setMessages(msgs);
  }

  if (loading) return <div style={{ color: "#8890a6" }}>Loading conversations…</div>;
  if (error) return <div style={{ color: "#e05555" }}>{error}</div>;

  return (
    <div style={{ display: "flex", gap: 20, height: "calc(100vh - 120px)" }}>
      {/* Conversation list */}
      <div style={{ width: 280, overflowY: "auto", borderRight: "1px solid #2a2d3a" }}>
        {convos.map((c) => (
          <div
            key={c.id}
            onClick={() => selectConvo(c)}
            style={{
              padding: "12px 16px", cursor: "pointer",
              background: selected?.id === c.id ? "#1e2130" : "transparent",
              borderBottom: "1px solid #1e2130",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {c.display_name || c.participant_names[0] || c.participants[0] || "Unknown"}
            </div>
            <div style={{ color: "#8890a6", fontSize: 12, marginTop: 2 }}>
              {c.message_count} messages
            </div>
            {c.last_message_text && (
              <div style={{ color: "#555", fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.last_message_text.slice(0, 60)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        {!selected && <div style={{ color: "#8890a6" }}>Select a conversation.</div>}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              maxWidth: "70%",
              alignSelf: m.is_from_me ? "flex-end" : "flex-start",
              background: m.is_from_me ? "#1c2a3a" : "#1a1d27",
              borderRadius: 10, padding: "10px 14px",
            }}
          >
            {!m.is_from_me && (
              <div style={{ fontSize: 11, color: "#6c8ebf", marginBottom: 4 }}>
                {m.sender_name || m.sender}
              </div>
            )}
            <div style={{ fontSize: 14 }}>{m.text || <em style={{ color: "#555" }}>[{m.type}]</em>}</div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 4, textAlign: "right" }}>
              {new Date(m.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
