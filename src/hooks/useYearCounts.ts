import { useEffect, useRef, useState } from 'react';
import { sidecarCall } from '../lib/ipc';
import { ContactOption, TimelineEntryType } from '../types/timeline';
import {
  IdentifierGroupMap,
  PersonRow,
  buildContactOptions,
  buildIdentifierGroupMap,
} from '../lib/people';
import { RawCall, RawVoicemail, normalizeCall, normalizeVoicemail } from './useTimeline';
import type { Conversation } from './useMessages';

export type DayCounts = Partial<Record<TimelineEntryType, number>>;

export interface YearCounts {
  year: number;
  years: number[];
  days: Record<string, DayCounts>;
  history_start: string | null;
  history_end: string | null;
  errors: Partial<Record<TimelineEntryType, string>>;
}

// The year to show first: this one if the backup holds it, or else its latest
// before now. A wrong camera clock can add a year from the future.
function latestYear(years: number[], thisYear: number): number | null {
  const past = years.filter(y => y <= thisYear);
  return past.length ? past[past.length - 1] : years[years.length - 1] ?? null;
}

// Counts for every type come back at once, so turning a type on or off is instant.
export function useYearCounts(
  udid: string,
  year: number | null,
  identifiers: string[] | null,
  onYearChosen: (year: number) => void,
) {
  const [counts, setCounts] = useState<YearCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const thisYear = new Date().getFullYear();
    setLoading(true);
    setError(null);
    sidecarCall<YearCounts>('get_year_counts', { udid, year: year ?? thisYear, identifiers })
      .then(result => {
        if (requestRef.current !== request) return;
        const chosen = year ?? latestYear(result.years, thisYear);
        if (chosen !== null && chosen !== result.year) {
          // The first look only learned which years there are. This asks again.
          onYearChosen(chosen);
          return;
        }
        if (year === null && chosen !== null) onYearChosen(chosen);
        setCounts(result);
        setLoading(false);
      })
      .catch((e: any) => {
        if (requestRef.current !== request) return;
        setError(e.message || 'Failed to count this year');
        setLoading(false);
      });
    return () => {
      requestRef.current += 1;
    };
    // `identifiers` is compared by content, and onYearChosen only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [udid, year, identifiers?.join('\n')]);

  return { counts, error, loading };
}

export interface YearPeople {
  options: ContactOption[];
  rows: PersonRow[];
  groups: IdentifierGroupMap;
}

// The Timeline's person picker, without loading the Timeline: the same people,
// from the conversation list, calls and voicemail.
export function useYearPeople(udid: string): YearPeople | null {
  const [people, setPeople] = useState<YearPeople | null>(null);

  useEffect(() => {
    let current = true;
    setPeople(null);
    (async () => {
      const [{ conversations }, calls, voicemails, contacts] = await Promise.all([
        sidecarCall<{ conversations: Conversation[] }>('list_conversations', { udid }),
        sidecarCall<{ calls: RawCall[] }>('list_calls', { udid, limit: 999999 }).catch(() => ({ calls: [] })),
        sidecarCall<{ voicemails: RawVoicemail[] }>('list_voicemails', { udid }).catch(() => ({ voicemails: [] })),
        sidecarCall<{ contacts: { phones: string[]; emails: string[] }[] }>('list_contacts', { udid })
          .catch(() => ({ contacts: [] })),
      ]);
      if (!current) return;
      const rows: PersonRow[] = [
        ...conversations.map(c => ({
          contactName: c.display_name || c.chat_identifier,
          contactIdentifier: c.chat_identifier,
        })),
        ...calls.calls.map(normalizeCall),
        ...voicemails.voicemails.map(normalizeVoicemail),
      ];
      setPeople({
        options: buildContactOptions(rows),
        rows,
        groups: buildIdentifierGroupMap(contacts.contacts),
      });
    })().catch(() => {
      // The picker stays at "All contacts"; the grid doesn't need it.
    });
    return () => {
      current = false;
    };
  }, [udid]);

  return people;
}
