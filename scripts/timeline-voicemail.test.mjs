// Tests for a voicemail on the Timeline (src/components/timeline/TimelineEntryCard.tsx, with
// normalizeVoicemail in src/hooks/useTimeline.ts): opening its card plays it whatever its id,
// a ROWID in the main voicemail store (12) or a copy in a per-line store ("A-<UUID>.27", the
// engine's id when only that store has the voicemail or its audio), and a caller with no
// number is named as the engine names them. The card runs in a small stand-in for React's
// hooks (as in voice-memos-screen.test.mjs). Data is fictional.
// Run with: node --test scripts/timeline-voicemail.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

// ── A stand-in for React's hooks ─────────────────────────────────────────────

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
    memo: component => component,
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
    return { get out() { return c.out; }, rerender() { render(); return c.out; } };
  }
  return { R, mount };
}

function findAll(tree, test, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, test, out)); return out; }
  if (test(tree)) out.push(tree);
  findAll(tree.props?.children, test, out);
  return out;
}

const text = tree => findAll(tree, () => true).flatMap(el => [el.props?.children].flat())
  .filter(c => typeof c === 'string' || typeof c === 'number').join(' ');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

// ── The card on a fake engine ────────────────────────────────────────────────

const LINE = 'A-0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D';

function card(t, raw) {
  const bridge = fakeBridge({
    call: async (method, params) => {
      if (method !== 'get_voicemail_audio') throw new Error(`unexpected ${method}`);
      // The engine finds audio by the id list_voicemails gave, as a number or as text
      const known = [12, '12', `${LINE}.27`];
      return known.includes(params.voicemail_id)
        ? { success: true, data: { data: Buffer.from('#!AMR\n').toString('base64'), mime_type: 'audio/amr', voicemail_id: params.voicemail_id } }
        : { success: true, data: { error: "This voicemail's audio isn't in the backup." } };
    },
  });
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  // The AMR player decodes in a browser; here it only has to be what the card shows
  const AmrPlayer = props => ({ type: 'amr-player', props });
  const stubs = { react: R, '../voicemail/AmrPlayer': { __esModule: true, default: AmrPlayer } };
  const { normalizeVoicemail } = loadTs('src/hooks/useTimeline.ts', { stubs });
  const Card = loadTs('src/components/timeline/TimelineEntryCard.tsx', { stubs }).default;
  const entry = normalizeVoicemail({
    phone_number: '+447700900005', contact_name: 'Casey Placeholder', date_received: '2025-05-02T10:10:40+00:00',
    duration: 19, is_read: true, transcript: 'Hi Sam, Casey here.', ...raw,
  });
  const probe = mount(Card, { entry, udid: 'u1' });
  return { bridge, probe, mount };
}

/** Opens the card's player (its header toggles it) and lets the player load; returns what it asked the engine for. */
async function play({ bridge, probe, mount }) {
  // The card's own click opens notes and messages; a voicemail's header row opens its player
  const header = findAll(probe.out, el => typeof el.props?.onClick === 'function' && !('data-entry-id' in el.props))[0];
  header.props.onClick();
  probe.rerender();
  const [player] = findAll(probe.out, el => el.props && 'voicemailId' in el.props);
  assert.ok(player, 'opening the card shows its player');
  const playing = mount(player.type, player.props);
  await settle();
  playing.rerender();
  const asked = bridge.calls.filter(c => c[0] === 'call').map(c => c[2].voicemail_id);
  return { asked, html: text(playing.out), audio: findAll(playing.out, el => el.props && 'base64Data' in el.props) };
}

test('a voicemail in the main store plays by its ROWID', async t => {
  const { asked, audio, html } = await play(card(t, { id: 12 }));
  assert.deepEqual(asked.map(String), ['12']);
  assert.equal(audio.length, 1, html);
});

test('a voicemail whose audio is in a per-line store plays by its "A-<UUID>.<ROWID>" id', async t => {
  // Before: the card read the id as a number (parseInt), which made NaN of it, and the player said "Audio not available"
  const { asked, audio, html } = await play(card(t, { id: `${LINE}.27` }));
  assert.deepEqual(asked, [`${LINE}.27`]);
  assert.equal(audio.length, 1, html);
  assert.doesNotMatch(html, /not available|Failed/);
});

test('a caller with no number reads "Unknown", not blank', t => {
  // As the engine names them now, and as an older engine left them (no name at all)
  for (const contact_name of ['Unknown', '']) {
    const { probe } = card(t, { id: 6, phone_number: '', contact_name, transcript: '' });
    assert.match(text(probe.out), /\bUnknown\b/, JSON.stringify(contact_name));
  }
});
