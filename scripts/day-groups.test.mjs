// Tests for the date pills in a thread (src/lib/dayGroups.ts, used by Messages,
// WhatsApp and Recover deleted messages): days in order, each once, a message
// stamped with an earlier day staying where it arrived, and no-date messages.
// Instants are built with the local Date constructor so the checks hold in any
// time zone; the file reruns itself in several (test-helpers/time-zones.mjs).
// Run with: node --test scripts/day-groups.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones, onlyIn } from './test-helpers/time-zones.mjs';

const { groupByDay, dayKey, isOffDay, UNKNOWN_DAY, UNKNOWN_DAY_LABEL } = loadTs('src/lib/dayGroups.ts');
const { formatDate } = loadTs('src/lib/dates.ts');

// A local instant as the engine sends it (UTC ISO)
const at = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
let nextId = 1;
const msg = (date, extra = {}) => ({ message_id: nextId++, date, ...extra });
const shape = groups => groups.map(g => [g.key, g.messages.map(m => m.message_id)]);

test('dayKey is the local calendar day', () => {
  assert.equal(dayKey(at(2025, 3, 3, 0, 5)), '2025-03-03');
  assert.equal(dayKey(at(2025, 3, 3, 23, 55)), '2025-03-03');
  assert.equal(dayKey(at(2024, 12, 31, 23, 59)), '2024-12-31');
  assert.equal(dayKey('2025-03-03'), '2025-03-03', 'a bare date is a local day already');
  for (const bad of [null, undefined, '', 'not a date']) assert.equal(dayKey(bad), null);
});

test('a thread in date order: one group per day, labelled like the rest of the app', () => {
  nextId = 1;
  const messages = [msg(at(2025, 3, 3, 9)), msg(at(2025, 3, 3, 18)), msg(at(2025, 3, 4, 8)), msg(at(2025, 3, 6, 7))];
  const groups = groupByDay(messages);
  assert.deepEqual(shape(groups), [['2025-03-03', [1, 2]], ['2025-03-04', [3]], ['2025-03-06', [4]]]);
  assert.equal(groups[0].label, formatDate(messages[0].date));
  assert.deepEqual(groupByDay([]), []);
});

test('a message stamped with an earlier day stays where it arrived: no second pill, no repeated key', () => {
  nextId = 1;
  // WhatsApp shows messages in arrival order; the date is the sender's clock
  const messages = [
    msg(at(2025, 3, 3, 23, 50)),
    msg(at(2025, 3, 4, 0, 10)),
    msg(at(2025, 3, 3, 23, 58)), // arrived after midnight, stamped before it
    msg(at(2025, 3, 4, 0, 20)),
  ];
  const groups = groupByDay(messages);
  assert.deepEqual(shape(groups), [['2025-03-03', [1]], ['2025-03-04', [2, 3, 4]]]);
  const keys = groups.map(g => g.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(isOffDay(messages[2].date, groups[1]), true, 'its bubble shows its own date');
  assert.equal(isOffDay(messages[1].date, groups[1]), false);
});

test('keys stay the same when older messages are loaded above', () => {
  nextId = 1;
  const newer = [msg(at(2025, 3, 4, 9)), msg(at(2025, 3, 5, 9))];
  const older = [msg(at(2025, 3, 3, 9)), msg(at(2025, 3, 4, 7))];
  const before = groupByDay(newer).map(g => g.key);
  const after = groupByDay([...older, ...newer]).map(g => g.key);
  assert.deepEqual(before, ['2025-03-04', '2025-03-05']);
  assert.deepEqual(after, ['2025-03-03', '2025-03-04', '2025-03-05']);
});

test('messages with no date join the day they arrived in; any before the first date are "Date unknown"', () => {
  nextId = 1;
  const messages = [msg(null), msg(''), msg(at(2025, 3, 3)), msg(null), msg(at(2025, 3, 4)), msg('garbage')];
  const groups = groupByDay(messages);
  assert.deepEqual(shape(groups), [[UNKNOWN_DAY, [1, 2]], ['2025-03-03', [3, 4]], ['2025-03-04', [5, 6]]]);
  assert.equal(groups[0].label, UNKNOWN_DAY_LABEL);
  assert.equal(isOffDay(null, groups[1]), false);
  assert.equal(isOffDay(at(2025, 3, 1), groups[0]), false, 'nothing is off-day under "Date unknown"');
  assert.deepEqual(shape(groupByDay([msg(null)])), [[UNKNOWN_DAY, [7]]]);
});

test('works for any message shape with a date, like recovered messages', () => {
  const groups = groupByDay([{ date: at(2025, 1, 1) }, { date: at(2025, 1, 1, 13) }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].messages.length, 2);
});

test('labels in en-US', { skip: onlyIn('America/Los_Angeles') }, () => {
  const [g] = groupByDay([{ date: '2025-03-03T20:00:00+00:00' }]);
  assert.equal(g.key, '2025-03-03');
  assert.equal(g.label, 'Mar 3, 2025');
});

rerunInTimeZones(import.meta.url);
