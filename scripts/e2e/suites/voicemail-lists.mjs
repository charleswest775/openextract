// Voicemail in the shapes a reader must handle, on the test persona's iOS 26 backup (ios-backup-core's
// backupgen): the Voicemail, Spam and Deleted lists (OE-79 listed spam as voicemail; OE-85 missed a
// voicemail only in the per-line store A-<UUID> and showed old deleted ones as not deleted), a caller
// with no number (#310: it joined everyone's history), and a voicemail whose audio is only in the
// per-line store, which the Timeline couldn't play (its id isn't a number). Checked against the
// answer key: tabs and their counts, the home tile, Save all's folders, the Timeline's player and
// People.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, launch, num, sleep } from '../harness.mjs';

const LISTS = { voicemail: 'Voicemail', spam: 'Spam', deleted: 'Deleted' };

/** A saved CSV's rows (quoted fields may hold commas, quotes and new lines). */
function parseCsv(file) {
  const s = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export default {
  name: 'voicemail-lists',
  about: 'Voicemail, Spam and Deleted, a caller with no number and the per-line store, on the test persona',
  needs: ['testpersona'],
  async run({ target, backups, out, scratch }) {
    const b = backups.testpersona;
    const key = b.expected;
    const app = await launch(target);
    const shot = name => app.page.screenshot({ path: `${out}/voicemail-lists-${name}.png` }).catch(() => {});
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      const inList = folder => key.voicemails.filter(v => v.folder === folder);
      const listed = key.voicemails.filter(v => !v.is_deleted);
      const line = key.voicemails.find(v => String(v.id).startsWith('A-'));
      const unknown = key.voicemails.find(v => v.sender === null);
      if (!check('the answer key has spam, deleted, a per-line copy and a caller with no number',
        inList('spam').length > 0 && inList('deleted').length > 0 && !!line && !!unknown, key.voicemails.length)) return;

      // ── Home: the tile counts the Voicemail and Spam lists, not Deleted ──
      const tiles = await app.homeTiles();
      check(`the Voicemail tile counts ${listed.length}, leaving out deleted ones`, tiles.Voicemail === listed.length, tiles.Voicemail);

      // ── The screen: a tab per list, each with its count ──
      check('Voicemail opens', await app.open('Voicemail', /\d+ voicemails?/));
      const tabs = await app.waitFor(() => {
        const group = document.querySelector('[role=group][aria-label="Which voicemails"]');
        return group && Object.fromEntries([...group.querySelectorAll('button')]
          .map(b => b.textContent.trim().match(/^(\w+) ([\d,]+)$/)).filter(Boolean).map(m => [m[1], Number(m[2].replace(/,/g, ''))]));
      }, null, 15_000);
      const want = Object.fromEntries(Object.entries(LISTS).map(([folder, label]) => [label, inList(folder).length]));
      check('the Voicemail, Spam and Deleted tabs show with the answer key\'s counts', JSON.stringify(tabs) === JSON.stringify(want), { tabs, want });
      const header = async () => num((await app.text()).match(/([\d,]+) (?:spam |deleted )?voicemails?/)?.[1]);
      check(`the Voicemail list has ${inList('voicemail').length}`, (await header()) === inList('voicemail').length, await header());
      const rowNames = () => app.eval(() => [...document.querySelectorAll('button[aria-expanded]')]
        .map(b => b.querySelector('.text-base.font-medium')?.textContent.trim() ?? ''));
      check('the voicemail with no number reads "Unknown", not blank', (await rowNames()).some(n => /^Unknown/.test(n)), await rowNames());
      await shot('voicemail');
      for (const folder of ['spam', 'deleted']) {
        await app.page.click(`[role=group][aria-label="Which voicemails"] button:has-text("${LISTS[folder]}")`);
        await sleep(500);
        const n = await header();
        check(`the ${LISTS[folder]} tab lists the ${inList(folder).length} the iPhone put there`, n === inList(folder).length, n);
        await shot(folder);
      }
      await app.page.click('[role=group][aria-label="Which voicemails"] button:has-text("Voicemail")');
      await sleep(500);

      // ── Save all: every list, spam and deleted audio in their own folders ──
      const dir = path.join(scratch, 'voicemail-lists', 'save-all');
      const res = await app.exportTo(dir, 'Save all');
      const files = res.files ?? [];
      const csv = files.find(f => f.endsWith('voicemails.csv'));
      const rows = csv ? parseCsv(path.join(dir, csv)) : [];
      const audioIn = sub => files.filter(f => f.endsWith('.amr') && path.dirname(f).split(path.sep).join('/') === sub).length;
      const withAudio = folder => inList(folder).filter(v => v.audio_available).length;
      const got = { voicemail: audioIn('audio'), spam: audioIn('audio/Spam'), deleted: audioIn('audio/Deleted'), csv: rows.length - 1 };
      const wantFiles = { voicemail: withAudio('voicemail'), spam: withAudio('spam'), deleted: withAudio('deleted'), csv: key.voicemails.length };
      check('Save all writes every list: audio/, audio/Spam and audio/Deleted, and one row per voicemail',
        res.notice?.kind === 'status' && JSON.stringify(got) === JSON.stringify(wantFiles), { got, want: wantFiles, notice: res.notice?.text });
      const header0 = rows[0] ?? [];
      const unknownRow = rows.find(row => row[header0.indexOf('Phone Number')] === '' && row[header0.indexOf('Contact')]);
      check('the saved list names the caller with no number "Unknown"', unknownRow?.[header0.indexOf('Contact')] === 'Unknown', unknownRow);
      fs.rmSync(dir, { recursive: true, force: true });

      // ── Timeline: a voicemail whose audio is only in the per-line store plays ──
      check('Timeline opens', await app.open('Timeline', /[\d,]+ events/));
      const entry = `[data-entry-id="voicemail:${line.id}"]`;
      let found = false;
      for (let i = 0; i < 40 && !found; i++) {
        found = await app.eval(sel => !!document.querySelector(sel), entry);
        if (!found) {
          await app.eval(() => { const pane = document.querySelector('[data-scroll-root]'); if (pane) pane.scrollTop = pane.scrollHeight; });
          await sleep(300);
        }
      }
      if (check(`the Timeline shows the per-line store's voicemail (${line.id})`, found)) {
        await app.eval(sel => {
          const card = document.querySelector(sel);
          card?.scrollIntoView({ block: 'center' });
          // Its header row opens the player
          [...card.querySelectorAll('div')].find(d => d.style.cursor === 'pointer' && d.querySelector('svg'))?.click();
        }, entry);
        const state = await app.waitFor(sel => {
          const card = document.querySelector(sel);
          if (card?.querySelector('button[aria-label=Play]')) return 'plays';
          return /Audio not available|Failed to load audio|isn't in the backup/.test(card?.innerText ?? '') ? 'error' : null;
        }, entry, 20_000);
        check("the Timeline plays a voicemail by its per-line store's id", state === 'plays', state);
        await shot('timeline-player');
      }
      // The Timeline counts the Voicemail and Spam lists too
      const chip = await app.eval(() => [...document.querySelectorAll('button')]
        .map(b => b.textContent.trim().match(/^Voicemail([\d,]+)$/)).filter(Boolean).map(m => Number(m[1].replace(/,/g, '')))[0] ?? null);
      check(`the Timeline's Voicemail chip counts ${listed.length}`, chip === listed.length, chip);

      // ── People: the voicemail with no number makes no one of its own ──
      // (Joining someone the address book calls "Unknown" is checked in scripts/hooks.test.mjs and
      // people.test.mjs: the test persona has no such card.)
      check('People opens', await app.open('People', /Most in touch first/));
      const people = await app.eval(() => document.body.innerText);
      check('People makes no person of the voicemail with no number', !/^Unknown$/m.test(people));
    } finally {
      await app.close();
    }
  },
};
