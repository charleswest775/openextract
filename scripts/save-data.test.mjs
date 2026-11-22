// Tests for "Save to this computer" (src/lib/saveData.ts): the contacts CSV and
// vCard, the engine's export results, and the save flow for conversations, chats,
// notes, calls, web history, recovered messages, podcasts and the Timeline.
// Contacts are shaped like list_contacts returns them; export results like
// python/messages.py export_conversation(s), python/notes.py, calls.py and so on.
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
const { checkEngineResult, csvEscape, plural, contactsToCsv, contactsToVcard } = lib;
const BOM = '\uFEFF';

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
  // A byte-order mark first, so Excel reads it as UTF-8
  assert.ok(csv.startsWith(BOM));
  const rows = parseCsv(csv.slice(1));
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
  assert.equal(contactsToCsv([]), `${BOM}"First Name","Last Name","Display Name","Organization","Phone Numbers","Email Addresses","Notes"`);
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

// ── Notes, calls, web history, recovered messages: the engine writes every format ──

const ENGINE_FILE = (params, base, count) => ({
  success: true,
  data: { success: true, path: `${params.output_dir}/${base}.${params.format}`, file: `${params.output_dir}/${base}.${params.format}`, count },
});

test('saveNote: one note in the chosen format, the PDF through the PDF exporter', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (_m, p) => ({ success: true, data: { status: 'ok', exported: [`${p.output_dir}/Groceries.${p.format}`], files: [`${p.output_dir}/Groceries.${p.format}`], count: 1 } }),
    exportPdf: async () => ({ success: true, data: { files: ['/Users/jane/Desktop/Groceries.pdf'], message_count: 0, count: 1 } }),
  });
  const note = { note_id: 'x7', title: 'Groceries' };
  assert.deepEqual(await save.saveNote('u', note, 'html'), { title: 'Saved "Groceries"', path: '/Users/jane/Desktop/Groceries.html' });
  assert.deepEqual(calls[1], ['call', 'export_notes', { udid: 'u', note_ids: ['x7'], output_dir: '/Users/jane/Desktop', format: 'html' }]);
  assert.deepEqual(await save.saveNote('u', note, 'pdf'), { title: 'Saved "Groceries"', path: '/Users/jane/Desktop/Groceries.pdf' });
  assert.deepEqual(calls[3], ['exportPdf', 'export_notes', { udid: 'u', note_ids: ['x7'], output_dir: '/Users/jane/Desktop' }]);
  assert.equal((await save.saveNote('u', { note_id: 1, title: '' }, 'txt')).title, 'Saved "Untitled"');
});

test('saveAllNotes: every note in one file, merged by the engine', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => 'D:\\Exports',
    call: async (_m, p) => ({ success: true, data: { status: 'ok', exported: [`D:\\Exports\\Notes.${p.format}`], files: [`D:\\Exports\\Notes.${p.format}`], file: `D:\\Exports\\Notes.${p.format}`, count: 1234 } }),
    exportPdf: async () => ({ success: true, data: { files: ['D:\\Exports\\Notes.pdf'], message_count: 0, count: 2 } }),
  });
  const txt = await save.saveAllNotes('u', 'txt');
  assert.deepEqual(calls[1], ['call', 'export_notes', { udid: 'u', output_dir: 'D:\\Exports', mode: 'merged', format: 'txt' }]);
  assert.deepEqual(txt, { title: `Saved ${(1234).toLocaleString()} notes`, detail: 'In one file', path: 'D:\\Exports\\Notes.txt' });
  const pdf = await save.saveAllNotes('u', 'pdf');
  assert.deepEqual(calls[3], ['exportPdf', 'export_notes', { udid: 'u', output_dir: 'D:\\Exports', mode: 'merged' }]);
  assert.deepEqual(pdf, { title: 'Saved 2 notes', detail: 'In one file', path: 'D:\\Exports\\Notes.pdf' });
});

