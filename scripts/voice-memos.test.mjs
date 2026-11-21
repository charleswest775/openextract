// Tests for the Voice Memos screen's wording and decisions (src/lib/voiceMemos.ts):
// names and lengths, chips, what's said when a recording's audio isn't in the
// backup, the sidebar's lists (All Recordings, Favorites, folders, Recently
// Deleted), empty states, what a save reports, the home tile and the section.
// Data is fictional, shaped like the engine's list_voice_memos.
// Run with: node --test scripts/voice-memos.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones } from './test-helpers/time-zones.mjs';

const vm = loadTs('src/lib/voiceMemos.ts');
const { formatDateTime } = loadTs('src/lib/dates.ts');

function memo(over = {}) {
  return {
    id: 1, unique_id: '6F3B2C1A-0000-4000-8000-000000000001', title: 'Site walk', date: '2026-05-13T21:15:22+00:00',
    duration_seconds: 83.4, folder_id: null, folder: null,
    is_favorite: false, is_deleted: false, deleted_date: null, in_phone_list: true,
    recorded_on_watch: false, is_enhanced: false, is_layered: false, is_spatial: false, has_transcript: false,
    file_name: '20260513 141522-6F3B2C1A.m4a', format: 'm4a', audio_available: true, audio_missing_reason: null,
    source: 'CloudRecordings.db',
    ...over,
  };
}

const folder = over => ({ id: 'F1', name: 'Site visits', rank: 1, count: 0, ...over });

test('a recording without a name still has one; lengths read like the Voice Memos app', () => {
  assert.equal(vm.memoName({ title: null }), 'Untitled recording');
  assert.equal(vm.memoName({ title: '  ' }), 'Untitled recording');
  assert.equal(vm.memoName({ title: ' Song idea ' }), 'Song idea');
  assert.equal(vm.memoLength(42), '0:42');
  assert.equal(vm.memoLength(83.4), '1:23');
  assert.equal(vm.memoLength(2480), '41:20');
  assert.equal(vm.memoLength(3729), '1:02:09');
  assert.equal(vm.memoLength(0.3), '0:01', 'a very short one is never 0:00');
  assert.equal(vm.memoLength(0), '');
  assert.equal(vm.memoLength(null), '');
  assert.equal(vm.memoLength(Number.NaN), '');
  assert.equal(vm.aboutLength(30), 'Under a minute');
  assert.equal(vm.aboutLength(2520), 'About 42 min');
  assert.equal(vm.aboutLength(3900), 'About 1 hr 5 min');
  assert.equal(vm.aboutLength(7200), 'About 2 hr');
  assert.equal(vm.aboutLength(0), '');
});

test("a recording's line: when, how long, its folder outside it, and when it was deleted", () => {
  const m = memo({ folder_id: 'F1', folder: 'Site visits' });
  const when = formatDateTime(m.date).trim();
  assert.equal(vm.memoLine(m), `${when} · 1:23 · Site visits`);
  assert.equal(vm.memoLine(m, { showFolder: false }), `${when} · 1:23`);
  assert.equal(vm.memoLine(memo({ duration_seconds: null, date: null })), '');
  const gone = memo({ is_deleted: true, deleted_date: '2026-06-01T10:00:00+00:00' });
  assert.equal(vm.memoLine(gone), `${when} · 1:23 · Deleted ${formatDateTime(gone.deleted_date).trim()}`);
});

test('chips: favourite, how it was made, and audio that isn\'t in the backup', () => {
  assert.deepEqual(vm.memoChips(memo()), []);
  assert.deepEqual(vm.memoChips(memo({ is_favorite: true, is_enhanced: true, recorded_on_watch: true, is_layered: true, is_spatial: true })),
    ['Favorite', 'Enhanced', 'Recorded on Apple Watch', 'Layered', 'Spatial audio']);
  assert.deepEqual(vm.memoChips(memo({ is_favorite: null, recorded_on_watch: null })), [], 'unknown is not a chip');
  assert.deepEqual(vm.memoChips(memo({ audio_available: false, audio_missing_reason: 'in_icloud_only' })), ['Kept in iCloud only']);
  assert.deepEqual(vm.memoChips(memo({ audio_available: false, audio_missing_reason: 'not_in_backup' })), ['Audio not in this backup']);
});

test('a recording whose audio isn\'t in the backup says why, in the engine\'s words', () => {
  assert.equal(vm.missingAudioText('in_icloud_only'), "This recording was kept in iCloud only, so it isn't in the backup.");
  assert.equal(vm.missingAudioText('not_in_backup'), "This recording isn't in the backup.");
  assert.equal(vm.missingAudioText(null), "This recording isn't in the backup.");
});

