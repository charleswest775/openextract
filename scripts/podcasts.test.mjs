// Tests for the Podcasts screen's wording and decisions (src/lib/podcasts.ts):
// how shows are grouped and ordered, the listening history's order, episode
// status chips, lengths and places, links, empty states and the home tile.
// Data is fictional, with example.com addresses, and shaped like the engine's
// list_podcasts / list_podcast_episodes.
// Run with: node --test scripts/podcasts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const pc = loadTs('src/lib/podcasts.ts');

function show(over = {}) {
  return {
    id: 1, uuid: null, title: 'Garden Hour', author: 'Example Radio', description: null, category: 'Leisure',
    feed_url: 'https://feeds.example.com/garden.xml', original_feed_url: null, webpage_url: 'https://example.com/garden',
    image_url: null, store_url: null, store_id: null, show_type: 'episodic',
    followed: true, subscribed: true, implicitly_followed: false, hidden: false,
    added_date: '2023-01-05T09:00:00Z', last_played_date: null, unfollowed_date: null,
    episode_count: 10, listened_count: 0,
    ...over,
  };
}

function episode(over = {}) {
  return {
    id: 100, podcast_id: 1, podcast_title: 'Garden Hour', uuid: null, guid: null, title: 'Planting bulbs', author: null,
    published_date: '2023-03-01T08:00:00Z', duration_seconds: 2520, play_count: 0, playhead_seconds: null,
    last_played_date: null, play_state: 'unplayed', listened: false, saved: false, downloaded_on_phone: false,
    enclosure_url: 'https://cdn.example.com/garden/bulbs.mp3', webpage_url: null,
    season: null, episode_number: null, episode_type: 'full', video: false, removed_from_feed: false, hidden: false,
    ...over,
  };
}

test('followed shows come first, A to Z; the rest are most recently played first', () => {
  const list = [
    show({ id: 1, title: 'zebra talk' }),
    show({ id: 2, title: 'Apple Orchard' }),
    show({ id: 3, title: 'Heard once', followed: false, last_played_date: '2023-02-01T10:00:00Z' }),
    show({ id: 4, title: 'Heard lately', followed: false, implicitly_followed: true, last_played_date: '2024-02-01T10:00:00Z' }),
    show({ id: 5, title: 'Never played', followed: false, unfollowed_date: '2022-01-01T00:00:00Z' }),
    show({ id: 6, title: null }),
  ];
  const { followed, others } = pc.groupShows(list);
  assert.deepEqual(followed.map(p => p.id), [2, 6, 1], 'case doesn\'t count; a show with no title sorts by its stand-in name');
  assert.deepEqual(others.map(p => p.id), [4, 3, 5]);
  assert.equal(list[0].id, 1, 'the engine\'s list is left as it was');
});

test('a show with no title still has a name, and its row says who makes it and what was heard', () => {
  assert.equal(pc.showName({ title: null }), 'Untitled podcast');
  assert.equal(pc.showName({ title: '  ' }), 'Untitled podcast');
  assert.equal(pc.episodeName({ title: '' }), 'Untitled episode');
  assert.equal(pc.showLine(show()), 'Example Radio');
  assert.equal(pc.showLine(show({ listened_count: 3 })), 'Example Radio · 3 episodes listened to');
  assert.equal(pc.showLine(show({ author: null, listened_count: 1 })), '1 episode listened to');
  assert.equal(pc.showCounts(show({ episode_count: 1 })), '1 episode');
  assert.equal(pc.showCounts(show({ episode_count: 12, listened_count: 3 })), '12 episodes, 3 listened to');
});

test('follow state: following, unfollowed with the day, or not followed', () => {
  assert.equal(pc.followState(show()), 'Following');
  assert.match(pc.followState(show({ followed: false, unfollowed_date: '2022-06-15T12:00:00Z' })), /^Unfollowed \S/);
  assert.equal(pc.followState(show({ followed: false })), 'Not followed');
});

test('a show opens on what was listened to, or on all its episodes when nothing was', () => {
  assert.equal(pc.defaultEpisodeView(show({ listened_count: 2 })), 'listened');
  assert.equal(pc.defaultEpisodeView(show({ listened_count: 0 })), 'all');
});

