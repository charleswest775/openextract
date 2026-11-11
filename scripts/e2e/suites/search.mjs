// The one search box: finding a message by its words and opening it in its conversation,
// people with accents typed without them, grouped results, nothing found, and the boxes that
// search just one screen.
import { check, launch, num, sleep, timing } from '../harness.mjs';

export default {
  name: 'search',
  about: 'global search, opening a result, accents, no results, per-screen search',
  needs: ['maren-encrypted'],
  async run({ target, backups }) {
    const b = backups['maren-encrypted'];
    const key = b.expected;
    const app = await launch(target);
    const box = () => app.page.locator('.titlebar input[type=search]').first();
    const search = async text => {
      await box().fill('');
      const t0 = performance.now();
      await box().fill(text);
      const settled = await app.waitFor(() => !/Still reading the backup/.test(document.body.innerText)
        && (/Nothing matches/.test(document.body.innerText) || document.querySelector('[id^="result-"]') || /People · \d/i.test(document.body.innerText)), null, 60_000);
      return { settled: !!settled, ms: performance.now() - t0 };
    };
    try {
      const r = await app.openBackup(b.dir, b.password);
      if (!check('backup opens', r.opened, r)) return;
      await sleep(1500);

      // A message, found by a phrase from its text.
      const msg = key.messages.find(m => !m.is_reaction && m.text && m.text.split(' ').length >= 8 && /^[\w\s,.'!?-]+$/.test(m.text));
      const phrase = msg.text.split(' ').slice(1, 5).join(' ');
      const s1 = await search(phrase);
      timing('search the whole backup', s1.ms);
      const chips = await app.eval(() => Object.fromEntries([...document.querySelectorAll('button[aria-pressed]')]
        .map(c => c.textContent.trim().match(/^(.+?)([\d,]+)$/)).filter(Boolean).map(m => [m[1], Number(m[2].replace(/,/g, ''))])));
      check(`"${phrase}" finds its message`, s1.settled && chips.Messages >= 1, chips);
      // Arrow down to the first result and press Enter: it opens in its conversation.
      await box().focus();
      await app.page.keyboard.press('ArrowDown');
      await app.page.keyboard.press('Enter');
      const opened = await app.waitFor(t => !document.querySelector('[id^="result-"]') && document.body.innerText.includes(t), msg.text.slice(0, 60), 15_000);
      check('Enter opens the message in its conversation', !!opened, (await app.text()).slice(0, 300));

      // A WhatsApp message (when the backup has WhatsApp), by words found nowhere else in the
      // backup, opens in its WhatsApp chat.
      const plain = /^[\w\s,.'!?-]+$/;
      const elsewhere = [...key.messages.map(m => m.text), ...key.notes.map(n => `${n.title} ${n.text}`),
        ...key.browser_history.map(v => `${v.title} ${v.url}`), ...key.contacts.map(c => `${c.first} ${c.last} ${c.organization}`)]
        .map(t => (t || '').toLowerCase());
      const waPick = (key.whatsapp?.messages ?? []).filter(m => m.kind === 'text' && plain.test(m.text) && m.text.split(' ').length >= 6)
        .map(m => ({ m, phrase: m.text.split(' ').slice(1, 5).join(' ') }))
        .find(({ m, phrase }) => {
          const words = phrase.toLowerCase().split(/\s+/);
          return !elsewhere.some(t => words.every(w => t.includes(w)))
            && key.whatsapp.messages.filter(o => o !== m && words.every(w => (o.text || '').toLowerCase().includes(w))).length === 0;
        });
      if (key.whatsapp) {
        await app.home();
        if (check('the answer key has a WhatsApp message to look for', !!waPick)) {
          const s5 = await search(waPick.phrase);
          const waChips = await app.eval(() => Object.fromEntries([...document.querySelectorAll('button[aria-pressed]')]
            .map(c => c.textContent.trim().match(/^(.+?)([\d,]+)$/)).filter(Boolean).map(m => [m[1], Number(m[2].replace(/,/g, ''))])));
          check(`"${waPick.phrase}" finds its WhatsApp message`, s5.settled && waChips.WhatsApp === 1, waChips);
          await box().focus();
          await app.page.keyboard.press('ArrowDown');
          await app.page.keyboard.press('Enter');
          const inChat = await app.waitFor(t => !document.querySelector('[id^="result-"]') && document.body.innerText.includes(t)
            && /\d+ chats?/.test(document.body.innerText), waPick.m.text.slice(0, 60), 15_000);
          check('Enter opens it in its WhatsApp chat', !!inChat, (await app.text()).slice(0, 300));
        }
      }

      // Accents: "Lucia" finds Lucía.
      await app.home();
      const s2 = await search('lucia navarro');
      check('typing without accents finds "Lucía Navarro"', s2.settled && /People · \d/i.test(await app.text()) && (await app.text()).includes('Lucía Navarro'));
      // A person result opens their page.
      const person = await app.eval(() => {
        const el = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Lucía Navarro') && !b.id);
        el?.click();
        return !!el;
      });
      check('a person result opens them', person && !!(await app.waitForText(/Lucía Navarro/, 10_000)));

      // A note, by its title.
      await app.home();
      const note = key.notes.find(n => n.title.split(' ').length >= 2 && /^[\w\s,'-]+$/.test(n.title));
      const s3 = await search(note.title);
      const noteChip = num(await app.eval(() => [...document.querySelectorAll('button[aria-pressed]')].map(c => c.textContent.trim()).find(t => /^Notes[\d,]+$/.test(t))?.slice(5)));
      check(`a note's title ("${note.title}") finds it`, s3.settled && noteChip >= 1, noteChip);

      // Nothing found says so.
      await app.home();
      const s4 = await search('qzxvbnm wkpfj');
      check('a search that finds nothing says so', s4.settled && /Nothing matches/.test(await app.text()));
      await box().fill('');
      await app.page.keyboard.press('Escape');

      // A screen's own search box narrows just that screen.
      await app.open('Notes', /\d+ notes?/);
      const notesBox = app.page.locator('input[aria-label="Search notes"]').first();
      if (check('Notes has its own search box', (await notesBox.count()) > 0)) {
        await notesBox.fill(note.title);
        await sleep(800);
        const shown = num((await app.text()).match(/([\d,]+) (?:of [\d,]+ )?notes?/)?.[1]);
        const titles = await app.eval(t => [...document.querySelectorAll('button')].filter(b => b.textContent.startsWith(t)).length, note.title);
        check('the Notes search narrows the list to matching notes', titles >= 1 && (shown === null || shown < key.notes.length), { shown, titles });
      }
      check('no renderer errors', app.seriousErrors().length === 0, app.seriousErrors().slice(0, 5));
    } finally {
      await app.close();
    }
  },
};
