// The Podcasts screen on a backup that has an Apple Podcasts library: the fictional demo
// library from python/tests/podcasts_backup.py in a copy of einstein (scripts/e2e/backups.py).
// Shows, listening history, one show's episodes, and both ways to save (OPML and CSV).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check, csvRows, launch, looksValid, timing } from '../harness.mjs';

export default {
  name: 'podcasts',
  about: 'the Podcasts screen and its saves, on a fictional Podcasts library',
  needs: ['podcasts'],
  async run({ target, backups, scratch }) {
    const b = backups.podcasts;
    const udid = path.basename(b.dir);
    const app = await launch(target);
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      const list = (await app.api('call', 'list_podcasts', { udid })).value?.data;
      const shows = list?.podcasts ?? [];
      if (!check('the engine lists the podcasts', shows.length > 0 && !list?.error, list && { empty_reason: list.empty_reason, error: list.error })) return;
      const history = (await app.api('call', 'list_podcast_episodes', { udid, listened_only: true })).value?.data?.episodes ?? [];

      const tiles = await app.homeTiles();
      check('the Podcasts tile counts every show', tiles.Podcasts === shows.length, { tiles: tiles.Podcasts, want: shows.length });

      check('Podcasts opens', await app.open('Podcasts', /\d+ podcasts?/));
      const text = await app.text();
      check(`the header counts ${shows.length} podcasts`, new RegExp(`\\b${shows.length} podcasts\\b`).test(text));
      check(`the listening history has the engine's ${history.length} episodes`,
        new RegExp(`\\b${history.length} episodes? played on this iPhone`).test(text), text.match(/\d+ episodes? played on this iPhone/)?.[0]);
      check('episode audio is mentioned once, calmly', text.split("Episode audio isn't kept in iPhone backups").length === 2);
      check('not followed shows are grouped apart', /Not followed/i.test(text) === shows.some(p => !p.followed));

      const show = shows.find(p => p.followed && p.listened_count > 0);
      check('a followed show opens on what was listened to', await app.click(show.title)
        && !!(await app.waitForText(new RegExp(`${show.episode_count} episodes, ${show.listened_count} listened to`), 10_000)));
      check('All episodes lists every episode', await app.click('All episodes')
        && !!(await app.waitForText(/Episode page/, 10_000)));
      // Get audio hands the published audio to the browser (stubbed by the harness); the app fetches nothing
      await app.opened();
      await app.click('Get audio');
      const opened = await app.opened();
      check('Get audio opens the published audio in the browser', opened.length === 1 && /^https:\/\/cdn\.example\.com\/.+\.mp3$/.test(opened[0]?.[1] ?? ''), opened);
      check('no podcast artwork or feed is fetched', !(await app.eval(() => [...document.images].some(i => /^https?:/.test(i.src)))));

      // The screen's own Save, both formats
      const followedFeeds = shows.filter(p => p.followed && p.feed_url).length;
      for (const format of ['opml', 'csv']) {
        await app.open('Podcasts', /\d+ podcasts?/);
        const dir = path.join(scratch, 'podcasts', `screen-${format}`);
        const res = await app.exportTo(dir, 'Save', format);
        timing(`save podcasts ${format}`, res.ms ?? 0);
        const bad = res.files.filter(f => !looksValid(path.join(dir, f)));
        let pass, detail;
        if (format === 'opml') {
          const opml = res.files.filter(f => f.endsWith('.opml'));
          const outlines = opml.length === 1 ? (fs.readFileSync(path.join(dir, opml[0]), 'utf-8').match(/<outline\b[^>]*xmlUrl=/g) || []).length : -1;
          pass = outlines === followedFeeds; detail = { outlines, want: followedFeeds };
        } else {
          const showsCsv = res.files.find(f => f === 'Podcasts.csv');
          const episodesCsv = res.files.find(f => f === 'Podcast episodes.csv');
          const rows = showsCsv ? csvRows(path.join(dir, showsCsv)) : -1;
          const episodeRows = episodesCsv ? csvRows(path.join(dir, episodesCsv)) : -1;
          const episodes = shows.reduce((n, p) => n + p.episode_count, 0);
          pass = rows === shows.length && episodeRows === episodes; detail = { rows, episodeRows, want: [shows.length, episodes] };
        }
        check(`Podcasts screen: save as ${format}`, res.clicked && res.notice?.kind === 'status' && /^Saved/.test(res.notice.text)
          && bad.length === 0 && pass, { notice: res.notice?.text?.split('\n')[0], files: res.files, ...detail });
      }
    } finally {
      await app.close();
    }
  },
};
