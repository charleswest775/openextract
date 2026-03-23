import { useState } from "react";
import BackupSelector from "./pages/BackupSelector";
import Dashboard from "./pages/Dashboard";
import AnalysisPage from "./pages/AnalysisPage";
import AnonymizePage from "./pages/AnonymizePage";

type Screen = "select" | "browse" | "analyze" | "anonymize";

export default function App() {
  const [screen, setScreen] = useState<Screen>("select");
  const [session, setSession] = useState<string | null>(null);

  const nav = (s: Screen) => setScreen(s);

  if (screen === "select" || !session) {
    return (
      <BackupSelector
        onOpen={(key) => {
          setSession(key);
          setScreen("browse");
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0f1117", color: "#e0e4ef" }}>
      {/* Top nav */}
      <nav style={{ display: "flex", gap: 8, padding: "12px 20px", borderBottom: "1px solid #2a2d3a", alignItems: "center" }}>
        <span style={{ fontWeight: 700, color: "#6c8ebf", marginRight: 16 }}>OpenExtract</span>
        {(["browse", "analyze", "anonymize"] as Screen[]).map((s) => (
          <button
            key={s}
            onClick={() => nav(s)}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "1px solid #2a2d3a",
              background: screen === s ? "#6c8ebf" : "transparent",
              color: screen === s ? "#fff" : "#8890a6",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {s}
          </button>
        ))}
        <button
          onClick={() => { setSession(null); setScreen("select"); }}
          style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 6, border: "1px solid #2a2d3a", background: "transparent", color: "#8890a6", cursor: "pointer" }}
        >
          ← Back
        </button>
      </nav>

      {/* Page content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {screen === "browse" && <Dashboard session={session} />}
        {screen === "analyze" && <AnalysisPage session={session} />}
        {screen === "anonymize" && <AnonymizePage session={session} />}
      </div>
    </div>
  );
}
