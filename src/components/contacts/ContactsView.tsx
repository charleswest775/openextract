import { useState, useEffect, useMemo } from 'react';
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

type SortOrder = 'asc' | 'desc';

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

        // Always sort alphabetically by display name
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
        <div className="flex flex-col h-full bg-[#0f1115] text-gray-200 font-sans">
            <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-[#161920]">
                <div>
                    <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
                        Contacts
                    </h2>
                    <p className="text-sm text-gray-400 mt-1">
                        {loading ? 'Reading address book...' : `${contacts.length.toLocaleString()} contacts found`}
                    </p>
                </div>

                <div className="flex items-center gap-4">
                    <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-500">
                            🔍
                        </span>
                        <input
                            type="text"
                            placeholder="Find name, number, email..."
                            className="bg-[#1f222b] border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-64 pl-10 pt-2 pb-2 transition-colors"
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                setPage(0);
                            }}
                        />
                    </div>
                    <button
                        onClick={exportToCSV}
                        disabled={loading || contacts.length === 0}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
                    >
                        ⬇ Export CSV
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6 bg-[#0f1115]">
                {loading && (
                    <div className="flex flex-col items-center justify-center h-full text-blue-400 animate-pulse">
                        <div className="text-4xl mb-4">⏳</div>
                        <p>Extracting Address Book...</p>
                    </div>
                )}

                {error && (
                    <div className="flex flex-col items-center justify-center h-full text-red-400">
                        <div className="text-4xl mb-4">⚠️</div>
                        <p>{error}</p>
                    </div>
                )}

                {!loading && !error && filteredContacts.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                        <div className="text-4xl mb-4 mb-2 opacity-50">📭</div>
                        <p>No contacts found.</p>
                    </div>
                )}

                {!loading && !error && filteredContacts.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {paginatedContacts.map((contact) => (
                            <div key={contact.id} className="bg-[#161920] border border-gray-800 rounded-xl p-5 hover:border-gray-600 transition-colors shadow-sm flex flex-col group">
                                <div className="flex items-center gap-3 mb-3 border-b border-gray-800 pb-3">
                                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
                                        {contact.display_name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-semibold text-gray-100 truncate">
                                            {contact.display_name}
                                        </h3>
                                        {contact.organization && (
                                            <p className="text-xs text-blue-400 truncate flex items-center gap-1 mt-0.5">
                                                <span>🏢</span> {contact.organization}
                                            </p>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2 flex-1">
                                    {contact.phones.map((phone, i) => (
                                        <div key={`phone-${i}`} className="flex items-center text-sm text-gray-300">
                                            <span className="text-gray-500 w-6 text-center shadow-sm">📞</span>
                                            <span className="font-mono">{phone}</span>
                                        </div>
                                    ))}

                                    {contact.emails.map((email, i) => (
                                        <div key={`email-${i}`} className="flex items-center text-sm text-gray-300">
                                            <span className="text-gray-500 w-6 text-center">✉️</span>
                                            <span className="truncate">{email}</span>
                                        </div>
                                    ))}

                                    {contact.phones.length === 0 && contact.emails.length === 0 && (
                                        <div className="text-sm text-gray-600 italic">No contact details</div>
                                    )}
                                </div>

                                {contact.note && (
                                    <div className="mt-4 pt-3 border-t border-gray-800 border-dashed text-xs text-gray-400 line-clamp-2 italic">
                                        📝 {contact.note.substring(0, 100)}{contact.note.length > 100 ? '...' : ''}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Pagination */}
                {!loading && !error && totalPages > 1 && (
                    <div className="flex items-center justify-between mt-6 px-4 py-3 bg-[#1a1d24] rounded-lg border border-gray-800 shadow-md">
                        <span className="text-sm text-gray-400">
                            Showing <span className="font-semibold text-white">{page * pageSize + 1}</span> to <span className="font-semibold text-white">{Math.min((page + 1) * pageSize, filteredContacts.length)}</span> of <span className="font-semibold text-white">{filteredContacts.length}</span> Contacts
                        </span>
                        <div className="inline-flex gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                disabled={page === 0}
                                className="px-4 py-1.5 text-sm font-medium text-white bg-[#252833] rounded-md hover:bg-[#2d303b] disabled:opacity-50 transition-colors"
                            >
                                ← Prev
                            </button>
                            <button
                                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={page === totalPages - 1}
                                className="px-4 py-1.5 text-sm font-medium text-white bg-[#252833] rounded-md hover:bg-[#2d303b] disabled:opacity-50 transition-colors"
                            >
                                Next →
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
