import { useState, useEffect, useMemo } from 'react';
import { Search, Loader2, AlertTriangle, Inbox, Phone, Mail, Building2, StickyNote, Download } from 'lucide-react';
import { BackupInfo } from '../../hooks/useBackup';

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
    backup: BackupInfo;
}

export default function ContactsView({ backup }: Props) {
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [page, setPage] = useState(0);
    const pageSize = 50;

    useEffect(() => {
        loadContacts();
    }, [backup.udid]);

    async function loadContacts() {
        setLoading(true);
        setError(null);
        try {
            const res = await window.openextract.call('list_contacts', { udid: backup.udid });
            if (!res.success) throw new Error(res.error);
            setContacts(res.data?.contacts || []);
        } catch (err: any) {
            setError(err.message || 'Failed to load contacts');
        } finally {
            setLoading(false);
        }
    }

    const filteredContacts = useMemo(() => {
        let result = contacts;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter(c =>
                c.display_name?.toLowerCase().includes(q) ||
                c.phones.some(p => p.toLowerCase().includes(q)) ||
                c.emails.some(e => e.toLowerCase().includes(q)) ||
                c.organization?.toLowerCase().includes(q)
            );
        }
        return result.sort((a, b) => a.display_name.localeCompare(b.display_name));
    }, [contacts, searchQuery]);

    const paginatedContacts = filteredContacts.slice(page * pageSize, (page + 1) * pageSize);
    const totalPages = Math.ceil(filteredContacts.length / pageSize);

    function exportToCSV() {
        const headers = ['First Name', 'Last Name', 'Display Name', 'Organization', 'Phone Numbers', 'Email Addresses', 'Notes'];
        const escape = (val: string) => `"${(val ?? '').replace(/"/g, '""')}"`;
        const rows = contacts.map(c => [
            escape(c.first_name),
            escape(c.last_name),
            escape(c.display_name),
            escape(c.organization),
            escape(c.phones.join('; ')),
            escape(c.emails.join('; ')),
            escape(c.note),
        ]);
        const csv = [headers.map(h => `"${h}"`).join(','), ...rows.map(r => r.join(','))].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `contacts_${backup.udid.slice(0, 8)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="flex flex-col h-full bg-base text-text-primary">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                <div>
                    <h2 className="font-display text-title font-semibold text-text-primary">Contacts</h2>
                    <p className="text-caption text-text-tertiary mt-0.5">
                        {loading ? 'Loading...' : `${contacts.length.toLocaleString()} contacts found`}
                    </p>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search size={14} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                        <input
                            type="text"
                            placeholder="Find name, number, email..."
                            className="bg-base text-body text-text-primary rounded-lg w-64 pl-8 pr-3 py-1.5 focus:outline-none focus:shadow-focus placeholder:text-text-tertiary transition-colors"
                            style={{ border: '0.5px solid var(--border-strong)' }}
                            value={searchQuery}
                            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
                        />
                    </div>
                    <button
                        onClick={exportToCSV}
                        disabled={loading || contacts.length === 0}
                        className="flex items-center gap-2 px-3 py-1.5 text-body font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
                    >
                        <Download size={14} strokeWidth={1.5} /> Export CSV
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-6 bg-base">
                {loading && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <Loader2 size={24} strokeWidth={1.5} className="animate-spin mb-3" />
                        <p className="text-body">Loading contacts...</p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center justify-center h-full">
                        <AlertTriangle size={24} strokeWidth={1.5} className="text-apple-error mb-3" />
                        <p className="text-body text-apple-error">{error}</p>
                    </div>
                )}

                {!loading && !error && filteredContacts.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
                        <Inbox size={24} strokeWidth={1.5} className="mb-3" />
                        <p className="text-body">No contacts found.</p>
                    </div>
                )}

                {!loading && !error && filteredContacts.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {paginatedContacts.map((contact) => (
                            <div
                                key={contact.id}
                                className="bg-surface rounded-lg p-4 hover:shadow-card transition-all duration-250 flex flex-col"
                                style={{ border: '0.5px solid var(--border-default)' }}
                            >
                                <div className="flex items-center gap-3 mb-3 pb-3" style={{ borderBottom: '0.5px solid var(--border-default)' }}>
                                    <div className="h-9 w-9 rounded-full bg-accent flex items-center justify-center text-white font-display font-semibold text-subhead flex-shrink-0">
                                        {contact.display_name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-display text-subhead font-medium text-text-primary truncate">
                                            {contact.display_name}
                                        </h3>
                                        {contact.organization && (
                                            <p className="text-caption text-text-secondary truncate flex items-center gap-1 mt-0.5">
                                                <Building2 size={10} strokeWidth={1.5} /> {contact.organization}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-1.5 flex-1">
                                    {contact.phones.map((phone, i) => (
                                        <div key={`phone-${i}`} className="flex items-center gap-2 text-body text-text-secondary">
                                            <Phone size={13} strokeWidth={1.5} className="text-text-tertiary flex-shrink-0" />
                                            <span className="font-mono text-caption">{phone}</span>
                                        </div>
                                    ))}

                                    {contact.emails.map((email, i) => (
                                        <div key={`email-${i}`} className="flex items-center gap-2 text-body text-text-secondary">
                                            <Mail size={13} strokeWidth={1.5} className="text-text-tertiary flex-shrink-0" />
                                            <span className="truncate text-caption">{email}</span>
                                        </div>
                                    ))}

                                    {contact.phones.length === 0 && contact.emails.length === 0 && (
                                        <div className="text-body text-text-tertiary italic">No contact details</div>
                                    )}
                                </div>

                                {contact.note && (
                                    <div className="mt-3 pt-2.5 text-caption text-text-tertiary line-clamp-2 italic flex items-start gap-1.5" style={{ borderTop: '0.5px dashed var(--border-default)' }}>
                                        <StickyNote size={11} strokeWidth={1.5} className="flex-shrink-0 mt-0.5" />
                                        {contact.note.substring(0, 100)}{contact.note.length > 100 ? '...' : ''}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Pagination */}
                {!loading && !error && totalPages > 1 && (
                    <div className="flex items-center justify-between mt-6 px-4 py-2.5 bg-surface rounded-lg" style={{ border: '0.5px solid var(--border-default)' }}>
                        <span className="text-caption text-text-tertiary">
                            Showing <span className="font-medium text-text-primary">{page * pageSize + 1}</span>–<span className="font-medium text-text-primary">{Math.min((page + 1) * pageSize, filteredContacts.length)}</span> of <span className="font-medium text-text-primary">{filteredContacts.length}</span>
                        </span>
                        <div className="inline-flex gap-1">
                            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors" style={{ border: '0.5px solid var(--border-strong)' }}>Prev</button>
                            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1} className="px-3 py-1 text-caption text-text-secondary bg-base rounded-sm hover:bg-elevated disabled:opacity-50 transition-colors" style={{ border: '0.5px solid var(--border-strong)' }}>Next</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
