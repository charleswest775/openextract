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

test('notes text file: a header per note, separated by a rule, with local dates', () => {
  // Instants at these local clock times, as UTC the way the engine sends them: the
  // file shows the local time, so an evening edit isn't dated the next day.
  const engine = (...args) => new Date(...args).toISOString().replace('Z', '+00:00');
  const text = notesToText([
    { title: 'Groceries', body: 'eggs\nflour', created: engine(2024, 2, 10, 9, 59, 59), modified: engine(2024, 2, 11, 22, 30) },
    { title: 'שלום 🎉', body: '', created: '', modified: 'sometime' },
  ]);
  const [first, second] = text.split('\n\n' + '-'.repeat(60) + '\n\n');
  assert.equal(first, `Title: Groceries\nCreated: Mar 10, 2024, 9:59 AM\nModified: Mar 11, 2024, 10:30 PM\n${'='.repeat(40)}\n\neggs\nflour`);
  assert.equal(second, `Title: שלום 🎉\nCreated: Unknown date\nModified: sometime\n${'='.repeat(40)}\n\n`);
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

// A conversation too big for one PDF comes back split by year (electron/pdfExport.ts);
// the notice says how many PDFs, and why.
const SPLIT = {
  name: 'Mom', labels: ['2022', '2023', '2024–2026'], messages: 60335, images: 2005,
  estimate: { pages: 6321, megabytes: 712 },
};

test('saveConversation as PDF split by year: how many PDFs, and why', async t => {
  const files = ['/tmp/out/Mom, 2022.pdf', '/tmp/out/Mom, 2023.pdf', '/tmp/out/Mom, 2024–2026.pdf'];
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    exportPdf: async () => ({ success: true, data: { files, message_count: 60335, splits: [SPLIT] } }),
  });
  assert.deepEqual(await save.saveConversation('u', MOM, 'pdf'), {
    title: 'Saved your conversation with Mom',
    detail: `${(60335).toLocaleString()} messages in 3 PDFs`,
    path: '/tmp/out',
    note: 'One PDF of it all would be about 710 MB and 6,300 pages, so it\'s split by year: 2022, 2023 and 2024–2026. '
      + 'Smaller files are easier to open, share and print.',
  });
});

test('pdfSplitNote: one conversation, everything merged, several conversations, months, many parts', () => {
  const note = lib.pdfSplitNote;
  assert.equal(note(undefined, 'conversation'), undefined);
  assert.equal(note([], 'chat'), undefined);
  assert.equal(note([SPLIT], 'conversation'),
    'Your conversation with Mom would be one PDF of about 710 MB and 6,300 pages, so it\'s split by year: 2022, 2023 and 2024–2026. '
    + 'Smaller files are easier to open, share and print.');
  assert.match(note([{ ...SPLIT, name: null, estimate: { pages: 12345, megabytes: 1449 } }], 'chat'),
    /^One PDF of it all would be about 1\.4 GB and 12,000 pages, so it's split by year: /);
  assert.match(note([{ ...SPLIT, labels: ['2022', 'Jan–Jun 2023', 'Jul–Dec 2023'] }], 'chat'),
    /so it's split by date: 2022, Jan–Jun 2023 and Jul–Dec 2023\./);
  assert.match(note([{ ...SPLIT, labels: ['2015–2017', '2018', '2019', '2020', '2021', '2022', '2023'] }], 'conversation'),
    /so it's split by year into 7 PDFs, 2015–2017 to 2023\./);
  assert.match(note([{ ...SPLIT, estimate: { pages: 40, megabytes: 0 } }], 'conversation'), /about 1 MB and 40 pages/);
  assert.equal(note([SPLIT, { ...SPLIT, name: 'Dad', labels: ['2023', '2024'] }], 'chat'),
    '2 chats would each be too big as one PDF, so each is split by year: Mom (3 PDFs) and Dad (2 PDFs). '
    + 'Smaller files are easier to open, share and print.');
  const five = ['A', 'B', 'C', 'D', 'E'].map(name => ({ ...SPLIT, name }));
  assert.match(note(five, 'conversation'), /^5 conversations would each .*: A \(3 PDFs\), B \(3 PDFs\), C \(3 PDFs\) and 2 more\./);
});

test('saveConversations as PDF: the note names the conversations that were split', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    exportPdf: async () => ({ success: true, data: { files: ['/tmp/out/Dad.pdf', '/tmp/out/a.pdf', '/tmp/out/b.pdf', '/tmp/out/c.pdf'], message_count: 70000, splits: [SPLIT] } }),
  });
  const result = await save.saveConversations('u', [MOM, { chat_id: 7, display_name: 'Dad', chat_identifier: 'dad' }], 'pdf', 'separate');
  assert.equal(result.detail, '2 conversations in 4 files');
  assert.match(result.note, /^Your conversation with Mom would be one PDF of about 710 MB/);
});

