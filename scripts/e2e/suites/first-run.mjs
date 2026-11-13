// A brand-new install: the welcome screen, Settings, Help, "Back up my iPhone" with no iPhone
// plugged in, and the mistakes people make when picking a backup folder.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, launch, sleep, timing } from '../harness.mjs';

export default {
  name: 'first-run',
  about: 'welcome screen, backup screen without an iPhone, wrong folders, settings, help',
  needs: ['maren-plain'],
  async run({ target, backups, scratch }) {
    const app = await launch(target);
    try {
      timing('launch to welcome screen', app.launchMs);
      const text = await app.text();
      check('welcome screen offers both ways in', /Back up my iPhone/.test(text) && /Open a backup folder/.test(text));
      check('says the data stays on this computer', /never leaves your computer/i.test(text));
      // The version arrives from the main process after the screen first paints, so wait for it
      // rather than reading the text once (on a slow runner it wasn't there yet).
      const version = await app.api('getVersion');
      const shown = typeof version.value === 'string' && !!(await app.waitForText(new RegExp(`v${version.value.replace(/\./g, '\\.')}`), 15_000));
      check('shows the app version', shown, { version, text: (await app.text()).slice(0, 80) });

      // "Back up my iPhone" with nothing plugged in explains what to do, and Back returns home.
      check('"Back up my iPhone" opens', await app.click('Back up my iPhone'));
      const backupScreen = await app.waitForText(/plug|connect|cable|no iPhone|looking for|Apple Devices|iTunes/, 60_000);
      check('backup screen explains how to connect an iPhone', !!backupScreen, (await app.text()).slice(0, 400));
      await app.click('Back');
      await app.waitForText(/Open a backup folder/, 15_000);

      // Picking a folder that isn't a backup says so, in words people can act on.
      const notBackup = path.join(scratch, 'not-a-backup');
      fs.mkdirSync(notBackup, { recursive: true });
      fs.writeFileSync(path.join(notBackup, 'readme.txt'), 'hello');
      const r = await app.openBackup(notBackup);
      check('a folder without a backup is refused with a clear message', !r.opened && /No iPhone backups found/.test(r.error ?? ''), r);
      await app.eval(() => [...document.querySelectorAll('[role=alert] button')].forEach(b => b.click()));
      const links = await app.opened();
      check('the message links to the fixes for common problems', links.some(([kind, url]) => kind === 'external' && url === 'https://www.openextract.app/fixes'), links);

      // Cancelling the folder picker does nothing.
      await app.cancelDialogs();
      await app.click('Open a backup folder');
      await sleep(800);
      check('cancelling the folder picker leaves the welcome screen as it was', /Open a backup folder/.test(await app.text()) && !(await app.eval(() => !!document.querySelector('[role=alert]'))));

      // Settings and Help live in the title bar of an opened backup.
      const opened = await app.openBackup(backups['maren-plain'].dir);
      check('a backup opens for the title bar checks', opened.opened, opened);
      // Settings: text size scales the whole window and is remembered.
      check('Settings opens', await app.click('Settings'));
      await app.waitFor(() => document.querySelector('[role=dialog][aria-label=Settings]'));
      const sizes = await app.eval(() => [...document.querySelectorAll('[role=radiogroup][aria-label="Text size"] [role=radio]')].map(r => r.textContent.trim()));
      check('three text sizes', sizes?.length === 3, sizes);
      for (const size of ['large', 'larger', 'default']) {
        const index = { default: 0, large: 1, larger: 2 }[size];
        await app.eval(i => document.querySelectorAll('[role=radiogroup][aria-label="Text size"] [role=radio]')[i].click(), index);
        await sleep(300);
        const stored = await app.api('textSize.get');
        const zoom = await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
        const want = { default: 1, large: 1.15, larger: 1.3 }[size];
        check(`text size "${size}" is stored and zooms to ${want}`, stored.value === size && Math.abs(zoom - want) < 0.01, { stored, zoom });
      }
      const updates = await app.api('updates.getState');
      check('update state has a version and no automatic check until asked', updates.value?.currentVersion && updates.value.autoCheck !== true, updates);
      await app.click('Close', { within: '[role=dialog]' });

      // Help: the feedback form shows what it would send, scrubbed, and never sends by itself.
      check('Help opens', await app.click('Help'));
      await sleep(500);
      const help = await app.eval(() => document.querySelector('[role=dialog]')?.innerText ?? '');
      check('Help shows a feedback form', /feedback|report|problem|idea/i.test(help), help.slice(0, 200));
      const diag = await app.api('feedback.getDiagnostics');
      check('diagnostics are available and name the OS', JSON.stringify(diag.value ?? {}).length > 20, diag);
      check('diagnostics never contain the home folder', !JSON.stringify(diag.value ?? {}).includes(process.env.HOME || process.env.USERPROFILE || '\0'));
      await app.page.keyboard.press('Escape');
      await app.click('Cancel', { within: '[role=dialog]' });
      await app.click('Close', { within: '[role=dialog]' });
      await sleep(300);

      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
