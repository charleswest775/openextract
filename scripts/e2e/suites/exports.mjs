// Every way to save data out of a backup: each kind and format on "Save to this computer", and
// the Save buttons on each screen (conversation, bulk, notes, address book, people, timeline,
// calls, voicemail, photos, web history, recovered messages). Files are checked for count and
// format, not just existence.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, csvRows, launch, looksValid, pdfStats, sleep, timing } from '../harness.mjs';

// Every kind on "Save to this computer" (ExportPanel's KINDS) with every format it offers.
// scripts/e2e-coverage.test.mjs fails if ExportPanel gains a kind or format missing here.
export const PANEL_EXPORTS = {
  messages: ['html', 'pdf', 'csv', 'txt'],
  whatsapp: ['html', 'pdf', 'csv', 'txt'],
  photos: ['originals'],
  contacts: ['vcf', 'csv'],
  calls: ['csv'],
  voicemail: ['audio'],
  notes: ['txt'],
  browser_history: ['csv'],
};
const PANEL_LABELS = {
  messages: 'Messages', whatsapp: 'WhatsApp', photos: 'Photos & videos', contacts: 'Address book', calls: 'Call history',
  voicemail: 'Voicemail', notes: 'Notes', browser_history: 'Web history',
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
      let shareSeen = false;
      let exportCheckSeen = 0;
      const prompts = async () => {
        const t = await app.text();
        if (/star|tell a friend|share/i.test(t) && /OpenExtract/.test(t)) shareSeen = true;
        if (/Did that come out right/i.test(t)) exportCheckSeen++;
        await app.eval(() => [...document.querySelectorAll('button')].filter(b => /^(Not now|Close|Dismiss|No thanks|×)$/.test(b.textContent.trim()) && b.closest('.fixed')).forEach(b => b.click()));
      };

      // WhatsApp chats in this backup, as the engine lists them (maren has none)
      const waChats = (await app.api('call', 'list_whatsapp_chats', { udid: key.udid })).value?.data?.conversations?.length ?? 0;

      // ── Save to this computer: every kind × every format ──
      for (const [kind, formats] of Object.entries(PANEL_EXPORTS)) {
        // A kind the backup doesn't have isn't offered at all
        if (kind === 'whatsapp' && waChats === 0) {
          await app.open('Save to this computer', /Copy what's in this backup/);
          const offered = await app.eval(() => [...document.querySelectorAll('li')].some(li => li.innerText.trim().startsWith('WhatsApp')));
          check('Save panel: no WhatsApp on a backup without it', !offered);
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
          if (kind === 'whatsapp') { pass = files.filter(f => ext(f) === format && !f.includes('/')).length === waChats; detail = { want: waChats }; }
          if (kind === 'photos') { const media = files.filter(f => /\.(jpe?g|heic|png|mov|mp4|gif)$/i.test(f)); pass = media.length === key.photos.length; detail = { media: media.length, want: key.photos.length }; }
          if (kind === 'contacts' && format === 'vcf') { const cards = files.map(f => (fs.readFileSync(path.join(dir, f), 'utf-8').match(/BEGIN:VCARD/g) || []).length).reduce((a, n) => a + n, 0); pass = cards === key.contacts.length; detail = { cards }; }
          if (kind === 'contacts' && format === 'csv') { const rows = csvRows(path.join(dir, files.find(f => ext(f) === 'csv'))); pass = rows === key.contacts.length; detail = { rows }; }
          if (kind === 'calls') { const rows = csvRows(path.join(dir, files.find(f => ext(f) === 'csv'))); const shown = tiles.Calls; pass = rows === shown; detail = { rows, shown }; }
          if (kind === 'voicemail') { const audio = files.filter(f => /\.(amr|m4a|wav|mp3|caf)$/i.test(f)); pass = audio.length === key.voicemails.length; detail = { audio: audio.length }; }
          if (kind === 'notes') { const txt = fs.readFileSync(path.join(dir, files[0]), 'utf-8'); pass = key.notes.every(n => txt.includes(n.title)); detail = { kb: Math.round(txt.length / 1024) }; }
          if (kind === 'browser_history') { const rows = csvRows(path.join(dir, files.find(f => ext(f) === 'csv'))); pass = rows === key.browser_history.length; detail = { rows }; }
          if (format === 'pdf') { const stats = files.map(f => pdfStats(path.join(dir, f))); pass = pass && stats.every(s => s.header && s.pages > 0); }
          ok(`Save panel: ${kind} as ${format}`, res, { pass, detail });
          await prompts();
        }
      }
      check('the share prompt showed after the first export', shareSeen);
      check('"Did this export come out right?" showed at most once', exportCheckSeen <= 1, exportCheckSeen);

      // ── One conversation, every format, and saving twice keeps both files ──
      await app.open('Messages', /\d+ conversations/);
      await app.click('Karin Lindqvist');
      await sleep(1500);
      for (const format of ['html', 'pdf', 'csv', 'txt']) {
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
      const screens = [
        { name: 'Notes', ready: /\d+ notes?/, button: 'Save note', formats: ['pdf', 'txt'] },
        { name: 'Address book', ready: /\d+ cards?/, button: 'Save contacts', formats: ['vcf', 'csv'] },
        { name: 'Calls', ready: /\d+ calls?/, button: 'Save', formats: [null] },
        { name: 'Voicemail', ready: /\d+ voicemails?/, button: 'Save all', formats: [null] },
        { name: 'Web history', ready: /Most Visited Sites|Browsing Activity/, button: 'Save all', formats: [null] },
        { name: 'Timeline', ready: /[\d,]+ events/, button: 'Save', formats: ['html', 'csv', 'md'] },
      ];
      for (const s of screens) {
        for (const format of s.formats) {
          await app.open(s.name, s.ready);
          if (s.name === 'Notes') await app.click([...key.notes].sort((a, z) => z.modified.localeCompare(a.modified))[0].title);
          const dir = path.join(root, `screen-${s.name.replace(/\W+/g, '-').toLowerCase()}-${format ?? 'default'}`);
          const res = await run(dir, () => app.eval(label => {
            const el = [...document.querySelectorAll('button')].filter(b => !b.closest('.titlebar') && !b.disabled).find(b => b.textContent.trim() === label);
            el?.click();
            return !!el;
          }, s.button), format ?? undefined);
          timing(`export from ${s.name} ${format ?? ''}`.trim(), res.ms ?? 0);
          ok(`${s.name} screen: Save${format ? ` as ${format}` : ''}`, res);
          await prompts();
        }
      }

      // People: a person's whole history.
      for (const format of ['html', 'csv', 'md']) {
        await app.open('People', /Most in touch first/);
        await app.click('Theo Navarro');
        await app.waitForText(/Save everything/, 10_000);
        const dir = path.join(root, `people-${format}`);
        const res = await run(dir, 'Save everything', format);
        ok(`People: a person's history as ${format}`, res, { pass: res.files.length === 1 });
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
        for (const format of ['html', 'pdf', 'csv']) {
          const dir = path.join(root, `recovered-${format}`);
          const res = await run(dir, () => app.eval(() => {
            const el = [...document.querySelectorAll('button')].find(b => /^Save/.test(b.textContent.trim()) && !b.closest('.titlebar'));
            el?.click();
            return !!el;
          }), format);
          ok(`recovered messages as ${format}`, res);
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
