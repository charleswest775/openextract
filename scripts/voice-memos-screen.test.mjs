// Tests for the Voice Memos screen (src/components/explore/VoiceMemoExplorer.tsx):
// what it asks the engine for, the sidebar (All Recordings, Favorites, folders,
// Recently Deleted), playing a recording from memory and letting that memory go
// (when the recording closes, another opens, or the screen goes), recordings too
// long to play here or of a kind that can't, audio that isn't in the backup,
// transcripts, search, and saving one recording or all of them. The component
// runs in a small stand-in for React's hooks (as in podcasts-screen.test.mjs,
// with unmount as in whatsapp-screen.test.mjs) and renders with react-dom/server.
// Data is fictional.
// Run with: node --test scripts/voice-memos-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

// ── A stand-in for React's hooks ─────────────────────────────────────────────
// State and refs kept between renders, effects run after a render when their
// deps change and are cleaned up on unmount. setState doesn't render: tests
// call rerender() after awaiting.

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
      unmount() { for (const s of c.slots) if (s && 'cleanup' in s) s.cleanup?.(); },
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

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// ── Fictional data ───────────────────────────────────────────────────────────

const memo = over => ({
  id: 1, unique_id: 'AAAA0000-0000-4000-8000-000000000001', title: 'Site walk', date: '2026-05-13T21:15:22+00:00',
  duration_seconds: 83, folder_id: null, folder: null,
  is_favorite: false, is_deleted: false, deleted_date: null, in_phone_list: true,
  recorded_on_watch: false, is_enhanced: false, is_layered: false, is_spatial: false, has_transcript: false,
  file_name: '20260513 141522-AAAA0000.m4a', format: 'm4a', audio_available: true, audio_missing_reason: null,
  source: 'CloudRecordings.db',
  ...over,
});

const WALK = memo({ id: 11, title: 'Site walk', folder_id: 'F1', folder: 'Site visits', has_transcript: true, date: '2026-05-13T21:15:22+00:00' });
const SONG = memo({ id: 12, title: 'Song idea', is_favorite: true, is_enhanced: true, date: '2026-05-01T08:00:00+00:00' });
const TALK = memo({ id: 13, title: null, audio_available: false, audio_missing_reason: 'in_icloud_only', file_name: null, date: '2026-04-20T08:00:00+00:00' });
const WORKSHOP = memo({ id: 14, title: 'Workshop', recorded_on_watch: true, audio_available: false, audio_missing_reason: 'not_in_backup', date: '2026-04-02T08:00:00+00:00' });
const OLD = memo({ id: 15, title: 'Old reminder', is_deleted: true, deleted_date: '2026-05-20T08:00:00+00:00', date: '2026-03-01T08:00:00+00:00' });
const MEMOS = [WALK, SONG, TALK, WORKSHOP, OLD];
const FOLDERS = [{ id: 'F1', name: 'Site visits', rank: 1, count: 1 }];

const audio = id => ({ data: Buffer.from('....ftypM4A ').toString('base64'), mime_type: 'audio/mp4', memo_id: id, filename: `Recording ${id}.m4a`, size: 12 });

const engine = (method, params) => {
  if (method === 'list_voice_memos') return { voice_memos: MEMOS, folders: FOLDERS };
  if (method === 'get_voice_memo_audio') {
    if (params.as_file) return { path: `/tmp/oe-voice-memos/${params.memo_id}/Site walk.m4a`, mime_type: 'audio/mp4', filename: 'Site walk.m4a', size: 12, openable: true };
    return audio(params.memo_id);
  }
  if (method === 'get_voice_memo_transcript') return { memo_id: params.memo_id, text: 'The north wall needs new flashing.', segments: [], locale: 'en_US' };
  throw new Error(`unexpected ${method}`);
};

