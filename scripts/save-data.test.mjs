// Tests for "Save to this computer" (src/lib/saveData.ts): the contacts CSV and
// vCard, the notes text file, the engine's export results, and the save flow.
// Contacts are shaped like list_contacts returns them; export results like
// python/messages.py export_conversation(s).
// Run with: node --test scripts/save-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, fakeBridge } from './test-helpers/load-ts.mjs';
import { enUS } from './test-helpers/time-zones.mjs';

// saveData.ts imports ipc.ts, which looks for the preload bridge when loaded
function loadWith(t, handlers = {}) {
  const bridge = fakeBridge(handlers);
  t.after(bridge.restore);
  return { lib: loadTs('src/lib/saveData.ts'), calls: bridge.calls };
}
const lib = loadTs('src/lib/saveData.ts');
const { checkEngineResult, csvEscape, plural, contactsToCsv, contactsToVcard, notesToText } = lib;

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

/** vCard 3.0 reader: { name: [values] } per card, with text escapes undone. */
function parseVcards(text) {
  const unescape = v => v.replace(/\\(n|N|,|;|\\)/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
  const cards = [];
  for (const line of text.split('\r\n')) {
    if (line === 'BEGIN:VCARD') cards.push({});
    else if (line && line !== 'END:VCARD') {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon);
      const raw = line.slice(colon + 1);
      const value = name === 'N' ? raw.split(/(?<!\\);/).map(unescape) : unescape(raw);
      (cards.at(-1)[name] ??= []).push(value);
    }
  }
  return cards;
}

const contact = (over = {}) => ({
  first_name: '', last_name: '', display_name: '', organization: '', phones: [], emails: [], note: '', ...over,
});

const TRICKY = contact({
  first_name: 'Zoë', last_name: 'O\'Brien, Jr.', display_name: 'Zoë "Zo" O\'Brien, Jr.',
  organization: 'Smith & Sons; Ltd.',
  phones: ['+1 (503) 555-0123', '+44 20 7946 0958'],
  emails: ['zoe@example.com', 'zo@work.example'],
  note: 'Gate code: 4521\nAllergic to "peanuts", shellfish\r\nC:\\Users\\zoe <script>alert(1)</script> 🎂',
});

test('checkEngineResult passes results through and throws the failures the engine reports', () => {
  const ok = [
    { file: '/Users/jane/Desktop/Mom_42.html', message_count: 1532 },
    { files: ['C:\\Users\\Jane\\Desktop\\merged.csv'], message_count: 9 },
    { status: 'success', exported: 4, path: '/tmp/voicemail' },
    { success: true, path: '/tmp/browser_history_export.csv', count: 3 },
    { error: 'one attachment was missing', files: ['/tmp/a.txt'], message_count: 2 },
  ];
  for (const r of ok) assert.equal(checkEngineResult(r), r);
  for (const r of [null, undefined, 0, '']) assert.equal(checkEngineResult(r), r);

  const failures = [
    [{ error: 'Unsupported format: xml' }, 'Unsupported format: xml'],
    [{ error: 'sms.db not found' }, 'sms.db not found'],
    [{ success: false, error: 'No browser history found to export.' }, 'No browser history found to export.'],
    [{ status: 'error', message: 'Voicemail database is locked' }, 'Voicemail database is locked'],
    [{ success: false }, 'The export did not finish.'],
    [{ status: 'error' }, 'The export did not finish.'],
  ];
  for (const [r, message] of failures) assert.throws(() => checkEngineResult(r), { message });
});

test('csvEscape always quotes, doubles quotes, and keeps each record on one line', () => {
  assert.equal(csvEscape('plain'), '"plain"');
  assert.equal(csvEscape(''), '""');
  assert.equal(csvEscape(null), '""');
  assert.equal(csvEscape(undefined), '""');
  assert.equal(csvEscape('Doe, Jane'), '"Doe, Jane"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line one\nline two'), '"line one line two"');
  assert.equal(csvEscape('windows\r\nline'), '"windows line"');
  assert.equal(csvEscape('محمد 🎉 李雷'), '"محمد 🎉 李雷"');
});

