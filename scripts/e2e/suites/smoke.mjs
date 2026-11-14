// A quick pass for installed builds (scripts/installers): the app starts from where the
// installer put it, finds its bundled engine, opens a backup, shows a screen and saves a file.
import * as path from 'node:path';
import { check, launch, sleep, timing } from '../harness.mjs';

export default {
  name: 'smoke',
  about: 'start, open a backup, read messages, save a PDF (for installed builds)',
  needs: ['maren-encrypted'],
  default: false,
  async run({ target, backups, scratch, out }) {
    const b = backups['maren-encrypted'];
    const app = await launch(target);
    try {
      // Their own budgets: this is often the app's very first launch after installing, which
      // the OS may check first (scripts/e2e/budgets.json).
      timing('installed app: launch to welcome screen', app.launchMs);
      // The engine starts with the app; the first answer is what opening a backup waits for.
      const t0 = performance.now();
      const ping = await app.api('call', 'ping', {});
      timing('installed app: first engine answer after launch', app.launchMs + performance.now() - t0);
      check('the bundled engine answers', ping.value?.success && ping.value.data?.status === 'ok', ping);
      const r = await app.openBackup(b.dir, b.password);
      if (!check('encrypted backup opens', r.opened, r)) return;
      timing('open encrypted backup', r.ms);
      const tiles = await app.homeTiles();
      check('home tiles match the answer key', tiles.Messages === b.expected.messages.length && tiles.Photos === b.expected.photos.length, tiles);
      await app.page.screenshot({ path: path.join(out, 'smoke-home.png') }).catch(() => {});
      check('Messages opens', await app.open('Messages', /\d+ conversations/));
      await app.click('Karin Lindqvist');
      await sleep(1500);
      const res = await app.exportTo(path.join(scratch, 'pdf'), 'Save conversation', 'pdf');
      check('a conversation saves as PDF', res.notice?.kind === 'status' && res.files.some(f => f.endsWith('.pdf')), { notice: res.notice, files: res.files });
      check('Photos opens and shows thumbnails', await app.open('Photos', /in this backup/) && !!(await app.waitFor(() => document.querySelectorAll('div.grid img').length > 10, null, 30_000)));
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
