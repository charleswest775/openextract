// Tests for saving the Timeline as CSV, Markdown or HTML (src/lib/timelineExport.ts).
// Entries are shaped like useTimeline's normalizers make them from the engine's
// records; timestamps are the engine's UTC ISO strings, grouped by local day.
// Run with: node --test scripts/timeline-export.test.mjs (also re-runs itself in other time zones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones, enUS, childZone } from './test-helpers/time-zones.mjs';

const { formatTimeline, FORMAT_FILTERS } = loadTs('src/lib/timelineExport.ts');
const { formatDate, formatTime } = loadTs('src/lib/dates.ts');

const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);
const engine = date => date.toISOString().replace('Z', '+00:00');

/** RFC 4180 reader: quoted fields, doubled quotes, line breaks inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  row.push(field); rows.push(row);
  return rows;
}

let n = 0;
const at = when => (typeof when === 'string' ? when : engine(when));
const message = (when, text, over = {}) => ({
  id: `message:${++n}`, type: 'message', timestamp: at(when), contactName: 'Mom', contactIdentifier: '+15035550123',
  message: { text, isFromMe: false, sender: '+15035550123', messageType: 'text', conversationName: 'Mom', service: 'iMessage', ...over },
});
const call = (when, over = {}) => ({
  id: `call:${++n}`, type: 'call', timestamp: at(when), contactName: 'Dad', contactIdentifier: '+15035550188',
  call: { direction: 'incoming', status: 'answered', duration: 0, app: 'com.apple.Telephony', ...over },
});
const photo = (when, over = {}) => ({
  id: `photo:${++n}`, type: 'photo', timestamp: at(when), contactName: null, contactIdentifier: null,
  photo: { filename: 'IMG_0001.HEIC', fileHash: 'abc', kind: 'photo', width: 4032, height: 3024, duration: 0, ...over },
});
const voicemail = (when, over = {}) => ({
  id: `voicemail:${++n}`, type: 'voicemail', timestamp: at(when), contactName: null, contactIdentifier: '+14065550109',
  voicemail: { duration: 45, transcript: '', phoneNumber: '+14065550109', ...over },
});
const note = (when, over = {}) => ({
  id: `note:${++n}`, type: 'note', timestamp: at(when), contactName: null, contactIdentifier: null,
  note: { noteId: n, title: 'Groceries', bodyPreview: 'eggs, flour', body: 'eggs, flour', modified: at(when), ...over },
});
const visit = (when, over = {}) => ({
  id: `browser:s_${++n}`, type: 'browser', timestamp: when === null ? '' : at(when), contactName: null, contactIdentifier: null,
  browser: { url: 'https://www.nhl.com/scores', title: 'NHL Scores', domain: 'www.nhl.com', browserName: 'safari', ...over },
});

const DAY = local(2024, 3, 9, 15, 30);
const csvRows = entries => parseCsv(formatTimeline(entries, 'csv'));
const describe = entry => csvRows([entry])[1][4];

test('CSV: a header, then one row of five fields per entry', () => {
  const entries = [message(DAY, 'hi'), call(DAY), photo(DAY)];
  const rows = csvRows(entries);
  assert.deepEqual(rows[0], ['Date', 'Time', 'Type', 'Contact', 'Description']);
  assert.equal(rows.length, 4);
  for (const [i, r] of rows.slice(1).entries()) {
    assert.equal(r.length, 5);
    assert.deepEqual(r.slice(0, 3), [formatDate(entries[i].timestamp), formatTime(entries[i].timestamp), entries[i].type]);
  }
  assert.equal(formatTimeline([], 'csv'), 'Date,Time,Type,Contact,Description');
});

test('CSV keeps commas, quotes, line breaks, emoji and right-to-left text intact', () => {
  const tricky = 'Running late, there at 7 "ish"\nsave me a seat 🙏 — مرحبا';
  const entries = [
    message(DAY, tricky, { conversationName: 'Tom, Jerry & "Spike"' }),
    message(DAY, '=HYPERLINK("http://x")', { isFromMe: true, conversationName: 'שרה' }),
  ];
  const rows = csvRows(entries);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].slice(3), ['Tom, Jerry & "Spike"', `Received: ${tricky}`]);
  assert.deepEqual(rows[2].slice(3), ['שרה', 'Sent: =HYPERLINK("http://x")']);
});

test('what each kind of entry says', () => {
  assert.equal(describe(message(DAY, 'See you soon')), 'Received: See you soon');
  assert.equal(describe(message(DAY, 'On my way', { isFromMe: true })), 'Sent: On my way');
  assert.equal(describe(message(DAY, null, { messageType: 'attachment' })), 'Received: [Attachment]');
  assert.equal(describe(message(DAY, null, { messageType: 'digital_touch' })), 'Received: [Digital Touch]');
  assert.equal(describe(message(DAY, '', { messageType: 'sticker' })), 'Received: [sticker]');
  assert.equal(describe(message(DAY, null, { messageType: '' })), 'Received: [No text]');

  assert.equal(describe(call(DAY, { status: 'missed' })), 'Incoming - Missed');
  assert.equal(describe(call(DAY, { direction: 'outgoing', duration: 3725 })), 'Outgoing - Answered - 62:05');
  assert.equal(describe(call(DAY, { status: 'declined', duration: 0 })), 'Incoming - declined');

  assert.equal(describe(photo(DAY)), '[Photo] IMG_0001.HEIC (4032x3024)');
  assert.equal(describe(photo(DAY, { kind: 'video', filename: 'IMG_0002.MOV', width: 1920, height: 1080, duration: 12.5 })),
    '[Video] IMG_0002.MOV (1920x1080) 0:12');
  assert.equal(describe(photo(DAY, { kind: 'live_photo' })), '[Live Photo] IMG_0001.HEIC (4032x3024)');
  assert.equal(describe(photo(DAY, { kind: 'screenshot', width: 0, height: 0 })), '[Screenshot] IMG_0001.HEIC');

  assert.equal(describe(voicemail(DAY)), '[Voicemail] 0:45');
  assert.equal(describe(voicemail(DAY, { transcript: 'Call me "back", ok?' })), '[Voicemail] 0:45 - "Call me "back", ok?"');

  assert.equal(describe(note(DAY)), 'Groceries - eggs, flour');
  assert.equal(describe(note(DAY, { bodyPreview: '' })), 'Groceries');

  assert.equal(describe(visit(DAY)), '[Safari] NHL Scores (https://www.nhl.com/scores)');
  assert.equal(describe(visit(DAY, { browserName: 'firefox', title: '' })), '[Firefox] www.nhl.com (https://www.nhl.com/scores)');
});

test('who each entry is with', () => {
  const contact = entry => csvRows([entry])[1][3];
  assert.equal(contact(message(DAY, 'x', { conversationName: 'Book club 📚' })), 'Book club 📚');
  assert.equal(contact(call(DAY)), 'Dad');
  assert.equal(contact({ ...call(DAY), contactName: null }), '+15035550188');
  assert.equal(contact(voicemail(DAY)), '+14065550109');
  assert.equal(contact(photo(DAY)), '');
});

test('entries are grouped under their local day, through midnight and DST changes', () => {
  // Newest first, as the Timeline sorts them
  const entries = [
    message(local(2024, 3, 11, 0, 1), 'just after midnight'),
    message(local(2024, 3, 10, 23, 59, 59), 'last thing'),
    call(local(2024, 3, 10, 12)),
    photo(local(2024, 3, 10, 0, 30)),
    note(local(2024, 3, 9, 23, 59)),
    visit(local(2024, 11, 3, 23, 30)),
    visit(local(2024, 11, 3, 0, 15)),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const md = formatTimeline(entries, 'md');
  const headings = md.split('\n').filter(l => l.startsWith('## '));
  assert.deepEqual(headings, [
    `## ${formatDate(engine(local(2024, 11, 3, 12)))}`,
    `## ${formatDate(engine(local(2024, 3, 11, 12)))}`,
    `## ${formatDate(engine(local(2024, 3, 10, 12)))}`,
    `## ${formatDate(engine(local(2024, 3, 9, 12)))}`,
  ]);
  const html = formatTimeline(entries, 'html');
  assert.equal((html.match(/<h2 /g) || []).length, 4);
  const csvDays = csvRows(entries).slice(1).map(r => r[0]);
  assert.equal(new Set(csvDays).size, 4);
});

test('entries with no time go under "Unknown date"', () => {
  const md = formatTimeline([visit(null)], 'md');
  assert.ok(md.includes('## Unknown date'));
  assert.ok(md.includes('- `--:--` **Browser**'));
  assert.ok(formatTimeline([visit(null)], 'html').includes('>Unknown date</h2>'));
  assert.deepEqual(csvRows([visit(null)])[1].slice(0, 3), ['', '', 'browser']);
});

test('Markdown layout', () => {
  const entry = message(DAY, 'See you at 7', { conversationName: 'Mom' });
  const lines = formatTimeline([entry], 'md').split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    '# Timeline Export', '',
    `## ${formatDate(entry.timestamp)}`, '',
    `- \`${formatTime(entry.timestamp)}\` **Message** | **Mom**`,
    '  Received: See you at 7',
  ]);
  assert.equal(lines.at(-2), '---');
  assert.match(lines.at(-1), /^\*Exported 1 entries on .+\*$/);
  // Photos have no contact
  assert.ok(formatTimeline([photo(DAY)], 'md').includes(`- \`${formatTime(at(DAY))}\` **Photo**\n`));
});

test('HTML escapes everything that came from the backup', () => {
  const evil = '<script>alert("pwned")</script> & <img src=x onerror=alert(1)>';
  const entries = [
    message(DAY, evil, { conversationName: 'Tom & Jerry <TJ> "the cat"' }),
    visit(DAY, { title: '</div><script>steal()</script>', url: 'https://x.test/?a=1&b="2"' }),
    note(DAY, { title: '<b>Bold</b>', bodyPreview: '<i>' }),
  ];
  const html = formatTimeline(entries, 'html');
  assert.ok(!/<script/i.test(html), 'no script tag gets through');
  assert.ok(!html.includes('<img'), 'no img tag gets through');
  assert.ok(!html.includes('<b>Bold'));
  assert.ok(html.includes('Received: &lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; &amp; &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<strong>Tom &amp; Jerry &lt;TJ&gt; &quot;the cat&quot;</strong>'));
  assert.ok(html.includes('&lt;/div&gt;&lt;script&gt;steal()&lt;/script&gt; (https://x.test/?a=1&amp;b=&quot;2&quot;)'));
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<meta charset="UTF-8">'));
  // Every div opened is closed: the backup's text didn't change the page's structure
  assert.equal((html.match(/<div/g) || []).length, (html.match(/<\/div>/g) || []).length);
});

test('HTML keeps emoji and right-to-left text as they are', () => {
  const html = formatTimeline([message(DAY, 'مرحبا 👋 שלום', { conversationName: 'محمد' })], 'html');
  assert.ok(html.includes('Received: مرحبا 👋 שלום'));
  assert.ok(html.includes('<strong>محمد</strong>'));
});

test('empty exports are still complete documents', () => {
  assert.match(formatTimeline([], 'md'), /^# Timeline Export\n\n---\n\*Exported 0 entries on .+\*$/);
  const html = formatTimeline([], 'html');
  assert.ok(html.includes('<div class="meta">0 entries &middot; Exported '));
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('entry counts are grouped for the locale', { skip: !enUS && 'needs an en-US locale' }, () => {
  const many = Array.from({ length: 1500 }, (_, i) => photo(local(2024, 3, 9, 10, 0, i % 60)));
  assert.ok(formatTimeline(many, 'html').includes('1,500 entries &middot;'));
  assert.match(formatTimeline(many, 'md'), /\*Exported 1,500 entries on /);
});

// About 40µs per entry per format, nearly all of it toLocaleDateString/toLocaleTimeString
test('a big Timeline (5,000 entries) exports in every format', { skip: childZone && 'not time-zone sensitive' }, () => {
  const entries = [];
  for (let i = 0; i < 5_000; i++) entries.push(message(new Date(Date.UTC(2024, 0, 1) + i * 3_600_000), `message ${i}, "quoted"`));
  entries.reverse();
  for (const format of ['csv', 'md', 'html']) {
    const out = formatTimeline(entries, format);
    assert.ok(out.length > 5_000 * 20, format);
  }
  assert.equal(csvRows(entries).length, 5_001);
});

test('the save dialog filter matches each format', () => {
  assert.deepEqual(FORMAT_FILTERS, {
    html: { name: 'HTML Document', extensions: ['html'] },
    md: { name: 'Markdown', extensions: ['md'] },
    csv: { name: 'CSV Spreadsheet', extensions: ['csv'] },
  });
});

rerunInTimeZones(import.meta.url);
