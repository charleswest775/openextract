// Tests for the price step in the Save window ("What's this worth to you?",
// src/components/shared/PriceStep.tsx) and when SaveDialog shows it (priceStepDue in
// src/lib/payItForward.ts): on the first save of a run, before saving, never after "I've paid"
// or once an ask has come in this run, and never in the way of the save. The components run in
// a small stand-in for React's hooks (as in pay-it-forward-card.test.mjs) and render with
// react-dom/server.
// Run with: node --test scripts/price-step.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
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
const text = el => (el == null || typeof el === 'boolean' ? ''
  : typeof el !== 'object' ? String(el)
  : Array.isArray(el) ? el.map(text).join('')
  : text(el.props?.children)).trim();
const button = (out, label) => findAll(out, el => el.type === 'button' && text(el) === label)[0];
const html = out => renderToStaticMarkup(out).replaceAll('&#x27;', "'");
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

const pay = loadTs('src/lib/payItForward.ts');

// ── priceStepDue and the amounts ─────────────────────────────────────────────

test('the step is due only when unpaid and nothing has asked in this run; unknown means no', () => {
  assert.equal(pay.priceStepDue({ paid: false, thanksSent: false, snoozed: false }), true);
  assert.equal(pay.priceStepDue({ paid: true, snoozed: false }), false, 'never after "I\'ve paid"');
  assert.equal(pay.priceStepDue({ paid: false, snoozed: true }), false, 'one ask a run');
  assert.equal(pay.priceStepDue(null), false, 'no status (no bridge, or it failed): straight to the save');
  assert.equal(pay.priceStepDue(undefined), false);
});

test('amounts: $5, $25 suggested and picked first, $100, or any amount, each through the site\'s app redirect', () => {
  assert.deepEqual(pay.PRICE_STEP_AMOUNTS.map(a => a.label), ['$5', '$25', '$100', 'Other']);
  assert.equal(pay.PRICE_STEP_SUGGESTED, '25');
  assert.equal(pay.PRICE_STEP_AMOUNTS.find(a => a.id === '25').note, 'Suggested');
  assert.deepEqual(pay.PRICE_STEP_AMOUNTS.map(a => pay.priceStepUrl(a.id)), [
    'https://www.openextract.app/support/pay/app/5',
    'https://www.openextract.app/support/pay/app/25',
    'https://www.openextract.app/support/pay/app/100',
    'https://www.openextract.app/support/pay/app/any',
  ]);
});

// ── PriceStep ────────────────────────────────────────────────────────────────

function step(t, props = {}) {
  const bridge = fakeBridge({ openExternal: () => {} });
  bridge.api.support = { markPaid: async () => { bridge.calls.push(['support.markPaid']); } };
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  const feedback = [];
  const continued = [];
  const back = [];
  // "Can't pay? Say thanks" opens the thank-you note through a window event (openThanks).
  globalThis.window.dispatchEvent = e => { if (e.type === 'openextract:say-thanks') feedback.push({ kind: 'thanks', area: e.detail }); };
  const PriceStep = loadTs('src/components/shared/PriceStep.tsx', { stubs: { react: R } }).default;
  const probe = mount(PriceStep, { onContinue: () => continued.push(true), onBack: () => back.push(true), ...props });
  return { bridge, feedback, continued, back, probe, opened: () => bridge.calls.filter(([m]) => m === 'openExternal').map(([, u]) => u) };
}

