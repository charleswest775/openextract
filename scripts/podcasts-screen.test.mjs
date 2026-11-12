// Tests for the Podcasts screen (src/components/explore/PodcastExplorer.tsx):
// what it asks the engine for (the listening history with listened_only, a
// show's episodes with its podcast_id), what it shows with shows, without any
// and when the library can't be read, searching, links, and saving. The
// component runs in a small stand-in for React's hooks (as in
// whatsapp-screen.test.mjs) and its output renders with react-dom/server.
// Data is fictional, with example.com addresses.
// Run with: node --test scripts/podcasts-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

// ── A stand-in for React's hooks ─────────────────────────────────────────────
// State and refs kept between renders, effects run after a render when their
// deps change. setState doesn't render: tests call rerender() after awaiting.

function hooksRuntime() {
  let current = null;
  const R = {
    useState(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { value: typeof init === 'function' ? init() : init };
      const s = c.slots[k];
      return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }];
    },
    useRef(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { current: init };
      return c.slots[k];
    },
    useEffect(fn, deps) {
      const c = current, k = c.i++;
      const prev = c.slots[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
      c.queue.push({ k, fn, deps });
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
  };

  function mount(Component, props) {
    const c = { slots: [], i: 0, queue: [], props, out: null };
    const render = () => {
      current = c;
      c.i = 0;
      try { c.out = Component(c.props); } finally { current = null; }
      const queue = c.queue;
      c.queue = [];
      for (const { k, fn, deps } of queue) {
        c.slots[k]?.cleanup?.();
        c.slots[k] = { deps, cleanup: fn() };
      }
    };
    render();
    return {
      get out() { return c.out; },
      rerender(next) { if (next) c.props = { ...c.props, ...next }; render(); return c.out; },
    };
  }
  return { R, mount };
}

/** The first element in a tree that passes `test` (through children, and a header's actions). */
function find(tree, test) {
  if (tree == null || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const x of tree) { const f = find(x, test); if (f) return f; }
    return null;
  }
  if (test(tree)) return tree;
  return find(tree.props?.children, test) ?? find(tree.props?.actions, test);
}

/** Every element in a tree that passes `test`. */
function findAll(tree, test, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, test, out)); return out; }
  if (test(tree)) out.push(tree);
  findAll(tree.props?.children, test, out);
  return out;
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

// ── Fictional data ───────────────────────────────────────────────────────────

const show = over => ({
  id: 1, uuid: null, title: 'Garden Hour', author: 'Example Radio', description: null, category: 'Leisure',
  feed_url: 'https://feeds.example.com/garden.xml', original_feed_url: null, webpage_url: 'https://example.com/garden',
  image_url: 'https://img.example.com/garden.jpg', store_url: null, store_id: null, show_type: 'episodic',
  followed: true, subscribed: true, implicitly_followed: false, hidden: false,
  added_date: '2023-01-05T09:00:00Z', last_played_date: null, unfollowed_date: null,
  episode_count: 10, listened_count: 0,
  ...over,
});

const episode = over => ({
  id: 100, podcast_id: 1, podcast_title: 'Garden Hour', uuid: null, guid: null, title: 'Planting bulbs', author: null,
  published_date: '2023-03-01T08:00:00Z', duration_seconds: 2520, play_count: 0, playhead_seconds: null,
  last_played_date: null, play_state: 'unplayed', listened: false, saved: false, downloaded_on_phone: false,
  enclosure_url: 'https://cdn.example.com/garden/bulbs.mp3', webpage_url: null,
  season: null, episode_number: null, episode_type: 'full', video: false, removed_from_feed: false, hidden: false,
  ...over,
});

