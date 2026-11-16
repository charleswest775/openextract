// OpenExtract home page: the app's screenshots, the download buttons, and real thank-you notes.
(function () {
  'use strict';

  // ── Header gets a line once you scroll ──
  var top = document.querySelector('.top');
  function onScroll() { top.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ── Download: lead with the visitor's own system (Mac for macOS, phones and anything unknown) ──
  var ua = navigator.userAgent;
  var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  var os = /win/.test(plat) ? 'windows' : (/linux/.test(plat) && !/android/i.test(ua)) ? 'linux' : 'mac';
  document.querySelectorAll('.os__card[data-dl="' + os + '"], .dl3__btn[data-dl="' + os + '"]').forEach(function (c) { c.classList.add('is-mine'); });

  // ── The app: real screenshots, real Save windows, real saved files ──
  // Tile positions come from the real app's home screen at 1440 × 900.
  var W = 1440, H = 900;
  var SCREENS = [
    { id: 'messages', name: 'Messages', rect: [173, 213, 260, 146], pulse: true,
      cap: 'Every iMessage and text, with the photos sent in them.', saves: 'PDF · web page · CSV · text',
      alt: "A text conversation between Maren and her mom, with a photo of Diablo Lake sent in the thread." },
    { id: 'whatsapp', name: 'WhatsApp', rect: [449, 213, 260, 146], pulse: true,
      cap: 'Chats and groups, with their photos, voice messages and calls.', saves: 'PDF · web page',
      alt: 'A WhatsApp chat with photos, a voice message and calls.' },
    { id: 'photos', name: 'Photos', rect: [725, 213, 260, 146],
      cap: 'The whole camera roll in original quality, sorted into the albums you made.', saves: 'HEIC · JPEG · MOV originals',
      alt: 'The Photos screen: a grid of landscape photos with the backup’s albums listed alongside.' },
    { id: 'people-list', name: 'People', rect: [1001, 213, 260, 146],
      cap: 'Everyone you were in touch with: texts, WhatsApp, calls and voicemails with each person, together.', saves: 'PDF per person',
      alt: 'The People screen with one person’s messages and calls in date order.' },
    { id: 'address-book', name: 'Contacts', rect: [173, 375, 260, 146],
      cap: 'Every contact card: names, numbers, email addresses and notes.', saves: 'vCard · CSV',
      alt: 'The Address book screen with contact cards.' },
    { id: 'calls', name: 'Calls', rect: [449, 375, 260, 146],
      cap: 'Who called, when, and for how long.', saves: 'CSV',
      alt: 'The Calls screen listing calls with dates, durations and direction.' },
    { id: 'notes', name: 'Notes', rect: [725, 375, 260, 146],
      cap: 'Everything in Apple Notes, from grocery lists to recipes.', saves: 'text · PDF',
      alt: 'The Notes screen with a grocery list open.' },
    { id: 'voicemail', name: 'Voicemail', rect: [1001, 375, 260, 146], pulse: true,
      cap: 'Saved voicemails you can play, and keep as audio files.', saves: 'audio files',
      alt: 'The Voicemail screen with a list of saved voicemails.' },
    { id: 'web-history', name: 'Web history', rect: [173, 538, 260, 124],
      cap: 'The pages visited in Safari and Firefox, and the sites visited most.', saves: 'CSV',
      alt: 'The Web history screen with total visits and the most visited sites.' },
    { id: 'timeline', name: 'Timeline', rect: [449, 538, 260, 124],
      cap: 'Everything in the backup in date order, filtered by person or kind.', saves: 'CSV',
      alt: 'The Timeline screen listing messages and web visits by date.' },
    { id: 'year', name: 'Year', rect: [725, 538, 260, 124],
      cap: 'A whole year at a glance, one square per day. Click a day to see it.', saves: '',
      alt: 'The Year screen: one square per day, busier days darker.' },
    { id: 'search', name: 'Search', rect: [458, 8, 520, 36],
      cap: 'One box searches texts, WhatsApp, notes, calls, voicemail and more. Here: “birthday”.', saves: '',
      alt: 'Search results for “birthday” across notes, messages and WhatsApp.' }
  ];
  var HOME = { id: 'home', name: 'Home screen', cap: 'Everything in the backup at a glance. Pick a screen above to look around.', saves: '',
    alt: document.querySelector('[data-demo-img]').alt };

  // How saving works, per screen: the real Save window, the files it really made from the
  // sample backup, and the one ask the app makes afterwards. Small steps under the
  // screenshot; a step opens large in a pop-up.
  var SAVE_BOX = { messages: [496, 222, 448, 456], whatsapp: [496, 222, 448, 456], 'people-list': [496, 270, 448, 361],
    'address-book': [496, 307, 448, 287], notes: [496, 307, 448, 287], timeline: [496, 270, 448, 361] };
  // Screens that save straight to a folder: where their Save button sits.
  var SAVE_BTN = { photos: [1305, 64, 111, 39], calls: [1324, 64, 92, 39], voicemail: [1305, 64, 111, 39], 'web-history': [1305, 64, 111, 39] };
  var H_ = '/img/home/';
  function pick(screen, button, formats) {
    return { label: 'Pick a format', kind: 'dialog', screen: screen, thumb: H_ + 'save-' + screen + '-600.webp', img: H_ + 'save-' + screen + '-900.webp',
      title: 'Click ' + button + ', then pick a format', cap: formats.cap, alt: formats.alt };
  }
  function press(screen, button, cap) {
    return { label: 'Click ' + button, kind: 'button', screen: screen, thumb: H_ + 'btn-' + screen + '-480.webp',
      title: 'Click ' + button + ', then choose a folder', cap: cap,
      alt: 'The ' + button + ' button at the top right of the screen.' };
  }
  function file(label, key, title, cap, alt) {
    return { label: label, kind: 'shot', thumb: H_ + 'file-' + key + '-1200.webp', img: H_ + 'file-' + key + '-2000.webp', title: title, cap: cap, alt: alt };
  }
  var ASK = { label: 'Then one ask', kind: 'card', thumb: H_ + 'pay-ask-680.webp', img: H_ + 'pay-ask-680.webp',
    title: 'Then the app asks, once',
    cap: 'Only after your file is saved. If it was worth something to you and you can afford it, pay what it’s worth. If you can’t, it’s yours. “Not now” means not now.',
    alt: 'The card after saving: Your messages are saved. Hi, I’m Charles. I give OpenExtract to everyone, and ask one thing: if getting your messages off your iPhone was worth something to you and you can afford it, pay what it was worth. $5 is a good start. If you can’t, it’s yours. Buttons: Not now, Pay $5.' };
  var FLOWS = {
    messages: [
      pick('messages', 'Save conversation', { cap: 'A web page, a PDF to read or print, a spreadsheet or plain text. Then you choose where it goes on your computer.',
        alt: 'The Save window for a conversation with Karin Lindqvist: web page, readable document (PDF), spreadsheet (CSV) or plain text.' }),
      { label: 'Get a PDF', kind: 'pages', thumb: H_ + 'file-messages-pdf-p19-900.webp',
        imgs: [H_ + 'file-messages-pdf-p1-900.webp', H_ + 'file-messages-pdf-p19-900.webp'],
        title: 'The PDF it saves',
        cap: 'Every message and photo in the conversation, with names, dates and times. 20 pages that open anywhere and print well. These are two of them.',
        alts: ['Page 1 of the saved PDF: the start of the conversation with Karin, in message bubbles with dates and times.',
          'Page 19 of the saved PDF: the photo of Diablo Lake and the messages around it.'] },
      { label: 'Or a web page', kind: 'shot', thumb: H_ + 'file-messages-web-1200.webp', img: H_ + 'file-messages-web-2000.webp',
        title: 'Or the web page it saves',
        cap: 'The same conversation as a page that opens in any browser, with the photos saved in a folder beside it.',
        alt: 'The saved web page open in a browser, with the Diablo Lake photo in the conversation.' },
      ASK
    ],
    whatsapp: [
      pick('whatsapp', 'Save chat', { cap: 'A web page, a PDF, a spreadsheet or plain text. Then you choose where it goes.',
        alt: 'The Save window for a WhatsApp chat with Lucía Navarro: web page, readable document (PDF), spreadsheet (CSV) or plain text.' }),
      { label: 'Get a PDF', kind: 'pages', thumb: H_ + 'file-whatsapp-pdf-p2-900.webp',
        imgs: [H_ + 'file-whatsapp-pdf-p2-900.webp', H_ + 'file-whatsapp-pdf-p4-900.webp'],
        title: 'The PDF it saves',
        cap: 'Photos, calls and voice messages in order, with names and times. Two of its four pages.',
        alts: ['A page of the saved WhatsApp PDF: a photo of Crater Lake, replies, a voice message and a video call.',
          'Another page: photos of a rose garden, a missed call, a voice message and an outgoing call.'] },
      file('Or a web page', 'whatsapp-web', 'Or the web page it saves',
        'The same chat in any browser. Voice messages play right in the page, and the photos are saved beside it.',
        'The saved WhatsApp web page: a photo of Crater Lake and a voice message with a play button.')
    ],
    photos: [
      press('photos', 'Save all', 'Or pick an album first to save just that one. You choose the folder; nothing is uploaded.'),
      file('The originals', 'photos', 'The original photos, in folders by year and month',
        'All 170 photos and videos, copied as the original files. This folder is August 2025.',
        'A folder of the saved photos: 2025, then 08, with 24 of its 45 photos shown by file name, from IMG_0068.JPG on.')
    ],
    'people-list': [
      pick('people-list', 'Save everything', { cap: 'Everything with one person, as a web page, a spreadsheet or Markdown.',
        alt: 'The Save window for everything with Theo Navarro: web page, spreadsheet (CSV) or Markdown.' }),
      file('Get the page', 'people-web', 'Everything with Theo, on one page',
        'Texts, WhatsApp, calls and voicemails with one person, in date order: 301 entries.',
        'The saved web page for Theo Navarro: messages and a call, newest first, grouped by day.')
    ],
    'address-book': [
      pick('address-book', 'Save contacts', { cap: 'Contact cards import into Contacts, Outlook or Google. The spreadsheet opens in Excel, Numbers or Google Sheets.',
        alt: 'The Save contacts window: contact cards (vCard) or a spreadsheet (CSV).' }),
      file('Get a spreadsheet', 'contacts', 'The spreadsheet it saves',
        'Contacts.csv: names, companies, phone numbers, email addresses and notes for all 45 cards.',
        'Contacts.csv: rows of contacts with name, organization, phone numbers, email addresses and notes.')
    ],
    calls: [
      press('calls', 'Save', 'You choose the folder. All 166 calls go into one spreadsheet.'),
      file('Get a spreadsheet', 'calls', 'The spreadsheet it saves',
        'call_history.csv: when, who, which way, answered or missed, and for how long.',
        'call_history.csv: rows of calls with date, contact name, number, direction, status and duration.')
    ],
    notes: [
      pick('notes', 'Save note', { cap: 'Keep a note as a PDF to read or print, or as plain text for any editor.',
        alt: 'The Save window for the note "Groceries": readable document (PDF) or plain text.' })
    ],
    voicemail: [
      press('voicemail', 'Save all', 'You choose the folder. Or save one voicemail from its own row.'),
      file('The audio files', 'voicemail', 'One audio file per voicemail',
        'Named by who called and when, plus a spreadsheet of them all.',
        'The saved Voicemail folder: nine audio files named by caller and date, with lengths and sizes, and voicemails.csv.')
    ],
    'web-history': [
      press('web-history', 'Save all', 'You choose the folder. Every visit goes into one spreadsheet.'),
      file('Get a spreadsheet', 'web-history', 'The spreadsheet it saves',
        'browser_history_export.csv: when, which browser, the page title, its address and how often it was visited.',
        'browser_history_export.csv: rows of visits with date, browser, address, page title, site and visit count.')
    ],
    timeline: [
      pick('timeline', 'Save', { cap: 'Everything in the timeline, filtered the way you had it, as a web page, a spreadsheet or Markdown.',
        alt: 'The Save window for 2,028 events from the Timeline: web page, spreadsheet (CSV) or Markdown.' }),
      file('Get the page', 'timeline-web', 'The timeline, on one page',
        'Messages, calls and web visits in date order, grouped by day.',
        'The saved timeline web page: messages and Safari visits grouped by day, newest first.')
    ]
  };

  var img = document.querySelector('[data-demo-img]');
  var cap = document.querySelector('[data-demo-cap]');
  var saves = document.querySelector('[data-demo-saves]');
  var title = document.querySelector('[data-demo-title]');
  var nameEl = document.querySelector('[data-demo-name]');
  var pills = document.querySelector('[data-demo-pills]');
  var flowEl = document.querySelector('[data-demo-flow]');
  var stepsEl = document.querySelector('[data-demo-flow-steps]');
  var current = 'home';

  function src(id, w) { return '/img/home/' + id + '-' + w + '.webp'; }
  function preload(id) { var i = new Image(); i.src = src(id, 1200); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function render() {
    var s = find(current) || HOME;
    nameEl.textContent = s.name;
    cap.textContent = s.cap;
    saves.textContent = s.saves ? 'Saves as ' + s.saves : '';
    title.textContent = current === 'home' ? "OpenExtract · Maren's iPhone (sample)" : "OpenExtract · Maren's iPhone › " + s.name;
    Array.prototype.forEach.call(pills.children, function (p) { p.setAttribute('aria-pressed', p.getAttribute('data-id') === current ? 'true' : 'false'); });

    // The workflow strip: small numbered steps, each opens large.
    var flow = FLOWS[current];
    stepsEl.innerHTML = '';
    flowEl.hidden = !flow;
    (flow || []).forEach(function (st, i) {
      var li = el('li', 'flow__step');
      var b = el('button', 'flow__btn');
      b.type = 'button';
      b.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + st.title + '. Opens larger.');
      var fig = el('span', 'flow__thumb flow__thumb--' + st.kind);
      var t = el('img');
      t.src = st.thumb;
      t.alt = '';
      t.loading = 'lazy';
      fig.appendChild(t);
      var lab = el('span', 'flow__label');
      var n = el('span', 'flow__n');
      n.textContent = String(i + 1);
      lab.appendChild(n);
      lab.appendChild(document.createTextNode(st.label));
      b.appendChild(fig);
      b.appendChild(lab);
      b.addEventListener('click', function () { openBox(current, i, b); });
      li.appendChild(b);
      stepsEl.appendChild(li);
    });
  }

  function find(id) { for (var i = 0; i < SCREENS.length; i++) if (SCREENS[i].id === id) return SCREENS[i]; return null; }

  function open(id) {
    if (id === current) return;
    current = id;
    var s = find(id) || HOME;
    img.classList.add('is-swapping');
    var next = new Image();
    next.onload = next.onerror = function () {
      if (current !== id) return; // a later click already moved on
      img.src = src(id, 1200);
      img.srcset = src(id, 1200) + ' 1200w, ' + src(id, 2000) + ' 2000w';
      img.alt = s.alt;
      img.classList.remove('is-swapping');
    };
    next.src = src(id, 1200);
    render();
  }

  // ── The pop-up: one step, large, with arrows to the next ──
  var box = document.querySelector('[data-lightbox]');
  var boxBody = box.querySelector('[data-lightbox-body]');
  var boxTitle = box.querySelector('[data-lightbox-title]');
  var boxCap = box.querySelector('[data-lightbox-cap]');
  var boxStep = box.querySelector('[data-lightbox-step]');
  var boxPrev = box.querySelector('[data-lightbox-prev]');
  var boxNext = box.querySelector('[data-lightbox-next]');
  var boxFlow = null, boxIndex = 0, boxOpener = null;

  function showStep() {
    var flow = FLOWS[boxFlow];
    var st = flow[boxIndex];
    boxBody.innerHTML = '';
    boxBody.className = 'lightbox__body lightbox__body--' + st.kind;
    if (st.kind === 'dialog') {
      // The Save window over the dimmed screen, where the app puts it.
      var scr = el('div', 'lb-screen');
      var base = el('img');
      base.src = src(st.screen, 2000);
      base.alt = '';
      scr.appendChild(base);
      var dim = el('div', 'lb-screen__dim');
      var dlg = el('img', 'lb-screen__dialog');
      var r = SAVE_BOX[st.screen];
      dlg.src = st.img;
      dlg.alt = st.alt;
      dlg.setAttribute('style', 'left:' + ((r[0] + r[2] / 2) / W * 100) + '%;top:' + ((r[1] + r[3] / 2) / H * 100) + '%;width:' + (r[2] / W * 100 * 1.25) + '%');
      dim.appendChild(dlg);
      scr.appendChild(dim);
      boxBody.appendChild(scr);
    } else if (st.kind === 'button') {
      var scr2 = el('div', 'lb-screen');
      var base2 = el('img');
      base2.src = src(st.screen, 2000);
      base2.alt = st.alt;
      scr2.appendChild(base2);
      var b = SAVE_BTN[st.screen];
      var ring = el('span', 'lb-ring');
      ring.setAttribute('style', 'left:' + (b[0] / W * 100) + '%;top:' + (b[1] / H * 100) + '%;width:' + (b[2] / W * 100) + '%;height:' + (b[3] / H * 100) + '%');
      scr2.appendChild(ring);
      boxBody.appendChild(scr2);
    } else if (st.kind === 'pages') {
      st.imgs.forEach(function (u, i) {
        var pg = el('img', 'lb-page');
        pg.src = u;
        pg.alt = st.alts[i];
        boxBody.appendChild(pg);
      });
    } else {
      var one = el('img', 'lb-' + st.kind);
      one.src = st.img;
      one.alt = st.alt;
      boxBody.appendChild(one);
    }
    boxTitle.textContent = st.title;
    boxCap.textContent = st.cap;
    boxStep.textContent = flow.length > 1 ? 'Step ' + (boxIndex + 1) + ' of ' + flow.length : 'How saving works';
    boxPrev.hidden = boxNext.hidden = flow.length < 2;
    boxPrev.disabled = boxIndex === 0;
    boxNext.disabled = boxIndex === flow.length - 1;
  }

  function openBox(flowId, i, opener) {
    boxFlow = flowId;
    boxIndex = i;
    boxOpener = opener || null;
    showStep();
    box.hidden = false;
    document.documentElement.classList.add('has-lightbox');
    box.querySelector('[data-lightbox-close]').focus();
  }

  function closeBox() {
    box.hidden = true;
    document.documentElement.classList.remove('has-lightbox');
    if (boxOpener) boxOpener.focus();
  }

  function stepBox(dir) {
    var n = boxIndex + dir;
    if (n < 0 || n >= FLOWS[boxFlow].length) return;
    boxIndex = n;
    showStep();
  }

  box.querySelector('[data-lightbox-close]').addEventListener('click', closeBox);
  boxPrev.addEventListener('click', function () { stepBox(-1); });
  boxNext.addEventListener('click', function () { stepBox(1); });
  // Clicking the dark area around the panel closes it.
  box.addEventListener('click', function (e) { if (e.target === box) closeBox(); });
  document.addEventListener('keydown', function (e) {
    if (box.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeBox(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepBox(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stepBox(-1); }
    else if (e.key === 'Tab') {
      // Keep focus inside the pop-up while it's open.
      var f = [].filter.call(box.querySelectorAll('button'), function (b) { return !b.hidden && !b.disabled; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // The screen picker above the screenshot. The screenshot itself isn't clickable:
  // it's a picture of the app, and pretending otherwise only disappoints.
  [{ id: 'home', name: 'Home' }].concat(SCREENS).forEach(function (sc) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = sc.name;
    b.setAttribute('data-id', sc.id);
    b.addEventListener('click', function () { open(sc.id); });
    b.addEventListener('mouseenter', function () { if (sc.id !== 'home') preload(sc.id); }, { once: true });
    pills.appendChild(b);
  });
  // The big words further down open their screen here.
  document.querySelectorAll('[data-open]').forEach(function (b) {
    b.addEventListener('mouseenter', function () { preload(b.getAttribute('data-open')); }, { once: true });
    b.addEventListener('click', function () {
      open(b.getAttribute('data-open'));
      document.getElementById('inside').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  render();

  // ── Real thank-you notes, sent from the app by people who allowed quoting ──
  // They drift left in a loop, about 40 pixels a second, slow enough to read a card as it goes
  // by. Hovering, tapping a card, focusing the row or Pause stops them. They stand still as a
  // row you can scroll when every card fits, or when the system asks for less motion (home.css).
  var voices = document.querySelector('[data-voices]');
  var list = document.querySelector('[data-voices-list]');
  if (voices && list && window.fetch) {
    fetch('/api/thanks').then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      var quotes = (data && data.quotes) || [];
      if (!quotes.length) return;
      // Fuller notes first (newest first within each group), then the short ones.
      var full = quotes.filter(function (q) { return q.text.length >= 80; });
      var short = quotes.filter(function (q) { return q.text.length < 80; });
      full.concat(short).slice(0, 14).forEach(function (q) {
        var card = document.createElement('figure');
        card.className = 'voice' + (q.text.length > 240 ? ' voice--long' : q.text.length < 80 ? ' voice--short' : '');
        var t = document.createElement('q');
        t.textContent = q.text;
        var d = document.createElement('small');
        var when = new Date(q.date + 'T12:00:00Z');
        d.textContent = 'Sent from the app' + (isNaN(when) ? '' : ' · ' + when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
        card.appendChild(t);
        card.appendChild(d);
        list.appendChild(card);
      });
      voices.hidden = false;
      drift();
    }).catch(function () {});
  }

  function drift() {
    var track = list.parentNode;
    var viewport = track.parentNode;
    var copy = list.cloneNode(true);
    copy.removeAttribute('data-voices-list');
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('inert', '');
    track.appendChild(copy);

    var pause = voices.querySelector('[data-voices-pause]');
    pause.addEventListener('click', function () {
      var paused = voices.classList.toggle('is-paused');
      pause.textContent = paused ? 'Play' : 'Pause';
    });

    function measure() {
      var width = list.offsetWidth;
      var room = viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft);
      voices.classList.toggle('is-still', width <= room);
      track.style.setProperty('--voices-seconds', Math.max(20, Math.round(width / 40)) + 's');
    }
    measure();
    voices.classList.add('is-ready');
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
  }
})();