test('free comes first, then the ask, signed; $25 is picked and "Save without paying" is a full button', t => {
  const s = step(t);
  const page = html(s.probe.out);
  assert.match(page, /What's this worth to you\?/);
  assert.match(page, /OpenExtract is free, and this save is yours either way\./);
  assert.match(page, /Apps like this cost \$30 to \$50\. I build and fix OpenExtract on my own time, and fewer than\s+1 in 100 people pay\. If it's getting you what you came for, please pay what it's worth\./);
  assert.match(page, /— Charles/);
  assert.ok(page.indexOf('yours either way') < page.indexOf('please pay'), 'free before the ask');
  assert.ok(button(s.probe.out, 'Pay $25 and save'), 'the suggested amount is picked when it opens');
  const free = button(s.probe.out, 'Save without paying');
  assert.match(free.props.className, /hearth-ghost-btn/, 'saving free is a real button, not a hidden link');
  assert.doesNotMatch(page, /autofocus/i, 'Enter from the format step doesn\'t open a payment page');
  assert.doesNotMatch(page, /amount due|balance|invoice|No thanks/i, 'no bills, no guilt-trip refusal');
  assert.match(page, /The payment page opens in your browser\. Your save starts right away\./);
});

test('picking an amount changes the Pay button; Pay opens that amount\'s page and goes on with the save', t => {
  const s = step(t);
  const radio = label => findAll(s.probe.out, el => el.props?.role === 'radio' && text(el).startsWith(label))[0];
  radio('$100').props.onClick();
  let out = s.probe.rerender();
  assert.ok(button(out, 'Pay $100 and save'));
  radio('Other').props.onClick();
  out = s.probe.rerender();
  button(out, 'Pay what you want and save').props.onClick();
  assert.deepEqual(s.opened(), ['https://www.openextract.app/support/pay/app/any']);
  assert.equal(s.continued.length, 1, 'the save starts right away');
});

test('"Save without paying" saves and opens nothing', t => {
  const s = step(t);
  button(s.probe.out, 'Save without paying').props.onClick();
  assert.equal(s.continued.length, 1);
  assert.deepEqual(s.opened(), []);
  assert.deepEqual(s.feedback, []);
});

test('"Can\'t pay? Say thanks" saves and opens the thank-you note; gone once thanks went out', t => {
  const s = step(t, { area: 'messages' });
  button(s.probe.out, "Can't pay? Say thanks").props.onClick();
  assert.equal(s.continued.length, 1);
  assert.deepEqual(s.feedback, [{ kind: 'thanks', area: 'messages' }]);

  const sent = step(t, { thanksSent: true });
  assert.equal(button(sent.probe.out, "Can't pay? Say thanks"), undefined);
});

test('"Already paid?" ends the asks for good and saves; Back goes back to the formats', t => {
  const s = step(t);
  button(s.probe.out, "Already paid? Don't ask again").props.onClick();
  assert.ok(s.bridge.calls.some(([m]) => m === 'support.markPaid'));
  assert.equal(s.continued.length, 1);
  button(s.probe.out, '← Back').props.onClick();
  assert.equal(s.back.length, 1);
});

// ── SaveDialog: when the step comes ──────────────────────────────────────────

function dialog(t, status) {
  const bridge = fakeBridge({});
  bridge.api.support = {
    status: status === 'missing' ? undefined : status === 'fails'
      ? async () => { throw new Error('no'); }
      : async () => status,
    snooze: async () => { bridge.calls.push(['support.snooze']); },
  };
  // SaveDialog listens for Escape on the window.
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  const saved = [];
  const PriceStepStub = props => ({ type: 'price-step', props });
  const SaveDialog = loadTs('src/components/shared/SaveDialog.tsx', { stubs: { react: R, './PriceStep': { __esModule: true, default: PriceStepStub } } }).default;
  const probe = mount(SaveDialog, {
    title: 'Save your conversation', formats: [{ id: 'pdf', label: 'PDF', detail: '' }, { id: 'csv', label: 'CSV', detail: '' }],
    onSave: f => saved.push(f), onCancel: () => {},
  });
  const priceStep = () => findAll(probe.rerender(), el => el.type === PriceStepStub)[0];
  return { bridge, saved, probe, priceStep, snoozed: () => bridge.calls.filter(([m]) => m === 'support.snooze').length };
}

test('first save of a run, not paid: the step comes before saving, and asks once a run', async t => {
  const d = dialog(t, { paid: false, thanksSent: false, snoozed: false });
  await settle();
  await button(d.probe.rerender(), 'Save').props.onClick();
  assert.deepEqual(d.saved, [], 'nothing saved yet');
  assert.equal(d.snoozed(), 1, 'no more asks in this run, the card after an export included');
  const stepEl = d.priceStep();
  assert.ok(stepEl, 'the price step shows');
  assert.equal(stepEl.props.thanksSent, false);
  stepEl.props.onContinue();
  assert.deepEqual(d.saved, ['pdf'], 'then the save goes on, in the format picked');
});

test('Back from the step shows the formats again', async t => {
  const d = dialog(t, { paid: false, thanksSent: true, snoozed: false });
  await settle();
  await button(d.probe.rerender(), 'Save').props.onClick();
  d.priceStep().props.onBack();
  assert.equal(d.priceStep(), undefined);
  assert.ok(button(d.probe.rerender(), 'Save'));
});

for (const [why, status] of [
  ['after "I\'ve paid"', { paid: true, thanksSent: false, snoozed: false }],
  ['once an ask came in this run', { paid: false, thanksSent: false, snoozed: true }],
  ['without a bridge', 'missing'],
  ['when the status fails', 'fails'],
]) {
  test(`no step ${why}: Save saves straight away`, async t => {
    const d = dialog(t, status);
    await settle();
    await button(d.probe.rerender(), 'Save').props.onClick();
    assert.deepEqual(d.saved, ['pdf']);
    assert.equal(d.priceStep(), undefined);
    assert.equal(d.snoozed(), 0);
  });
}

test('Save clicked before the status is in waits for it', async t => {
  const d = dialog(t, { paid: false, thanksSent: false, snoozed: false });
  // No settle(): the status promise hasn't resolved into state yet.
  await button(d.probe.out, 'Save').props.onClick();
  assert.deepEqual(d.saved, []);
  assert.ok(d.priceStep());
});

// ── askPriceFirst, exportFolder and PriceStepHost: saves that skip the Save window ─────

function withBridge(t, status, extra = {}) {
  const bridge = fakeBridge({ saveFolder: async () => '/chosen', ...extra });
  bridge.api.support = {
    status: async () => status,
    snooze: async () => { bridge.calls.push(['support.snooze']); },
  };
  t.after(bridge.restore);
  return bridge;
}

test('askPriceFirst: with no host mounted, or nothing due, it goes straight on', async t => {
  const bridge = withBridge(t, { paid: false, thanksSent: false, snoozed: false });
  const lib = loadTs('src/lib/payItForward.ts');
  assert.equal(await lib.askPriceFirst(), true, 'no host: never waits on a window that isn\'t there');
  const asked = [];
  lib.setPriceStepHost(r => asked.push(r));
  bridge.api.support.status = async () => ({ paid: true, thanksSent: false, snoozed: false });
  assert.equal(await lib.askPriceFirst(), true, 'paid: no step');
  bridge.api.support.status = async () => ({ paid: false, thanksSent: false, snoozed: true });
  assert.equal(await lib.askPriceFirst(), true, 'already asked in this run (the Save window): no second ask');
  assert.deepEqual(asked, []);
  assert.ok(!bridge.calls.some(([m]) => m === 'support.snooze'));
});

test('askPriceFirst: when due, the host shows the step (once a run) and its answer decides', async t => {
  const bridge = withBridge(t, { paid: false, thanksSent: true, snoozed: false });
  const lib = loadTs('src/lib/payItForward.ts');
  const asked = [];
  const off = lib.setPriceStepHost(r => asked.push(r));
  const goOn = lib.askPriceFirst();
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].thanksSent, true);
  assert.ok(bridge.calls.some(([m]) => m === 'support.snooze'), 'shown, so no more asks this run');
  asked[0].resolve(true);
  assert.equal(await goOn, true);

  const back = lib.askPriceFirst();
  await settle();
  asked[1].resolve(false);
  assert.equal(await back, false);
  off();
  assert.equal(await lib.askPriceFirst(), true, 'unmounted host: straight on');
});