const GARDEN = show({ id: 1, listened_count: 2, last_played_date: '2024-02-01T10:00:00Z' });
const ORCHARD = show({ id: 2, title: 'Apple Orchard Weekly', author: 'Example Farms', feed_url: 'https://feeds.example.com/orchard.xml', webpage_url: null, listened_count: 0 });
const STRAY = show({ id: 3, title: 'Heard from a link', author: 'Example Studio', followed: false, implicitly_followed: true, listened_count: 1, last_played_date: '2023-07-01T10:00:00Z' });
const SHOWS = [GARDEN, ORCHARD, STRAY];

const HISTORY = [
  episode({ id: 11, title: 'Pruning in winter', play_count: 2, listened: true, last_played_date: '2023-12-01T10:00:00Z', saved: true }),
  episode({ id: 12, title: 'Seed swaps', play_state: 'in_progress', playhead_seconds: 187, listened: true, last_played_date: '2024-02-01T10:00:00Z', downloaded_on_phone: true }),
  episode({ id: 31, podcast_id: 3, podcast_title: 'Heard from a link', title: 'A guest episode', play_count: 1, listened: true, last_played_date: '2023-07-01T10:00:00Z', webpage_url: 'https://example.com/guest' }),
];

const AUDIO_NOTE = "Episode audio isn't kept in iPhone backups. Get audio opens an episode in your browser, from where the podcast publishes it.";

/** The screen on a fake engine. `answers(method, params)` is the engine's data, or a whole { success, ... } reply. */
function screen(t, answers, extra = {}) {
  const bridge = fakeBridge({
    call: async (method, params) => {
      const a = answers(method, params);
      return a && 'success' in a ? a : { success: true, data: a };
    },
    openExternal: () => {},
    saveFolder: async () => '/Users/jane/Desktop',
    ...extra,
  });
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  const saves = [];
  const areas = [];
  const stubs = {
    react: R,
    '../../hooks/useSaveAction': { useSaveAction: area => { areas.push(area); return { busy: false, run: fn => { saves.push(fn); } }; } },
    '../shared/Feedback': { ReportProblemButton: ({ area }) => createElement('button', { 'data-report': area }, 'Report this problem') },
    '../shared/OrganicLoader': () => createElement('span', { 'data-loader': '' }),
  };
  const PodcastExplorer = loadTs('src/components/explore/PodcastExplorer.tsx', { stubs }).default;
  return { bridge, mount: props => mount(PodcastExplorer, { udid: 'u1', query: '', ...props }), saves, areas };
}

const engine = (method, params) => {
  if (method === 'list_podcasts') return { podcasts: SHOWS };
  if (method === 'list_podcast_episodes') {
    if (params.podcast_id == null) return { episodes: HISTORY };
    const all = [episode({ id: 10 + params.podcast_id, podcast_id: params.podcast_id, title: `Episode of show ${params.podcast_id}` })];
    return { episodes: params.listened_only ? [] : all, ...(params.listened_only ? { empty_reason: 'no_records' } : {}) };
  }
  throw new Error(`unexpected ${method}`);
};

const calls = bridge => bridge.calls.filter(c => c[0] === 'call').map(c => [c[1], c[2]]);
const html = probe => renderToStaticMarkup(probe.out);

// ── With shows ───────────────────────────────────────────────────────────────

