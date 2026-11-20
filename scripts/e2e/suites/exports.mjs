// Every way to save data out of a backup: each kind and format on "Save to this computer", and
// the Save buttons on each screen (conversation, bulk, notes, address book, people, timeline,
// calls, voicemail, photos, web history, recovered messages). Files are checked for count and
// format, not just existence.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, csvRows, launch, looksValid, pdfStats, sleep, timing } from '../harness.mjs';

// Every kind on "Save to this computer" (ExportPanel's KINDS) with every format it offers, in
// the order its dialog lists them: the kind's own format first, then PDF, web page, spreadsheet,
// plain text (scripts/save-formats.test.mjs). scripts/e2e-coverage.test.mjs fails if ExportPanel
// gains a kind or format missing here.
export const PANEL_EXPORTS = {
  messages: ['pdf', 'html', 'csv', 'txt'],
  whatsapp: ['pdf', 'html', 'csv', 'txt'],
  photos: ['originals'],
  contacts: ['vcf', 'csv'],
  calls: ['pdf', 'html', 'csv', 'txt'],
  voicemail: ['audio'],
  podcasts: ['opml', 'csv'],
  notes: ['pdf', 'html', 'txt'],
  browser_history: ['pdf', 'html', 'csv', 'txt'],
};
// The four core formats, in that order: what a list of records saves as.
const RECORD = ['pdf', 'html', 'csv', 'txt'];
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
// Rows in a saved record page (python/record_document.py: a heading row, then one per record),
// and lines in its plain text (one per record, starting with its date in brackets).
const pageRows = file => (fs.readFileSync(file, 'utf-8').match(/<tr>/g) || []).length - 1;
const textRecords = file => fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.startsWith('[')).length;
const PANEL_LABELS = {
  messages: 'Messages', whatsapp: 'WhatsApp', photos: 'Photos & videos', contacts: 'Address book', calls: 'Call history',
  voicemail: 'Voicemail', podcasts: 'Podcasts', notes: 'Notes', browser_history: 'Web history',
};