test('contacts CSV reads back field for field', () => {
  const contacts = [
    TRICKY,
    contact({ first_name: 'محمد', last_name: 'العلي', display_name: 'محمد العلي', phones: ['+971 50 123 4567'] }),
    contact({ display_name: 'Pizza Place', organization: 'Pizza Place', phones: ['72727'] }),
    contact({ first_name: 'No', last_name: 'Lists', phones: null, emails: undefined, note: null }),
  ];
  const csv = contactsToCsv(contacts);
  assert.ok(!csv.endsWith('\n'));
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['First Name', 'Last Name', 'Display Name', 'Organization', 'Phone Numbers', 'Email Addresses', 'Notes']);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.length, 7);
  assert.deepEqual(rows[1], [
    'Zoë', 'O\'Brien, Jr.', 'Zoë "Zo" O\'Brien, Jr.', 'Smith & Sons; Ltd.',
    '+1 (503) 555-0123; +44 20 7946 0958', 'zoe@example.com; zo@work.example',
    'Gate code: 4521 Allergic to "peanuts", shellfish C:\\Users\\zoe <script>alert(1)</script> 🎂',
  ]);
  assert.deepEqual(rows[2].slice(0, 5), ['محمد', 'العلي', 'محمد العلي', '', '+971 50 123 4567']);
  assert.deepEqual(rows[4], ['No', 'Lists', '', '', '', '', '']);
  assert.equal(contactsToCsv([]), '"First Name","Last Name","Display Name","Organization","Phone Numbers","Email Addresses","Notes"');
});

test('vCard: one card per contact, CRLF lines, text escaped per vCard 3.0', () => {
  const vcf = contactsToVcard([TRICKY]);
  assert.ok(vcf.endsWith('END:VCARD\r\n'));
  assert.ok(!/[^\r]\n/.test(vcf), 'every line ends in CRLF');
  const lines = vcf.split('\r\n');
  assert.deepEqual(lines.slice(0, 2), ['BEGIN:VCARD', 'VERSION:3.0']);
  assert.ok(lines.includes('N:O\'Brien\\, Jr.;Zoë;;;'));
  assert.ok(lines.includes('ORG:Smith & Sons\\; Ltd.'));
  assert.ok(lines.includes('TEL;TYPE=VOICE:+1 (503) 555-0123'));
  assert.ok(lines.includes('EMAIL;TYPE=INTERNET:zo@work.example'));

  const [card] = parseVcards(vcf);
  assert.deepEqual(card.N[0], ['O\'Brien, Jr.', 'Zoë', '', '', '']);
  assert.deepEqual(card.FN, ['Zoë "Zo" O\'Brien, Jr.']);
  assert.deepEqual(card.ORG, ['Smith & Sons; Ltd.']);
  assert.deepEqual(card['TEL;TYPE=VOICE'], TRICKY.phones);
  assert.deepEqual(card['EMAIL;TYPE=INTERNET'], TRICKY.emails);
  assert.deepEqual(card.NOTE, ['Gate code: 4521\nAllergic to "peanuts", shellfish\nC:\\Users\\zoe <script>alert(1)</script> 🎂']);
});

test('vCard name falls back to first and last, then the organization', () => {
  const cards = parseVcards(contactsToVcard([
    contact({ first_name: 'Ada', last_name: 'Lovelace' }),
    contact({ last_name: 'Nakamura' }),
    contact({ organization: 'Alderbrook Vet', phones: ['+15035550199'] }),
    contact({ display_name: '👩‍👩‍👧 Family', phones: ['+15035550100'] }),
    contact({}),
  ]));
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map(c => c.FN[0]), ['Ada Lovelace', 'Nakamura', 'Alderbrook Vet', '👩‍👩‍👧 Family', '']);
  assert.equal(cards[0].ORG, undefined);
  assert.equal(cards[0].NOTE, undefined);
  assert.deepEqual(cards[2].ORG, ['Alderbrook Vet']);
  assert.equal(contactsToVcard([]), '\r\n');
});