test('saveWhatsAppChat as PDF split by year', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    exportPdf: async () => ({ success: true, data: { files: ['/tmp/out/a.pdf', '/tmp/out/b.pdf'], message_count: 9, splits: [{ ...SPLIT, labels: ['2023', '2024'] }] } }),
  });
  const result = await save.saveWhatsAppChat('u', RILEY, 'pdf');
  assert.equal(result.detail, '9 messages in 2 PDFs');
  assert.equal(result.path, '/tmp/out');
  assert.match(result.note, /^One PDF of it all would be about 710 MB and 6,300 pages, so it's split by year: 2023 and 2024\./);
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

// ── WhatsApp chats: the same flow through WhatsApp's own engine methods ──

const RILEY = { chat_id: 42, display_name: 'Riley Chen', handle: '+15035550101' };

test('saveWhatsAppChat exports through export_whatsapp_chat, never the Messages method', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (method, params) => ({ success: true, data: { file: `${params.output_dir}/Riley Chen.${params.format}`, message_count: 7 } }),
  });
  const result = await save.saveWhatsAppChat('00008030-001A', RILEY, 'html');
  assert.deepEqual(result, { title: 'Saved your WhatsApp chat with Riley Chen', detail: '7 messages', path: '/Users/jane/Desktop/Riley Chen.html' });
  assert.deepEqual(calls[1], ['call', 'export_whatsapp_chat', {
    udid: '00008030-001A', chat_id: 42, output_dir: '/Users/jane/Desktop', display_name: 'Riley Chen', format: 'html',
  }]);
  assert.ok(!calls.some(c => c[1] === 'export_conversation'), 'the same chat id in sms.db is somebody else');
});

test('saveWhatsAppChat names a chat by its number when it has no name, and never by its address', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async () => ({ success: true, data: { file: 'D:\\Exports\\whatsapp_chat_9.txt', message_count: 1 } }),
  });
  const numbered = await save.saveWhatsAppChat('u', { chat_id: 9, display_name: '', handle: '+15035550102' }, 'txt');
  assert.equal(numbered.title, 'Saved your WhatsApp chat with +15035550102');
  assert.equal(numbered.detail, '1 message');
  const nameless = await save.saveWhatsAppChat('u', { chat_id: 9, display_name: '', handle: '' }, 'txt');
  assert.equal(nameless.title, 'Saved your WhatsApp chat with WhatsApp chat');
});

test('saveWhatsAppChat as PDF goes through the PDF exporter with the WhatsApp method', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    exportPdf: async () => ({ success: true, data: { files: ['/tmp/out/Riley Chen.pdf'], message_count: 12 } }),
    call: async () => assert.fail('PDF goes through exportPdf'),
  });
  const result = await save.saveWhatsAppChat('u', RILEY, 'pdf');
  assert.deepEqual(result, { title: 'Saved your WhatsApp chat with Riley Chen', detail: '12 messages', path: '/tmp/out/Riley Chen.pdf' });
  assert.deepEqual(calls[1], ['exportPdf', 'export_whatsapp_chat', { udid: 'u', chat_id: 42, output_dir: '/tmp/out', display_name: 'Riley Chen' }]);
});

test('saveWhatsAppChat: cancelled does nothing, an engine failure is an error', async t => {
  let folder = null;
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => folder,
    call: async () => ({ success: true, data: { error: "WhatsApp's chats couldn't be read." } }),
  });
  assert.equal(await save.saveWhatsAppChat('u', RILEY, 'csv'), null);
  assert.deepEqual(calls.map(c => c[0]), ['saveFolder']);
  folder = '/tmp/out';
  await assert.rejects(save.saveWhatsAppChat('u', RILEY, 'csv'), { message: "WhatsApp's chats couldn't be read." });
});