test('saving notes reports what the engine says went wrong', async t => {
  let data = { status: 'error', message: 'No matching notes found.' };
  const { lib: save } = loadWith(t, { saveFolder: async () => '/tmp/out', call: async () => ({ success: true, data }) });
  await assert.rejects(save.saveAllNotes('u', 'html'), { message: 'No matching notes found.' });
  data = { error: 'Unsupported format: docx' };
  await assert.rejects(save.saveNote('u', { note_id: 1, title: 'x' }, 'docx'), { message: 'Unsupported format: docx' });
});

test('saveCalls and saveBrowserHistory: every record, in any format, from the engine', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async (method, p) => ENGINE_FILE(p, method === 'export_calls' ? 'call_history' : 'browser_history_export', method === 'export_calls' ? 1 : 2500),
    exportPdf: async method => ({ success: true, data: { files: [`/Users/jane/Desktop/${method}.pdf`], message_count: 0, count: 7 } }),
  });
  assert.deepEqual(await save.saveCalls('u', 'csv'), { title: 'Saved 1 call', path: '/Users/jane/Desktop/call_history.csv' });
  assert.deepEqual(calls[1], ['call', 'export_calls', { udid: 'u', output_dir: '/Users/jane/Desktop', format: 'csv' }]);
  assert.deepEqual(await save.saveCalls('u', 'pdf'), { title: 'Saved 7 calls', path: '/Users/jane/Desktop/export_calls.pdf' });
  assert.deepEqual(calls[3], ['exportPdf', 'export_calls', { udid: 'u', output_dir: '/Users/jane/Desktop' }]);
  assert.deepEqual(await save.saveBrowserHistory('u', 'txt'), {
    title: `Saved ${(2500).toLocaleString()} page visits`, path: '/Users/jane/Desktop/browser_history_export.txt',
  });
  assert.deepEqual(calls[5], ['call', 'export_browser_history', { udid: 'u', output_dir: '/Users/jane/Desktop', format: 'txt' }]);
  assert.deepEqual(await save.saveBrowserHistory('u', 'pdf'), { title: 'Saved 7 page visits', path: '/Users/jane/Desktop/export_browser_history.pdf' });
});

test('saveCalls and saveBrowserHistory: nothing to save is an error, cancelling saves nothing', async t => {
  let folder = '/tmp/out';
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => folder,
    call: async method => ({ success: true, data: { success: false, error: method === 'export_calls' ? 'No calls found to export.' : 'No browser history found to export.' } }),
  });
  await assert.rejects(save.saveCalls('u', 'html'), { message: 'No calls found to export.' });
  await assert.rejects(save.saveBrowserHistory('u', 'csv'), { message: 'No browser history found to export.' });
  folder = null;
  const before = calls.length;
  assert.equal(await save.saveCalls('u', 'pdf'), null);
  assert.equal(await save.saveBrowserHistory('u', 'pdf'), null);
  assert.deepEqual(calls.slice(before).map(c => c[0]), ['saveFolder', 'saveFolder']);
});

test('saveRecoveredMessages: one file, its message count in the notice', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    call: async (_m, p) => ({ success: true, data: { file: `/tmp/out/recovered_messages.${p.format}`, message_count: 5, conversation_count: 2 } }),
    exportPdf: async () => ({ success: true, data: { files: ['/tmp/out/recovered_messages.pdf'], message_count: 1 } }),
  });
  assert.deepEqual(await save.saveRecoveredMessages('u', 'txt'), { title: 'Saved 5 recovered messages', path: '/tmp/out/recovered_messages.txt' });
  assert.deepEqual(calls[1], ['call', 'export_recovered_messages', { udid: 'u', output_dir: '/tmp/out', format: 'txt' }]);
  assert.deepEqual(await save.saveRecoveredMessages('u', 'pdf'), { title: 'Saved 1 recovered message', path: '/tmp/out/recovered_messages.pdf' });
  assert.deepEqual(calls[3], ['exportPdf', 'export_recovered_messages', { udid: 'u', output_dir: '/tmp/out' }]);
});

// ── The Timeline: built here, the PDF printed by the main process ──

