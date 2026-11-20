// Tests for the "Pay it forward" card after an export (src/components/shared/PayItForwardPrompt.tsx):
// its two buttons are Say thanks and Pay $5, its message offers a thank-you to people who
// can't pay, Say thanks opens the in-app thank-you note, and the × dismisses it the way
// "Not now" used to (no more asks until the app is opened again). The component runs in a
// small stand-in for React's hooks (as in podcasts-screen.test.mjs) and renders with
// react-dom/server.
// Run with: node --test scripts/pay-it-forward-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

// ── A stand-in for React's hooks ─────────────────────────────────────────────
// State kept between renders, effects run after a render when their deps change.
// setState doesn't render: tests call rerender() after awaiting.

function hooksRuntime() {
  let current = null;
  const R = {
    useState(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { value: typeof init === 'function' ? init() : init };
      const s = c.slots[k];
      return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }];
    },
    useEffect(fn, deps) {
      const c = current, k = c.i++;
      const prev = c.slots[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
      c.queue.push({ k, fn, deps });
    },
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
      rerender() { render(); return c.out; },
    };
  }
  return { R, mount };
}

/** Every element in a tree that passes `test`. */
function findAll(tree, test, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, test, out)); return out; }
  if (test(tree)) out.push(tree);
  findAll(tree.props?.children, test, out);
  return out;
}

/** An element's own text, without its icons. */
const text = el => (el == null || typeof el === 'boolean' ? ''
  : typeof el !== 'object' ? String(el)
  : Array.isArray(el) ? el.map(text).join('')
  : text(el.props?.children)).trim();

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

/** The card on a fake preload bridge. `status` is what support.status() answers. */
function card(t, status = { paid: false, thanksSent: false }) {
  let fromExport = null;
  let fromAsk = null;
  const bridge = fakeBridge({
    onSharePrompt: cb => { fromExport = cb; return () => {}; },
    openExternal: () => {},
  });
  bridge.api.support = {
    status: async () => { bridge.calls.push(['support.status']); return status; },
    snooze: async () => { bridge.calls.push(['support.snooze']); },
    markPaid: async () => { bridge.calls.push(['support.markPaid']); },
  };
  t.after(bridge.restore);

  const { R, mount } = hooksRuntime();
  const feedback = [];
  const payItForward = loadTs('src/lib/payItForward.ts');
  const stubs = {
    react: R,
    './Feedback': { useFeedback: () => ({ openFeedback: req => feedback.push(req) }) },
    '../../lib/payItForward': { ...payItForward, onAsk: cb => { fromAsk = cb; return () => {}; } },
  };
  const PayItForwardPrompt = loadTs('src/components/shared/PayItForwardPrompt.tsx', { stubs }).default;
  const probe = mount(PayItForwardPrompt, {});

  return {
    bridge,
    feedback,
    payItForward,
    probe,
    /** As the main process does after an export: share-prompt:show with the area and whether it's the introduction. */
    async afterExport(area, intro) { fromExport(area, intro); await settle(); return probe.rerender(); },
    /** As the header's "Pay it forward" button and Settings do. */
    async ask(request) { fromAsk(request); await settle(); return probe.rerender(); },
  };
}

/** The card's main buttons (not the small links under them), by their text. */
const buttons = out => findAll(out, el => el.type === 'button' && /hearth-/.test(el.props.className ?? '')).map(text);
const button = (out, label) => findAll(out, el => el.type === 'button' && text(el) === label)[0];
const html = out => renderToStaticMarkup(out).replaceAll('&#x27;', "'");

