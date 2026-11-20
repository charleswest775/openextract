import type { TimelineEntryType } from '../../types/timeline';
import { plural } from '../../lib/saveData';
import { matches } from '../../lib/search';
import type { Person } from './gather';

// One person's page on People: everything that passed between you, which the
// Timeline's person filter works out (useTimeline). These say how its chips
// read and what each one shows.

/** What can pass between you and someone, in the order the chips go. */
export type StreamKind = 'message' | 'whatsapp' | 'call' | 'voicemail' | 'photo' | 'note';
export const STREAM_KINDS: StreamKind[] = ['message', 'whatsapp', 'call', 'voicemail', 'photo', 'note'];

const KIND_LABEL: Record<StreamKind, [string, string]> = {
  message: ['message', 'messages'],
  whatsapp: ['WhatsApp message', 'WhatsApp messages'],
  call: ['call', 'calls'],
  voicemail: ['voicemail', 'voicemails'],
  photo: ['photo', 'photos'],
  note: ['shared note', 'shared notes'],
};

/** "114 messages", "1 shared note". */
export function countOf(kind: StreamKind, n: number): string {
  return plural(n, ...KIND_LABEL[kind]);
}

/**
 * The kinds of event a chip shows. Photos are the ones sent in your chats, so
 * they come inside their messages: Everything doesn't list them separately, and
 * Photos shows the messages that carry one.
 */
export function streamTypes(kind: StreamKind | 'all'): Set<TimelineEntryType> {
  return new Set<TimelineEntryType>(kind === 'all' ? ['message', 'whatsapp', 'call', 'voicemail', 'note'] : [kind]);
}

export interface KindChip {
  kind: StreamKind | 'all';
  label: string;
}

/**
 * The chips over someone's stream: Everything, then each kind there's any of
 * after the dates and search, and the one picked even when there's none.
 */
export function kindChips(counts: Record<TimelineEntryType, number>, picked: StreamKind | 'all'): KindChip[] {
  const everything = counts.message + counts.whatsapp + counts.call + counts.voicemail + counts.note;
  return [
    { kind: 'all', label: `Everything · ${everything.toLocaleString()}` },
    ...STREAM_KINDS.filter(k => counts[k] > 0 || k === picked).map(k => ({ kind: k, label: countOf(k, counts[k]) })),
  ];
}

/** What an empty stream says: "No calls with Karin in these dates match "tent"". */
export function nothingBetween(name: string, { kind, dates, within }: { kind: StreamKind | 'all'; dates: boolean; within: string }): string {
  const words = within.trim();
  const what = kind === 'all' ? 'Nothing' : `No ${KIND_LABEL[kind][1]}`;
  return `${what} with ${name}${dates ? ' in these dates' : ''}${words ? ` ${kind === 'all' ? 'matches' : 'match'} “${words}”` : ''}`;
}

/**
 * The person a search names, for pointing from the Timeline to their page:
 * the one most in touch whose name it matches. Groups are left out, and a
 * single letter names no one.
 */
export function personNamed(people: Person[], query: string): Person | undefined {
  if (query.trim().length < 2) return undefined;
  return people.find(p => !p.isGroup && matches(query, p.name));
}
