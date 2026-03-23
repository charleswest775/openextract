import { useState } from "react";
import ConversationsTab from "../components/ConversationsTab";
import ContactsTab from "../components/ContactsTab";
import CallsTab from "../components/CallsTab";
import NotesTab from "../components/NotesTab";

type Tab = "messages" | "contacts" | "calls" | "notes" | "photos" | "voicemail";

const TABS: Tab[] = ["messages", "contacts", "calls", "notes", "photos", "voicemail"];

interface Props { session: string; }

export default function Dashboard({ session }: Props) {
  const [tab, setTab] = useState<Tab>("messages");

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Sidebar */}
      <div style={{ width: 160, borderRight: "1px solid #2a2d3a", padding: "16px 0" }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              display: "block", width: "100%", padding: "10px 20px",
              background: tab === t ? "#1e2130" : "transparent",
              borderLeft: tab === t ? "3px solid #6c8ebf" : "3px solid transparent",
              color: tab === t ? "#e0e4ef" : "#8890a6",
              border: "none", cursor: "pointer", textAlign: "left",
              textTransform: "capitalize", fontSize: 14,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {tab === "messages"  && <ConversationsTab session={session} />}
        {tab === "contacts"  && <ContactsTab session={session} />}
        {tab === "calls"     && <CallsTab session={session} />}
        {tab === "notes"     && <NotesTab session={session} />}
        {tab === "photos"    && <PlaceholderTab label="Photos" />}
        {tab === "voicemail" && <PlaceholderTab label="Voicemail" />}
      </div>
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return <div style={{ color: "#8890a6" }}>{label} tab — coming soon.</div>;
}
