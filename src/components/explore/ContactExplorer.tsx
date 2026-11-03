import { useState, useEffect } from 'react';
import { sidecarCall } from '../../lib/ipc';
import { ContactIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { contactsToCsv, contactsToVcard, plural, saveTextFile } from '../../lib/saveData';

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
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('contacts');

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

  function save(format: 'vcf' | 'csv') {
    setChoosing(false);
    const list = search ? filtered : contacts;
    run(async () => {
      const vcf = format === 'vcf';
      const path = await saveTextFile({
        title: 'Save contacts',
        defaultName: vcf ? 'Contacts.vcf' : 'Contacts.csv',
        filter: vcf ? { name: 'vCard', extensions: ['vcf'] } : { name: 'CSV', extensions: ['csv'] },
        content: vcf ? contactsToVcard(list) : contactsToCsv(list),
      });
      return path ? { title: `Saved ${plural(list.length, 'contact')}`, path } : null;
    });
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
      <PageHeader
        title="Contacts"
        count={contacts.length > 0 ? plural(contacts.length, 'contact') : undefined}
        search={{ value: search, onChange: setSearch, placeholder: 'Search contacts' }}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={contacts.length === 0} />}
      />
      <div className="flex-1 overflow-y-auto p-5">
        {loading && (
          <div className="flex justify-center py-12 text-accent">
            <OrganicLoader size={72} />
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <EmptyState
            icon={ContactIcon}
            title={search ? `No contacts match "${search}"` : 'No contacts in this backup'}
            detail={search ? 'Try part of a name, a phone number or an email address.' : undefined}
          />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <div key={c.id} className="hearth-card p-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-accent-wash flex items-center justify-center flex-shrink-0">
                  <span className="text-base font-medium text-accent">
                    {(c.display_name || '?')[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="text-base font-medium text-text-primary truncate">{c.display_name}</div>
                  {c.organization && c.organization !== c.display_name && (
                    <div className="text-sm text-text-secondary truncate">{c.organization}</div>
                  )}
                </div>
              </div>
              {c.phones.length > 0 && (
                <div className="text-sm text-text-secondary mb-1">
                  {c.phones.map((p, i) => <div key={i}>{p}</div>)}
                </div>
              )}
              {c.emails.length > 0 && (
                <div className="text-sm text-text-secondary">
                  {c.emails.map((e, i) => <div key={i} className="truncate">{e}</div>)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {choosing && (
        <SaveDialog
          title={search ? `Save ${plural(filtered.length, 'contact')} matching "${search}"` : 'Save contacts'}
          formats={[FORMATS.vcf, FORMATS.csv]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