/** The screen on a fake engine. `answers(method, params)` is the engine's data, or a whole { success, ... } reply. */
function screen(t, answers, extra = {}) {
  const bridge = fakeBridge({
    call: async (method, params) => {
      const a = await answers(method, params);
      return a && 'success' in a ? a : { success: true, data: a };
    },
    openExternal: () => {},
    openPath: async () => '',
    showInFolder: async () => {},
    saveFolder: async () => '/Users/jane/Desktop',
    ...extra,
  });
  t.after(bridge.restore);
  // Blob URLs, counted so every one made can be checked as let go
  const made = [], freed = [];
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = () => { const u = `blob:test/${made.length}`; made.push(u); return u; };
  URL.revokeObjectURL = u => { freed.push(u); };
  t.after(() => { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; });
  const { R, mount } = hooksRuntime();
  const saves = [];
  const areas = [];
  const stubs = {
    react: R,
    '../../hooks/useSaveAction': { useSaveAction: area => { areas.push(area); return { busy: false, run: fn => { saves.push(fn); } }; } },
    '../shared/Feedback': { ReportProblemButton: ({ area }) => createElement('button', { 'data-report': area }, 'Report this problem') },
    '../shared/OrganicLoader': () => createElement('span', { 'data-loader': '' }),
  };
  const VoiceMemoExplorer = loadTs('src/components/explore/VoiceMemoExplorer.tsx', { stubs }).default;
  return {
    bridge, saves, areas, made, freed,
    held: () => made.filter(u => !freed.includes(u)),
    mount: props => mount(VoiceMemoExplorer, { udid: 'u1', query: '', ...props }),
  };
}

const calls = bridge => bridge.calls.filter(c => c[0] === 'call').map(c => [c[1], c[2]]);
const html = probe => renderToStaticMarkup(probe.out);
const rows = probe => findAll(probe.out, el => el.props?.memo && typeof el.props?.onToggle === 'function');
const row = (probe, id) => rows(probe).find(r => r.props.memo.id === id);
const inside = r => r.type(r.props);
const sidebar = (probe, title) => find(probe.out, el => el.props?.title === title && typeof el.props?.onClick === 'function' && 'count' in el.props);

async function opened(t, answers = engine, props = {}) {
  const s = screen(t, answers);
  const probe = s.mount(props);
  await settle();
  probe.rerender();
  return { ...s, probe };
}

async function toggle(probe, id) {
  row(probe, id).props.onToggle();
  probe.rerender();
  await settle();
  probe.rerender();
}

// ── With recordings ──────────────────────────────────────────────────────────

test('opens on All Recordings: the sidebar lists Favorites, the folders and, last and quiet, Recently Deleted', async t => {
  const { bridge, probe, areas } = await opened(t);
  assert.deepEqual(calls(bridge), [['list_voice_memos', { udid: 'u1' }]], 'no audio is read until a recording is opened');
  assert.ok(areas.every(a => a === 'voice_memos'), 'saves report under Voice Memos');
  const out = html(probe);
  assert.match(out, /4 recordings/, 'deleted ones are not counted');
  for (const label of ['All Recordings', 'Favorites', 'My folders', 'Site visits', 'Recently Deleted']) assert.match(out, new RegExp(label));
  assert.ok(out.indexOf('>Favorites<') < out.indexOf('>My folders<'));
  assert.ok(out.indexOf('>My folders<') < out.indexOf('>Recently Deleted<'), 'Recently Deleted is last');
  assert.match(out, /aria-current="true"[^>]*><span class="truncate">All Recordings/);
  // Newest first, as the engine lists them; the deleted one isn't here
  assert.ok(out.indexOf('Site walk') < out.indexOf('Song idea') && out.indexOf('Song idea') < out.indexOf('Untitled recording'));
  assert.doesNotMatch(out, /Old reminder/);
  assert.match(out, />Favorite</);
  assert.match(out, />Enhanced</);
  assert.match(out, />Recorded on Apple Watch</);
  assert.match(out, />Kept in iCloud only</);
  assert.match(out, />Audio not in this backup</);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<audio/);
  assert.doesNotMatch(out, /\bError\b/);
});

