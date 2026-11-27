// A backup with only Messages and Contacts in it (einstein): every other screen must show a
// clear empty state rather than a spinner that never stops, an error, or a blank page.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { check, launch, num, sleep, timing } from '../harness.mjs';

export default {
  name: 'empty',
  about: 'empty states on a backup with only messages and contacts',
  needs: ['einstein', 'einstein-encrypted'],
  async run({ target, backups, out }) {
    const b = backups.einstein;
    const key = b.expected;
    const app = await launch(target);
    try {
      const r = await app.openBackup(b.dir);
      if (!check('backup opens', r.opened, r)) return;
      timing('open sparse backup', r.ms);
      const tiles = await app.homeTiles();
      check('Messages and Address book tiles have the answer key\'s counts', tiles.Messages === key.messages.length && tiles['Address book'] === key.contacts.length, tiles);
      const home = await app.text();
      check('home says which kinds of data aren\'t in this backup', /Not in this backup/.test(home), home.slice(0, 400));
      await app.page.screenshot({ path: `${out}/empty-home.png` }).catch(() => {});

      // Each screen for a kind this backup lacks: open it the way people can (tile or link), and
      // check it settles on a message, not a spinner.
      const empty = [
        { name: 'Photos', want: /No photos|0 photos|Not in this backup|nothing/i },
        { name: 'Calls', want: /No calls|0 calls|Not in this backup|nothing/i },
        { name: 'Notes', want: /No notes|0 notes|Not in this backup|nothing/i },
        { name: 'Voicemail', want: /No voicemails|0 voicemails|Not in this backup|nothing/i },
        { name: 'Web history', want: /No Safari|No web history|Not in this backup|nothing/i },
      ];
      for (const s of empty) {
        const opened = await app.open(s.name);
        if (!opened) {
          // A kind with nothing in it may not be clickable at all; that's a fine empty state too.
          check(`${s.name}: no screen to open, and home says it isn't in this backup`, /Not in this backup/.test(await app.text()));
          continue;
        }
        const settled = await app.waitFor(src => {
          const t = document.body.innerText;
          return new RegExp(src, 'i').test(t) && !document.querySelector('.animate-spin');
        }, s.want.source, 30_000);
        check(`${s.name}: shows an empty state`, !!settled, (await app.text()).slice(0, 300));
        check(`${s.name}: no error`, !/Couldn't|Something went wrong|Error:/i.test(await app.text()));
      }

      // WhatsApp: most iPhones don't have it, so a backup without it has no WhatsApp tile and
      // doesn't list it as missing; the engine says so without an error. The answer key agrees
      // (a backupgen that writes WhatsApp lists it under "absent"). An iPhone that has the app but
      // whose chats aren't in the backup (the answer key's "apps": einstein's iOS 26 backup, made
      // the way OpenExtract makes them) has a tile with no number that says so, and so does its screen.
      check('the answer key has no WhatsApp chats for this backup', !key.whatsapp && [undefined, 'none'].includes(key.absent?.whatsapp), key.absent);
      const waInstalled = (key.apps ?? []).includes('net.whatsapp.WhatsApp');
      await app.home();
      if (waInstalled) {
        const t = await app.tiles();
        check('WhatsApp: a tile with no number that says its chats aren\'t in this backup',
          'WhatsApp' in t && t.WhatsApp === null && /Its chats aren't in this backup/.test(await app.text()), t);
        check('WhatsApp: its screen says the chats aren\'t in this backup',
          await app.open('WhatsApp', /WhatsApp's chats aren't in this backup/), (await app.text()).slice(0, 300));
        check('WhatsApp: no error', !/Couldn't|Something went wrong|Error:/i.test(await app.text()));
        await app.home();
      } else {
        const waShown = await app.eval(() => [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'WhatsApp'));
        check('WhatsApp: no tile, and not listed as missing', !('WhatsApp' in (await app.tiles())) && !waShown);
      }
      const waList = await app.api('call', 'list_whatsapp_chats', { udid: key?.udid ?? path.basename(b.dir) });
      const wa = waList.value?.data;
      check(`WhatsApp: the engine says calmly why there are no chats (${waInstalled ? 'left out' : 'not in this backup'})`,
        waList.value?.success === true && wa?.empty_reason === (waInstalled ? 'chats_left_out' : 'not_in_backup') && !wa?.error, wa ?? waList);

      // Podcasts, the same: many iPhones never use the Podcasts app, so no tile, not listed as
      // missing, and the engine's list, episodes and save all say so calmly, writing nothing.
      const udid = key?.udid ?? path.basename(b.dir);
      const podShown = await app.eval(() => [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'Podcasts'));
      check('Podcasts: no tile, and not listed as missing', !('Podcasts' in (await app.tiles())) && !podShown);
      const podList = await app.api('call', 'list_podcasts', { udid });
      const pods = podList.value?.data;
      check('Podcasts: the engine says calmly that they aren\'t in this backup',
        podList.value?.success === true && pods?.empty_reason === 'not_in_backup' && !pods?.error && Array.isArray(pods?.podcasts) && pods.podcasts.length === 0, pods ?? podList);
      const epList = await app.api('call', 'list_podcast_episodes', { udid, listened_only: true });
      const eps = epList.value?.data;
      check('Podcasts: no listening history, calmly', epList.value?.success === true && eps?.empty_reason === 'not_in_backup' && !eps?.error, eps ?? epList);
      const podOut = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-podcasts-'));
      try {
        const saved = await app.api('call', 'export_podcasts', { udid, output_dir: podOut, format: 'csv' });
        const s = saved.value?.data;
        check('Podcasts: saving says there\'s nothing to save, and writes nothing',
          saved.value?.success === true && !!s?.error && s?.empty_reason === 'not_in_backup' && fs.readdirSync(podOut).length === 0, s ?? saved);
      } finally {
        fs.rmSync(podOut, { recursive: true, force: true });
      }

      // Voice Memos: like Podcasts, many iPhones never record one, so no tile, not listed as missing,
      // and the engine's list, a recording asked for by id and the save all say so calmly.
      const vmShown = await app.eval(() => [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'Voice Memos'));
      check('Voice Memos: no tile, and not listed as missing', !('Voice Memos' in (await app.tiles())) && !vmShown);
      const vmList = (await app.api('call', 'list_voice_memos', { udid })).value;
      check('Voice Memos: the engine says calmly that there are none in this backup',
        vmList?.success === true && vmList.data?.empty_reason === 'not_in_backup' && !vmList.data?.error && vmList.data?.voice_memos?.length === 0, vmList);
      const vmAudio = (await app.api('call', 'get_voice_memo_audio', { udid, memo_id: 1 })).value;
      check('Voice Memos: asking for a recording that isn\'t there gets a sentence, not a crash', vmAudio?.success === true && !!vmAudio.data?.error, vmAudio);
      // Calendar: no tile; it may be listed as missing, and then says why
      const calTiles = await app.tiles();
      check('Calendar: no tile', !('Calendar' in calTiles), calTiles);
      const homeText = await app.text();
      check('Calendar: if it\'s listed as missing, it says there are no events', !/Calendar\s*\n\s*Not in this backup/.test(homeText)
        || /No events in this iPhone's calendars/.test(homeText), homeText.slice(0, 600));
      for (const method of ['list_calendars', 'list_calendar_events']) {
        const r = (await app.api('call', method, { udid })).value;
        const items = r?.data?.calendars ?? r?.data?.events;
        check(`Calendar: ${method} says calmly that there's none in this backup`,
          r?.success === true && r.data?.empty_reason === 'not_in_backup' && !r.data?.error && Array.isArray(items) && items.length === 0, r);
      }
      for (const [method, format] of [['export_voice_memos', 'recordings'], ['export_calendar', 'ics']]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `oe-e2e-${method}-`));
        try {
          const saved = (await app.api('call', method, { udid, output_dir: dir, format })).value;
          check(`${method}: says there's nothing to save, and writes nothing`,
            saved?.success === true && !!saved.data?.error && saved.data?.empty_reason === 'not_in_backup' && fs.readdirSync(dir).length === 0, saved);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      // Timeline and Year still work with messages only.
      await app.open('Timeline', /[\d,]+ events/);
      const events = num((await app.text()).match(/([\d,]+) events/)?.[1]);
      check('Timeline counts only messages', events > 0 && events <= key.messages.length, events);
      await app.open('Year', /\d{4} · [\d,]+ events/);
      check('Year view renders', /\d{4} · [\d,]+ events/.test(await app.text()));
      await app.open('Recover deleted messages', /Look for deleted messages/);
      await app.click('Look for deleted messages');
      check('recovery scan finishes', !!(await app.waitForText(/Nothing to recover|Pick a conversation|recovered|found/, 120_000)));
      await app.open('Backup details', /Messages/);
      check('Backup details lists what is missing', /Not in this backup/.test(await app.text()));

      // The Save panel greys out or explains kinds with nothing to save.
      await app.open('Save to this computer', /Copy what's in this backup/);
      const panel = await app.text();
      check('Save panel still offers messages and contacts', /All [\d,]+ messages/.test(panel) && /contacts/.test(panel), panel.slice(0, 400));

      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
      check('the backup closes', await app.closeBackup());

      // The same persona encrypted with an older iOS layout.
      const enc = backups['einstein-encrypted'];
      const r2 = await app.openBackup(enc.dir, enc.password);
      check(`encrypted iOS ${enc.expected.ios} backup opens`, r2.opened, r2);
      if (r2.opened) {
        const t2 = await app.homeTiles();
        check('its message count matches the answer key', t2.Messages === enc.expected.messages.length, t2);
        const waEnc = (await app.api('call', 'list_whatsapp_chats', { udid: enc.expected.udid })).value?.data;
        check('it has no WhatsApp either, and says so calmly', !enc.expected.whatsapp && !('WhatsApp' in t2)
          && waEnc?.empty_reason === 'not_in_backup' && !waEnc?.error, waEnc);
        // This phone never had WhatsApp (no "apps" in its answer key), so home doesn't list it as missing either.
        const waShownEnc = await app.eval(() => [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'WhatsApp'));
        check('it has no WhatsApp tile, and doesn\'t list it as missing', !(enc.expected.apps ?? []).includes('net.whatsapp.WhatsApp')
          && !('WhatsApp' in t2) && !waShownEnc);
      }
    } finally {
      await app.close();
    }
  },
};