export default {
  name: 'exports',
  about: 'every export kind and format, from the Save panel and from each screen',
  needs: ['maren-encrypted'],
  async run({ target, backups, out, scratch }) {
    const b = backups['maren-encrypted'];
    const key = b.expected;
    // Exports go to the scratch folder (photos alone are over 100 MB); the PDFs worth looking
    // at are copied to the output folder at the end.
    const root = path.join(scratch, 'exports');
    const app = await launch(target);
    const ok = (name, res, extra = {}) => {
      const bad = res.files.filter(f => !looksValid(path.join(res.dir, f)));
      return check(name, res.clicked && res.notice?.kind === 'status' && /^Saved/.test(res.notice.text) && res.files.length > 0 && bad.length === 0 && (extra.pass ?? true),
        { notice: res.notice?.text?.split('\n')[0], files: res.files.length, bad: bad.slice(0, 5), ms: Math.round(res.ms ?? 0), ...extra.detail });
    };
    const run = async (dir, button, format, opts) => ({ dir, ...(await app.exportTo(dir, button, format, opts)) });
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      const tiles = await app.homeTiles();
      let shareSeen = null;
      let thanksOpened = null;
      let exportCheckSeen = 0;
      const prompts = async () => {
        const t = await app.text();
        // The "Pay it forward" card: its buttons, in order. The first time, Say thanks opens the
        // thank-you note (and, like the ×, quiets the ask for the rest of the run); Escape closes it.
        const card = await app.eval(() => {
          const pay = [...document.querySelectorAll('.fixed button')].find(b => b.textContent.trim() === 'Pay $5');
          const box = pay?.closest('[role=status]');
          return box ? [...box.querySelectorAll('.hearth-ghost-btn, .hearth-primary-btn')].map(b => b.textContent.trim()) : null;
        });
        if (card && !shareSeen) {
          shareSeen = card;
          await app.eval(() => [...document.querySelectorAll('.fixed button')].find(b => b.textContent.trim() === 'Say thanks')?.click());
          thanksOpened = await app.waitFor(() => document.getElementById('feedback-title')?.textContent, null, 5_000);
          await app.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
        }
        if (/Did that come out right/i.test(t)) exportCheckSeen++;
        await app.eval(() => [...document.querySelectorAll('button')].filter(b => /^(Not now|Close|Dismiss|No thanks|×)$/.test(b.textContent.trim()) && b.closest('.fixed')).forEach(b => b.click()));
      };

      // WhatsApp chats in this backup: the answer key's when it has a "whatsapp" section, which the
      // engine must agree with; without one (an older backupgen), whatever the engine lists.
      const waKey = key.whatsapp ?? null;
      const engineChats = (await app.api('call', 'list_whatsapp_chats', { udid: key.udid })).value?.data?.conversations?.length ?? 0;
      const waChats = waKey ? waKey.chats.length : engineChats;
      if (waKey) check(`the engine lists the answer key's ${waChats} WhatsApp chats`, engineChats === waChats, engineChats);
      const waTotal = waKey ? waKey.chats.reduce((n, c) => n + c.message_count, 0) : null;
      // And its podcasts (maren has none: no Podcasts library)
      const podcasts = (await app.api('call', 'list_podcasts', { udid: key.udid })).value?.data?.podcasts ?? [];
      const followedFeeds = podcasts.filter(p => p.followed && p.feed_url).length;

      // ── Save to this computer: every kind × every format ──
      for (const [kind, formats] of Object.entries(PANEL_EXPORTS)) {
        // A kind the backup doesn't have isn't offered at all
        if (kind === 'whatsapp' && waChats === 0) {
          await app.open('Save to this computer', /Copy what's in this backup/);
          const offered = await app.eval(() => [...document.querySelectorAll('li')].some(li => li.innerText.trim().startsWith('WhatsApp')));
          check('Save panel: no WhatsApp on a backup without it', !offered);
          continue;
        }
        if (kind === 'podcasts' && podcasts.length === 0) {
          await app.open('Save to this computer', /Copy what's in this backup/);
          const offered = await app.eval(() => [...document.querySelectorAll('li')].some(li => li.innerText.trim().startsWith('Podcasts')));
          check('Save panel: no Podcasts on a backup without them', !offered);
          continue;
        }
        for (const format of formats) {
          await app.open('Save to this computer', /Copy what's in this backup/);
          const dir = path.join(root, `panel-${kind}-${format}`);
          const label = PANEL_LABELS[kind];
          const res = await run(dir, () => app.eval(label => {
            const row = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Save')
              .find(b => { let el = b; for (let i = 0; i < 6 && el; i++, el = el.parentElement) if (el.innerText?.startsWith(label)) return true; return false; });
            row?.click();
            return !!row;
          }, label), format, { mode: kind === 'messages' || kind === 'whatsapp' ? 'separate' : undefined });
          timing(`export ${kind} ${format}`, res.ms ?? 0);
          const files = res.files;
          const ext = f => path.extname(f).slice(1).toLowerCase();
          let pass = true, detail = {};
          if (kind === 'messages') { pass = files.filter(f => ext(f) === format).length === key.conversations.length; detail = { want: key.conversations.length }; }
          if (kind === 'whatsapp') {
            const pages = files.filter(f => ext(f) === format && !f.includes('/'));
            pass = pages.length === waChats; detail = { pages: pages.length, want: waChats };
            if (waKey && format === 'csv') {
              // One row per message, notices included
              const rows = pages.reduce((n, f) => n + csvRows(path.join(dir, f)), 0);
              pass = pass && rows === waTotal; detail.rows = rows; detail.wantRows = waTotal;
            }
            if (waKey && format === 'txt') {
              const text = pages.map(f => fs.readFileSync(path.join(dir, f), 'utf-8')).join('\n');
              const lost = waKey.messages.filter(m => m.kind === 'text' && !text.includes(m.text));
              pass = pass && lost.length === 0; detail.lost = lost.slice(0, 3).map(m => `${m.chat} #${m.sort}`);
            }
            if (waKey && format === 'html') {
              // The photos, voice messages, documents and map previews that are in the backup, copied beside the pages
              const copied = files.filter(f => f.includes('/')).length;
              const want = waKey.messages.filter(m => m.attachment?.available || m.location).length;
              pass = pass && copied >= want; detail.copied = copied; detail.wantMedia = want;
            }
          }
          if (kind === 'photos') { const media = files.filter(f => /\.(jpe?g|heic|png|mov|mp4|gif)$/i.test(f)); pass = media.length === key.photos.length; detail = { media: media.length, want: key.photos.length }; }
          if (kind === 'contacts' && format === 'vcf') { const cards = files.map(f => (fs.readFileSync(path.join(dir, f), 'utf-8').match(/BEGIN:VCARD/g) || []).length).reduce((a, n) => a + n, 0); pass = cards === key.contacts.length; detail = { cards }; }
          if (kind === 'contacts' && format === 'csv') { const rows = csvRows(path.join(dir, files.find(f => ext(f) === 'csv'))); pass = rows === key.contacts.length; detail = { rows }; }
          // Calls and web history: one file, a row (or line) per record, in every format
          const records = (format, file) => (format === 'csv' ? csvRows(file) : format === 'html' ? pageRows(file) : format === 'txt' ? textRecords(file) : null);
          if (kind === 'calls') {
            const one = files.filter(f => ext(f) === format);
            const rows = one.length === 1 ? records(format, path.join(dir, one[0])) : -1;
            const shown = tiles.Calls;
            pass = one.length === 1 && files.length === 1 && (rows === null || rows === shown); detail = { files, rows, shown };
          }
          if (kind === 'voicemail') { const audio = files.filter(f => /\.(amr|m4a|wav|mp3|caf)$/i.test(f)); pass = audio.length === key.voicemails.length; detail = { audio: audio.length }; }
          if (kind === 'podcasts' && format === 'opml') {
            const opml = files.filter(f => ext(f) === 'opml');
            const outlines = opml.length === 1 ? (fs.readFileSync(path.join(dir, opml[0]), 'utf-8').match(/<outline\b[^>]*xmlUrl=/g) || []).length : -1;
            pass = outlines === followedFeeds; detail = { outlines, want: followedFeeds };
          }
          if (kind === 'podcasts' && format === 'csv') {
            const shows = files.find(f => /^Podcasts( \(\d+\))?\.csv$/.test(f));
            const rows = shows ? csvRows(path.join(dir, shows)) : -1;
            pass = rows === podcasts.length && files.some(f => /^Podcast episodes( \(\d+\))?\.csv$/.test(f)); detail = { rows, want: podcasts.length, files };
          }
          if (kind === 'notes') {
            // Every note in one file, Notes.<format>
            const one = files.length === 1 && files[0] === `Notes.${format}`;
            const text = one && format !== 'pdf' ? fs.readFileSync(path.join(dir, files[0]), 'utf-8') : '';
            const missing = format === 'pdf' ? [] : key.notes.filter(n => !text.includes(format === 'html' ? escapeHtml(n.title) : n.title)).map(n => n.title);
            pass = one && missing.length === 0; detail = { files, missing: missing.slice(0, 3), kb: Math.round(text.length / 1024) };
          }
          if (kind === 'browser_history') {
            const one = files.filter(f => ext(f) === format);
            const rows = one.length === 1 ? records(format, path.join(dir, one[0])) : -1;
            pass = one.length === 1 && files.length === 1 && (rows === null || rows === key.browser_history.length); detail = { files, rows };
          }
          if (format === 'pdf') { const stats = files.map(f => pdfStats(path.join(dir, f))); pass = pass && stats.every(s => s.header && s.pages > 0); }
          ok(`Save panel: ${kind} as ${format}`, res, { pass, detail });
          await prompts();
        }
      }
      // ── Save to this computer: a data bundle (docs/BUNDLE.md) ──
      {
        await app.open('Save to this computer', /Copy what's in this backup/);
        const dir = path.join(root, 'panel-bundle');
        const res = await run(dir, () => app.eval(() => {
          const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export');
          el?.click();
          return !!el;
        }), 'bundle');
        timing('export a data bundle', res.ms ?? 0);
        // One new folder holding the bundle
        const folder = res.files.find(f => f.endsWith('/manifest.json'))?.slice(0, -'manifest.json'.length) ?? '';
        const inBundle = name => path.join(dir, folder, name);
        const lines = name => fs.existsSync(inBundle(name)) ? fs.readFileSync(inBundle(name), 'utf-8').split('\n').filter(Boolean) : [];
        const manifest = folder ? JSON.parse(fs.readFileSync(inBundle('manifest.json'), 'utf-8')) : null;
        // Every file is in SHA256SUMS with its right hash, and nothing else is
        const sums = lines('SHA256SUMS').map(l => [l.slice(66), l.slice(0, 64)]);
        const files = res.files.filter(f => f.startsWith(folder)).map(f => f.slice(folder.length)).filter(f => f !== 'SHA256SUMS');
        const wrong = sums.filter(([f, h]) => !fs.existsSync(inBundle(f))
          || crypto.createHash('sha256').update(fs.readFileSync(inBundle(f))).digest('hex') !== h).map(([f]) => f);
        const voicemails = lines('voicemail.jsonl').map(l => JSON.parse(l));
        const detail = {
          format: manifest?.format, version: manifest?.schema_version, messages: lines('messages.jsonl').length,
          voicemails: voicemails.length, sums: sums.length, files: files.length, wrong: wrong.slice(0, 5),
        };
        const pass = manifest?.format === 'openextract-bundle' && manifest?.time_zone_used === 'UTC'
          && detail.messages === key.messages.length && voicemails.length === key.voicemails.length
          && voicemails.every(v => v.phone_number && v.audio_sha256 && typeof v.is_spam === 'boolean')
          && sums.length === files.length && wrong.length === 0;
        ok('Save panel: data bundle', res, { pass, detail });
        await prompts();
      }

      check('the "Pay it forward" card showed after the first export, with Say thanks and Pay $5', shareSeen?.join() === 'Say thanks,Pay $5', shareSeen);
      check('Say thanks on that card opens the thank-you note', thanksOpened === 'Say thanks', thanksOpened);
      check('"Did this export come out right?" showed at most once', exportCheckSeen <= 1, exportCheckSeen);

      // ── One conversation, every format, and saving twice keeps both files ──
      await app.open('Messages', /\d+ conversations/);
      await app.click('Karin Lindqvist');
      await sleep(1500);
      {
        // PDF first, and preselected (the home page's "Save a conversation as a PDF" opens this)
        await app.click('Save conversation');
        const offered = await app.saveFormats();
        const picked = await app.eval(() => document.querySelector('[role=dialog] input[name=save-format]:checked')?.value);
        check('Save conversation offers PDF, web page, spreadsheet, plain text, PDF picked', offered?.join() === RECORD.join() && picked === 'pdf', { offered, picked });
        await app.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      }
      for (const format of RECORD) {
        const dir = path.join(root, `conversation-${format}`);
        const res = await run(dir, 'Save conversation', format);
        timing(`export one conversation ${format}`, res.ms ?? 0);
        let pass = res.files.length === 1, detail = {};
        if (format === 'html') {
          // The page, and its photos in the folder named after it (OE-15).
          const pages = res.files.filter(f => !f.includes('/'));
          const folder = pages[0]?.replace(/\.html$/, '_attachments/');
          const attached = res.files.filter(f => folder && f.startsWith(folder));
          const imgs = pages[0] ? (fs.readFileSync(path.join(dir, pages[0]), 'utf-8').match(/<img /g) || []).length : 0;
          pass = pages.length === 1 && attached.length === res.files.length - 1 && imgs === 7;
          detail = { attached: attached.length, imgs };
        }
        if (format === 'pdf' && res.files[0]) { const s = pdfStats(path.join(dir, res.files[0])); pass = pass && s.photos === 7; detail = s; }
        if (format === 'csv' && res.files[0]) { const rows = csvRows(path.join(dir, res.files[0])); const want = key.messages.filter(m => m.chat_identifier === '+14065550107' && !m.is_reaction).length; pass = pass && rows >= want * 0.9; detail = { rows, want }; }
        ok(`conversation as ${format}`, res, { pass, detail });
        if (format === 'pdf') {
          await app.stubDialogs(dir);
          await app.clearNotices();
          await app.trackNotices();
          await app.click('Save conversation');
          await app.saveAs('pdf');
          await app.waitNotice();
          await sleep(300);
          const again = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
          check('saving the same conversation again keeps the first file', again.length === 2 && again.some(f => f.includes(' (2).pdf')), again);
        }
        await prompts();
      }

      // ── Several conversations: one file each, and all in one ──
      for (const mode of ['separate', 'merged']) {
        await app.open('Messages', /\d+ conversations/);
        await app.click('Select');
        await sleep(300);
        for (const n of ['Karin Lindqvist', 'Theo Navarro', 'Switchbacks']) await app.click(n);
        await sleep(300);
        const dir = path.join(root, `bulk-${mode}`);
        const res = await run(dir, () => app.eval(() => {
          const el = [...document.querySelectorAll('button')].find(b => /^Save \d+ conversation/.test(b.textContent.trim()));
          el?.click();
          return !!el;
        }), 'pdf', { mode });
        timing(`export 3 conversations pdf ${mode}`, res.ms ?? 0);
        const stats = res.files.map(f => pdfStats(path.join(dir, f)));
        const photos = stats.reduce((a, s) => a + s.photos, 0);
        ok(`3 conversations as PDF, ${mode}`, res, { pass: res.files.length === (mode === 'merged' ? 1 : 3) && photos === 28, detail: { photos, pages: stats.reduce((a, s) => a + s.pages, 0) } });
        await app.click('Done');
        await prompts();
      }

      // ── Each screen's own Save button ──
      // formats: what its dialog offers, in order ([null]: it saves straight away, no dialog)
      const screens = [
        { name: 'Notes', ready: /\d+ notes?/, button: 'Save note', formats: ['pdf', 'html', 'txt'] },
        { name: 'Address book', ready: /\d+ cards?/, button: 'Save contacts', formats: ['vcf', 'csv'] },
        { name: 'Calls', ready: /\d+ calls?/, button: 'Save', formats: RECORD },
        { name: 'Voicemail', ready: /\d+ voicemails?/, button: 'Save all', formats: [null] },
        { name: 'Web history', ready: /Most Visited Sites|Browsing Activity/, button: 'Save all', formats: RECORD },
        { name: 'Timeline', ready: /[\d,]+ events/, button: 'Save', formats: RECORD },
        // Only on a backup with a Podcasts library
        ...(podcasts.length ? [{ name: 'Podcasts', ready: /\d+ podcasts?/, button: 'Save', formats: ['opml', 'csv'] }] : []),
      ];
      const clickSave = label => app.eval(label => {
        const el = [...document.querySelectorAll('button')].filter(b => !b.closest('.titlebar') && !b.disabled).find(b => b.textContent.trim() === label);
        el?.click();
        return !!el;
      }, label);
      for (const s of screens) {
        if (s.formats[0] !== null) {
          // The dialog lists exactly these, in this order
          await app.open(s.name, s.ready);
          if (s.name === 'Notes') await app.click([...key.notes].sort((a, z) => z.modified.localeCompare(a.modified))[0].title);
          await clickSave(s.button);
          const offered = await app.saveFormats();
          check(`${s.name} screen: Save offers ${s.formats.join(', ')}`, offered?.join() === s.formats.join(), offered);
          await app.eval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
        }
        for (const format of s.formats) {
          await app.open(s.name, s.ready);
          if (s.name === 'Notes') await app.click([...key.notes].sort((a, z) => z.modified.localeCompare(a.modified))[0].title);
          const dir = path.join(root, `screen-${s.name.replace(/\W+/g, '-').toLowerCase()}-${format ?? 'default'}`);
          const res = await run(dir, () => clickSave(s.button), format ?? undefined);
          timing(`export from ${s.name} ${format ?? ''}`.trim(), res.ms ?? 0);
          // One file in the format asked for (voicemail: audio and its list)
          const inFormat = format ? res.files.filter(f => path.extname(f).slice(1).toLowerCase() === format) : res.files;
          const pdfOk = format !== 'pdf' || inFormat.every(f => pdfStats(path.join(dir, f)).pages > 0);
          ok(`${s.name} screen: Save${format ? ` as ${format}` : ''}`, res, { pass: inFormat.length >= 1 && pdfOk, detail: { files: res.files.slice(0, 5) } });
          await prompts();
        }
      }

      // People: a person's whole history, in the four core formats (PDF first).
      for (const format of RECORD) {
        await app.open('People', /Most in touch first/);
        await app.click('Theo Navarro');
        await app.waitForText(/Save everything/, 10_000);
        const dir = path.join(root, `people-${format}`);
        const res = await run(dir, 'Save everything', format);
        const page = res.files.filter(f => f.endsWith(`.${format}`) && !f.includes('/'));
        ok(`People: a person's history as ${format}`, res, { pass: page.length === 1, detail: { files: res.files.slice(0, 5) } });
        await prompts();
      }

      // Photos: Save all copies the originals.
      await app.open('Photos', /in this backup/);
      {
        const dir = path.join(root, 'photos-save-all');
        const res = await run(dir, 'Save all', 'only', { timeoutMs: 600_000 });
        const media = res.files.filter(f => /\.(jpe?g|heic|png|mov|mp4|gif)$/i.test(f));
        ok('Photos: Save all', res, { pass: media.length === key.photos.length, detail: { media: media.length } });
      }

      // Recovered messages, when the scan finds any.
      await app.open('Recover deleted messages', /Look for deleted messages/);
      await app.click('Look for deleted messages');
      await app.waitForText(/Nothing to recover|Pick a conversation|recovered|found/, 120_000);
      if (!/Nothing to recover/.test(await app.text())) {
        for (const format of RECORD) {
          const dir = path.join(root, `recovered-${format}`);
          const res = await run(dir, () => app.eval(() => {
            const el = [...document.querySelectorAll('button')].find(b => /^Save/.test(b.textContent.trim()) && !b.closest('.titlebar'));
            el?.click();
            return !!el;
          }), format);
          const one = res.files.length === 1 && res.files[0] === `recovered_messages.${format}`;
          ok(`recovered messages as ${format}`, res, { pass: one, detail: { files: res.files } });
        }
      } else {
        check('recovered messages: nothing to recover in this backup, so nothing to save', true);
      }

      // A cancelled folder picker saves nothing and says nothing alarming.
      await app.open('Notes', /\d+ notes?/);
      await app.cancelDialogs();
      await app.clearNotices();
      await app.trackNotices();
      await app.click('Save note');
      await app.saveAs('txt');
      await sleep(1500);
      const notices = await app.eval(() => window.__seenNotices);
      check('cancelling the folder picker shows no error', !notices.some(n => n.kind === 'alert'), notices);

      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
      for (const keep of ['conversation-pdf', 'bulk-merged']) {
        if (fs.existsSync(path.join(root, keep))) fs.cpSync(path.join(root, keep), path.join(out, 'exports', keep), { recursive: true });
      }
    } finally {
      await app.close();
    }
  },
};
