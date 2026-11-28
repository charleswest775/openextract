// Opening backups: plain and encrypted (wrong password first), a folder holding several
// backups, closing a backup, what a second launch remembers, and what a third leaves out.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, launch, sleep, timing } from '../harness.mjs';

export default {
  name: 'open',
  about: 'plain and encrypted backups, wrong password, several backups in one folder, recents, deleted ones',
  needs: ['maren-plain', 'maren-encrypted', 'einstein'],
  async run({ target, backups, scratch }) {
    const plain = backups['maren-plain'];
    const enc = backups['maren-encrypted'];
    const deletedDir = path.join(scratch, 'deleted-backups', 'udid-deleted');
    const awayDir = path.join(scratch, 'Unplugged Drive', 'Backups', 'udid-away');
    const trashDir = path.join(scratch, 'trash-test', path.basename(backups.einstein.dir));
    const remembered = (id, name, backupDir) => ({ id, type: 'device', name, subtitle: '', exportCount: 0, lastOpened: new Date().toISOString(), backupDir });
    const app = await launch(target);
    let profile = app.profile;
    try {
      const r = await app.openBackup(plain.dir);
      check('plain backup opens', r.opened, r);
      timing('open plain backup', r.ms);
      // The line under the device name ("Backed up … · iOS …") arrives after the page does.
      await app.waitFor(v => document.body.innerText.includes(v), `iOS ${plain.expected.ios}`, 30_000);
      const header = await app.text();
      check('home names the device and iOS version', header.includes("Maren's iPhone") && header.includes(`iOS ${plain.expected.ios}`), header.slice(0, 300));

      // Close it: back to the list of backups, which now remembers this one.
      check('"All backups" closes the backup', await app.closeBackup());
      const list = await app.waitForText(/Maren's iPhone/, 15_000);
      check('closed backup is listed under recent backups', !!list && !(await app.eval(() => !!document.querySelector('.titlebar input[type=search]'))));

      // Encrypted: a wrong password is refused clearly and can be retried.
      const wrong = await app.openBackup(enc.dir, 'not-the-password');
      check('wrong password is refused with a message', !wrong.opened && wrong.password && !!wrong.passwordError, wrong);
      await app.page.fill('input[type=password]', enc.password);
      const t0 = performance.now();
      await app.click('Unlock');
      const opened = await app.waitFor(() => !!document.querySelector('.titlebar input[type=search]'), null, 120_000);
      check('right password opens the encrypted backup', !!opened);
      timing('unlock encrypted backup', performance.now() - t0);
      const tiles = await app.homeTiles();
      check('encrypted backup shows its calls (only encrypted backups have them)', tiles.Calls > 0, tiles);
      await app.closeBackup();

      // A backup in a folder whose name isn't plain ASCII, like a home folder with an accent.
      const unicodeDir = path.join(scratch, 'Bäckups – José ✓', path.basename(plain.dir));
      fs.cpSync(plain.dir, unicodeDir, { recursive: true });
      const u = await app.openBackup(unicodeDir);
      check('a backup in a folder named with accents and symbols opens', u.opened, u);
      if (u.opened) await app.closeBackup();
      else await app.eval(() => [...document.querySelectorAll('[role=alert] button')].forEach(b => b.click()));

      // A folder above the backup's own, up to 4 folders up (a drive with Apple Computer/MobileSync/
      // Backup/<udid> on it), finds and opens it, and so does one of the backup's own folders. One
      // folder further up isn't searched, and the message says how far it looked (#331).
      const einstein = backups.einstein;
      const drive = path.join(scratch, 'drive');
      const deep = path.join(drive, 'Apple Computer', 'MobileSync', 'Backup', path.basename(einstein.dir));
      fs.cpSync(einstein.dir, deep, { recursive: true });
      const ownFolder = fs.readdirSync(deep).find(n => /^[0-9a-f]{2}$/i.test(n));
      const dismiss = () => app.eval(() => [...document.querySelectorAll('[role=alert] button')].forEach(b => b.click()));
      for (const [what, chosen] of [
        ['4 folders above it (a drive)', drive],
        ['2 folders above it (MobileSync)', path.join(drive, 'Apple Computer', 'MobileSync')],
        ['one of its own folders', path.join(deep, ownFolder)],
      ]) {
        const r = await app.openBackup(chosen);
        const opened = r.opened && !!(await app.waitFor(() => /Albert|Einstein/.test(document.body.innerText), null, 30_000));
        check(`a backup is found and opened from ${what}`, opened, r);
        if (r.opened) await app.closeBackup();
        else await dismiss();
      }
      const tooFar = path.join(scratch, 'too-far');
      fs.cpSync(einstein.dir, path.join(tooFar, 'X', 'Apple Computer', 'MobileSync', 'Backup', path.basename(einstein.dir)), { recursive: true });
      const far = await app.openBackup(tooFar);
      check('a backup 5 folders down is not found, and the message says how far it looked',
        !far.opened && /No iPhone backups found/.test(far.error ?? '') && /4 folders deep/.test(far.error ?? ''), far);
      if (far.opened) await app.closeBackup();
      else await dismiss();

      // A folder holding several backups asks which one to open.
      const parent = path.join(scratch, 'two-backups');
      fs.mkdirSync(parent, { recursive: true });
      for (const b of [plain, backups.einstein]) {
        fs.cpSync(b.dir, path.join(parent, path.basename(b.dir)), { recursive: true });
      }
      await app.stubDialogs(parent);
      await app.click('Open a backup folder') || await app.click('Open another backup') || await app.click('Open a backup');
      const chooserText = await app.waitFor(() => {
        const box = [...document.querySelectorAll('div')].find(d => d.firstElementChild?.textContent === 'Choose a backup');
        return box && /Albert|Einstein/.test(box.innerText) && /Maren/.test(box.innerText) ? box.innerText : null;
      }, null, 30_000);
      check('a folder with two backups asks which to open', !!chooserText, (await app.text()).slice(-400));
      check('the backup chooser is announced as a dialog', await app.eval(() => !!document.querySelector('[role=dialog]') && /Choose a backup/.test(document.querySelector('[role=dialog]').innerText)));
      if (chooserText) {
        await app.eval(() => {
          const el = [...document.querySelectorAll('button')].find(b => /Albert|Einstein/.test(b.textContent));
          el?.click();
          return !!el;
        });
        const einsteinOpen = await app.waitFor(() => document.querySelector('.titlebar input[type=search]') && /Albert|Einstein/.test(document.body.innerText), null, 60_000);
        check('the chosen backup opens', !!einsteinOpen);
        await app.closeBackup();
      }
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }

    // A second launch with the same profile lists the recent backups and reopens one in a click.
    const again = await launch(target, { profile });
    try {
      timing('second launch to backups list', again.launchMs);
      const text = await again.text();
      check('second launch lists recent backups', /Maren's iPhone/.test(text), text.slice(0, 300));
      const t0 = performance.now();
      const clicked = await again.eval(() => {
        const el = [...document.querySelectorAll('button, [role=button], a')].find(b => /Maren's iPhone/.test(b.textContent) && !/Albert/.test(b.textContent));
        el?.click();
        return !!el;
      });
      const reopened = clicked && await again.waitFor(() => !!document.querySelector('.titlebar input[type=search]') || !!document.querySelector('input[type=password]'), null, 60_000);
      check('a recent backup reopens from the list', !!reopened);
      if (await again.eval(() => !!document.querySelector('input[type=password]'))) {
        await again.page.fill('input[type=password]', enc.password);
        await again.click('Unlock');
        await again.waitFor(() => !!document.querySelector('.titlebar input[type=search]'), null, 120_000);
      }
      timing('reopen recent backup', performance.now() - t0);
      const sessions = await again.api('getRecentSessions');
      check('recent backups are stored without passwords', Array.isArray(sessions.value) && !JSON.stringify(sessions.value).includes(enc.password === 'test' ? '"password":"test"' : enc.password), sessions.value?.length);

      // Two more remembered backups for the third launch: one deleted since, one on a drive that
      // isn't plugged in.
      fs.mkdirSync(path.dirname(deletedDir), { recursive: true });
      await again.api('addSession', remembered('e2e-deleted', 'Deleted iPhone', deletedDir));
      await again.api('addSession', remembered('e2e-away', 'Unplugged iPhone', awayDir));
      // And one to move to the Trash from its menu: a copy of Einstein's backup in a folder of its own.
      fs.cpSync(backups.einstein.dir, trashDir, { recursive: true });
      await again.api('addSession', remembered('e2e-trash', 'Trash Test iPhone', trashDir));
      check('no renderer errors (second launch)', again.seriousErrors().length === 0, again.seriousErrors().slice(0, 5));
    } finally {
      await again.close();
    }

    // A backup deleted since it was opened isn't listed (OE-214). One on a drive that isn't
    // plugged in is, and its "Can't find this backup" alert can take it off the list. On a Mac
    // the home folder is an empty one: a backup that isn't where it was is also looked for in
    // the usual backup folder, and where macOS blocks that folder the app asks for Full Disk
    // Access instead.
    const home = path.join(scratch, 'home');
    fs.mkdirSync(home, { recursive: true });
    const third = await launch(target, { profile, env: process.platform === 'darwin' ? { HOME: home } : {} });
    try {
      await third.waitForText(/Unplugged iPhone/, 15_000);
      const listed = await third.text();
      check('a deleted backup is left out of the recent backups; one on a drive that is away stays',
        /Unplugged iPhone/.test(listed) && !/Deleted iPhone/.test(listed) && /Maren's iPhone/.test(listed), listed.slice(0, 400));
      await third.eval(() => [...document.querySelectorAll('button')].find(b => /Unplugged iPhone/.test(b.textContent))?.click());
      const missing = await third.waitFor(() => [...document.querySelectorAll('[role=alert]')].map(a => a.innerText).find(t => /Can't find/.test(t)), null, 30_000);
      check("the backup that's away says it can't be found and offers Find it and Remove from list",
        /Can't find this backup/.test(missing ?? '') && /Find it/.test(missing ?? '') && /Remove from list/.test(missing ?? ''), missing ?? (await third.text()).slice(0, 400));
      await third.click('Remove from list', { within: '[role=alert]' });
      const gone = await third.waitFor(() => !document.body.innerText.includes('Unplugged iPhone') && !document.querySelector('[role=alert]'), null, 15_000);
      const kept = ((await third.api('getRecentSessions')).value ?? []).map(s => s.id);
      check('Remove from list takes only that backup off the list, and the deleted one is still remembered',
        !!gone && !kept.includes('e2e-away') && kept.includes('e2e-deleted') && /Maren's iPhone/.test(await third.text()), kept);

      // Move to Trash from a backup's ⋯ menu. The question is answered yes here and the Trash is a
      // folder in scratch; the main process's own check, question and move run for real.
      const trashed = path.join(scratch, 'trashed');
      await third.app.evaluate(({ dialog, shell }, trashed) => {
        globalThis.__asked = [];
        dialog.showMessageBox = async (_win, options) => { globalThis.__asked.push(options); return { response: 1 }; };
        shell.trashItem = async p => { (process.getBuiltinModule?.('fs') ?? require('fs')).renameSync(p, trashed); };
      }, trashed);
      await third.eval(() => document.querySelector('button[aria-label="More for Trash Test iPhone"]')?.click());
      const menu = await third.waitFor(() => document.querySelector('[role=menu]')?.innerText, null, 5_000);
      if (process.platform === 'linux') {
        check('the menu offers Show in folder and Remove from list, and no Move to Trash on Linux',
          /Show in folder/.test(menu ?? '') && /Remove from list/.test(menu ?? '') && !/Move to/.test(menu ?? ''), menu);
      } else {
        const bin = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
        check(`a backup's menu offers Move to ${bin}…`, (menu ?? '').includes(`Move to ${bin}…`) && /Remove from list/.test(menu ?? ''), menu);
        await third.click(`Move to ${bin}…`, { within: '[role=menu]' });
        const outcome = await third.waitFor(() => {
          const t = document.body.innerText;
          return /Moved to the/.test(t) ? 'moved' : [...document.querySelectorAll('[role=alert]')].map(a => a.innerText).find(Boolean);
        }, null, 120_000);
        const asked = await third.app.evaluate(() => globalThis.__asked);
        if (outcome === 'moved') {
          const kept = ((await third.api('getRecentSessions')).value ?? []).map(s => s.id);
          check(`Move to ${bin} asks first, keeping is the default, and says it may be the only copy`,
            asked.length === 1 && asked[0].defaultId === 0 && asked[0].buttons[0] === 'Keep it' && /only copy/.test(asked[0].detail), asked);
          check('the backup is moved, its row goes, and it stays remembered in case it comes back',
            !fs.existsSync(trashDir) && fs.existsSync(path.join(trashed, 'Manifest.db')) && !(await third.text()).includes('Trash Test iPhone')
            && kept.includes('e2e-trash'), { kept, text: (await third.text()).slice(0, 300) });
        } else {
          // A Windows runner whose Recycle Bin can't take it: refused before anything is asked.
          check(`Move to ${bin} refused with a reason, asking nothing and moving nothing`,
            process.platform === 'win32' && /Recycle Bin/.test(outcome ?? '') && asked.length === 0 && fs.existsSync(trashDir), { outcome, asked });
        }
      }
      check('no renderer errors (third launch)', third.seriousErrors().length === 0, third.seriousErrors().slice(0, 5));
    } finally {
      await third.close();
    }
  },
};
