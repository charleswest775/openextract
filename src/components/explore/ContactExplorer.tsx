import { useState, useEffect } from 'react';
import { sidecarCall, saveFolder } from '../../lib/ipc';
import { SearchIcon, ExportIcon, ContactIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';

interface Contact {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  organization: string;
  phones: string[];
  emails: string[];
  note: string;
}

interface Props {
  udid: string;
}

export default function ContactExplorer({ udid }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadContacts();
  }, [udid]);

  async function loadContacts() {
    setLoading(true);
    try {
      const result = await sidecarCall<{ contacts: Contact[] }>('list_contacts', { udid });
      setContacts(result.contacts);
    } finally {
      setLoading(false);
    }
  }

  function exportCSV() {
    const escape = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
    const header = 'First Name,Last Name,Display Name,Organization,Phone Numbers,Email Addresses,Notes\n';
    const rows = contacts.map(c =>
      [c.first_name, c.last_name, c.display_name, c.organization,
       c.phones.join('; '), c.emails.join('; '), c.note]
        .map(escape).join(',')
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
    window.openextract.incrementExportCount();
  }

  const filtered = contacts
    .filter(c => {
      if (!search) return true;
      const q = search.toLowerCase();
      return c.display_name.toLowerCase().includes(q) ||
        c.phones.some(p => p.includes(q)) ||
        c.emails.some(e => e.toLowerCase().includes(q)) ||
        c.organization.toLowerCase().includes(q);
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-end justify-between gap-4 bg-base" style={{ padding: '20px 28px 14px', borderBottom: '1px solid var(--border-default)', flexShrink: 0 }}>
        <div>
          <div className="hearth-eyebrow mb-1.5">
            Contacts{contacts.length > 0 && ` · ${contacts.length} total`}
          </div>
          <h1 className="hearth-title text-3xl">
            The people who <span className="font-serif-italic text-accent">mattered.</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" size={13} />
            <input
              type="text"
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 text-sm bg-surface rounded-full border border-rule focus:outline-none focus:border-accent w-48"
            />
          </div>
          <button onClick={exportCSV} className="hearth-ghost-btn" title="Export CSV">
            <ExportIcon size={13} /> Export vCard
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-8 text-sm text-gray-400">No contacts found</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <div key={c.id} className="border border-gray-200 rounded-lg p-3 hover:border-gray-300 transition-colors">
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-medium text-emerald-600">
                    {(c.display_name || '?')[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{c.display_name}</div>
                  {c.organization && <div className="text-xs text-gray-400 truncate">{c.organization}</div>}
                </div>
              </div>
              {c.phones.length > 0 && (
                <div className="text-xs text-gray-500 mb-1">
                  {c.phones.map((p, i) => <div key={i}>{p}</div>)}
                </div>
              )}
              {c.emails.length > 0 && (
                <div className="text-xs text-gray-500">
                  {c.emails.map((e, i) => <div key={i} className="truncate">{e}</div>)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
