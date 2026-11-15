// Fills every [data-thanks] block with quotes from /api/thanks (api/_lib/thanks.js): thank-yous
// sent from the app by people who ticked "OK to quote", word for word and without names.
//
//   data-thanks-limit="3"   show at most this many (newest first); leave it out to show all
//   [data-thanks-list]      where the cards go
//   [data-thanks-count]     gets "16 people", the number of thank-yous so far
//   [data-thanks-shown]     unhidden once that number is known and above zero
//   [data-thanks-status]    gets a line when there's nothing to show (only on the full page)
//   data-thanks-ribbon      the cards drift sideways in a loop instead of sitting in a grid;
//                           see ribbon() below
//   [data-thanks-pause]     a ribbon's pause button
//
// A block marked `hidden` stays hidden until it has at least one quote, so pages never show
// an empty box. A ribbon is the exception: it shows (empty, at its final height) as soon as
// this script runs, and hides again if no quotes come. Quotes are added as text, never as HTML.
(function () {
  var blocks = document.querySelectorAll('[data-thanks]');
  if (!blocks.length || !window.fetch) return;

  function when(date) {
    var d = new Date(date + 'T12:00:00Z');
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function card(q) {
    var article = document.createElement('article');
    // The ribbon sizes cards by length, so a long note is never cut short and a short one
    // doesn't sit in a wide, empty card.
    var size = q.text.length < 90 ? 'short' : q.text.length < 220 ? 'medium' : 'long';
    article.className = 'testimonial testimonial--' + size;
    var glyph = document.createElement('div');
    glyph.className = 'testimonial__quote-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '“';
    var quote = document.createElement('blockquote');
    quote.className = 'testimonial__quote';
    quote.textContent = q.text;
    var foot = document.createElement('div');
    foot.className = 'testimonial__loc';
    var parts = ['Sent from the app'];
    if (q.area && q.area !== 'The app in general') parts.push(q.area);
    if (when(q.date)) parts.push(when(q.date));
    foot.textContent = parts.join(' · ');
    article.appendChild(glyph);
    article.appendChild(quote);
    article.appendChild(foot);
    return article;
  }

  // A ribbon drifts left in a loop. Its list of cards is followed by a copy that screen
  // readers and the keyboard skip, and the track moves by exactly one list's width
  // (quote-ribbon-drift in site.css), so the loop has no seam. It stands still, as a row you
  // can scroll, when the cards fit on screen or the visitor's system asks for less motion.
  // Hovering it, tapping a card, focusing inside it or the pause button stops it.
  //
  // A ribbon is shown before the quotes arrive, at the height of one card (--ribbon-card-h in
  // site.css), so the page under it doesn't jump when they do. A card whose words don't fit in
  // that height gets wider instead of taller, up to a limit.
  function isRibbon(block) {
    return block.hasAttribute('data-thanks-ribbon');
  }

  function fit(list, viewport) {
    var cards = list.children;
    var widest = Math.min(640, viewport.clientWidth * 0.86);
    list.classList.add('is-fitting');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      c.style.width = '';
      var tall = parseFloat(getComputedStyle(c).minHeight) || 0;
      while (c.offsetHeight > tall + 1 && c.offsetWidth + 40 <= widest) {
        c.style.width = c.offsetWidth + 40 + 'px';
      }
    }
    list.classList.remove('is-fitting');
  }

  function ribbon(block) {
    var list = block.querySelector('[data-thanks-list]');
    var track = list && list.parentNode;
    var viewport = track && track.parentNode;
    if (!viewport) return;
    fit(list, viewport);
    var copy = list.cloneNode(true);
    copy.removeAttribute('data-thanks-list');
    copy.setAttribute('aria-hidden', 'true');
    copy.setAttribute('inert', '');
    track.appendChild(copy);

    var pause = block.querySelector('[data-thanks-pause]');
    if (pause) {
      pause.addEventListener('click', function () {
        var paused = block.classList.toggle('is-paused');
        pause.textContent = paused ? 'Play' : 'Pause';
      });
    }

    function measure() {
      fit(list, viewport);
      for (var i = 0; i < list.children.length; i++) {
        copy.children[i].style.width = list.children[i].style.width;
      }
      var width = list.offsetWidth;
      block.classList.toggle('is-still', width <= viewport.clientWidth);
      // About 40 pixels a second: slow enough to read a card as it goes by.
      track.style.setProperty('--ribbon-seconds', Math.max(20, Math.round(width / 40)) + 's');
    }
    measure();
    block.classList.add('is-ready');
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
  }

  function status(block, text) {
    var el = block.querySelector('[data-thanks-status]');
    if (el) el.textContent = text;
  }

  function fill(block, data) {
    var count = typeof data.thanks === 'number' ? data.thanks : 0;
    block.querySelectorAll('[data-thanks-count]').forEach(function (el) {
      el.textContent = count === 1 ? '1 person' : count.toLocaleString('en-US') + ' people';
    });
    if (count > 0) {
      block.querySelectorAll('[data-thanks-shown]').forEach(function (el) {
        el.hidden = false;
      });
    }
    var limit = parseInt(block.getAttribute('data-thanks-limit') || '0', 10);
    var quotes = limit > 0 ? data.quotes.slice(0, limit) : data.quotes;
    if (!quotes.length) {
      status(block, 'No quotes yet. The first ones are on their way.');
      if (isRibbon(block)) block.hidden = true;
      return;
    }
    var list = block.querySelector('[data-thanks-list]');
    if (!list) return;
    quotes.forEach(function (q) {
      if (q && typeof q.text === 'string' && q.text) list.appendChild(card(q));
    });
    status(block, '');
    block.hidden = false;
    if (isRibbon(block)) ribbon(block);
  }

  blocks.forEach(function (block) {
    if (isRibbon(block)) block.hidden = false;
  });

  fetch('/api/thanks', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (!data || !Array.isArray(data.quotes)) throw new Error('no quotes');
      blocks.forEach(function (block) {
        fill(block, data);
      });
    })
    .catch(function () {
      blocks.forEach(function (block) {
        status(block, "The quotes couldn't load just now. Try again in a minute.");
        if (isRibbon(block)) block.hidden = true;
      });
    });
})();