test('the sidebar: All Recordings, Favorites when there are any, the folders by rank, then Recently Deleted', () => {
  const list = [
    memo({ id: 5, is_favorite: true }),
    memo({ id: 4, folder_id: 'F2', folder: 'Workshop' }),
    memo({ id: 3, folder_id: 'F1', folder: 'Site visits' }),
    memo({ id: 2, is_deleted: true, is_favorite: true, folder_id: 'F1', folder: 'Site visits' }),
    memo({ id: 1 }),
  ];
  const lists = vm.memoLists(list, [folder({ id: 'F2', name: 'Workshop', rank: 2 }), folder({ id: 'F1', rank: 1 }), folder({ id: 'F3', name: 'Empty', rank: 3 })]);
  assert.deepEqual(lists.all.memos.map(m => m.id), [5, 4, 3, 1], 'deleted recordings are only in Recently Deleted');
  assert.equal(lists.all.label, 'All Recordings');
  assert.deepEqual(lists.favorites.memos.map(m => m.id), [5]);
  assert.deepEqual(lists.folders.map(f => [f.id, f.label, f.memos.map(m => m.id)]),
    [['folder:F1', 'Site visits', [3]], ['folder:F2', 'Workshop', [4]], ['folder:F3', 'Empty', []]]);
  assert.deepEqual(lists.deleted.memos.map(m => m.id), [2]);
  assert.deepEqual(vm.allLists(lists).map(l => l.id), ['all', 'favorites', 'folder:F1', 'folder:F2', 'folder:F3', 'deleted']);

  const plainLists = vm.memoLists([memo()]);
  assert.equal(plainLists.favorites, null, 'no favourites: no Favorites list');
  assert.equal(plainLists.deleted, null, 'nothing deleted: no Recently Deleted');
  assert.deepEqual(plainLists.folders, []);
  assert.deepEqual(vm.allLists(plainLists).map(l => l.id), ['all']);
  assert.equal(vm.folderName({ name: null }), 'Untitled folder');
  assert.equal(list[0].id, 5, "the engine's list is left as it was");
});

test('where a found recording opens, and what an empty list says', () => {
  assert.equal(vm.homeListOf(memo()), vm.ALL_RECORDINGS);
  assert.equal(vm.homeListOf(memo({ is_deleted: true })), vm.RECENTLY_DELETED);
  assert.equal(vm.memoSelectId(memo({ id: 12 })), 'voice_memo:12');
  assert.equal(vm.listEmptyText('favorites'), 'No recordings are marked as favorites.');
  assert.equal(vm.listEmptyText('deleted'), 'Nothing is in Recently Deleted.');
  assert.equal(vm.listEmptyText('folder:F1'), 'This folder has no recordings.');
  assert.equal(vm.listEmptyText('all'), 'Every recording in this backup is in Recently Deleted.');
  assert.equal(vm.DELETED_NOTE, 'Recordings deleted on the iPhone that are still in this backup.');
  assert.deepEqual(vm.memoMatchFields(memo({ folder: 'Workshop' }), 'the roof needs work'), ['Site walk', 'Workshop', 'the roof needs work']);
});

test('empty states: calm when Voice Memos wasn\'t used, an error or an old format to report', () => {
  assert.deepEqual(vm.emptyCopy('not_in_backup', null), {
    kind: 'empty', title: 'No voice memos in this backup', detail: "Voice Memos wasn't used on this iPhone, or its recordings weren't in the backup.",
  });
  assert.deepEqual(vm.emptyCopy('no_records', null), {
    kind: 'empty', title: 'No voice memos in this backup', detail: 'Voice Memos is on this iPhone, but it has no recordings.',
  });
  const old = vm.emptyCopy('unsupported_format', "This backup's Voice Memos are in an older format OpenExtract can't read yet.");
  assert.deepEqual([old.kind, old.title], ['unsupported', "This version of Voice Memos can't be read yet"]);
  const broken = vm.emptyCopy(null, 'Voice Memos are in this backup but could not be read. The backup may be incomplete or damaged.');
  assert.deepEqual([broken.kind, broken.title], ['error', "Couldn't read the voice memos"]);
  // Transcripts are read only when a recording is opened, so search can't promise to find their words
  assert.deepEqual(vm.noMatchCopy('roof'), {
    title: 'No recordings match "roof"', detail: "Try a recording's name or its folder. Transcripts are searched once you've opened the recording.",
  });
});

test('what a save reports: what was written, and what wasn\'t in the backup', () => {
  assert.equal(vm.voiceMemoSaveDetail({ count: 3, not_in_backup: 0, failed: 0 }, 'recordings'), 'Audio files, as recorded');
  assert.equal(vm.voiceMemoSaveDetail({ count: 3, not_in_backup: 1 }, 'recordings'), "Audio files, as recorded. 1 recording wasn't in the backup");
  assert.equal(vm.voiceMemoSaveDetail({ count: 3, not_in_backup: 2, failed: 1 }, 'recordings'),
    "Audio files, as recorded. 2 recordings weren't in the backup. 1 recording couldn't be copied");
  assert.equal(vm.voiceMemoSaveDetail({ count: 5, not_in_backup: 2 }, 'csv'), 'A spreadsheet of the recordings', 'every row is written');
});

