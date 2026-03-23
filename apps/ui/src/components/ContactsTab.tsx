import { useEffect, useState } from "react";
import { api, type Contact } from "../lib/api";

export default function ContactsTab({ session }: { session: string }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.contacts.list(session)
      .then(setContacts)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [session]);

  const filtered = contacts.filter((c) => {
    const name = [c.first_name, c.last_name, c.organization].join(" ").toLowerCase();
    return name.includes(query.toLowerCase());
  });

  if (loading) return <div style={{ color: "#8890a6" }}>Loading contacts…</div>;
  if (error) return <div style={{ color: "#e05555" }}>{error}</div>;

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${contacts.length} contacts…`}
        style={{ width: "100%", padding: "8px 12px", borderRadius: 6, background: "#1a1d27", border: "1px solid #2a2d3a", color: "#e0e4ef", marginBottom: 16 }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.slice(0, 200).map((c) => (
          <div key={c.id} style={{ background: "#1a1d27", borderRadius: 8, padding: "10px 16px", border: "1px solid #2a2d3a" }}>
            <div style={{ fontWeight: 600 }}>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.organization || "Unknown"}</div>
            <div style={{ color: "#8890a6", fontSize: 12 }}>
              {c.phones.map((p) => p.number).join(" · ")}
              {c.emails.length > 0 && ` · ${c.emails[0].address}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
