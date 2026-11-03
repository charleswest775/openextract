import { useMemo, useState } from 'react';
import { ArrowLeftIcon, GlobeIcon } from '../shared/Icons';
import { formatDateTime } from '../../lib/dates';
import { SaveButton } from '../shared/SaveDialog';
import EmptyState from '../shared/EmptyState';
import Highlight from '../shared/Highlight';
import { plural } from '../../lib/saveData';
import { matches } from '../../lib/search';
import type { HistoryVisit } from '../../lib/browserHistoryStats';

interface Props {
  visits: HistoryVisit[];
  udid: string;
  /** What the top search box holds. */
  query: string;
  /** The visit a search found, as a timeline id ("browser:…"). */
  selectId?: string;
  initialDomainFilter?: string | null;
  initialDateFilter?: string | null;
  /** Back to the charts; left out while a search is showing the list. */
  onBack?: () => void;
  onSave: () => void;
  saving: boolean;
}

export default function BrowserHistoryTable({
  visits,
  udid,
  query,
  selectId,
  initialDomainFilter,
  initialDateFilter,
  onBack,
  onSave,
  saving,
}: Props) {
  const [domainFilter, setDomainFilter] = useState(initialDomainFilter || '');
  const [dateFilter, setDateFilter] = useState(initialDateFilter || '');
  const [browserFilter, setBrowserFilter] = useState<'all' | 'safari' | 'firefox'>('all');

  const filtered = useMemo(() => visits.filter(v => {
    if (browserFilter !== 'all' && v.browser !== browserFilter) return false;
    if (dateFilter && !v.visit_date?.startsWith(dateFilter)) return false;
    if (domainFilter && v.domain !== domainFilter) return false;
    return matches(query, v.title, v.url, v.domain);
  }), [visits, browserFilter, dateFilter, domainFilter, query]);

  const hasActiveFilter = !!dateFilter || !!domainFilter || !!query;

  return (
    <div className="h-full flex flex-col">
      {/* Header: same shape as PageHeader, with a way back to the overview */}
      <div className="h-16 px-6 border-b border-rule flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="hearth-ghost-btn !px-3 !py-1.5 flex-shrink-0"
            >
              <ArrowLeftIcon size={18} />
              Overview
            </button>
          )}
          <h1 className="text-2xl text-text-primary whitespace-nowrap">Web history</h1>
          <span className="text-sm text-text-tertiary truncate">{plural(filtered.length, 'page visit')}</span>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {domainFilter && (
            <span className="flex items-center gap-1 text-sm bg-accent-wash text-accent-hover border border-accent-line rounded-full px-3 py-1">
              {domainFilter}
              <button onClick={() => setDomainFilter('')} className="hover:text-accent-hover ml-0.5" aria-label="Show every site">×</button>
            </span>
          )}
          {dateFilter && (
            <span className="flex items-center gap-1 text-sm bg-accent-wash text-accent-hover border border-accent-line rounded-full px-3 py-1">
              {dateFilter}
              <button onClick={() => setDateFilter('')} className="hover:text-accent-hover ml-0.5" aria-label="Clear date">×</button>
            </span>
          )}

          <div className="flex items-center bg-sand rounded-full p-0.5">
            {(['all', 'safari', 'firefox'] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBrowserFilter(b)}
                aria-pressed={browserFilter === b}
                className={`px-3 py-1 text-sm rounded-full transition-colors ${
                  browserFilter === b
                    ? 'bg-surface text-text-primary shadow-sm font-medium'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {b === 'all' ? 'All' : b === 'safari' ? 'Safari' : 'Firefox'}
              </button>
            ))}
          </div>

          <SaveButton onClick={onSave} busy={saving} label="Save all" />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-base border-b border-rule">
            <tr>
              <th className="text-left px-6 py-2.5 font-medium text-text-secondary text-xs">Page</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">Site</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">When</th>
              <th className="text-left px-4 py-2.5 font-medium text-text-secondary text-xs">Browser</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr
                key={v.visit_id}
                ref={`browser:${v.visit_id}` === selectId ? el => el?.scrollIntoView({ block: 'center' }) : undefined}
                className={`border-b border-rule ${`browser:${v.visit_id}` === selectId ? 'bg-accent-wash' : 'hover:bg-surface'}`}
              >
                <td className="px-6 py-3 max-w-xs">
                  <div className="font-medium text-text-primary truncate"><Highlight text={v.title || v.url} query={query} /></div>
                  {v.title && (
                    <div className="text-xs text-text-tertiary truncate"><Highlight text={v.url} query={query} around={30} /></div>
                  )}
                </td>
                <td className="px-4 py-3 text-text-secondary"><Highlight text={v.domain} query={query} /></td>
                <td className="px-4 py-3 text-text-secondary whitespace-nowrap">
                  {formatDateTime(v.visit_date)}
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sand text-text-secondary">
                    {v.browser === 'safari' ? 'Safari' : 'Firefox'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <EmptyState
            icon={GlobeIcon}
            title={hasActiveFilter ? 'No pages match' : 'No web history in this backup'}
            detail={hasActiveFilter ? 'Try a different word, or clear the site or date.' : undefined}
          />
        )}
      </div>
    </div>
  );
}