test('opens on the listening history: asked for with listened_only, most recently played first', async t => {
  const { bridge, mount, areas } = screen(t, engine);
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  probe.rerender();
  assert.deepEqual(calls(bridge), [
    ['list_podcasts', { udid: 'u1' }],
    ['list_podcast_episodes', { udid: 'u1', podcast_id: null, listened_only: true }],
  ]);
  assert.ok(areas.every(a => a === 'podcasts'), 'saves report under Podcasts');
  const out = html(probe);
  assert.match(out, /3 podcasts/);
  assert.match(out, /Listening history/);
  assert.match(out, /3 episodes played on this iPhone/);
  assert.match(out, />Following</);
  assert.match(out, />Not followed</);
  // Followed shows A to Z, then the rest
  assert.ok(out.indexOf('Apple Orchard Weekly') < out.indexOf('Garden Hour'));
  assert.ok(out.indexOf('Garden Hour') < out.indexOf('Heard from a link'));
  // History order: Seed swaps (2024), Pruning (Dec 2023), the guest episode (Jul 2023)
  assert.ok(out.indexOf('Seed swaps') < out.indexOf('Pruning in winter') && out.indexOf('Pruning in winter') < out.indexOf('A guest episode'));
  assert.match(out, /In progress, 3:07 in/);
  assert.match(out, /Played 2 times/);
  assert.match(out, /Downloaded on the iPhone/);
  assert.match(out, />Saved</);
  assert.equal(out.split("Episode audio isn&#x27;t kept in iPhone backups").length, 2, 'the audio note, said once');
  assert.doesNotMatch(out, /<img/, 'no artwork: nothing is fetched');
  assert.doesNotMatch(out, /img\.example\.com/);
  assert.doesNotMatch(out, /\bError\b/);
  assert.match(out, /aria-current="true"[^>]*>.*?Listening history/, 'the history is the open entry');
});

test('a show asks for its own episodes by podcast_id, Listened first when it has some, and caches each list', async t => {
  const { bridge, mount } = screen(t, engine);
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  const showButton = title => find(probe.rerender(), el => el.props?.onClick && el.props?.title?.props?.text === title);

  showButton('Garden Hour').props.onClick();
  probe.rerender();
  await settle();
  let out = html({ out: probe.rerender() });
  assert.deepEqual(calls(bridge).at(-1), ['list_podcast_episodes', { udid: 'u1', podcast_id: 1, listened_only: true }]);
  assert.match(out, /Feed address/);
  assert.match(out, /https:\/\/feeds\.example\.com\/garden\.xml/);
  assert.match(out, /Following/);
  assert.match(out, /10 episodes, 2 listened to/);
  assert.match(out, /aria-pressed="true"[^>]*>Listened</);
  assert.match(out, /No episodes of this show were listened to\./, 'an empty list is calm (no_records), not an error');
  assert.equal(out.split("Episode audio isn&#x27;t kept").length, 2);

  // All episodes
  find(probe.out, el => typeof el.props?.onView === 'function').props.onView('all');
  probe.rerender();
  await settle();
  out = html({ out: probe.rerender() });
  assert.deepEqual(calls(bridge).at(-1), ['list_podcast_episodes', { udid: 'u1', podcast_id: 1, listened_only: false }]);
  assert.match(out, /Episode of show 1/);
  assert.match(out, /42 min/);

  // A show with nothing listened to opens on all its episodes
  showButton('Apple Orchard Weekly').props.onClick();
  probe.rerender();
  await settle();
  probe.rerender();
  assert.deepEqual(calls(bridge).at(-1), ['list_podcast_episodes', { udid: 'u1', podcast_id: 2, listened_only: false }]);

  // Back to Garden Hour: its All episodes list is already read
  const before = calls(bridge).length;
  showButton('Garden Hour').props.onClick();
  probe.rerender();
  await settle();
  probe.rerender();
  assert.equal(calls(bridge).length, before, 'no second call for a list already read');
});

test('links go through openExternal: the show\'s website, each episode\'s audio and page', async t => {
  const { bridge, mount } = screen(t, engine);
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  probe.rerender();
  // An episode row in the history: Get audio opens the published audio, Episode page its page
  const rows = findAll(probe.out, el => el.props?.episode && el.props?.inHistory === true);
  const guest = rows.find(r => r.props.episode.id === 31);
  const row = guest.type(guest.props);
  const opened = () => bridge.calls.filter(c => c[0] === 'openExternal').at(-1);
  find(row, el => el.type === 'button' && el.props.children === 'Get audio').props.onClick();
  assert.deepEqual(opened(), ['openExternal', 'https://cdn.example.com/garden/bulbs.mp3']);
  find(row, el => el.type === 'button' && el.props.children === 'Episode page').props.onClick();
  assert.deepEqual(opened(), ['openExternal', 'https://example.com/guest']);
  // No page: only Get audio
  const pruning = rows.find(r => r.props.episode.id === 11);
  const labels = findAll(pruning.type(pruning.props), el => el.type === 'button').map(b => b.props.children);
  assert.deepEqual(labels, ['Get audio']);

  find(probe.out, el => el.props?.onClick && el.props?.title?.props?.text === 'Garden Hour').props.onClick();
  probe.rerender();
  await settle();
  const details = find(probe.rerender(), el => typeof el.props?.onView === 'function');
  find(details.type(details.props), el => el.type === 'button' && el.props.children === 'Website').props.onClick();
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'openExternal').at(-1), ['openExternal', 'https://example.com/garden']);
});