test('the listening history is most recently played first, then newest published', () => {
  const list = [
    episode({ id: 1, last_played_date: '2023-05-01T10:00:00Z' }),
    episode({ id: 2, last_played_date: null, published_date: '2023-01-01T00:00:00Z' }),
    episode({ id: 3, last_played_date: '2024-01-01T10:00:00Z' }),
    episode({ id: 4, last_played_date: null, published_date: '2023-06-01T00:00:00Z' }),
    episode({ id: 5, last_played_date: 'not a date', published_date: null }),
  ];
  assert.deepEqual(pc.historyOrder(list).map(e => e.id), [3, 1, 4, 2, 5]);
  assert.deepEqual(list.map(e => e.id), [1, 2, 3, 4, 5], 'sorted as a copy');
});

test('lengths read like "42 min" and places like "3:07 in"', () => {
  assert.equal(pc.episodeLength(2520), '42 min');
  assert.equal(pc.episodeLength(20), '1 min');
  assert.equal(pc.episodeLength(3900), '1 hr 5 min');
  assert.equal(pc.episodeLength(7200), '2 hr');
  assert.equal(pc.episodeLength(null), '');
  assert.equal(pc.episodeLength(0), '');
  assert.equal(pc.clock(187.6), '3:07');
  assert.equal(pc.clock(3729), '1:02:09');
  assert.equal(pc.clock(5), '0:05');
});

test('status chips: how often it was played or how far in, saved, and downloaded on the iPhone', () => {
  assert.deepEqual(pc.episodeChips(episode()), []);
  assert.deepEqual(pc.episodeChips(episode({ play_count: 1, listened: true, play_state: 'played' })), ['Played once']);
  assert.deepEqual(pc.episodeChips(episode({ play_count: 3, listened: true })), ['Played 3 times']);
  assert.deepEqual(pc.episodeChips(episode({ play_state: 'in_progress', playhead_seconds: 187, listened: true })), ['In progress, 3:07 in']);
  assert.deepEqual(pc.episodeChips(episode({ play_state: 'in_progress', listened: true })), ['In progress']);
  assert.deepEqual(pc.episodeChips(episode({ play_count: 2, play_state: 'in_progress', playhead_seconds: 65, listened: true })), ['Played 2 times', '1:05 in']);
  assert.deepEqual(pc.episodeChips(episode({ last_played_date: '2023-03-02T08:00:00Z', listened: true, play_state: 'played' })), ['Played']);
  assert.deepEqual(pc.episodeChips(episode({ saved: true, downloaded_on_phone: true })), ['Saved', 'Downloaded on the iPhone']);
  // "played" from following a show isn't listening: no chip
  assert.deepEqual(pc.episodeChips(episode({ play_state: 'played' })), []);
});

test('an episode\'s line: published date and length, or in the history the show and when it was played', () => {
  const e = episode({ last_played_date: '2023-03-04T08:00:00Z' });
  const line = pc.episodeLine(e);
  assert.match(line, / · 42 min$/);
  assert.doesNotMatch(line, /Garden Hour/);
  assert.match(pc.episodeLine(e, { inHistory: true }), /^Garden Hour · Played \S.* · 42 min$/);
  assert.equal(pc.episodeLine(episode({ published_date: null, duration_seconds: null })), '');
});

test('links open only web addresses: the episode page, and the published audio', () => {
  assert.equal(pc.episodeLink({ webpage_url: 'https://example.com/ep/1' }), 'https://example.com/ep/1');
  assert.equal(pc.episodeLink({ webpage_url: null }), null);
  assert.equal(pc.episodeLink({ webpage_url: 'file:///var/mobile/Media/Podcasts/1.mp3' }), null);
  assert.equal(pc.episodeAudio({ enclosure_url: 'https://cdn.example.com/1.mp3' }), 'https://cdn.example.com/1.mp3');
  assert.equal(pc.episodeAudio({ enclosure_url: null }), null);
  // The phone's own copy (never in a backup) is never offered
  assert.equal(pc.episodeAudio({ enclosure_url: 'ipod-library://item/item.mp3?id=1' }), null);
  assert.equal(pc.webAddress('javascript:alert(1)'), null);
  assert.equal(pc.webAddress(' http://example.com '), 'http://example.com');
  assert.equal(pc.webAddress(null), null);
});

test('search looks through a show\'s name, maker and category, and an episode\'s title and show', () => {
  assert.deepEqual(pc.showMatchFields(show()), ['Garden Hour', 'Example Radio', 'Leisure']);
  assert.deepEqual(pc.episodeMatchFields(episode()), ['Planting bulbs', 'Garden Hour', null]);
});