const ENTRY = {
  id: 'message:1', type: 'message', timestamp: '2024-03-09T22:30:00+00:00', contactName: 'Mom', contactIdentifier: '+15035550123',
  message: { text: 'See you at 7', isFromMe: false, sender: '+15035550123', messageType: 'text', conversationName: 'Mom', service: 'iMessage' },
};

test('writeTimeline writes text formats into the folder, and prints the PDF from the web page', async t => {
  const { lib: save, calls } = loadWith(t, {
    // The main process picks a name that's free and says which
    writeNewFile: async (dir, base, ext) => `${dir}/${base} (2).${ext}`,
    exportHtmlPdf: async (_html, dir, base) => ({ success: true, data: { file: `${dir}/${base} (2).pdf` } }),
  });
  assert.equal(await save.writeTimeline([ENTRY], 'csv', '/tmp/out', 'timeline-export'), '/tmp/out/timeline-export (2).csv');
  assert.deepEqual(calls[0].slice(0, 4), ['writeNewFile', '/tmp/out', 'timeline-export', 'csv']);
  assert.ok(calls[0][4].startsWith(`${BOM}Date,Time,Type,Contact,Description\n`));

  assert.equal(await save.writeTimeline([ENTRY], 'txt', '/tmp/out', 'Mom', 'Everything with Mom'), '/tmp/out/Mom (2).txt');
  assert.ok(calls[1][4].startsWith('Everything with Mom\n1 event · Saved '));
  assert.equal(await save.writeTimeline([ENTRY], 'html', '/tmp/out', 'timeline-export'), '/tmp/out/timeline-export (2).html');
  assert.ok(calls[2][4].includes('<h1>Timeline</h1>'));

  // The PDF: the same page, printed; the main process picks a name that's free
  assert.equal(await save.writeTimeline([ENTRY], 'pdf', '/tmp/out', 'Mom', 'Everything with Mom'), '/tmp/out/Mom (2).pdf');
  const [method, html, dir, base] = calls[3];
  assert.deepEqual([method, dir, base], ['exportHtmlPdf', '/tmp/out', 'Mom']);
  assert.ok(html.startsWith('<!DOCTYPE html>') && html.includes('<h1>Everything with Mom</h1>') && html.includes('See you at 7'));
  assert.equal(calls.length, 4, 'the PDF writes no file of its own');
});

test('writeTimeline passes on a PDF that couldn\'t be printed', async t => {
  const { lib: save } = loadWith(t, { exportHtmlPdf: async () => ({ success: false, error: 'Choose a folder to save the PDF in.' }) });
  await assert.rejects(save.writeTimeline([ENTRY], 'pdf', '/gone', 'x'), { message: 'Choose a folder to save the PDF in.' });
});

test('writeTimeline: more events than one PDF holds are refused before the page is built; the other formats have no limit', async t => {
  assert.equal(lib.MAX_PDF_EVENTS, 25_000);
  const { lib: save, calls } = loadWith(t, {
    writeNewFile: async (dir, base, ext) => `${dir}/${base}.${ext}`,
    exportHtmlPdf: async (_html, dir, base) => ({ success: true, data: { file: `${dir}/${base}.pdf` } }),
  });
  const many = n => Array.from({ length: n }, (_, i) => ({ ...ENTRY, id: `message:${i}` }));
  const tooMany = many(lib.MAX_PDF_EVENTS + 1);
  await assert.rejects(save.writeTimeline(tooMany, 'pdf', '/tmp/out', 'timeline-export'), {
    message: `This is too much for one PDF: ${(25_001).toLocaleString()} events, and one PDF holds up to ${(25_000).toLocaleString()}. `
      + 'Narrow it down to a date range, a search or fewer kinds, or save it as a web page or spreadsheet, which have no limit.',
  });
  assert.equal(calls.length, 0, 'nothing was sent to be printed');

  // The other formats save them all (one is checked: formatting 25,000 events takes a moment)
  assert.equal(await save.writeTimeline(tooMany, 'csv', '/tmp/out', 'timeline-export'), '/tmp/out/timeline-export.csv');
  assert.deepEqual(calls.map(c => c[0]), ['writeNewFile']);

  // Right at the limit it prints
  assert.equal(await save.writeTimeline(many(lib.MAX_PDF_EVENTS), 'pdf', '/tmp/out', 'timeline-export'), '/tmp/out/timeline-export.pdf');
  assert.equal(calls.at(-1)[0], 'exportHtmlPdf');
});