test('saveWhatsAppChats: merged or one file each, through export_whatsapp_chats', async t => {
  const chats = [RILEY, { chat_id: 7, display_name: 'Hiking crew', handle: '' }, { chat_id: 9, display_name: '', handle: '+15035550102' }];
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({
      success: true,
      data: p.mode === 'merged'
        ? { files: ['/Users/jane/Desktop/WhatsApp chats.html'], message_count: 1532 }
        : { files: p.chat_ids.map(id => `/Users/jane/Desktop/${id}.html`), message_count: 2 },
    }),
  });
  const merged = await save.saveWhatsAppChats('u', chats, 'html', 'merged');
  assert.deepEqual(calls[1], ['call', 'export_whatsapp_chats', {
    udid: 'u', chat_ids: [42, 7, 9], conversation_names: { 42: 'Riley Chen', 7: 'Hiking crew', 9: '+15035550102' },
    output_dir: '/Users/jane/Desktop', mode: 'merged', format: 'html',
  }]);
  assert.deepEqual(merged, {
    title: `Saved ${(1532).toLocaleString()} WhatsApp messages`,
    detail: '3 chats in 1 file',
    path: '/Users/jane/Desktop/WhatsApp chats.html',
  });
  const separate = await save.saveWhatsAppChats('u', chats, 'html', 'separate');
  assert.deepEqual(separate, { title: 'Saved 2 WhatsApp messages', detail: '3 chats in 3 files', path: '/Users/jane/Desktop' });
});

test('saveWhatsAppChats as PDF, and its failures', async t => {
  let folder = '/tmp/out';
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => folder,
    exportPdf: async () => ({ success: false, error: 'PDF export is not available for export_whatsapp_chats' }),
    call: async () => ({ success: true, data: { error: 'Unsupported format: xml' } }),
  });
  await assert.rejects(save.saveWhatsAppChats('u', [RILEY], 'pdf', 'merged'), { message: 'PDF export is not available for export_whatsapp_chats' });
  assert.equal(calls[1][0], 'exportPdf');
  assert.equal(calls[1][1], 'export_whatsapp_chats');
  await assert.rejects(save.saveWhatsAppChats('u', [RILEY], 'csv', 'separate'), { message: 'Unsupported format: xml' });
  folder = null;
  assert.equal(await save.saveWhatsAppChats('u', [RILEY], 'csv', 'merged'), null);
});

// ── Podcasts: the engine writes the files (export_podcasts) ──

test('savePodcasts as OPML: the followed shows, into the chosen folder', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({
      success: true,
      data: { status: 'success', count: 6, path: `${p.output_dir}/Podcasts.opml`, files: [`${p.output_dir}/Podcasts.opml`] },
    }),
  });
  const result = await save.savePodcasts('00008030-001A', 'opml');
  assert.deepEqual(calls[1], ['call', 'export_podcasts', { udid: '00008030-001A', output_dir: '/Users/jane/Desktop', format: 'opml' }]);
  assert.deepEqual(result, {
    title: 'Saved 6 podcasts',
    detail: 'Subscription list for another podcast app',
    path: '/Users/jane/Desktop/Podcasts.opml',
  });
});

test('savePodcasts as CSV: shows and episodes, and "Show in folder" finds the shows file', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async () => ({
      success: true,
      data: {
        status: 'success', count: 1, path: 'D:\\Exports\\Podcasts (2).csv',
        files: ['D:\\Exports\\Podcasts (2).csv', 'D:\\Exports\\Podcast episodes (2).csv'],
      },
    }),
  });
  const result = await save.savePodcasts('u', 'csv');
  assert.deepEqual(calls[1], ['call', 'export_podcasts', { udid: 'u', output_dir: 'D:\\Exports', format: 'csv' }]);
  assert.deepEqual(result, {
    title: 'Saved 1 podcast',
    detail: 'Spreadsheets of the shows and their episodes',
    path: 'D:\\Exports\\Podcasts (2).csv',
  });
});

