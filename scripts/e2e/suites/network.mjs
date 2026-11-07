// The app promises no network requests beyond the opt-in update check, and a fresh profile
// hasn't opted in. Chromium's spell checker fetches its dictionaries from the browser process
// on Windows and Linux, which page.on('request') never sees, so read Chromium's own net log.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { check, launch, sleep } from '../harness.mjs';

export default {
  name: 'network',
  about: 'nothing contacts another computer while a backup is browsed and searched',
  needs: ['maren-plain'],
  async run({ target, backups }) {
    const b = backups['maren-plain'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-netlog-'));
    const netLog = path.join(dir, 'net.json');
    const app = await launch(target, { extraArgs: [`--log-net-log=${netLog}`] });
    try {
      const r = await app.openBackup(b.dir);
      if (check('backup opens', r.opened, r)) {
        for (const screen of ['Messages', 'Photos', 'People', 'Timeline', 'Notes']) { await app.open(screen); await sleep(1500); }
        const box = app.page.locator('.titlebar input[type=search]');
        await box.first().click();
        await app.page.keyboard.type('hello wrold, is this spelled rihgt', { delay: 40 });
        await sleep(15_000);
      }
    } finally {
      await app.close();
    }
    // The log is complete only once the app has closed.
    const text = fs.existsSync(netLog) ? fs.readFileSync(netLog, 'utf8') : '';
    const contacted = [...new Set([...text.matchAll(/"(?:url|original_url)":"(?:https?|wss?):\/\/([^"/:]+)/g)].map(m => m[1]))]
      .filter(h => !['localhost', '127.0.0.1', '[::1]'].includes(h));
    check('net log was written', text.length > 0, { kb: Math.round(text.length / 1024) });
    check('no other computer contacted', contacted.length === 0, contacted);
    fs.rmSync(dir, { recursive: true, force: true });
  },
};
