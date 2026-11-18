// The data bundle: everything in one folder, in a documented format other tools can
// read (docs/BUNDLE.md). The engine writes it (export_bundle in python/bundle.py);
// this is what the Save to computer screen offers and says about it.

/** The kinds of data a bundle can hold, as the engine names them. */
export type BundleKind = 'messages' | 'calls' | 'voicemail' | 'contacts' | 'photos' | 'people';

/** Files copied into the bundle beside the JSON. */
export type BundleFiles = 'attachments' | 'voicemail_audio' | 'photos';

/** The overview counts the screen has, enough to leave out what a backup doesn't hold. */
export interface BundleCounts {
  total_messages?: number;
  total_calls?: number;
  total_voicemails?: number;
  total_contacts?: number;
  photos_in_backup?: number;
  hidden_photos_in_backup?: number;
}

export const BUNDLE_KINDS: { id: BundleKind; label: string; count?: (c: BundleCounts) => number }[] = [
  { id: 'messages', label: 'Messages', count: c => c.total_messages ?? 0 },
  { id: 'calls', label: 'Call history', count: c => c.total_calls ?? 0 },
  { id: 'voicemail', label: 'Voicemail', count: c => c.total_voicemails ?? 0 },
  { id: 'contacts', label: 'Address book', count: c => c.total_contacts ?? 0 },
  { id: 'photos', label: 'Photo and video details', count: c => (c.photos_in_backup ?? 0) + (c.hidden_photos_in_backup ?? 0) },
  { id: 'people', label: 'People (who you were in touch with)' },
];

export const BUNDLE_FILES: { id: BundleFiles; label: string; needs: BundleKind; detail?: string }[] = [
  { id: 'attachments', label: 'Message attachments', needs: 'messages' },
  { id: 'voicemail_audio', label: 'Voicemail audio', needs: 'voicemail' },
  { id: 'photos', label: 'Photo and video files', needs: 'photos', detail: 'Can take a lot of space' },
];

export interface BundleChoice {
  kinds: Set<BundleKind>;
  files: Set<BundleFiles>;
}

/**
 * What's ticked to start with: every kind of data the backup has (all of them when
 * the counts aren't known yet), attachments and voicemail audio, but not photo files,
 * which can be tens of gigabytes.
 */
export function defaultBundleChoice(counts: BundleCounts | null): BundleChoice {
  const kinds = new Set<BundleKind>(
    BUNDLE_KINDS.filter(k => !counts || !k.count || k.count(counts) > 0).map(k => k.id),
  );
  return { kinds, files: new Set<BundleFiles>(['attachments', 'voicemail_audio']) };
}

/** The engine's export_bundle params for a choice (the folder and time zone are added by the caller). */
export function bundleParams(choice: BundleChoice): { types: BundleKind[]; files: Record<BundleFiles, boolean> } {
  return {
    types: BUNDLE_KINDS.map(k => k.id).filter(id => choice.kinds.has(id)),
    files: Object.fromEntries(
      BUNDLE_FILES.map(f => [f.id, choice.files.has(f.id) && choice.kinds.has(f.needs)]),
    ) as Record<BundleFiles, boolean>,
  };
}

/** What export_bundle returns. */
export interface BundleResult {
  path: string;
  schema_version: string;
  files: string[];
  counts: Partial<Record<BundleKind, number>>;
  errors: Partial<Record<BundleKind, string>>;
  failed_files: number;
}

const NOUNS: Record<BundleKind, [string, string]> = {
  messages: ['message', 'messages'],
  calls: ['call', 'calls'],
  voicemail: ['voicemail', 'voicemails'],
  contacts: ['contact', 'contacts'],
  photos: ['photo or video', 'photos and videos'],
  people: ['person', 'people'],
};

/** "1,410 messages · 9 voicemails · 45 contacts · Call history couldn't be read · 2 files couldn't be copied" */
export function bundleSummary(result: BundleResult): string {
  const parts: string[] = [];
  for (const { id, label } of BUNDLE_KINDS) {
    const n = result.counts?.[id];
    if (result.errors?.[id]) parts.push(`${label.replace(/ \(.*\)$/, '')} couldn't be read`);
    else if (n != null && n > 0) parts.push(`${n.toLocaleString()} ${n === 1 ? NOUNS[id][0] : NOUNS[id][1]}`);
  }
  if (result.failed_files > 0) {
    parts.push(`${result.failed_files.toLocaleString()} ${result.failed_files === 1 ? "file couldn't" : "files couldn't"} be copied`);
  }
  return parts.length ? parts.join(' · ') : 'Nothing to save from this backup';
}

/** "Saving 1,234 of 5,678 records…" */
export function bundleProgress(done: number, total: number): string {
  const current = Math.min(done, total);
  return `Saving ${current.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}…`;
}

/** The computer's time zone ("America/Los_Angeles"), for the bundle's manifest; null if it can't be told. */
export function computerTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