test('after the first export: Say thanks and Pay $5 are the two buttons, and free comes first', async t => {
  const c = card(t);
  assert.equal(c.probe.out, null, 'nothing before an export');
  const out = await c.afterExport('photos', true);

  assert.deepEqual(buttons(out), ['Say thanks', 'Pay $5']);
  const page = html(out);
  assert.match(page, /Your photos are saved/);
  assert.match(page, /Hi, I'm Charles\. OpenExtract is free for everyone, no strings\./);
  assert.match(page, /If getting your photos off your iPhone helped, pay what it's worth to you, but only if you can\./);
  assert.match(page, /If you can't pay, say thank you instead\./);
  assert.ok(page.indexOf('free for everyone') < page.indexOf('pay what it'), '"free, no strings" up front');
  assert.doesNotMatch(page, /Not now/);
  assert.equal(page.split('Say thanks').length, 2, 'one way to say thanks, not a button and a link');
  assert.match(page, /aria-label="Dismiss"[^>]*>×</, 'a quiet × to dismiss it');
  assert.match(page, />Other amounts</);
  assert.match(page, />Already paid\? Stop asking</);
});

test('Say thanks opens the thank-you note for what was saved, and quiets the ask like dismissing', async t => {
  const c = card(t);
  const out = await c.afterExport('messages', true);
  button(out, 'Say thanks').props.onClick();
  assert.deepEqual(c.feedback, [{ kind: 'thanks', area: 'messages' }]);
  assert.ok(c.bridge.calls.some(([m]) => m === 'support.snooze'), 'no more asks until the app is opened again');
  assert.equal(c.probe.rerender(), null, 'the card goes away');
});

test('the header ask (no export behind it) says thanks under the general "export" area', async t => {
  const c = card(t);
  const out = await c.ask({ mode: 'header' });
  assert.match(html(out), /Pay it forward/);
  assert.match(html(out), /If it got your photos, messages or contacts off your iPhone, pay what it's worth to you/);
  button(out, 'Say thanks').props.onClick();
  assert.deepEqual(c.feedback, [{ kind: 'thanks', area: 'export' }]);
});

test('the × does what "Not now" did: the card closes and the ask is quiet until the app is opened again', async t => {
  const c = card(t);
  const out = await c.afterExport('calls', true);
  assert.equal(typeof out.props.onClose, 'function', 'the card has a ×');
  out.props.onClose();
  assert.deepEqual(c.bridge.calls.filter(([m]) => m === 'support.snooze'), [['support.snooze']]);
  assert.deepEqual(c.feedback, [], 'dismissing opens nothing');
  assert.equal(c.probe.rerender(), null);
});

test('Pay $5 opens the payment page and asks to hear back once paid', async t => {
  const c = card(t);
  const out = await c.afterExport('photos', true);
  button(out, 'Pay $5').props.onClick();
  assert.deepEqual(c.bridge.calls.filter(([m]) => m === 'openExternal'), [['openExternal', c.payItForward.SUPPORT_PAY_URL]]);
  assert.ok(!c.bridge.calls.some(([m]) => m === 'support.snooze'));
  const next = c.probe.rerender();
  assert.match(html(next), /The payment page is open in your browser/);
  assert.deepEqual(buttons(next), ['Close', "I've paid"]);
});

test('later exports: the short ask, signed, with the same two buttons', async t => {
  const c = card(t);
  const out = await c.afterExport('notes', false);
  assert.deepEqual(buttons(out), ['Say thanks', 'Pay $5']);
  const page = html(out);
  assert.match(page, /Your notes are saved/);
  assert.doesNotMatch(page, /Hi, I'm Charles/);
  assert.match(page, /OpenExtract is free, no strings\. If getting your notes off your iPhone helped, pay what it's worth to you, but only if you can\. If you can't pay, say thank you instead\./);
  assert.match(page, /— Charles/);
});

test('once a thank-you went out from this computer, the card asks only to pay, and says it\'s theirs if they can\'t', async t => {
  const c = card(t, { paid: false, thanksSent: true });
  const out = await c.afterExport('photos', false);
  assert.deepEqual(buttons(out), ['Pay $5']);
  const page = html(out);
  assert.doesNotMatch(page, /Say thanks|say thank you/);
  assert.match(page, /but only if you can\. If you can't, it's yours\./);
  // Still dismissable
  out.props.onClose();
  assert.ok(c.bridge.calls.some(([m]) => m === 'support.snooze'));
});

test('after "I\'ve paid": the thank-you offers a like on AlternativeTo and a star on GitHub, and still one way out', async t => {
  const c = card(t);
  const out = await c.afterExport('photos', false);
  button(out, 'Already paid? Stop asking').props.onClick();
  const paid = c.probe.rerender();
  const page = html(paid);
  assert.match(page, /Thank you, truly/);
  assert.match(page, /I won't ask again\./);
  assert.match(page, /a like on AlternativeTo or a star on GitHub helps the next\s+person find it/);
  assert.match(page, />Like it on AlternativeTo</);
  assert.match(page, />Star it on GitHub</);
  assert.deepEqual(buttons(paid), ['Close'], 'the links are small links, not more buttons');

  const help = findAll(paid, el => typeof el.type === 'function' && el.type.name === 'HelpOthersFindIt')[0];
  assert.ok(help, 'the card shows the links');
  const links = help.type(help.props);
  button(links, 'Like it on AlternativeTo').props.onClick();
  button(links, 'Star it on GitHub').props.onClick();
  assert.deepEqual(c.bridge.calls.filter(([m]) => m === 'openExternal'), [
    ['openExternal', c.payItForward.SUPPORT_LIKE_URL],
    ['openExternal', c.payItForward.SUPPORT_STAR_URL],
  ]);
});

test('the ask itself doesn\'t add the like and star links: they come only after thanks or paying', async t => {
  const c = card(t);
  const page = html(await c.afterExport('photos', true));
  assert.doesNotMatch(page, /AlternativeTo|Star it on GitHub/);
});
