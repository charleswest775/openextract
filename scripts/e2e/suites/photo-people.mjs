// The Photos screen's People list on the test persona, whose few placeholder photos carry a People
// album (people, faces, a merged group, a hidden face, a dog) written by ios-backup-core's backupgen.
// Every person is listed with a face and their count; picking one or two filters the grid (any of
// them, or all together); Save saves just those photos; Clear and picking an album undo it.
import * as path from 'node:path';
import { check, launch, sleep } from '../harness.mjs';

const HEADER = /([\d,]+) photos? (?:and videos|or video) in this backup/;

export default {
  name: 'photo-people',
  about: "the Photos screen's People list, on a backup whose library has People",
  needs: ['testpersona'],
  async run({ target, backups, out, scratch }) {
    const b = backups.testpersona;
    const key = b.expected;
    const app = await launch(target);
    const shot = name => app.page.screenshot({ path: `${out}/photo-people-${name}.png` }).catch(() => {});
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      // People the list shows: not pets, not groups merged into someone else, with a photo All Photos shows.
      const people = (key.photo_people ?? []).filter(p => !p.pet && !p.merged_into && p.photos.length > 0);
      if (!check('the answer key has a People album', people.length >= 2, key.photo_people)) return;
      const label = p => `${p.name ?? 'Unnamed person'}, ${p.photos.length} ${p.photos.length === 1 ? 'photo' : 'photos'}`;
      const allShown = key.photos.filter(p => !p.trashed).length;

      check('Photos opens', await app.open('Photos', HEADER));
      const rows = await app.waitFor(() => {
        const found = [...document.querySelectorAll('nav button[aria-pressed]')].map(b => b.getAttribute('aria-label'));
        return found.length ? found : null;
      }, null, 15_000);
      check('every person is listed with their photo count, and no pet', rows?.length === people.length
        && people.every(p => rows.includes(label(p))), { rows, want: people.map(label) });
      const faces = await app.waitFor(() => {
        const imgs = [...document.querySelectorAll('nav button[aria-pressed] img')];
        return imgs.length && imgs.every(i => i.complete && i.naturalWidth > 0) ? imgs.length : 0;
      }, null, 15_000);
      check('every person has a face thumbnail', faces === people.length, faces);

      const header = async () => Number((await app.text()).match(HEADER)?.[1]?.replace(/,/g, ''));
      const tiles = () => app.waitFor(() => {
        const g = [...document.querySelectorAll('div.grid')].find(x => x.querySelector('.aspect-square'));
        const imgs = g ? [...g.querySelectorAll('.aspect-square img')] : [];
        return g && !g.querySelector('.animate-spin') && imgs.every(i => i.complete) ? g.children.length : null;
      }, null, 15_000);
      const pick = async p => { await app.page.click(`nav button[aria-label="${label(p)}"]`); await sleep(600); };
      const pressed = () => app.eval(() => [...document.querySelectorAll('nav button[aria-pressed="true"]')].length);

      // One person
      const [first, second] = people;
      await pick(first);
      check(`picking ${first.name ?? 'an unnamed person'} shows their ${first.photos.length} photos`,
        (await tiles()) === first.photos.length && (await header()) === first.photos.length, { tiles: await tiles(), header: await header() });
      const bar = await app.text();
      check('the bar above the grid names them, and Save is for their photos',
        /Photos of/.test(bar) && /Save their photos/.test(bar) && (await pressed()) === 1);

      // Two people: any of them, then all together
      await pick(second);
      const either = new Set([...first.photos, ...second.photos]).size;
      const both = first.photos.filter(id => second.photos.includes(id)).length;
      check(`two people: the ${either} photos with either of them`, (await tiles()) === either && /Photos with any of/.test(await app.text()),
        await tiles());
      await app.page.click('button[aria-pressed]:has-text("All together")');
      await sleep(600);
      check(`All together: the ${both} photos with both`, (await tiles()) === both && /Photos with all of/.test(await app.text()),
        await tiles());
      await shot('together');

      // Save saves just those photos
      const dir = path.join(scratch, 'photo-people', 'together');
      const res = await app.exportTo(dir, async () => {
        await app.page.click('button:has-text("Save their photos")');
        return true;
      });
      const saved = res.files.filter(f => /\.(jpe?g|heic|png)$/i.test(f));
      check(`Save their photos saves the ${both} photos with both`, res.notice?.kind === 'status'
        && /^Saved photos of 2 people together/.test(res.notice.text) && saved.length === both,
        { notice: res.notice?.text?.split('\n')[0], files: res.files });

      // Clear goes back to All Photos
      await app.page.click('[aria-label="People picked"] button:has-text("Clear")');
      await sleep(600);
      check('Clear goes back to All Photos', (await pressed()) === 0 && (await tiles()) === allShown
        && !(await app.eval(() => !!document.querySelector('[aria-label="People picked"]'))), await tiles());

      // Picking an album lets go of the people
      await pick(first);
      const album = key.photos.find(p => p.albums.length)?.albums[0];
      const inAlbum = key.photos.filter(p => !p.trashed && p.albums.includes(album)).length;
      await app.page.click(`nav button[title="${album}"]`);
      await sleep(600);
      check(`picking the album "${album}" lets go of the people`, (await pressed()) === 0 && (await tiles()) === inAlbum, await tiles());
      await shot('list');
    } finally {
      await app.close();
    }
  },
};