test('notes text file: a header per note, separated by a rule', () => {
  const text = notesToText([
    { title: 'Groceries', body: 'eggs\nflour', created: '2024-03-10T09:59:59+00:00', modified: '2024-03-11T10:00:00+00:00' },
    { title: 'שלום 🎉', body: '', created: '', modified: '' },
  ]);
  const [first, second] = text.split('\n\n' + '-'.repeat(60) + '\n\n');
  assert.equal(first, `Title: Groceries\nCreated: 2024-03-10T09:59:59+00:00\nModified: 2024-03-11T10:00:00+00:00\n${'='.repeat(40)}\n\neggs\nflour`);
  assert.equal(second, `Title: שלום 🎉\nCreated: \nModified: \n${'='.repeat(40)}\n\n`);
  assert.equal(notesToText([]), '');
});

test('plural', () => {
  assert.equal(plural(1, 'contact'), '1 contact');
  assert.equal(plural(0, 'contact'), '0 contacts');
  assert.equal(plural(2, 'person', 'people'), '2 people');
  assert.equal(plural(1, 'person', 'people'), '1 person');
  assert.equal(plural(1_234_567, 'message'), `${(1_234_567).toLocaleString()} messages`);
});

test('plural groups digits in English', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(plural(1_234_567, 'message'), '1,234,567 messages');
});

test('saveTextFile writes only after a place is chosen', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFile: async opts => (opts.title === 'cancel' ? null : 'C:\\Users\\Jane\\Documents\\Contacts.csv'),
    writeFile: async () => {},
  });
  let built = 0;
  const content = async () => { built++; return 'csv'; };
  const filter = { name: 'CSV Spreadsheet', extensions: ['csv'] };

  assert.equal(await save.saveTextFile({ title: 'cancel', defaultName: 'Contacts.csv', filter, content }), null);
  assert.equal(built, 0, 'nothing is built when the dialog is cancelled');
  assert.deepEqual(calls.map(c => c[0]), ['saveFile']);

  const written = await save.saveTextFile({ title: 'Save contacts', defaultName: 'Contacts.csv', filter, content });
  assert.equal(written, 'C:\\Users\\Jane\\Documents\\Contacts.csv');
  assert.equal(built, 1);
  assert.deepEqual(calls[1], ['saveFile', { title: 'Save contacts', defaultPath: 'Contacts.csv', filters: [filter] }]);
  assert.deepEqual(calls[2], ['writeFile', 'C:\\Users\\Jane\\Documents\\Contacts.csv', 'csv']);

  await save.saveTextFile({ title: 'Save notes', defaultName: 'Notes.txt', filter, content: 'plain text' });
  assert.deepEqual(calls.at(-1), ['writeFile', 'C:\\Users\\Jane\\Documents\\Contacts.csv', 'plain text']);
});

test('saveTextFile passes the suggested name to the dialog unchanged', async t => {
  // Names are cleaned where they're built (or by the OS dialog), not here
  const { lib: save, calls } = loadWith(t, { saveFile: async () => null });
  for (const name of ['CON.csv', 'Mom: cell?.csv', 'trailing dot.', 'ملاحظات.txt']) {
    await save.saveTextFile({ title: 't', defaultName: name, filter: { name: 'x', extensions: ['csv'] }, content: '' });
    assert.equal(calls.at(-1)[1].defaultPath, name);
  }
});

const MOM = { chat_id: 42, display_name: 'Mom', chat_identifier: '+15035550123' };

test('saveConversation exports into the chosen folder and says what it saved', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (method, params) => ({ success: true, data: { file: `${params.output_dir}/Mom_42.${params.format}`, message_count: 1 } }),
  });
  const result = await save.saveConversation('00008030-001A', MOM, 'html');
  assert.deepEqual(result, { title: 'Saved your conversation with Mom', detail: '1 message', path: '/Users/jane/Desktop/Mom_42.html' });
  assert.deepEqual(calls[1], ['call', 'export_conversation', {
    udid: '00008030-001A', chat_id: 42, output_dir: '/Users/jane/Desktop', display_name: 'Mom', format: 'html',
  }]);
});

