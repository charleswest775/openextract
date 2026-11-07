// A real public test backup (Josh Hickman's iOS 15.3.1 image, corpus item pub-hickman-15.3.1),
// fetched with `python -m corpus.fetch`. Its terms forbid screenshots and redistribution: only
// counts are recorded, and its exports go to the scratch folder, which is deleted.
import * as path from 'node:path';
import { check, launch, num, pdfStats, sleep, timing } from '../harness.mjs';

export default {
  name: 'hickman',
  about: 'a real iOS 15 backup from the public corpus (prerelease only)',
  needs: ['hickman'],
  optional: true,
  async run({ target, backups, scratch }) {
    const b = backups.hickman;
    const app = await launch(target);
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      timing('open hickman backup', r.ms);
      const tiles = await app.homeTiles();
      await app.open('Photos', /in this backup/);
      await sleep(2000);
      const t = await app.text();
      const header = num(t.match(/([\d,]+) photos? (?:and videos|or video) in this backup/i)?.[1]);
      const icloud = num(t.match(/([\d,]+) more are only in iCloud/)?.[1]) ?? 0;
      check('Photos tile = 146', tiles.Photos === 146, tiles.Photos);
      check('Photos header = 146', header === 146, header);
      check('85 more only in iCloud', icloud === 85, icloud);
      for (const mode of ['separate', 'merged']) {
        await app.open('Messages', /\d+ conversations/);
        await app.click('Select');
        await sleep(300);
        await app.click('Select all');
        await sleep(300);
        const selected = num(await app.eval(() => document.body.innerText.match(/Save (\d+) conversations?/)?.[1]));
        const dir = path.join(scratch, mode);
        const res = await app.exportTo(dir, () => app.eval(() => {
          const el = [...document.querySelectorAll('button')].find(b => /^Save \d+ conversation/.test(b.textContent.trim()));
          el?.click();
          return !!el;
        }), 'pdf', { mode });
        const stats = res.files.map(f => pdfStats(path.join(dir, f)));
        timing(`hickman export all conversations pdf ${mode}`, res.ms ?? 0);
        check(`all ${selected} conversations as PDF, ${mode}`, res.notice?.kind === 'status' && res.files.length === (mode === 'merged' ? 1 : selected) && stats.every(s => s.header && s.pages > 0),
          { notice: res.notice?.text.split('\n')[0], files: res.files.length });
        await app.click('Done');
      }
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
