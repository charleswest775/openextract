// Opening backups: plain and encrypted (wrong password first), a folder holding several
// backups, closing a backup, and what a second launch remembers.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, launch, sleep, timing } from '../harness.mjs';

export default {
  name: 'open',
  about: 'plain and encrypted backups, wrong password, several backups in one folder, recents',
  needs: ['maren-plain', 'maren-encrypted', 'einstein'],
  async run({ target, backups, scratch }) {
    const plain = backups['maren-plain'];
    const enc = backups['maren-encrypted'];
    const app = await launch(target);
    let profile = app.profile;
    try {
      const r = await app.openBackup(plain.dir);
      check('plain backup opens', r.opened, r);
      timing('open plain backup', r.ms);
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
      check('no renderer errors (second launch)', again.seriousErrors().length === 0, again.seriousErrors().slice(0, 5));
    } finally {
      await again.close();
    }
  },
};
