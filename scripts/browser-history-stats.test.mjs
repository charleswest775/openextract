// Tests for the browser-history overview numbers (src/lib/browserHistoryStats.ts).
// Visits are shaped like list_browser_history returns them (ios_backup_core
// BrowserHistoryExtractor): UTC ISO dates with "+00:00", or null when Safari/Firefox
// kept no time, ids prefixed per browser.
// Run with: node --test scripts/browser-history-stats.test.mjs (also re-runs itself in other time zones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones, childZone } from './test-helpers/time-zones.mjs';

const { computeBrowserStats } = loadTs('src/lib/browserHistoryStats.ts');

const engine = date => date.toISOString().replace('Z', '+00:00');
const localKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// A day `n` days before today, at this local time
function daysAgo(n, h = 12, mi = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, h, mi);
}

let nextId = 1;
function visit(when, { domain = 'example.com', browser = 'safari', title = 'Example', url } = {}) {
  const id = nextId++;
  return {
    visit_id: browser === 'safari' ? `s_${id}` : `ff_${id}`,
    url: url ?? `https://${domain}/page/${id}`,
    title,
    domain,
    visit_date: when === null ? null : engine(when),
    browser,
    visit_count: when === null ? null : 3,
  };
}

test('no visits: zeros everywhere, still 24 hours and 7 days to draw', () => {
  const s = computeBrowserStats([]);
  assert.equal(s.totalVisits, 0);
  assert.equal(s.uniqueDomains, 0);
  assert.equal(s.dateRange, null);
  assert.deepEqual(s.browsersFound, []);
  assert.deepEqual(s.activityByDay, []);
  assert.deepEqual(s.topDomains, []);
  assert.deepEqual(s.browserBreakdown, []);
  assert.equal(s.peakHour, 0);
  assert.equal(s.hourDistribution.length, 24);
  assert.ok(s.hourDistribution.every(h => h.count === 0));
  assert.deepEqual(s.dayOfWeekDistribution.map(d => d.label), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
});

test('hour labels read 12a, 1a ... 11a, 12p, 1p ... 11p', () => {
  const labels = computeBrowserStats([]).hourDistribution.map(h => h.label);
  assert.deepEqual(labels, [
    '12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
    '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p',
  ]);
  assert.deepEqual(computeBrowserStats([]).hourDistribution.map(h => h.hour), [...Array(24).keys()]);
});

test('visits with no date count toward totals and sites, not toward time charts', () => {
  const visits = [visit(null, { domain: 'news.ycombinator.com' }), visit(daysAgo(3, 9), { domain: 'news.ycombinator.com' })];
  const s = computeBrowserStats(visits);
  assert.equal(s.totalVisits, 2);
  assert.deepEqual(s.topDomains, [{ domain: 'news.ycombinator.com', count: 2 }]);
  assert.equal(s.hourDistribution.reduce((n, h) => n + h.count, 0), 1);
  assert.equal(s.dayOfWeekDistribution.reduce((n, d) => n + d.count, 0), 1);
  assert.equal(s.activityByDay.reduce((n, d) => n + d.count, 0), 1);
  assert.deepEqual(s.dateRange, { earliest: visits[1].visit_date, latest: visits[1].visit_date });
});

test('hours and weekdays are on the local clock', () => {
  // Evenings at 9pm local, on three different days
  const visits = [daysAgo(1, 21, 15), daysAgo(2, 21, 40), daysAgo(9, 21, 5), daysAgo(4, 7, 30)].map(d => visit(d));
  const s = computeBrowserStats(visits);
  assert.equal(s.peakHour, 21);
  assert.equal(s.hourDistribution[21].count, 3);
  assert.equal(s.hourDistribution[7].count, 1);
  for (const d of [daysAgo(1), daysAgo(2), daysAgo(9), daysAgo(4)]) {
    assert.ok(s.dayOfWeekDistribution[d.getDay()].count >= 1, `weekday ${d.getDay()}`);
  }
  assert.equal(s.dayOfWeekDistribution.reduce((n, d) => n + d.count, 0), 4);
});

test('a tie for the busiest hour goes to the earlier hour', () => {
  const s = computeBrowserStats([visit(daysAgo(1, 14)), visit(daysAgo(1, 8)), visit(daysAgo(2, 14)), visit(daysAgo(2, 8))]);
  assert.equal(s.peakHour, 8);
});

test('the activity chart buckets visits by local calendar day', {
  todo: 'BUG: activityByDay slices the UTC date off the ISO string, while hours and weekdays use local time, '
    + 'so evening (west of UTC) or early-morning (east of UTC) visits land on the wrong day',
}, () => {
  const late = daysAgo(5, 23, 30);
  const early = daysAgo(4, 0, 30);
  const s = computeBrowserStats([visit(late), visit(early)]);
  assert.deepEqual(s.activityByDay, [
    { date: localKey(late), count: 1 },
    { date: localKey(early), count: 1 },
  ]);
  // The 90-day window has the same slip: its cutoff is a UTC date too
  const edge = computeBrowserStats([visit(daysAgo(91)), visit(daysAgo(89))]);
  assert.deepEqual(edge.activityByDay.map(d => d.date), [localKey(daysAgo(89))]);
});

test('the activity chart covers the last 90 days, oldest first', () => {
  const visits = [daysAgo(200), daysAgo(120), daysAgo(85), daysAgo(30), daysAgo(30, 12, 30), daysAgo(1)].map(d => visit(d));
  const s = computeBrowserStats(visits);
  const days = s.activityByDay.map(d => d.date);
  assert.equal(days.length, 3);
  assert.deepEqual([...days].sort(), days);
  assert.deepEqual(s.activityByDay.map(d => d.count), [1, 2, 1]);
  for (const d of days) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  // The date range still covers everything
  assert.equal(s.dateRange.earliest, visits[0].visit_date);
  assert.equal(s.dateRange.latest, visits[5].visit_date);
});

test('top sites: the 15 most visited, busiest first', () => {
  const visits = [];
  for (let i = 0; i < 20; i++) {
    for (let n = 0; n <= i; n++) visits.push(visit(daysAgo(n % 30), { domain: `site${i}.example` }));
  }
  visits.push(visit(daysAgo(2), { domain: 'bücher.de' }), visit(daysAgo(2), { domain: '' }));
  const s = computeBrowserStats(visits);
  assert.equal(s.topDomains.length, 15);
  assert.deepEqual(s.topDomains[0], { domain: 'site19.example', count: 20 });
  assert.deepEqual(s.topDomains[14], { domain: 'site5.example', count: 6 });
  // A visit with no host isn't a site
  assert.equal(s.uniqueDomains, 21);
  assert.ok(!s.topDomains.some(d => d.domain === ''));
});

test('browser breakdown with whole-number percentages', () => {
  const visits = [
    visit(daysAgo(1)), visit(daysAgo(2)),
    visit(daysAgo(3), { browser: 'firefox', domain: 'mozilla.org' }),
  ];
  const s = computeBrowserStats(visits);
  assert.deepEqual(s.browsersFound, ['safari', 'firefox']);
  assert.deepEqual(s.browserBreakdown, [
    { browser: 'safari', count: 2, pct: 67 },
    { browser: 'firefox', count: 1, pct: 33 },
  ]);
  const onlyFirefox = computeBrowserStats([visit(daysAgo(1), { browser: 'firefox' })]);
  assert.deepEqual(onlyFirefox.browserBreakdown, [{ browser: 'firefox', count: 1, pct: 100 }]);
});

test('a big history (60,000 visits) adds up', { skip: childZone && 'not time-zone sensitive' }, () => {
  const visits = [];
  for (let i = 0; i < 60_000; i++) {
    visits.push(visit(daysAgo(i % 400, i % 24, i % 60), { domain: `d${i % 250}.com`, browser: i % 5 ? 'safari' : 'firefox' }));
  }
  const s = computeBrowserStats(visits);
  assert.equal(s.totalVisits, 60_000);
  assert.equal(s.uniqueDomains, 250);
  assert.equal(s.hourDistribution.reduce((n, h) => n + h.count, 0), 60_000);
  assert.equal(s.dayOfWeekDistribution.reduce((n, d) => n + d.count, 0), 60_000);
  assert.deepEqual(s.browserBreakdown.map(b => [b.browser, b.count, b.pct]), [['safari', 48_000, 80], ['firefox', 12_000, 20]]);
  assert.ok(s.activityByDay.length <= 92);
});

rerunInTimeZones(import.meta.url);
