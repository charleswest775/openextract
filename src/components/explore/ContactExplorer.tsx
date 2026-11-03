import { useState, useMemo } from 'react';
import { ChevronRightIcon, ContactIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import Highlight from '../shared/Highlight';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import { useSaveAction } from '../../hooks/useSaveAction';
import { contactsToCsv, contactsToVcard, plural, saveTextFile } from '../../lib/saveData';
import { matches } from '../../lib/search';
import { gatherPeople, linkCards } from '../people/gather';
import type { ExploreContext } from './sections';

interface Props {
  ctx: ExploreContext;
  /** What the top search box holds; only matching cards show. */
  query: string;
  /** The card to show first, marked: from a search, or from a person's page. */
  openContactId?: number;
}

/** The address book: the cards saved on the phone, whether or not you were ever in touch. */
export default function ContactExplorer({ ctx, query, openContactId }: Props) {
  const { addressBook, entries } = ctx.index;
  const contacts = addressBook ?? [];
  const loading = addressBook === null;
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('contacts');

  const people = useMemo(() => gatherPeople(entries), [entries]);
  const { personOf } = useMemo(() => linkCards(people, contacts), [people, contacts]);

  const filtered = useMemo(() => contacts
    .filter(c => matches(query, c.display_name, c.organization, ...c.phones, ...c.emails))
    .sort((a, b) => (a.id === openContactId ? -1 : b.id === openContactId ? 1 : a.display_name.localeCompare(b.display_name))),
  [contacts, query, openContactId]);

  function save(format: 'vcf' | 'csv') {
    setChoosing(false);
    const list = query ? filtered : contacts;
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

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Address book"
        count={contacts.length > 0
          ? (query ? `${filtered.length} of ${plural(contacts.length, 'card')}` : plural(contacts.length, 'card'))
          : undefined}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={contacts.length === 0} label="Save contacts" />}
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
            title={query ? `No cards match "${query}"` : 'No saved contacts in this backup'}
            detail={query ? 'Try part of a name, a phone number or an email address.' : undefined}
          />
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((c) => {
            const person = personOf.get(c.id);
            const opened = c.id === openContactId;
            return (
              <div
                key={c.id}
                ref={opened ? el => el?.scrollIntoView({ block: 'center' }) : undefined}
                className={`hearth-card p-4 flex flex-col ${opened ? '!border-accent ring-2 ring-[var(--accent-wash)]' : ''}`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full bg-accent-wash flex items-center justify-center flex-shrink-0">
                    <span className="text-base font-medium text-accent">
                      {(c.display_name || '?')[0].toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-medium text-text-primary truncate"><Highlight text={c.display_name} query={query} /></div>
                    {c.organization && c.organization !== c.display_name && (
                      <div className="text-sm text-text-secondary truncate"><Highlight text={c.organization} query={query} /></div>
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
                    {c.emails.map((e, i) => <div key={i} className="truncate"><Highlight text={e} query={query} /></div>)}
                  </div>
                )}
                {person && (
                  <button
                    onClick={() => ctx.openTab('people', { person: person.identifier })}
                    className="mt-3 self-start flex items-center gap-1 text-sm text-accent font-medium hover:underline"
                  >
                    See history · {plural(person.total, 'event')}
                    <ChevronRightIcon size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {choosing && (
        <SaveDialog
          title={query ? `Save ${plural(filtered.length, 'contact')} matching "${query}"` : 'Save contacts'}
          formats={[FORMATS.vcf, FORMATS.csv]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}