test('folders, Favorites and Recently Deleted each show their own recordings, and the deleted note is said once', async t => {
  const { probe } = await opened(t);
  sidebar(probe, 'Site visits').props.onClick();
  let out = html({ out: probe.rerender() });
  assert.match(out, /aria-label="Site visits"/);
  assert.match(out, /1 recording</);
  assert.match(out, /Site walk/);
  assert.doesNotMatch(out, /Song idea/);
  assert.doesNotMatch(out, /Site walk<\/span><\/div><div class="text-sm text-text-secondary">[^<]*· Site visits/, 'the folder isn\'t repeated inside it');

  sidebar(probe, 'Favorites').props.onClick();
  out = html({ out: probe.rerender() });
  assert.match(out, /Song idea/);
  assert.doesNotMatch(out, /Site walk/);

  sidebar(probe, 'Recently Deleted').props.onClick();
  out = html({ out: probe.rerender() });
  assert.match(out, /Old reminder/);
  assert.equal(out.split('Recordings deleted on the iPhone that are still in this backup.').length, 2, 'said once');
  assert.match(out, /Deleted /);
});

test('opening a recording plays it from memory; closing it, opening another, changing list or leaving lets that memory go', async t => {
  const { bridge, probe, made, held } = await opened(t);
  await toggle(probe, 12);
  assert.deepEqual(calls(bridge).at(-1), ['get_voice_memo_audio', { udid: 'u1', memo_id: 12 }]);
  let out = html(probe);
  assert.match(out, /<audio controls="" src="blob:test\/0" aria-label="Recording: Song idea"/);
  assert.equal(made.length, 1);

  // Another recording: the first one's sound goes
  await toggle(probe, 11);
  assert.deepEqual(held(), ['blob:test/1']);
  out = html(probe);
  assert.match(out, /src="blob:test\/1"/);
  assert.doesNotMatch(out, /blob:test\/0/);

  // Closed: the player goes, and so does its sound
  await toggle(probe, 11);
  assert.deepEqual(held(), []);
  assert.doesNotMatch(html(probe), /<audio/);

  // A list change closes it too
  await toggle(probe, 12);
  assert.equal(held().length, 1);
  sidebar(probe, 'Site visits').props.onClick();
  probe.rerender();
  assert.deepEqual(held(), []);
  assert.doesNotMatch(html(probe), /<audio/);

  // And leaving the screen
  sidebar(probe, 'All Recordings').props.onClick();
  probe.rerender();
  await toggle(probe, 12);
  assert.equal(held().length, 1);
  probe.unmount();
  assert.deepEqual(held(), [], 'every recording read into memory is let go');
});

test('a search that hides the open recording closes it and lets its sound go', async t => {
  const { probe, held } = await opened(t);
  await toggle(probe, 12);
  assert.equal(held().length, 1);
  probe.rerender({ query: 'site' }); // Song idea doesn't match
  probe.rerender();
  assert.deepEqual(held(), []);
  probe.rerender({ query: '' });
  assert.doesNotMatch(html(probe), /aria-expanded="true"/, 'it stays closed when the search is cleared');
});

test('a recording that arrives after it was closed, or after the screen went, is never held in memory', async t => {
  const answer = deferred();
  const { probe, made } = await opened(t, (method, params) => (method === 'get_voice_memo_audio' ? answer.promise : engine(method, params)));
  row(probe, 12).props.onToggle();
  probe.rerender();
  row(probe, 12).props.onToggle(); // closed again while it loads
  probe.rerender();
  answer.resolve(audio(12));
  await settle();
  assert.equal(made.length, 0, 'no blob made for a recording no longer open');

  const again = deferred();
  const s2 = await opened(t, (method, params) => (method === 'get_voice_memo_audio' ? again.promise : engine(method, params)));
  row(s2.probe, 12).props.onToggle();
  s2.probe.unmount();
  again.resolve(audio(12));
  await settle();
  assert.equal(s2.made.length, 0, 'none for a screen that has gone');
});

test('a recording too long to play here opens in another app straight away', async t => {
  const { bridge, probe, held } = await opened(t, (method, params) => (
    method === 'get_voice_memo_audio' && !params.as_file
      ? { too_large: true, mime_type: 'audio/mp4', memo_id: params.memo_id, filename: 'Song idea.m4a', size: 40 * 1024 * 1024 }
      : engine(method, params)
  ));
  await toggle(probe, 12);
  assert.deepEqual(calls(bridge).slice(-2), [
    ['get_voice_memo_audio', { udid: 'u1', memo_id: 12 }],
    ['get_voice_memo_audio', { udid: 'u1', memo_id: 12, as_file: true }],
  ]);
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'openPath'), [['openPath', '/tmp/oe-voice-memos/12/Site walk.m4a']]);
  const out = html(probe);
  assert.match(out, /This recording is too long to play here, so it opens in another app\./);
  assert.doesNotMatch(out, /<audio/);
  assert.deepEqual(held(), []);
});

