// Tests for "Using it for paid work?" (src/components/shared/BusinessUsePrompt.tsx): it shows
// only when the main process sends business-card:show, says the count stays on this computer,
// never uses "license required"-style words (OpenExtract is MIT; this is a request), and its
// two answers are remembered, with "It's for work" opening the site's business rates.
// Run with: node --test scripts/business-use-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

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
      if (c.slots[k] && deps?.length === 0) return;
      c.queue.push({ k, fn, deps });
    },
  };
  function mount(Component) {
    const c = { slots: [], i: 0, queue: [], out: null };
    const render = () => {
      current = c;
      c.i = 0;
      try { c.out = Component({}); } finally { current = null; }
      for (const { k, fn, deps } of c.queue.splice(0)) c.slots[k] = { deps, cleanup: fn() };
      return c.out;
    };
    render();
    return { get out() { return c.out; }, rerender: render };
  }
  return { R, mount };
}

function findAll(tree, pick, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, pick, out)); return out; }
  if (pick(tree)) out.push(tree);
  findAll(tree.props?.children, pick, out);
  return out;
}
const text = el => (el == null || typeof el === 'boolean' ? '' : typeof el !== 'object' ? String(el)
  : Array.isArray(el) ? el.map(text).join('') : text(el.props?.children)).trim();
const html = out => renderToStaticMarkup(out).replaceAll('&#x27;', "'");
const button = (out, label) => findAll(out, el => el.type === 'button' && text(el) === label)[0];

function card(t) {
  let show = null;
  const bridge = fakeBridge({
    onBusinessCard: cb => { show = cb; return () => {}; },
    openExternal: () => {},
  });
  bridge.api.support = {
    answerBusiness: async a => { bridge.calls.push(['answerBusiness', a]); },
  };
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  const Prompt = loadTs('src/components/shared/BusinessUsePrompt.tsx', { stubs: { react: R } }).default;
  const probe = mount(Prompt);
  return { bridge, probe, show(n) { show(n); return probe.rerender(); } };
}

test('nothing until the main process asks; then the count, both rates, and that nothing is sent', t => {
  const c = card(t);
  assert.equal(c.probe.out, null);
  const page = html(c.show(6));
  assert.match(page, /You've used OpenExtract on 6 iPhones in the past year/);
  assert.match(page, /family's tech person/);
  assert.match(page, /\$50 a case.*\$200 a year/s);
  assert.match(page, /Nothing in the app changes either way\./);
  assert.match(page, /Counted only on this computer\. Nothing is sent\./);
  assert.match(page, /— Charles/);
  assert.doesNotMatch(page, /licen[cs]e required|violat|you must|amount due|invoice/i);
});

test('"It\'s for work" is remembered and opens the business rates; then a thank-you', t => {
  const c = card(t);
  button(c.show(7), "It's for work").props.onClick();
  assert.deepEqual(c.bridge.calls.filter(x => x[0] !== 'onBusinessCard'), [
    ['answerBusiness', 'work'],
    ['openExternal', 'https://www.openextract.app/support#business'],
  ]);
  const page = html(c.probe.rerender());
  assert.match(page, /Thanks for being straight with me/);
  button(c.probe.out, 'Close').props.onClick();
  assert.equal(c.probe.rerender(), null);
});

test('"It\'s personal" is remembered and closes it; the × closes it with no answer', t => {
  const c = card(t);
  button(c.show(6), "It's personal").props.onClick();
  assert.deepEqual(c.bridge.calls.at(-1), ['answerBusiness', 'personal']);
  assert.equal(c.probe.rerender(), null);

  const d = card(t);
  // The × is NoticeCard's, wired to its onClose.
  d.show(6).props.onClose();
  assert.equal(d.probe.rerender(), null);
  assert.ok(!d.bridge.calls.some(x => x[0] === 'answerBusiness'));
});
