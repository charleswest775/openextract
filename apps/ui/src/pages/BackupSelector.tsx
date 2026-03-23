import { useState } from "react";
import { api, type BackupInfo } from "../lib/api";

interface Props {
  onOpen: (sessionKey: string) => void;
}

export default function BackupSelector({ onOpen }: Props) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState("");
  const [password, setPassword] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  async function discover() {
    setLoading(true);
    setError(null);
    try {
      const found = await api.backups.discover(customPath || undefined);
      setBackups(found);
      if (!found.length) setError("No backups found.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Discovery failed.");
    } finally {
      setLoading(false);
    }
  }

  async function open(backup: BackupInfo) {
    setOpening(backup.udid);
    setError(null);
    try {
      const { session_key } = await api.backups.open(backup.path, password || undefined);
      onOpen(session_key);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to open backup.");
      setOpening(null);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: "1.8rem", fontWeight: 700, color: "#6c8ebf", marginBottom: 8 }}>OpenExtract</h1>
      <p style={{ color: "#8890a6", marginBottom: 32 }}>Open an iPhone backup to browse, analyse, or anonymise its data.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          placeholder="Custom backup path (optional)"
          style={inputStyle}
        />
        <button onClick={discover} disabled={loading} style={btnStyle}>
          {loading ? "Scanning…" : "Discover"}
        </button>
      </div>

      {backups.length > 0 && (
        <>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password (for encrypted backups)"
            style={{ ...inputStyle, marginBottom: 16 }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {backups.map((b) => (
              <div
                key={b.udid}
                style={{ background: "#1a1d27", border: "1px solid #2a2d3a", borderRadius: 10, padding: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{b.device_name ?? "Unknown Device"}</div>
                  <div style={{ color: "#8890a6", fontSize: 13 }}>
                    iOS {b.ios_version} &nbsp;·&nbsp; {(b.size_bytes / 1e9).toFixed(1)} GB
                    {b.is_encrypted && <span style={{ marginLeft: 8, color: "#f0c040" }}>🔒 Encrypted</span>}
                  </div>
                  <div style={{ color: "#555", fontSize: 11, marginTop: 2 }}>{b.path}</div>
                </div>
                <button
                  onClick={() => open(b)}
                  disabled={opening === b.udid}
                  style={btnStyle}
                >
                  {opening === b.udid ? "Opening…" : "Open"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p style={{ color: "#e05555", marginTop: 16 }}>{error}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 12px", borderRadius: 6,
  background: "#1a1d27", border: "1px solid #2a2d3a",
  color: "#e0e4ef", outline: "none", fontSize: 14,
};

const btnStyle: React.CSSProperties = {
  padding: "8px 18px", borderRadius: 6, background: "#6c8ebf",
  color: "#fff", border: "none", cursor: "pointer", fontWeight: 600,
};