test('the search box filters shows by name or maker, and says when nothing matches', async t => {
  const { mount } = screen(t, engine);
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  let out = html({ out: probe.rerender({ query: 'orchard' }) });
  assert.match(out, /1 of 3 podcasts/);
  assert.doesNotMatch(out, /Heard from a link<\/mark>|>Heard from a link</);
  out = html({ out: probe.rerender({ query: 'example studio' }) });
  assert.match(out, /1 of 3 podcasts/);
  out = html({ out: probe.rerender({ query: 'xylophone' }) });
  assert.match(out, /0 of 3 podcasts/);
  assert.match(out, /No podcasts match &quot;xylophone&quot;/);
  assert.match(out, /Try a show&#x27;s name or who makes it\./);
});

test('Save offers subscriptions (OPML) and a spreadsheet, and saves through export_podcasts', async t => {
  const { bridge, mount, saves } = screen(t, (method, params) => (
    method === 'export_podcasts'
      ? { status: 'success', count: 2, path: `${params.output_dir}/Podcasts.opml`, files: [`${params.output_dir}/Podcasts.opml`] }
      : engine(method, params)
  ));
  const probe = mount();
  await settle();
  probe.rerender();
  const saveButton = find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick);
  assert.equal(saveButton.props.disabled, false);
  saveButton.props.onClick();
  const dialog = find(probe.rerender(), el => Array.isArray(el.props?.formats));
  assert.equal(dialog.props.title, 'Save your podcasts');
  assert.deepEqual(dialog.props.formats.map(f => f.id), ['opml', 'csv']);
  assert.equal(dialog.props.formats[0].label, 'Podcast subscriptions');
  dialog.props.onSave('opml');
  assert.equal(find(probe.rerender(), el => Array.isArray(el.props?.formats)), null, 'the dialog closes');
  assert.equal(saves.length, 1);
  const result = await saves[0]();
  assert.deepEqual(calls(bridge).at(-1), ['export_podcasts', { udid: 'u1', output_dir: '/Users/jane/Desktop', format: 'opml' }]);
  assert.equal(result.title, 'Saved 2 podcasts');
  assert.equal(result.path, '/Users/jane/Desktop/Podcasts.opml');
});

test('searching for an episode title keeps the open show and narrows its episodes', async t => {
  const { mount } = screen(t, engine);
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  const showButton = title => find(probe.rerender(), el => el.props?.onClick && el.props?.title?.props?.text === title);
  showButton('Apple Orchard Weekly').props.onClick();
  probe.rerender();
  await settle();
  probe.rerender();
  // "Episode of show 2" is in the open show's list; the show's own name doesn't match
  let out = html({ out: probe.rerender({ query: 'episode of show' }) });
  assert.match(out, /aria-label="Apple Orchard Weekly"/, 'the open show stays open');
  assert.match(out, /Episode of show 2/);
  assert.match(out, /1 of 3 podcasts/);
  // A word in no episode and no show still says nothing matches
  out = html({ out: probe.rerender({ query: 'xylophone' }) });
  assert.match(out, /0 of 3 podcasts/);
});

