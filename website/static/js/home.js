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

  // The Save window each screen opens, cut from the real app at the same size and place.
  // box: where the window sits on the 1440 × 900 screen.
  var SAVES = {
    messages: { box: [496, 222, 448, 456], name: 'Saving a conversation',
      cap: 'Pick how you want it: a web page, a PDF to read or print, a spreadsheet or plain text. Then choose where it goes on your computer.',
      alt: 'The Save window for a conversation with Karin Lindqvist: web page, readable document (PDF), spreadsheet (CSV) or plain text.' },
    'address-book': { box: [496, 307, 448, 287], name: 'Saving contacts',
      cap: 'Contact cards import into Contacts, Outlook or Google. The spreadsheet opens in Excel, Numbers or Google Sheets.',
      alt: 'The Save contacts window: contact cards (vCard) or a spreadsheet (CSV).' },
    notes: { box: [496, 307, 448, 287], name: 'Saving a note',
      cap: 'Keep a note as a PDF to read or print, or as plain text for any editor.',
      alt: 'The Save window for the note "Groceries": readable document (PDF) or plain text.' }
  };

  // Real files the app saved from the sample backup: what you end up with.
  var FILES = {
    messages: {
      pdf: { name: 'The PDF it saves', title: 'Karin Lindqvist, Jul 5 2024 - Jun 21 2026.pdf',
        cap: 'Every message and photo in the conversation, with names, dates and times. 20 pages that open anywhere and print well.',
        pages: ['/img/home/file-messages-pdf-p1-900.webp', '/img/home/file-messages-pdf-p19-900.webp'],
        alt: ['Page 1 of the saved PDF: the start of the conversation with Karin, in message bubbles with dates and times.',
          'Page 19 of the saved PDF: the photo of Diablo Lake and the messages around it.'] },
      web: { name: 'The web page it saves', title: 'Karin Lindqvist, Jul 5 2024 - Jun 21 2026.html',
        cap: 'The same conversation as a page that opens in any browser, with the photos saved in a folder beside it.',
        img: 'file-messages-web', alt: 'The saved web page open in a browser, with the Diablo Lake photo in the conversation.' }
    }
  };
  var VIEW_LABELS = { app: 'In the app', save: 'Save window', pdf: 'PDF', web: 'Web page' };

  var img = document.querySelector('[data-demo-img]');
  var cap = document.querySelector('[data-demo-cap]');
  var saves = document.querySelector('[data-demo-saves]');
  var title = document.querySelector('[data-demo-title]');
  var nameEl = document.querySelector('[data-demo-name]');
  var pills = document.querySelector('[data-demo-pills]');
  var viewsEl = document.querySelector('[data-demo-views]');
  var layer = document.querySelector('[data-demo-save]');
  var layerImg = layer.querySelector('img');
  var fileLayer = document.querySelector('[data-demo-file]');
  var current = 'home';
  var view = 'app';

  function src(id, w) { return '/img/home/' + id + '-' + w + '.webp'; }
  function preload(id) { var i = new Image(); i.src = src(id, 1200); }
  function preloadUrl(u) { var i = new Image(); i.src = u; }
  function preloadViews(id) {
    if (SAVES[id]) preloadUrl('/img/home/save-' + id + '-900.webp');
    var f = FILES[id] || {};
    Object.keys(f).forEach(function (k) { (f[k].pages || [src(f[k].img, 1200)]).forEach(preloadUrl); });
  }

  // The views one screen has: the screen itself, its Save window, and the files it makes.
  function viewsFor(id) {
    var v = [];
    if (SAVES[id] || FILES[id]) v.push('app');
    if (SAVES[id]) v.push('save');
    Object.keys(FILES[id] || {}).forEach(function (k) { v.push(k); });
    return v;
  }

  function render() {
    var s = find(current) || HOME;
    var sv = SAVES[current];
    var file = (FILES[current] || {})[view];

    // The Save window, over a dimmed screen, like the app shows it.
    if (view === 'save' && sv) {
      layerImg.src = '/img/home/save-' + current + '-900.webp';
      layerImg.srcset = '/img/home/save-' + current + '-600.webp 600w, /img/home/save-' + current + '-900.webp 900w';
      layerImg.alt = sv.alt;
      // Centred where the app puts it; CSS decides how much larger than life to draw it.
      layerImg.setAttribute('style', '--cx:' + ((sv.box[0] + sv.box[2] / 2) / W * 100) + ';--cy:' + ((sv.box[1] + sv.box[3] / 2) / H * 100) + ';--w:' + (sv.box[2] / W * 100));
      layer.hidden = false;
    } else {
      layer.hidden = true;
    }

    // A saved file, opened the way you would on your computer.
    fileLayer.innerHTML = '';
    if (file) {
      if (file.pages) {
        var desk = document.createElement('div');
        desk.className = 'desk';
        file.pages.forEach(function (u, i) {
          var pg = document.createElement('img');
          pg.className = 'paper paper--' + (i === 0 ? 'back' : 'front');
          pg.src = u;
          pg.alt = file.alt[i];
          desk.appendChild(pg);
        });
        fileLayer.appendChild(desk);
        fileLayer.className = 'demo__file demo__file--pdf';
      } else {
        var shot = document.createElement('img');
        shot.src = src(file.img, 1200);
        shot.srcset = src(file.img, 1200) + ' 1200w, ' + src(file.img, 2000) + ' 2000w';
        shot.alt = file.alt;
        fileLayer.appendChild(shot);
        fileLayer.className = 'demo__file demo__file--web';
      }
      fileLayer.hidden = false;
    } else {
      fileLayer.hidden = true;
    }

    var named = view === 'save' && sv ? sv : file || s;
    nameEl.textContent = named.name;
    cap.textContent = named.cap;
    saves.textContent = view === 'app' && s.saves ? 'Saves as ' + s.saves : '';
    title.textContent = file ? file.title : current === 'home' ? "OpenExtract · Maren's iPhone (sample)" : "OpenExtract · Maren's iPhone › " + s.name;

    // The view switch under the caption, for screens that have more to show.
    var vs = viewsFor(current);
    viewsEl.innerHTML = '';
    viewsEl.hidden = vs.length < 2;
    vs.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = VIEW_LABELS[v];
      b.setAttribute('aria-pressed', v === view ? 'true' : 'false');
      b.addEventListener('click', function () { setView(v); });
      viewsEl.appendChild(b);
    });
    Array.prototype.forEach.call(pills.children, function (p) { p.setAttribute('aria-pressed', p.getAttribute('data-id') === current ? 'true' : 'false'); });
  }

  function find(id) { for (var i = 0; i < SCREENS.length; i++) if (SCREENS[i].id === id) return SCREENS[i]; return null; }

  function setView(v) {
    view = viewsFor(current).indexOf(v) >= 0 ? v : 'app';
    render();
  }

  function open(id) {
    if (id === current) { setView('app'); return; }
    current = id;
    view = 'app';
    preloadViews(id);
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
  document.querySelector('[data-demo-stage]').addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && view !== 'app') { e.preventDefault(); setView('app'); }
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
  var voices = document.querySelector('[data-voices]');
  var track = document.querySelector('[data-voices-track]');
  if (voices && window.fetch) {
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
        track.appendChild(card);
      });
      voices.hidden = false;
    }).catch(function () {});
    function step(dir) { track.scrollBy({ left: dir * Math.min(track.clientWidth * 0.8, 460), behavior: 'smooth' }); }
    document.querySelector('[data-voices-prev]').addEventListener('click', function () { step(-1); });
    document.querySelector('[data-voices-next]').addEventListener('click', function () { step(1); });
  }
})();