test('the home tile: shown with recordings or when they couldn\'t be read, with a line to match', () => {
  assert.equal(vm.voiceMemosUnreadable({ voice_memos_status: 'error' }), true);
  assert.equal(vm.voiceMemosUnreadable({ voice_memos_status: 'unsupported_format' }), true);
  assert.equal(vm.voiceMemosUnreadable({ voice_memos_status: 'no_records' }), false);
  assert.equal(vm.voiceMemosUnreadable(null), false);
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'error' }), "Couldn't be read: open it to see why");
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'unsupported_format' }), "This Voice Memos version can't be read yet");
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'ok', total_voice_memos: 4, total_voice_memo_seconds: 2520 }), 'About 42 min of recordings');
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'ok', total_voice_memos: 4 }), 'Recordings from Voice Memos');
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'ok', total_voice_memos: 4, total_deleted_voice_memos: 2, total_voice_memo_seconds: 2520 }), 'About 42 min of recordings');
  // Every recording is in Recently Deleted: the backup still has them
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'ok', total_voice_memos: 0, total_deleted_voice_memos: 2, total_voice_memo_seconds: 0 }), 'In Recently Deleted');
  assert.equal(vm.voiceMemosHomeLine({ voice_memos_status: 'error', total_voice_memos: 0, total_deleted_voice_memos: 2 }), "Couldn't be read: open it to see why");
});

test('every recording a save writes, Recently Deleted too', () => {
  assert.equal(vm.voiceMemosListed({ total_voice_memos: 4, total_deleted_voice_memos: 2 }), 6);
  assert.equal(vm.voiceMemosListed({ total_voice_memos: 0, total_deleted_voice_memos: 2 }), 2);
  assert.equal(vm.voiceMemosListed({ total_voice_memos: 3 }), 3, 'an older engine without the deleted count');
  assert.equal(vm.voiceMemosListed({}), 0);
  assert.equal(vm.voiceMemosListed(null), 0);
});

test('"Audio files" is offered unless no recording\'s audio is in the backup', () => {
  assert.equal(vm.voiceMemosAudioSaveable({ total_voice_memos: 3, total_voice_memos_with_audio: 2 }), true);
  // Every recording kept in iCloud only: only the spreadsheet can be saved
  assert.equal(vm.voiceMemosAudioSaveable({ total_voice_memos: 3, total_voice_memos_with_audio: 0 }), false);
  assert.equal(vm.voiceMemosAudioSaveable({ total_voice_memos: 3 }), true, 'an older engine without the count');
  assert.equal(vm.voiceMemosAudioSaveable(null), true);
});

test('Voice Memos is a section shown only with recordings or when unreadable, and never "missing"', () => {
  const s = loadTs('src/components/explore/sections.ts');
  const base = {
    total_messages: 1, total_whatsapp_messages: 0, photos_in_backup: 1, total_contacts: 1, total_calls: 1,
    total_notes: 1, total_voicemails: 1, total_calendar_events: 1,
  };
  const ids = o => s.availableData(o, true).map(x => x.id);
  assert.ok(!ids({ ...base, total_voice_memos: 0, voice_memos_status: 'not_in_backup' }).includes('voice_memos'));
  assert.ok(!ids(base).includes('voice_memos'), 'an older engine without the numbers: no section');
  assert.ok(ids({ ...base, total_voice_memos: 2, voice_memos_status: 'ok' }).includes('voice_memos'));
  assert.ok(ids({ ...base, total_voice_memos: 0, voice_memos_status: 'error' }).includes('voice_memos'));
  // Every recording in Recently Deleted: still shown, so they can be played and saved
  const deletedOnly = { ...base, total_voice_memos: 0, total_deleted_voice_memos: 2, voice_memos_status: 'ok' };
  assert.ok(ids(deletedOnly).includes('voice_memos'));
  assert.ok(!s.missingKinds(deletedOnly, true).includes('voice memos'));
  assert.ok(!ids({ ...base, total_voice_memos: 0, total_deleted_voice_memos: 0, voice_memos_status: 'no_records' }).includes('voice_memos'));
  assert.ok(!s.missingKinds({ ...base, total_voice_memos: 0 }, true).includes('voice memos'));
  assert.deepEqual(s.SCOPED.voice_memos, { placeholder: 'Search voice memos', items: 'recordings' });
  assert.equal(s.sectionFor('voice_memos').label, 'Voice Memos');
});