test('a kind of recording that can\'t play here lets its sound go and offers another app', async t => {
  const { bridge, probe, held } = await opened(t, (method, params) => (
    method === 'get_voice_memo_audio' && params.as_file
      ? { path: '/tmp/oe-voice-memos/12/Song idea.qta', mime_type: 'audio/mp4', filename: 'Song idea.qta', size: 12, openable: false }
      : engine(method, params)
  ));
  await toggle(probe, 12);
  const sound = find(inside(row(probe, 12)), el => typeof el.props?.onCantPlay === 'function' && el.props?.player);
  sound.type(sound.props).props.onError();
  probe.rerender();
  assert.deepEqual(held(), [], 'a sound that can\'t play isn\'t kept');
  let out = html(probe);
  assert.match(out, /This kind of recording can&#x27;t play here\. Open it in another app to listen\./);
  find(inside(row(probe, 12)), el => el.type === 'button' && el.props['aria-label'] === 'Open "Song idea" in another app').props.onClick();
  await settle();
  probe.rerender();
  assert.deepEqual(calls(bridge).at(-1), ['get_voice_memo_audio', { udid: 'u1', memo_id: 12, as_file: true }]);
  // Not a kind the engine says is safe to open: shown in its folder instead
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'showInFolder'), [['showInFolder', '/tmp/oe-voice-memos/12/Song idea.qta']]);
  out = html(probe);
  assert.match(out, /role="status"[^>]*>OpenExtract doesn&#x27;t open this kind of file itself, so it&#x27;s shown in its folder\./);
});