test('savePodcasts: cancelled does nothing', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => null,
    call: async () => assert.fail('nothing is exported without a folder'),
  });
  assert.equal(await save.savePodcasts('u', 'opml'), null);
  assert.equal(await save.savePodcasts('u', 'csv'), null);
  assert.deepEqual(calls.map(c => c[0]), ['saveFolder', 'saveFolder']);
});

test('savePodcasts: nothing to save, or a library that can\'t be read, is reported', async t => {
  let data = { error: 'There are no podcasts in this backup to save.', empty_reason: 'not_in_backup' };
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    call: async () => (data ? { success: true, data } : { success: false, error: 'The engine stopped.' }),
  });
  await assert.rejects(save.savePodcasts('u', 'csv'), { message: 'There are no podcasts in this backup to save.' });
  data = { error: 'None of the podcasts in this backup have a feed address to save.', empty_reason: 'no_records' };
  await assert.rejects(save.savePodcasts('u', 'opml'), { message: 'None of the podcasts in this backup have a feed address to save.' });
  data = { error: "The Podcasts library couldn't be read." };
  await assert.rejects(save.savePodcasts('u', 'opml'), { message: "The Podcasts library couldn't be read." });
  data = null;
  await assert.rejects(save.savePodcasts('u', 'opml'), { message: 'The engine stopped.' });
});

// ── Voice Memos: the engine copies the recordings (export_voice_memos) ──

test('saveVoiceMemos as recordings: a "Voice Memos" folder, and what wasn\'t in the backup is said', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({
      success: true,
      data: {
        status: 'success', count: 4, path: `${p.output_dir}/Voice Memos`, not_in_backup: 1, failed: 0,
        files: [`${p.output_dir}/Voice Memos/2026-05-13 14.15 Site walk.m4a`, `${p.output_dir}/Voice Memos/Voice Memos.csv`],
      },
    }),
  });
  const result = await save.saveVoiceMemos('00008030-001A', 'recordings');
  assert.deepEqual(calls[1], ['call', 'export_voice_memos', { udid: '00008030-001A', output_dir: '/Users/jane/Desktop', format: 'recordings' }]);
  assert.deepEqual(result, {
    title: 'Saved 4 voice memos',
    detail: "Audio files, as recorded. 1 recording wasn't in the backup",
    path: '/Users/jane/Desktop/Voice Memos',
  });
});

test('saveVoiceMemos for one recording: just its file, named in the notice; as CSV: the spreadsheet', async t => {
  let answer;
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async () => ({ success: true, data: answer }),
  });
  answer = { status: 'success', count: 1, path: 'D:\\Exports\\2026-05-13 14.15 Site walk.m4a', files: ['D:\\Exports\\2026-05-13 14.15 Site walk.m4a'], not_in_backup: 0, failed: 0 };
  let result = await save.saveVoiceMemos('u', 'recordings', { memoIds: [11], name: 'Site walk' });
  assert.deepEqual(calls[1], ['call', 'export_voice_memos', { udid: 'u', output_dir: 'D:\\Exports', format: 'recordings', memo_ids: [11] }]);
  assert.deepEqual(result, { title: 'Saved "Site walk"', detail: 'Audio files, as recorded', path: 'D:\\Exports\\2026-05-13 14.15 Site walk.m4a' });
  answer = { status: 'success', count: 5, path: 'D:\\Exports\\Voice Memos (2).csv', files: ['D:\\Exports\\Voice Memos (2).csv'] };
  result = await save.saveVoiceMemos('u', 'csv');
  assert.deepEqual(calls[3], ['call', 'export_voice_memos', { udid: 'u', output_dir: 'D:\\Exports', format: 'csv' }]);
  assert.deepEqual(result, { title: 'Saved 5 voice memos', detail: 'A spreadsheet of the recordings', path: 'D:\\Exports\\Voice Memos (2).csv' });
});

