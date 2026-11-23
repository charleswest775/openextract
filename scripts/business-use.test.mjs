// electron/businessUse.ts: counting different iPhones saved from in the past year, and when
// "Using it for paid work?" shows (once, from the 6th iPhone, never after "I've paid").
// Run with: node --test scripts/business-use.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadElectronModule } from './test-helpers/electron-env.mjs';

const { BUSINESS_ASK_DEVICES, DEVICE_WINDOW_MS, deviceKey, recordSave, shouldAskBusiness, isBusinessAnswer } =
  loadElectronModule('businessUse').module;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 22);
const UDID = '00008110-001A2B3C4D5E801E';

describe('deviceKey', () => {
  test('keeps a hash, never the ID', () => {
    const key = deviceKey(UDID);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(UDID.toLowerCase().replace(/-/g, '')));
  });

  test('the same iPhone with or without dashes, in either case, is one key', () => {
    assert.equal(deviceKey(UDID), deviceKey(UDID.replace(/-/g, '').toLowerCase()));
  });
});

describe('recordSave', () => {
  test('counts different iPhones; saving twice from one counts once', () => {
    let log = {};
    for (const id of ['A', 'B', 'A', 'C', 'b']) ({ log } = recordSave(log, id, NOW));
    assert.equal(Object.keys(log).length, 3);
    assert.equal(recordSave(log, 'C', NOW).count, 3);
  });

  test('saves older than a year drop off', () => {
    const { log } = recordSave({}, 'old', NOW - DEVICE_WINDOW_MS - DAY);
    const later = recordSave(log, 'new', NOW);
    assert.equal(later.count, 1);
    assert.deepEqual(Object.keys(later.log), [deviceKey('new')]);
  });

  test('a save refreshes the date, so a phone saved from again stays counted', () => {
    let { log } = recordSave({}, 'A', NOW - 300 * DAY);
    ({ log } = recordSave(log, 'A', NOW - 10 * DAY));
    assert.equal(recordSave(log, 'B', NOW + 100 * DAY).count, 2);
  });

  test('a damaged log is treated as empty', () => {
    for (const bad of [null, 'x', [1, 2], { k: 'soon' }, { k: NaN }]) {
      assert.equal(recordSave(bad, 'A', NOW).count, 1);
    }
  });

  test('an empty ID adds nothing', () => {
    assert.equal(recordSave({}, '  ', NOW).count, 0);
  });
});

describe('shouldAskBusiness', () => {
  test(`from the ${BUSINESS_ASK_DEVICES}th iPhone, once, and not after "I've paid"`, () => {
    assert.equal(BUSINESS_ASK_DEVICES, 6);
    assert.equal(shouldAskBusiness({ count: 5, shown: false, paid: false }), false);
    assert.equal(shouldAskBusiness({ count: 6, shown: false, paid: false }), true);
    assert.equal(shouldAskBusiness({ count: 9, shown: true, paid: false }), false);
    assert.equal(shouldAskBusiness({ count: 9, shown: false, paid: true }), false);
  });

  test('answers are work or personal only', () => {
    assert.ok(isBusinessAnswer('work') && isBusinessAnswer('personal'));
    assert.ok(!isBusinessAnswer('business') && !isBusinessAnswer(undefined));
  });
});