test('saveConversation names an unnamed conversation by its number', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async () => ({ success: true, data: { file: 'D:\\Exports\\15035550123_7.csv', message_count: 3 } }),
  });
  const result = await save.saveConversation('u', { chat_id: 7, display_name: '', chat_identifier: '+15035550123' }, 'csv');
  assert.equal(result.title, 'Saved your conversation with +15035550123');
  assert.equal(result.detail, '3 messages');
  assert.equal(result.path, 'D:\\Exports\\15035550123_7.csv');
});

test('saveConversation does nothing when the folder dialog is cancelled', async t => {
  const { lib: save, calls } = loadWith(t, { saveFolder: async () => null, call: async () => assert.fail('no export') });
  assert.equal(await save.saveConversation('u', MOM, 'txt'), null);
  assert.deepEqual(calls.map(c => c[0]), ['saveFolder']);
});

test('saveConversation reports an engine failure as an error', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    call: async () => ({ success: true, data: { error: 'sms.db not found' } }),
  });
  await assert.rejects(save.saveConversation('u', MOM, 'txt'), { message: 'sms.db not found' });
});

test('saveConversation as PDF goes through the PDF exporter without a format', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    exportPdf: async () => ({ success: true, data: { files: ['/tmp/out/Mom.pdf'], message_count: 12 } }),
    call: async () => assert.fail('PDF goes through exportPdf'),
  });
  const result = await save.saveConversation('u', MOM, 'pdf');
  assert.deepEqual(result, { title: 'Saved your conversation with Mom', detail: '12 messages', path: '/tmp/out/Mom.pdf' });
  assert.deepEqual(calls[1], ['exportPdf', 'export_conversation', { udid: 'u', chat_id: 42, output_dir: '/tmp/out', display_name: 'Mom' }]);
});

test('saveConversation falls back to the folder when the engine names no file', async t => {
  const { lib: save } = loadWith(t, { saveFolder: async () => '/tmp/out', call: async () => ({ success: true, data: {} }) });
  assert.deepEqual(await save.saveConversation('u', MOM, 'txt'), {
    title: 'Saved your conversation with Mom', detail: undefined, path: '/tmp/out',
  });
});

test('saveConversations: merged into one file, or one file each', async t => {
  const convos = [MOM, { chat_id: 7, display_name: '', chat_identifier: 'dad@example.com' }, { chat_id: 9, display_name: '🏡 Family', chat_identifier: 'chat123' }];
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({
      success: true,
      data: p.mode === 'merged'
        ? { files: ['/Users/jane/Desktop/merged.html'], message_count: 1532 }
        : { files: p.chat_ids.map(id => `/Users/jane/Desktop/${id}.html`), message_count: 2 },
    }),
  });
  const merged = await save.saveConversations('u', convos, 'html', 'merged');
  assert.deepEqual(calls[1], ['call', 'export_conversations', {
    udid: 'u', chat_ids: [42, 7, 9], conversation_names: { 42: 'Mom', 7: 'dad@example.com', 9: '🏡 Family' },
    output_dir: '/Users/jane/Desktop', mode: 'merged', format: 'html',
  }]);
  assert.deepEqual(merged, {
    title: `Saved ${(1532).toLocaleString()} messages`,
    detail: '3 conversations in 1 file',
    path: '/Users/jane/Desktop/merged.html',
  });
  const separate = await save.saveConversations('u', convos, 'html', 'separate');
  assert.deepEqual(separate, { title: 'Saved 2 messages', detail: '3 conversations in 3 files', path: '/Users/jane/Desktop' });
});

test('saveConversations reports an engine failure, and stops if cancelled', async t => {
  let folder = '/tmp/out';
  const { lib: save } = loadWith(t, {
    saveFolder: async () => folder,
    call: async () => ({ success: true, data: { error: 'Unsupported format: xml' } }),
  });
  await assert.rejects(save.saveConversations('u', [MOM], 'csv', 'merged'), { message: 'Unsupported format: xml' });
  folder = null;
  assert.equal(await save.saveConversations('u', [MOM], 'csv', 'merged'), null);
});