test('saveVoiceMemos: cancelled does nothing; nothing to save, or recordings that can\'t be read, is reported', async t => {
  let folder = null;
  let data = null;
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => folder,
    call: async () => (data ? { success: true, data } : { success: false, error: 'The engine stopped.' }),
  });
  assert.equal(await save.saveVoiceMemos('u', 'recordings'), null);
  assert.deepEqual(calls.map(c => c[0]), ['saveFolder']);
  folder = '/tmp/out';
  data = { error: 'There are no voice memos in this backup to save.', empty_reason: 'not_in_backup' };
  await assert.rejects(save.saveVoiceMemos('u', 'csv'), { message: 'There are no voice memos in this backup to save.' });
  data = { error: 'Voice Memos are in this backup but could not be read. The backup may be incomplete or damaged.' };
  await assert.rejects(save.saveVoiceMemos('u', 'recordings'), { message: /could not be read/ });
  data = { error: 'Unsupported format: mp3' };
  await assert.rejects(save.saveVoiceMemos('u', 'mp3'), { message: 'Unsupported format: mp3' });
  data = null;
  await assert.rejects(save.saveVoiceMemos('u', 'csv'), { message: 'The engine stopped.' });
});

// ── Calendar: the engine writes the files (export_calendar) ──

test('saveCalendar as ICS: every calendar, one file each in a folder', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({
      success: true,
      data: { status: 'success', count: 40, calendars: 3, path: `${p.output_dir}/Jane's iPhone Calendar`, files: ['Home.ics', 'Work.ics', 'US Holidays.ics'].map(f => `${p.output_dir}/Jane's iPhone Calendar/${f}`) },
    }),
  });
  const result = await save.saveCalendar('00008030-001A', 'ics');
  assert.deepEqual(calls[1], ['call', 'export_calendar', { udid: '00008030-001A', output_dir: '/Users/jane/Desktop', format: 'ics' }], 'no calendar_id: every calendar');
  assert.deepEqual(result, {
    title: 'Saved 40 events',
    detail: '3 calendar files, for Calendar, Outlook or Google',
    path: "/Users/jane/Desktop/Jane's iPhone Calendar",
  });
});

test('saveCalendar for one calendar, as ICS or CSV: calendar_id is sent and the one file is shown', async t => {
  let answer;
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async () => ({ success: true, data: answer }),
  });
  answer = { status: 'success', count: 2, path: 'D:\\Exports\\Work.ics', files: ['D:\\Exports\\Work.ics'] };
  let result = await save.saveCalendar('u', 'ics', { calendarId: 2 });
  assert.deepEqual(calls[1], ['call', 'export_calendar', { udid: 'u', output_dir: 'D:\\Exports', format: 'ics', calendar_id: 2 }]);
  assert.deepEqual(result, { title: 'Saved 2 events', detail: 'A calendar file, for Calendar, Outlook or Google', path: 'D:\\Exports\\Work.ics' });
  answer = { status: 'success', count: 1, path: 'D:\\Exports\\Personal.csv', files: ['D:\\Exports\\Personal.csv'] };
  result = await save.saveCalendar('u', 'csv', { calendarId: 0 });
  assert.deepEqual(calls[3], ['call', 'export_calendar', { udid: 'u', output_dir: 'D:\\Exports', format: 'csv', calendar_id: 0 }], 'a calendar id of 0 is still sent');
  assert.deepEqual(result, { title: 'Saved 1 event', detail: 'A spreadsheet of the events', path: 'D:\\Exports\\Personal.csv' });
});

test('saveCalendar: cancelled does nothing; nothing to save, an unknown calendar or an unreadable one is reported', async t => {
  let folder = null;
  let data = null;
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => folder,
    call: async () => (data ? { success: true, data } : { success: false, error: 'The engine stopped.' }),
  });
  assert.equal(await save.saveCalendar('u', 'ics'), null);
  assert.equal(await save.saveCalendar('u', 'csv', { calendarId: 2 }), null);
  assert.deepEqual(calls.map(c => c[0]), ['saveFolder', 'saveFolder']);
  folder = '/tmp/out';
  data = { error: 'There are no calendar events in this backup to save.', empty_reason: 'not_in_backup' };
  await assert.rejects(save.saveCalendar('u', 'ics'), { message: 'There are no calendar events in this backup to save.' });
  data = { error: "That calendar isn't in this backup." };
  await assert.rejects(save.saveCalendar('u', 'ics', { calendarId: 99 }), { message: "That calendar isn't in this backup." });
  data = null;
  await assert.rejects(save.saveCalendar('u', 'csv'), { message: 'The engine stopped.' });
});
