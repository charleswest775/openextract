// Every screen of an opened backup, on the encrypted maren backup (the only kind that holds
// calls and web history), checked against the generator's answer key: the home tile, the
// screen's own count, and something you can click on each screen. WhatsApp is checked
// against the key's "whatsapp" section when maren has one.
import { check, launch, num, sleep, timed, timing } from '../harness.mjs';

// The screens a backup has, as ExploreLayout names its tabs. scripts/e2e-coverage.test.mjs
// fails if a tab is added there without being added here.
export const SCREENS = {
  home: 'Backup home', dashboard: 'Backup details', people: 'People', timeline: 'Timeline', year: 'Year',
  messages: 'Messages', whatsapp: 'WhatsApp', photos: 'Photos', contacts: 'Address book', calls: 'Calls', notes: 'Notes',
  voicemail: 'Voicemail', browser_history: 'Web history', record_recovery: 'Recover deleted messages', export: 'Save to this computer',
};

export default {
  name: 'screens',
  about: 'every screen on a backup with everything in it, against its answer key',
  needs: ['maren-encrypted'],
  async run({ target, backups, out }) {
    const b = backups['maren-encrypted'];
    const key = b.expected;
    const app = await launch(target);
    const shot = name => app.page.screenshot({ path: `${out}/screens-${name}.png` }).catch(() => {});
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      const tiles = await app.homeTiles();
      await shot('home');
      check('home tiles match the answer key', tiles.Messages === key.messages.length && tiles.Photos === key.photos.length
        && tiles['Address book'] === key.contacts.length && tiles.Notes === key.notes.length && tiles.Voicemail === key.voicemails.length, { tiles });
      // WhatsApp, when the backup has it: the answer key's "whatsapp" section (none from a
      // backupgen without the WhatsApp writer, and most iPhones have none).
      const waKey = key.whatsapp ?? null;
      const waTotal = waKey ? waKey.chats.reduce((n, c) => n + c.message_count, 0) : 0;
      const waOf = chat => waKey.messages.filter(m => m.chat === chat.chat);
      const engineCalls = await app.api('call', 'list_calls', { udid: key.udid, offset: 0, limit: 100000 });
      const callList = engineCalls.value?.data?.calls ?? engineCalls.value?.data;
      check('Calls tile matches the engine', Array.isArray(callList) && tiles.Calls === callList.length, { tile: tiles.Calls, engine: Array.isArray(callList) ? callList.length : engineCalls });

      // ── Messages ──
      check('Messages opens', await timed('screen Messages', () => app.open('Messages', /\d+ conversations/)));
      const convos = num((await app.text()).match(/([\d,]+) conversations/)?.[1]);
      check(`Messages lists ${key.conversations.length} conversations`, convos === key.conversations.length, convos);
      check('a conversation opens', await app.click('Karin Lindqvist'));
      const thread = await app.waitFor(() => document.querySelectorAll('[class*=bubble], [data-message-id], .chat-bubble').length || /Karin/.test(document.body.innerText) && document.body.innerText.length, null, 15_000);
      check('the conversation shows its messages', !!thread);
      await shot('messages-thread');
      const filterBox = await app.page.$('input[aria-label="Search messages"], input[placeholder="Search messages"]');
      if (check('Messages has its own search box', !!filterBox)) {
        await filterBox.fill('Theo');
        await sleep(800);
        const filtered = await app.eval(() => [...document.querySelectorAll('button')].filter(b => /messages$/.test(b.textContent.trim())).length);
        check('typing in it narrows the list', filtered >= 1 && filtered < key.conversations.length, filtered);
        await filterBox.fill('');
      }

      // ── WhatsApp ──
      // Checked against the answer key when the backup has it. Without it there's no tile and
      // it isn't listed as missing, since most iPhones don't have WhatsApp.
      const waList = await app.api('call', 'list_whatsapp_chats', { udid: key.udid });
      const wa = waList.value?.data;
      if (waKey) {
        check(`WhatsApp tile counts the answer key's ${waTotal} messages`, tiles.WhatsApp === waTotal, { tile: tiles.WhatsApp });
        check(`the engine lists the answer key's ${waKey.chats.length} chats`, wa?.conversations?.length === waKey.chats.length, wa ?? waList);
        check('WhatsApp opens', await timed('screen WhatsApp', () => app.open('WhatsApp', /\d+ chats?/)));
        const waChats = num((await app.text()).match(/([\d,]+) chats?/)?.[1]);
        check(`WhatsApp lists ${waKey.chats.length} chats`, waChats === waKey.chats.length, waChats);
        check('WhatsApp opens on a chat', !!(await app.waitFor(() => document.querySelectorAll('[data-message-id]').length, null, 15_000)));
        // Opens a chat by name and waits for all its messages; returns their bubbles' text by sort.
        const engineChat = c => wa.conversations.find(x => x.chat_jid === c.jid);
        const openChat = async c => {
          const clicked = await app.click(c.name);
          const ids = (await app.api('call', 'get_whatsapp_messages', { udid: key.udid, chat_id: engineChat(c)?.chat_id, offset: 0, limit: 1000 }))
            .value?.data?.messages ?? [];
          const shown = await app.waitFor(n => document.querySelectorAll('[data-message-id]').length === n ? n : null, c.message_count, 15_000);
          const bubbles = await app.eval(ids => Object.fromEntries(ids.map(([sort, id]) => [sort, document.querySelector(`[data-message-id="${id}"]`)?.textContent ?? null])),
            ids.map(m => [m.sort, m.message_id]));
          return { clicked, shown, bubbles, ids: ids.map(m => [m.sort, m.message_id]) };
        };
        // A group: its notices, a reply, reactions, a deleted message, a photo that isn't in the backup.
        const group = waKey.chats.find(c => c.type === 'group' && waOf(c).some(m => m.quoted) && waOf(c).some(m => m.reactions.length))
          ?? waKey.chats.find(c => c.type === 'group');
        if (check('the answer key has a WhatsApp group', !!group)) {
          const g = await openChat(group);
          check(`the group "${group.name}" shows all ${group.message_count} messages`, g.clicked && g.shown === group.message_count, { clicked: g.clicked, shown: g.shown });
          const ms = waOf(group);
          const notices = ms.filter(m => m.notice && m.notice.event !== 'encrypted');
          check('its notices say who made the group and who was added', notices.every(m => (g.bubbles[m.sort] ?? '').includes(
            m.notice.event === 'created' ? `${m.notice.name} created the group` : m.notice.member === 'me' ? 'You were added' : `${m.notice.name} was added`)),
          notices.map(m => g.bubbles[m.sort]));
          const reply = ms.find(m => m.quoted && m.quoted.text);
          check('a reply shows the message it answers', !reply || ((g.bubbles[reply.sort] ?? '').includes(reply.text) && g.bubbles[reply.sort].includes(reply.quoted.text)), reply && g.bubbles[reply.sort]);
          const reacted = ms.filter(m => m.reactions.length);
          check('reactions sit under their messages', reacted.every(m => m.reactions.every(r => (g.bubbles[m.sort] ?? '').includes(r.emoji))), reacted.map(m => g.bubbles[m.sort]));
          const deleted = ms.find(m => m.kind === 'deleted');
          check('a deleted message says so', !deleted || /This message was deleted|You deleted this message/.test(g.bubbles[deleted.sort] ?? ''), deleted && g.bubbles[deleted.sort]);
          const gone = ms.find(m => m.attachment && !m.attachment.available);
          check('a photo that isn\'t in the backup is labelled so', !gone || /not in this backup/.test(g.bubbles[gone.sort] ?? ''), gone && g.bubbles[gone.sort]);
          await shot('whatsapp');
        }
        // A one-to-one chat with voice messages, calls and photos.
        const voiceChat = waKey.chats.find(c => waOf(c).some(m => m.kind === 'audio') && waOf(c).some(m => m.call));
        if (voiceChat) {
          const v = await openChat(voiceChat);
          check(`"${voiceChat.name}" shows all ${voiceChat.message_count} messages`, v.clicked && v.shown === voiceChat.message_count, { shown: v.shown });
          const voices = waOf(voiceChat).filter(m => m.kind === 'audio');
          const playButtons = await app.eval(() => [...document.querySelectorAll('[data-message-id] button')].filter(b => b.textContent.trim().startsWith('Play voice message')).length);
          check(`its ${voices.length} voice messages each have a Play button`, playButtons === voices.length, playButtons);
          // Play the last one: the app reads it from the backup and the window's own player must decode it
          await app.eval(() => [...document.querySelectorAll('[data-message-id] button')].filter(b => b.textContent.trim().startsWith('Play voice message')).at(-1)?.click());
          const played = await app.waitFor(() => {
            const a = document.querySelector('[data-message-id] audio');
            return a && Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration) : null;
          }, null, 15_000);
          check('a voice message plays in the app, at its length', played === voices.at(-1).attachment.duration
            && !/can't play here/.test(await app.text()), { played, want: voices.at(-1).attachment.duration });
          const calls = waOf(voiceChat).filter(m => m.call);
          check('calls show what happened', calls.every(m => /call/i.test(v.bubbles[m.sort] ?? '') && (m.call.outcome !== 'missed' || /Missed/.test(v.bubbles[m.sort]))),
            calls.map(m => v.bubbles[m.sort]));
          // Pictures load as they scroll near: bring each photo into view and wait for it
          const photoIds = waOf(voiceChat).filter(m => m.kind === 'image' && m.attachment.available)
            .map(m => (v.ids ?? []).find(([sort]) => sort === m.sort)?.[1]);
          let loadedPhotos = 0;
          for (const id of photoIds) {
            await app.eval(id => document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'center' }), id);
            if (await app.waitFor(id => [...(document.querySelector(`[data-message-id="${id}"]`)?.querySelectorAll('img') ?? [])]
              .some(i => i.complete && i.naturalWidth > 0) || null, id, 15_000)) loadedPhotos++;
          }
          check(`its ${photoIds.length} photos load`, photoIds.length > 0 && loadedPhotos === photoIds.length, loadedPhotos);
          await shot('whatsapp-voice');
        }
        // A shared location with WhatsApp's map preview, a document, and starred messages.
        const placeChat = waKey.chats.find(c => waOf(c).some(m => m.kind === 'shared_location'));
        if (placeChat) {
          const p = await openChat(placeChat);
          check(`"${placeChat.name}" shows all ${placeChat.message_count} messages`, p.clicked && p.shown === placeChat.message_count, { shown: p.shown });
          const place = waOf(placeChat).find(m => m.kind === 'shared_location');
          check('a shared location shows its place', (p.bubbles[place.sort] ?? '').includes(place.location.place ?? 'Location'), p.bubbles[place.sort]);
          const map = await app.waitFor(() => [...document.querySelectorAll('[data-message-id] img')].some(i => i.complete && i.naturalWidth > 0) || null, null, 20_000);
          check('its map preview loads', !!map);
          const doc = waOf(placeChat).find(m => m.kind === 'document');
          check('a document shows its name', !doc || (p.bubbles[doc.sort] ?? '').includes(doc.attachment.name.replace(/\.pdf$/, '')), doc && p.bubbles[doc.sort]);
          const starred = await app.eval(() => document.querySelectorAll('[data-message-id] [aria-label=Starred]').length);
          check('starred messages are marked', starred === waOf(placeChat).filter(m => m.starred).length, starred);
          await shot('whatsapp-location');
        }
      } else if (wa?.conversations?.length) {
        check('WhatsApp opens', await timed('screen WhatsApp', () => app.open('WhatsApp', /\d+ chats?/)));
        const waChats = num((await app.text()).match(/([\d,]+) chats?/)?.[1]);
        check(`WhatsApp lists the engine's ${wa.conversations.length} chats`, waChats === wa.conversations.length, waChats);
        check('WhatsApp opens on a chat', !!(await app.waitFor(() => document.querySelectorAll('[data-message-id]').length, null, 15_000)));
        await shot('whatsapp');
      } else {
        check('the engine says calmly that WhatsApp isn\'t in this backup', waList.value?.success === true && wa?.empty_reason === 'not_in_backup' && !wa?.error && Array.isArray(wa?.conversations), wa ?? waList);
        await app.home();
        const listed = await app.eval(() => [...document.querySelectorAll('span')].some(s => s.textContent.trim() === 'WhatsApp'));
        check('no WhatsApp tile, and not listed as missing', !('WhatsApp' in tiles) && !listed, { tiles });
      }

      // ── Photos ──
      check('Photos opens', await timed('screen Photos', () => app.open('Photos', /photos? (and videos|or video) in this backup/)));
      const photoHeader = num((await app.text()).match(/([\d,]+) photos? (?:and videos|or video) in this backup/i)?.[1]);
      check(`Photos says ${key.photos.length} photos`, photoHeader === key.photos.length, photoHeader);
      const albums = {};
      for (const p of key.photos) for (const a of p.albums) albums[a] = (albums[a] || 0) + 1;
      // An album button reads "<name><count>", e.g. "Portland20".
      const buttons = await app.eval(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()));
      const albumMismatch = Object.entries(albums).filter(([a, n]) => !buttons.includes(`${a}${n}`));
      check('every album is listed with its photo count', albumMismatch.length === 0 && buttons.includes(`All Photos${key.photos.length}`), { albumMismatch });
      const grid = await timed('photos grid paged to the end', () => app.eval(async () => {
        const g = [...document.querySelectorAll('div.grid')].find(g => g.querySelector('.aspect-square'));
        if (!g) return { tiles: 0 };
        const sc = g.parentElement; let last = -1, same = 0;
        for (let i = 0; i < 120 && same < 6; i++) {
          sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 500));
          const n = g.children.length; if (n === last) same++; else { same = 0; last = n; }
        }
        for (let i = 0; i < 60 && g.querySelector('.animate-spin'); i++) await new Promise(r => setTimeout(r, 500));
        const tiles = [...g.children];
        const kind = t => t.querySelector('img') ? 'img' : t.querySelector('.animate-spin') ? 'spinner' : t.querySelector('.bg-gray-800') ? 'video' : 'failed';
        const counts = {}; tiles.forEach(t => (counts[kind(t)] = (counts[kind(t)] || 0) + 1));
        const ids = tiles.map(t => (t.querySelector('img')?.alt || t.innerText) + '|' + (t.querySelector('img')?.src.length || 0));
        return { tiles: tiles.length, unique: new Set(ids).size, counts, error: (document.body.innerText.match(/Couldn't load more photos[^\n]*/) || [null])[0] };
      }));
      check(`photo grid pages to all ${key.photos.length}, no duplicates, no errors`, grid.tiles === key.photos.length && grid.unique === grid.tiles && !grid.error, grid);
      check('every thumbnail loads', !grid.counts?.failed && !grid.counts?.spinner, grid.counts);
      await shot('photos');
      // Open one photo full size.
      await app.eval(() => document.querySelector('div.grid .aspect-square')?.click());
      const big = await app.waitFor(() => [...document.querySelectorAll('img')].some(i => i.naturalWidth >= 800), null, 20_000);
      check('a photo opens full size', !!big);
      await shot('photo-viewer');
      await app.page.keyboard.press('Escape');
      await sleep(300);

      // ── People ──
      check('People opens', await timed('screen People', () => app.open('People', /Most in touch first/)));
      const people = await app.text();
      check('People lists the most-messaged person first', /Most in touch first[\s\S]*Theo Navarro/.test(people));
      check('a person opens with their history', await app.click('Theo Navarro') && !!(await app.waitForText(/Open conversation/, 10_000)));
      check('"Open conversation" goes to the thread', await app.click('Open conversation') && !!(await app.waitForText(/Theo Navarro/, 10_000)));
      if (waKey) {
        // Someone who writes on both: their texts and WhatsApp chat on one page, matched by number.
        const both = waKey.chats.find(c => c.type === 'individual' && c.contact && key.conversations.some(t => t.chat_identifier === c.handle));
        if (both) {
          await app.open('People', /Most in touch first/);
          const wants = `${both.message_count} WhatsApp message`;
          check(`${both.name}'s page has their texts and their WhatsApp`, await app.click(both.name)
            && !!(await app.waitFor(w => document.body.innerText.includes(w) && /\d+ messages?/.test(document.body.innerText), wants, 10_000)), wants);
          check('"Open WhatsApp chat" goes to the chat', await app.click('Open WhatsApp chat') && !!(await app.waitForText(/\d+ chats?/, 10_000)));
        }
        // Someone only on WhatsApp is a person too.
        const outsider = waKey.chats.find(c => c.type === 'individual' && !c.contact);
        if (outsider) {
          await app.open('People', /Most in touch first/);
          check(`${outsider.name}, only on WhatsApp, is in People`, (await app.text()).includes(outsider.name));
        }
      }

      // ── Address book ──
      check('Address book opens', await timed('screen Address book', () => app.open('Address book', /\d+ cards?/)));
      const cards = num((await app.text()).match(/([\d,]+) cards?/)?.[1]);
      check(`Address book has ${key.contacts.length} cards`, cards === key.contacts.length, cards);
      const firstWithHistory = await app.eval(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('See history'));
        let el = b; for (let i = 0; i < 6 && el && !/\+\d/.test(el.innerText); i++) el = el.parentElement;
        return el?.innerText.split('\n').find(l => l.trim() && !/^[A-Z]$/.test(l.trim()))?.trim();
      });
      check('"See history" opens that person in People', await app.click('See history') && !!(await app.waitFor(n => /Most in touch first/.test(document.body.innerText) && /Open conversation|Save everything/.test(document.body.innerText) && document.body.innerText.includes(n), firstWithHistory, 10_000)), firstWithHistory);

      // ── Calls ──
      check('Calls opens', await timed('screen Calls', () => app.open('Calls', /\d+ calls?/)));
      const calls = num((await app.text()).match(/([\d,]+) calls?/)?.[1]);
      check('Calls count matches its home tile', calls === tiles.Calls, { calls, tile: tiles.Calls });
      const rows = await app.eval(() => document.querySelectorAll('table tbody tr, [role=row]').length);
      check('the call list shows rows', rows > 0, rows);
      await shot('calls');

      // ── Notes ──
      check('Notes opens', await timed('screen Notes', () => app.open('Notes', /\d+ notes?/)));
      const notes = num((await app.text()).match(/([\d,]+) notes?/)?.[1]);
      check(`Notes has ${key.notes.length} notes`, notes === key.notes.length, notes);
      const sample = [...key.notes].sort((a, z) => z.modified.localeCompare(a.modified))[1];
      check('a note opens', await app.click(sample.title));
      const body = sample.text.split('\n').filter(Boolean).slice(-1)[0];
      check('the note shows its text', !!(await app.waitFor(t => document.body.innerText.includes(t), body, 10_000)), body);

      // ── Voicemail ──
      check('Voicemail opens', await timed('screen Voicemail', () => app.open('Voicemail', /\d+ voicemails?/)));
      const vms = num((await app.text()).match(/([\d,]+) voicemails?/)?.[1]);
      check(`Voicemail has ${key.voicemails.length}`, vms === key.voicemails.length, vms);
      // (The answer key has transcripts, but backupgen doesn't write them into the backup.)
      const vm = [...key.voicemails].sort((a, z) => z.date.localeCompare(a.date)).find(v => v.contact);
      await app.click(vm.contact);
      const mmss = `0:${String(vm.duration).padStart(2, '0')}`;
      check('a voicemail opens with its length', !!(await app.waitFor(t => document.body.innerText.split(t).length > 2, mmss, 10_000)), mmss);
      const play = await app.waitFor(() => !!document.querySelector('button[aria-label=Play]'), null, 20_000);
      check('a voicemail\'s audio loads and can play', !!play && !/Couldn't read the voicemail/.test(await app.text()));
      await shot('voicemail');

      // ── Web history ──
      check('Web history opens', await timed('screen Web history', () => app.open('Web history', /Web history/)));
      const web = await app.waitForText(/Most Visited Sites|Browsing Activity/, 30_000);
      check('Web history shows its overview', !!web, (await app.text()).slice(0, 400));
      const visitsShown = num((await app.text()).match(/([\d,]+) page visits/)?.[1]);
      check(`Web history counts the ${key.browser_history.length} visits`, visitsShown === key.browser_history.length, visitsShown);
      await shot('web-history');

      // ── Timeline ──
      check('Timeline opens', await timed('screen Timeline', () => app.open('Timeline', /[\d,]+ events/)));
      const tl = await app.text();
      const events = num(tl.match(/([\d,]+) events/)?.[1]);
      const chips = await app.eval(() => Object.fromEntries([...document.querySelectorAll('button')]
        .map(b => b.textContent.trim().match(/^(Messages|WhatsApp|Calls|Photos|Voicemail|Notes|Web)([\d,]+)$/)).filter(Boolean).map(m => [m[1], Number(m[2].replace(/,/g, ''))])));
      const chipTotal = Object.values(chips).reduce((a, n) => a + n, 0);
      check('timeline total is the sum of its type chips', events === chipTotal, { events, chips });
      check('timeline photos, notes, voicemail and web visits match the answer key', chips.Photos === key.photos.length && chips.Notes === key.notes.length
        && chips.Voicemail === key.voicemails.length && chips.Web === key.browser_history.length && chips.Calls === tiles.Calls, chips);
      check(`timeline has the answer key's ${waTotal} WhatsApp messages`, (chips.WhatsApp ?? 0) === waTotal, chips);
      await app.click(`Photos${chips.Photos}`);
      await sleep(800);
      const afterChip = num((await app.text()).match(/([\d,]+) events/)?.[1]);
      check('turning off a type removes its events', afterChip === events - chips.Photos, { events, afterChip });
      await app.click(`Photos${chips.Photos}`);
      check('older pages load', await app.click('Older →') && !!(await app.waitForText(/events/, 5000)));

      // ── Year ──
      check('Year opens', await timed('screen Year', () => app.open('Year', /\d{4} · [\d,]+ events/)));
      const years = await app.eval(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /^20\d\d$/.test(t)));
      const keyYears = [...new Set(key.messages.map(m => m.date.slice(0, 4)))].sort();
      check('Year lists every year the backup covers', keyYears.every(y => years.includes(y)), { years, keyYears });
      await app.click(years[0]);
      await sleep(800);
      const yearTitle = (await app.text()).match(/(\d{4}) · ([\d,]+) events/);
      check('switching year updates the grid', yearTitle?.[1] === years[0], yearTitle?.[0]);
      const day = await app.eval(() => {
        const cell = [...document.querySelectorAll('button[aria-label]')].find(b => /: \d+ messages?/.test(b.getAttribute('aria-label')));
        if (!cell) return null;
        const label = cell.getAttribute('aria-label');
        cell.click();
        return label;
      });
      check('clicking a day opens it in the Timeline', !!day && !!(await app.waitForText(/events/, 10_000)), day);
      const dayCount = Number(day?.match(/: (\d+) messages?/)?.[1]);
      const dayText = await app.text();
      check('the day shows its messages', /Message/.test(dayText) && dayCount > 0, { day, sample: dayText.slice(0, 200) });

      // ── Recover deleted messages ──
      check('Recover deleted opens', await app.open('Recover deleted messages', /Look for deleted messages/));
      await app.click('Look for deleted messages');
      const recovered = await timed('recover deleted messages scan', () => app.waitForText(/Nothing to recover|Pick a conversation|recovered|found/, 120_000));
      check('the scan finishes with an answer', !!recovered && !/Couldn't|error/i.test(await app.text()), (await app.text()).slice(0, 300));

      // ── Backup details ──
      check('Backup details opens', await timed('screen Backup details', () => app.open('Backup details', /Top conversations/)));
      // The big numbers count up from 0; wait for them to land.
      await app.waitFor(n => document.body.innerText.includes(n), tiles.Messages.toLocaleString('en-US'), 10_000);
      const details = await app.text();
      check('details agree with the home tiles', details.includes(tiles.Messages.toLocaleString('en-US')) && details.includes(String(tiles.Photos)), details.slice(0, 300));
      check('"Open Messages" from details goes to Messages', await app.click('Open Messages') && !!(await app.waitForText(/\d+ conversations/, 10_000)));

      // ── Save to this computer (exports are checked in the exports suite) ──
      check('Save to this computer opens', await app.open('Save to this computer', /Copy what's in this backup/));

      timing('backup home after visiting every screen', await (async () => { const t0 = performance.now(); await app.home(); return performance.now() - t0; })());
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