test('exportFolder: the step first when due, then the folder picker; backing out saves nothing', async t => {
  const bridge = withBridge(t, { paid: false, thanksSent: false, snoozed: false });
  const lib = loadTs('src/lib/payItForward.ts');
  const ipc = loadTs('src/lib/ipc.ts', { stubs: { './payItForward': lib } });
  let answer = false;
  lib.setPriceStepHost(r => r.resolve(answer));
  assert.equal(await ipc.exportFolder(), null, 'Back: no folder picker');
  assert.ok(!bridge.calls.some(([m]) => m === 'saveFolder'));
  answer = true;
  assert.equal(await ipc.exportFolder(), '/chosen');
  assert.equal(bridge.calls.filter(([m]) => m === 'saveFolder').length, 1);
  assert.equal(await ipc.saveFolder(), '/chosen', 'saveFolder itself (the backup destination) never asks');
});

test('PriceStepHost: opens the step for a request; going on or backing out answers it and closes', async t => {
  const bridge = fakeBridge({});
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  let host = null;
  const PriceStepStub = props => ({ type: 'price-step', props });
  const PriceStepHost = loadTs('src/components/shared/PriceStepHost.tsx', {
    stubs: {
      react: R,
      './PriceStep': { __esModule: true, default: PriceStepStub },
      '../../lib/payItForward': { setPriceStepHost: h => { host = h; return () => { host = null; }; } },
    },
  }).default;
  const probe = mount(PriceStepHost, {});
  assert.equal(probe.out, null, 'nothing until a save asks');
  assert.equal(typeof host, 'function', 'registered as the host');

  const answers = [];
  host({ thanksSent: false, resolve: v => answers.push(v) });
  let stepEl = findAll(probe.rerender(), el => el.type === PriceStepStub)[0];
  assert.ok(stepEl);
  stepEl.props.onContinue();
  assert.equal(probe.rerender(), null);

  host({ thanksSent: false, resolve: v => answers.push(v) });
  findAll(probe.rerender(), el => el.type === PriceStepStub)[0].props.onBack();
  host({ thanksSent: false, resolve: v => answers.push(v) });
  probe.rerender().props.onClick();
  assert.deepEqual(answers, [true, false, false], 'go on; Back; a click outside');
});