// ── One person (People's Save everything, export_person) ─────────────────────
const msgEntry = (id, chatId, name) => ({ id: `message:${id}`, type: 'message', timestamp: '2026-11-17T10:00:00Z', contactName: name, contactIdentifier: '+15035550102', message: { text: 'hi', isFromMe: false, sender: '', messageType: 'text', conversationName: name, service: 'iMessage', chatId } });
const waEntry = (id, chatId, name) => ({ id: `whatsapp:${id}`, type: 'whatsapp', timestamp: '2026-11-17T10:00:00Z', contactName: name, contactIdentifier: '+15035550102', whatsapp: { text: 'hi', isFromMe: false, sender: '', messageType: 'text', eventText: null, attachmentLabel: null, conversationName: name, chatId, chatType: 'individual', isGroup: false, sort: 1 } });
const simple = (type, id) => ({ id: `${type}:${id}`, type, timestamp: '2026-11-17T10:00:00Z', contactName: 'Theo', contactIdentifier: '+15035550102' });

test("personExportSpec: whole chats per source, each once, and calls and voicemails by their own ids, as text", () => {
  const { personExportSpec } = lib;
  const spec = personExportSpec('Theo Navarro', [
    msgEntry(1, 17, 'Theo Navarro'), msgEntry(2, 17, 'Theo Navarro'), msgEntry(3, 21, 'theo@icloud.com'),
    // A WhatsApp chat whose id is the same number as a Messages chat: never mixed up
    waEntry(9, 17, 'Theo (WhatsApp)'), waEntry(10, 17, 'Theo (WhatsApp)'),
    simple('call', 12), simple('call', 'ft_3'), simple('call', 12),
    simple('voicemail', 7), simple('voicemail', 'A-0D1F2E3C-4B5A-6978-8796-A5B4C3D2E1F0.7'),
  ]);
  assert.deepEqual(spec, {
    display_name: 'Theo Navarro',
    chat_ids: [17, 21], conversation_names: { 17: 'Theo Navarro', 21: 'theo@icloud.com' },
    whatsapp_chat_ids: [17], whatsapp_names: { 17: 'Theo (WhatsApp)' },
    call_ids: ['12', 'ft_3'],
    voicemail_ids: ['7', 'A-0D1F2E3C-4B5A-6978-8796-A5B4C3D2E1F0.7'],
    note_ids: [],
  });
  assert.deepEqual(personExportSpec('Nobody', []), {
    display_name: 'Nobody', chat_ids: [], conversation_names: {}, whatsapp_chat_ids: [], whatsapp_names: {}, call_ids: [], voicemail_ids: [], note_ids: [],
  });
});

test('personExportSpec: the notes you share go in by id; picked-out messages only when asked', () => {
  const { personExportSpec } = lib;
  const entries = [msgEntry(1, 17, 'Theo'), msgEntry(4, 17, 'Theo'), waEntry(9, 17, 'Theo (WhatsApp)'), simple('note', 42), simple('note', 42), simple('call', 12)];
  // Save everything: whole chats, so no message ids
  const whole = personExportSpec('Theo', entries);
  assert.deepEqual(whole.note_ids, ['42']);
  assert.equal('message_ids' in whole, false);
  assert.equal('whatsapp_message_ids' in whole, false);
  // Dates, a search or Photos picked these out: only them, by each source's own ids
  const these = personExportSpec('Theo', entries, { onlyThese: true });
  assert.deepEqual(these.message_ids, [1, 4]);
  assert.deepEqual(these.whatsapp_message_ids, [9]);
  assert.deepEqual(these.chat_ids, [17]);
  assert.deepEqual(these.whatsapp_chat_ids, [17]);
  // Nothing of a source picked out is an empty list, not "every message"
  assert.deepEqual(personExportSpec('Theo', [simple('call', 12)], { onlyThese: true }).message_ids, []);
});