test('audio that isn\'t in the backup says why, calmly, without asking the engine; iCloud only is said differently', async t => {
  const { bridge, probe } = await opened(t);
  await toggle(probe, 13);
  let out = html(probe);
  assert.match(out, /This recording was kept in iCloud only, so it isn&#x27;t in the backup\./);
  await toggle(probe, 14);
  out = html(probe);
  assert.match(out, /This recording isn&#x27;t in the backup\./);
  assert.doesNotMatch(out, /iCloud only, so/);
  assert.doesNotMatch(out, /data-report/, 'not a problem to report');
  assert.doesNotMatch(out, /aria-label="Save &quot;Workshop&quot;"/, 'nothing to save');
  assert.equal(calls(bridge).filter(([m]) => m === 'get_voice_memo_audio').length, 0);
  assert.equal(calls(bridge).filter(([m]) => m === 'get_voice_memo_transcript').length, 0);
});

test('a file the list thought was there but the engine can\'t find: the engine\'s sentence; a read error: reported', async t => {
  let answer = { error: "This recording isn't in the backup.", empty_reason: 'not_in_backup' };
  const { probe } = await opened(t, (method, params) => (method === 'get_voice_memo_audio' ? answer : engine(method, params)));
  await toggle(probe, 12);
  let out = html(probe);
  assert.match(out, /This recording isn&#x27;t in the backup\./);
  assert.doesNotMatch(out, /data-report/);
  answer = { error: 'Recording not found.' };
  await toggle(probe, 12);
  await toggle(probe, 12);
  out = html(probe);
  assert.match(out, /Couldn&#x27;t load the recording: Recording not found\./);
  assert.match(out, /data-report="voice_memos"/);
});

test('a transcribed recording reads its transcript when opened, and search finds its words', async t => {
  const { bridge, probe } = await opened(t);
  await toggle(probe, 11);
  assert.ok(calls(bridge).some(c => c[0] === 'get_voice_memo_transcript' && c[1].memo_id === 11 && c[1].udid === 'u1'));
  let out = html(probe);
  assert.match(out, />Transcript</);
  assert.match(out, /The north wall needs new flashing\./);
  out = html({ out: probe.rerender({ query: 'flashing' }) });
  assert.match(out, /1 of 4 recordings/);
  assert.match(out, /Site walk/);
  // Read once
  await toggle(probe, 11);
  await toggle(probe, 11);
  assert.equal(calls(bridge).filter(([m]) => m === 'get_voice_memo_transcript').length, 1);
});

test('a transcript that can\'t be read says so, and is asked for again the next time', async t => {
  let broken = true;
  const { bridge, probe } = await opened(t, (method, params) => (
    method === 'get_voice_memo_transcript' && broken ? { success: false, error: 'The engine stopped.' } : engine(method, params)
  ));
  await toggle(probe, 11);
  assert.match(html(probe), /Couldn&#x27;t read the transcript: The engine stopped\./);
  broken = false;
  await toggle(probe, 11);
  await toggle(probe, 11);
  assert.equal(calls(bridge).filter(([m]) => m === 'get_voice_memo_transcript').length, 2);
  assert.match(html(probe), /The north wall needs new flashing\./);
});

test('the search box filters by name and folder, and says when nothing matches', async t => {
  const { probe } = await opened(t);
  let out = html({ out: probe.rerender({ query: 'site visits' }) });
  assert.match(out, /1 of 4 recordings/);
  assert.match(out, /<mark[^>]*>Site<\/mark><span> walk/, 'found by its folder, with the words marked');
  assert.doesNotMatch(out, /Song idea/);
  out = html({ out: probe.rerender({ query: 'song' }) });
  assert.match(out, /1 of 4 recordings/);
  assert.doesNotMatch(out, /Site visits<\/span><span class="text-xs/, 'the sidebar counts only matches');
  out = html({ out: probe.rerender({ query: 'xylophone' }) });
  assert.match(out, /0 of 4 recordings/);
  assert.match(out, /No recordings match &quot;xylophone&quot;/);
  assert.match(out, /Try a recording&#x27;s name or its folder\. Transcripts are searched once you&#x27;ve opened the recording\./);
  // A word from a transcript not read yet isn't found, and the text doesn't promise it would be
  out = html({ out: probe.rerender({ query: 'flashing' }) });
  assert.match(out, /No recordings match &quot;flashing&quot;/);
  assert.doesNotMatch(out, /a word from its transcript/);
});

test('Save on an open recording saves just that one, straight into the chosen folder', async t => {
  const { bridge, probe, saves } = await opened(t, (method, params) => (
    method === 'export_voice_memos'
      ? { status: 'success', count: 1, path: `${params.output_dir}/2026-05-13 14.15 Site walk.m4a`, files: [`${params.output_dir}/2026-05-13 14.15 Site walk.m4a`], not_in_backup: 0, failed: 0 }
      : engine(method, params)
  ));
  await toggle(probe, 11);
  find(inside(row(probe, 11)), el => el.type === 'button' && el.props['aria-label'] === 'Save "Site walk"').props.onClick();
  assert.equal(saves.length, 1);
  const result = await saves[0]();
  assert.deepEqual(calls(bridge).at(-1), ['export_voice_memos', { udid: 'u1', output_dir: '/Users/jane/Desktop', format: 'recordings', memo_ids: [11] }]);
  assert.equal(result.title, 'Saved "Site walk"');
  assert.equal(result.path, '/Users/jane/Desktop/2026-05-13 14.15 Site walk.m4a');
});

test('Save offers the recordings and a spreadsheet, and saves everything through export_voice_memos', async t => {
  const { bridge, probe, saves } = await opened(t, (method, params) => (
    method === 'export_voice_memos'
      ? { status: 'success', count: 5, path: `${params.output_dir}/Voice Memos.csv`, files: [`${params.output_dir}/Voice Memos.csv`] }
      : engine(method, params)
  ));
  const button = find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  const dialog = find(probe.rerender(), el => Array.isArray(el.props?.formats));
  assert.equal(dialog.props.title, 'Save your voice memos');
  assert.deepEqual(dialog.props.formats.map(f => f.id), ['recordings', 'csv']);
  assert.equal(dialog.props.formats[0].label, 'Audio files');
  dialog.props.onSave('csv');
  assert.equal(find(probe.rerender(), el => Array.isArray(el.props?.formats)), null, 'the dialog closes');
  const result = await saves[0]();
  assert.deepEqual(calls(bridge).at(-1), ['export_voice_memos', { udid: 'u1', output_dir: '/Users/jane/Desktop', format: 'csv' }]);
  assert.equal(result.title, 'Saved 5 voice memos');
  assert.equal(result.path, '/Users/jane/Desktop/Voice Memos.csv');
});

test('with no audio in the backup at all, Save offers only the spreadsheet', async t => {
  const none = MEMOS.map(m => ({ ...m, audio_available: false, audio_missing_reason: 'in_icloud_only' }));
  const { probe } = await opened(t, (method, params) => (method === 'list_voice_memos' ? { voice_memos: none, folders: [] } : engine(method, params)));
  find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick).props.onClick();
  assert.deepEqual(find(probe.rerender(), el => Array.isArray(el.props?.formats)).props.formats.map(f => f.id), ['csv']);
});

test('a recording a search found opens in its own list, ready to play', async t => {
  const { bridge, probe } = await opened(t, engine, { selectId: 'voice_memo:15' });
  await settle();
  probe.rerender();
  const out = html(probe);
  assert.match(out, /aria-label="Recently Deleted"/);
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, /Old reminder/);
  assert.deepEqual(calls(bridge).at(-1), ['get_voice_memo_audio', { udid: 'u1', memo_id: 15 }]);
  assert.match(out, /<audio/);
});

test('every recording in Recently Deleted: the screen opens there', async t => {
  const { probe } = await opened(t, (method, params) => (method === 'list_voice_memos' ? { voice_memos: [OLD], folders: [] } : engine(method, params)));
  const out = html(probe);
  assert.match(out, /aria-label="Recently Deleted"/);
  assert.match(out, /Old reminder/);
});

// ── Without recordings ───────────────────────────────────────────────────────

test('no Voice Memos in the backup: calm, with nothing to report, nothing to save and nothing more asked', async t => {
  const { bridge, probe } = await opened(t, () => ({ voice_memos: [], empty_reason: 'not_in_backup' }));
  const out = html(probe);
  assert.match(out, /No voice memos in this backup/);
  assert.match(out, /Voice Memos wasn&#x27;t used on this iPhone, or its recordings weren&#x27;t in the backup\./);
  assert.doesNotMatch(out, /data-report/);
  assert.doesNotMatch(out, /Couldn|\bError\b/);
  assert.equal(find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick).props.disabled, true);
  assert.deepEqual(calls(bridge), [['list_voice_memos', { udid: 'u1' }]]);
});

test('Voice Memos with no recordings says the app is there but empty', async t => {
  const { probe } = await opened(t, () => ({ voice_memos: [], folders: [], empty_reason: 'no_records' }));
  const out = html(probe);
  assert.match(out, /Voice Memos is on this iPhone, but it has no recordings\./);
  assert.doesNotMatch(out, /data-report/);
});

test('recordings that can\'t be read, or an older format, say so with a Report button', async t => {
  let answer = { voice_memos: [], error: 'Voice Memos are in this backup but could not be read. The backup may be incomplete or damaged.' };
  const s1 = await opened(t, () => answer);
  let out = html(s1.probe);
  assert.match(out, /Couldn&#x27;t read the voice memos/);
  assert.match(out, /could not be read\. The backup may be incomplete or damaged\./);
  assert.match(out, /data-report="voice_memos"/);

  answer = { voice_memos: [], error: "This backup's Voice Memos are in an older format OpenExtract can't read yet.", empty_reason: 'unsupported_format' };
  const s2 = await opened(t, () => answer);
  out = html(s2.probe);
  assert.match(out, /This version of Voice Memos can&#x27;t be read yet/);
  assert.match(out, /data-report="voice_memos"/);

  const s3 = await opened(t, () => ({ success: false, error: 'The engine stopped.' }));
  out = html(s3.probe);
  assert.match(out, /Couldn&#x27;t read the voice memos/);
  assert.match(out, /The engine stopped\./);
  assert.match(out, /data-report="voice_memos"/);
});