test('empty states: calm when the Podcasts app wasn\'t used, a Report button when the library can\'t be read', () => {
  assert.deepEqual(pc.emptyCopy('not_in_backup', null), {
    kind: 'empty', title: 'No podcasts in this backup',
    detail: "The Podcasts app wasn't used on this iPhone, or its library wasn't in the backup.",
  });
  assert.deepEqual(pc.emptyCopy('no_records', null), {
    kind: 'empty', title: 'No podcasts in this backup',
    detail: "The Podcasts app is on this iPhone, but it doesn't follow any shows.",
  });
  assert.equal(pc.emptyCopy('not_in_backup', 'MTLibrary.sqlite not found').kind, 'empty', 'not there is never an error');
  assert.deepEqual(pc.emptyCopy(null, 'database disk image is malformed'), {
    kind: 'error', title: "Couldn't read the podcasts", detail: 'database disk image is malformed',
  });
  assert.equal(pc.emptyCopy('unsupported_format', null).kind, 'unsupported');
  assert.equal(pc.emptyCopy(null, null).detail, undefined);
  for (const c of [pc.emptyCopy('not_in_backup', null), pc.emptyCopy(null, 'x'), pc.emptyCopy('unsupported_format', null)]) {
    assert.doesNotMatch(`${c.title} ${c.detail ?? ''}`, /\berror\b/i, 'never says "Error"');
  }
  assert.deepEqual(pc.noMatchCopy('tea'), { title: 'No podcasts match "tea"', detail: "Try a show's name or who makes it." });
  assert.match(pc.episodesEmptyText('history'), /No episodes were listened to/);
  assert.match(pc.episodesEmptyText('listened'), /No episodes of this show/);
  assert.match(pc.episodesEmptyText('all'), /no episodes/);
});

test('the audio note says once, calmly, that audio isn\'t in backups', () => {
  assert.equal(pc.AUDIO_NOTE, "Episode audio isn't kept in iPhone backups. Get audio opens an episode in your browser, from where the podcast publishes it.");
});

test('home tile: shows followed, else episodes listened to; unreadable says so with no number', () => {
  assert.equal(pc.podcastsHomeLine({ total_podcasts: 8, total_podcasts_followed: 6, podcasts_status: 'ok' }), '6 shows you follow');
  assert.equal(pc.podcastsHomeLine({ total_podcasts: 1, total_podcasts_followed: 1 }), '1 show you follow');
  assert.equal(pc.podcastsHomeLine({ total_podcasts: 2, total_podcasts_followed: 0, total_podcast_episodes_listened: 4 }), '4 episodes listened to');
  assert.equal(pc.podcastsHomeLine({}), 'Shows and listening history', 'an older engine sends none of the numbers');
  assert.equal(pc.podcastsHomeLine({ podcasts_status: 'error' }), "Couldn't be read: open it to see why");
  assert.equal(pc.podcastsHomeLine({ podcasts_status: 'unsupported_format' }), "This Podcasts version can't be read yet");
  assert.equal(pc.podcastsUnreadable({ podcasts_status: 'error' }), true);
  assert.equal(pc.podcastsUnreadable({ podcasts_status: 'unsupported_format' }), true);
  assert.equal(pc.podcastsUnreadable({ podcasts_status: 'not_in_backup' }), false);
  assert.equal(pc.podcastsUnreadable(null), false);
});

test('Podcasts is a section shown only when the backup has shows or can\'t read them, and is never "missing"', () => {
  const s = loadTs('src/components/explore/sections.ts');
  const base = {
    total_messages: 1, total_whatsapp_messages: 0, photos_in_backup: 1, total_contacts: 1, total_calls: 1,
    total_notes: 1, total_voicemails: 1,
  };
  const ids = o => s.availableData(o, true).map(x => x.id);
  assert.ok(!ids({ ...base, total_podcasts: 0, podcasts_status: 'not_in_backup' }).includes('podcasts'));
  assert.ok(!ids(base).includes('podcasts'), 'an older engine without the numbers: no section');
  assert.ok(ids({ ...base, total_podcasts: 3, podcasts_status: 'ok' }).includes('podcasts'));
  assert.ok(ids({ ...base, total_podcasts: 0, podcasts_status: 'error' }).includes('podcasts'));
  const order = s.DATA_SECTIONS.map(x => x.id);
  assert.equal(order.indexOf('podcasts'), order.indexOf('voicemail') + 1, 'placed after Voicemail');
  assert.ok(!s.missingKinds({ ...base, total_podcasts: 0 }, true).includes('podcasts'));
  assert.deepEqual(s.SCOPED.podcasts, { placeholder: 'Search podcasts', items: 'podcasts' });
});