const PERSON = { display_name: 'Theo', chat_ids: [17], conversation_names: { 17: 'Theo' }, whatsapp_chat_ids: [], whatsapp_names: {}, call_ids: ['12'], voicemail_ids: [] };

test('savePerson: the engine saves the file and a folder of photos and files, and the notice says how many', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    call: async () => ({ success: true, data: {
      file: '/Users/jane/Desktop/Theo, Jul 5 2024 - Nov 17 2026.html', message_count: 3083,
      counts: { message: 3001, whatsapp: 0, call: 73, voicemail: 9 }, media: { copied: 214, not_in_backup: 0, failed: 0 }, errors: {},
    } }),
    exportPdf: async () => assert.fail('only a PDF is printed'),
  });
  const result = await save.savePerson('u', PERSON, 'html', 'Saved everything with Theo');
  assert.deepEqual(result, {
    title: 'Saved everything with Theo',
    detail: `${(3083).toLocaleString()} events and 214 photos and files`,
    path: '/Users/jane/Desktop/Theo, Jul 5 2024 - Nov 17 2026.html',
  });
  assert.deepEqual(calls[1], ['call', 'export_person', { udid: 'u', output_dir: '/Users/jane/Desktop', ...PERSON, format: 'html' }]);
});

test('savePerson as PDF: printed by Chromium, with the originals copied beside the PDF', async t => {
  const { lib: save, calls } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    exportPdf: async () => ({ success: true, data: {
      files: ['/Users/jane/Desktop/Theo.pdf'], message_count: 10, media_folder: '/Users/jane/Desktop/Theo_attachments',
      media: { copied: 3, not_in_backup: 1, failed: 0 }, errors: { whatsapp: "WhatsApp's chats couldn't be read" },
    } }),
    call: async () => assert.fail('PDF goes through exportPdf'),
  });
  const result = await save.savePerson('u', PERSON, 'pdf', 'Saved everything with Theo');
  assert.deepEqual(result, {
    title: 'Saved everything with Theo',
    detail: "10 events and 3 photos and files. 1 file wasn't in the backup. WhatsApp's chats couldn't be read",
    path: '/Users/jane/Desktop/Theo.pdf',
  });
  // The page is printed from a temporary folder; media_dir is where the originals go
  assert.deepEqual(calls[1], ['exportPdf', 'export_person', { udid: 'u', output_dir: '/Users/jane/Desktop', ...PERSON, media_dir: '/Users/jane/Desktop' }]);
});

test('savePerson as PDF: a PDF that can\'t be made says why (its copied files are taken away by the main process)', async t => {
  const tooMany = 'Too many photos for one PDF. Save it as a web page instead, which keeps every photo and video beside it.';
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/Users/jane/Desktop',
    exportPdf: async () => ({ success: false, error: tooMany }),
  });
  await assert.rejects(save.savePerson('u', PERSON, 'pdf', 'Saved everything with Theo'), { message: tooMany });
});

test('savePerson: nothing saved is an error, and cancelling the folder saves nothing', async t => {
  const { lib: save } = loadWith(t, {
    saveFolder: async () => '/tmp/out',
    call: async () => ({ success: true, data: { error: 'There was nothing to save with this person.', errors: {} } }),
  });
  await assert.rejects(save.savePerson('u', PERSON, 'csv', 'Saved'), /nothing to save/);
  const { lib: cancelled, calls } = loadWith(t, { saveFolder: async () => null, call: async () => assert.fail('no folder, no save') });
  assert.equal(await cancelled.savePerson('u', PERSON, 'txt', 'Saved'), null);
  assert.equal(calls.length, 1);
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