// A backup's overview and stats as get_backup_stats sends them, with every Voice Memos recording in Recently Deleted
function deletedOnlyStats() {
  const overview = {
    device_name: 'Test iPhone', product_type: 'iPhone17,1', ios_version: '26.5', last_backup: '2026-11-20T18:00:00+00:00', encrypted: true, size_gb: 1,
    total_messages: 1, total_conversations: 1, total_photos: 1, total_videos: 0, photos_in_backup: 1, total_contacts: 1, total_calls: 1,
    total_notes: 1, total_voicemails: 1, total_whatsapp_messages: 0, total_whatsapp_chats: 0, whatsapp_status: 'not_in_backup',
    total_podcasts: 0, total_podcasts_followed: 0, total_podcast_episodes_listened: 0, podcasts_status: 'not_in_backup',
    total_voice_memos: 0, total_voice_memo_seconds: 0, total_deleted_voice_memos: 2, total_voice_memos_with_audio: 2, voice_memos_status: 'ok',
    total_calendar_events: 0, total_subscribed_events: 0, total_calendars: 0, total_calendars_with_events: 0, calendar_status: 'not_in_backup',
  };
  return {
    overview,
    messages: { sent: 0, received: 1, imessage_count: 1, sms_count: 0, group_conversations: 0, one_on_one_conversations: 1, top_conversations: [], busiest_day: '', busiest_hour: 0, avg_messages_per_day: 0, total_attachments: 0, first_message_date: null, last_message_date: null },
    photos: { by_kind: {}, total_photos: 1, total_videos: 0, total_favorites: 0, with_location: 0, earliest_date: null, latest_date: null, total_video_duration_seconds: 0 },
    calls: { incoming: 0, outgoing: 1, answered: 1, missed: 0, total_duration_seconds: 0, avg_duration_seconds: 0, longest_call_seconds: 0, facetime_count: 0, regular_count: 1, top_contacts: [] },
    notes: { total: 1, avg_length_chars: 1, longest_chars: 1 },
    voicemails: { total: 1, total_duration_seconds: 0, read: 0, unread: 1 },
    errors: [],
  };
}

test('every recording in Recently Deleted: the home tile, Backup details and Save to computer still offer them', t => {
  const bridge = fakeBridge({});
  window.openextract.platform = 'darwin';
  t.after(bridge.restore);
  const stats = deletedOnlyStats();
  const { overview } = stats;
  const s = loadTs('src/components/explore/sections.ts');
  // Home: the tile, with no number (none outside Recently Deleted), saying where they are
  const BackupHome = loadTs('src/components/explore/BackupHome.tsx').default;
  const ctx = {
    udid: 'u1', session: null, stats: null, overview, hasBrowserHistory: false, index: { entries: [], addressBook: [] },
    data: s.availableData(overview, false), missing: [], activeTab: 'home', openTab: () => {}, onBack: () => {}, openSettings: () => {}, unfinished: false,
  };
  const home = renderToStaticMarkup(createElement(BackupHome, { ctx, onSearch: () => {} }));
  const tile = home.match(/<button[^>]*aria-label="Voice Memos[",][\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(tile, /aria-label="Voice Memos"/, 'no number');
  assert.match(tile, />In Recently Deleted</);
  // Backup details: its card, with how many are in Recently Deleted
  const BackupDashboard = loadTs('src/components/explore/BackupDashboard.tsx').default;
  const details = renderToStaticMarkup(createElement(BackupDashboard, { stats, loading: false, error: null, onNavigate: () => {}, hasBrowserHistory: false }))
    .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.match(details, /\|In Recently Deleted\|2\|/);
  // Save to computer: offered, counting what a save writes
  const ExportPanel = loadTs('src/components/explore/ExportPanel.tsx').default;
  const panel = renderToStaticMarkup(createElement(ExportPanel, { udid: 'u1', overview, hasBrowserHistory: false })).replace(/<[^>]+>/g, '|');
  assert.match(panel, /Voice Memos\|+2 voice memos, as the recordings themselves or a spreadsheet/);
  // With some outside Recently Deleted too, the save's count is all of them
  const both = renderToStaticMarkup(createElement(ExportPanel, { udid: 'u1', overview: { ...overview, total_voice_memos: 3 }, hasBrowserHistory: false }));
  assert.match(both, /5 voice memos, as the recordings/);
});

test('after a save, the thank-you card names what was saved', () => {
  const { whatWasSaved } = loadTs('src/lib/payItForward.ts');
  assert.deepEqual(whatWasSaved('voice_memos'), { noun: 'voice memos', plural: true });
  assert.deepEqual(whatWasSaved('calendar'), { noun: 'calendar', plural: false });
});

rerunInTimeZones(import.meta.url);