test('with no followed show, Save offers only the spreadsheet', async t => {
  const unfollowed = SHOWS.map(p => ({ ...p, followed: false }));
  const { mount } = screen(t, (method, params) => (method === 'list_podcasts' ? { podcasts: unfollowed } : engine(method, params)));
  const probe = mount();
  await settle();
  probe.rerender();
  find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick).props.onClick();
  const dialog = find(probe.rerender(), el => Array.isArray(el.props?.formats));
  assert.deepEqual(dialog.props.formats.map(f => f.id), ['csv']);
});

// ── Without shows ────────────────────────────────────────────────────────────

test('no Podcasts library: calm, with nothing to report, nothing to save and no episodes asked for', async t => {
  const { bridge, mount } = screen(t, () => ({ podcasts: [], empty_reason: 'not_in_backup' }));
  const probe = mount();
  await settle();
  const out = html({ out: probe.rerender() });
  assert.match(out, /No podcasts in this backup/);
  assert.match(out, /The Podcasts app wasn&#x27;t used on this iPhone, or its library wasn&#x27;t in the backup\./);
  assert.doesNotMatch(out, /data-report/, 'not having podcasts is not a problem to report');
  assert.doesNotMatch(out, /Couldn|\bError\b/);
  assert.equal(find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick).props.disabled, true);
  assert.deepEqual(calls(bridge), [['list_podcasts', { udid: 'u1' }]]);
});

test('a library with no shows says the app is there but follows nothing', async t => {
  const { mount } = screen(t, () => ({ podcasts: [], empty_reason: 'no_records' }));
  const probe = mount();
  await settle();
  const out = html({ out: probe.rerender() });
  assert.match(out, /The Podcasts app is on this iPhone, but it doesn&#x27;t follow any shows\./);
  assert.doesNotMatch(out, /data-report/);
});

test('a library that can\'t be read says so, with a Report button for Podcasts', async t => {
  const { mount } = screen(t, () => ({ podcasts: [], error: 'database disk image is malformed' }));
  const probe = mount();
  await settle();
  const out = html({ out: probe.rerender() });
  assert.match(out, /Couldn&#x27;t read the podcasts/);
  assert.match(out, /database disk image is malformed/);
  assert.match(out, /data-report="podcasts"/);
});

test('an engine that fails outright is shown the same way', async t => {
  const { mount } = screen(t, () => ({ success: false, error: 'The engine stopped.' }));
  const probe = mount();
  await settle();
  const out = html({ out: probe.rerender() });
  assert.match(out, /Couldn&#x27;t read the podcasts/);
  assert.match(out, /The engine stopped\./);
  assert.match(out, /data-report="podcasts"/);
});

test('episodes that can\'t be read show the error and a Report button, and are asked for again next time', async t => {
  let broken = true;
  const { bridge, mount } = screen(t, (method, params) => (
    method === 'list_podcast_episodes' && broken ? { episodes: [], error: "The Podcasts library couldn't be read." } : engine(method, params)
  ));
  const probe = mount();
  await settle();
  probe.rerender();
  await settle();
  const out = html({ out: probe.rerender() });
  assert.match(out, /Couldn&#x27;t read the episodes/);
  assert.match(out, /data-report="podcasts"/);
  // Away and back: asked again
  broken = false;
  find(probe.out, el => el.props?.onClick && el.props?.title?.props?.text === 'Garden Hour').props.onClick();
  probe.rerender();
  await settle();
  find(probe.rerender(), el => el.props?.onClick && el.props?.title === 'Listening history').props.onClick();
  probe.rerender();
  await settle();
  probe.rerender();
  const history = calls(bridge).filter(([m, p]) => m === 'list_podcast_episodes' && p.podcast_id == null);
  assert.equal(history.length, 2);
  assert.match(html(probe), /Seed swaps/);
});

test('the audio note matches the shared wording', () => {
  const { AUDIO_NOTE: note } = loadTs('src/lib/podcasts.ts');
  assert.equal(note, AUDIO_NOTE);
});
