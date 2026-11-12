// Fills every [data-thanks] block with quotes from /api/thanks (api/_lib/thanks.js): thank-yous
// sent from the app by people who ticked "OK to quote", word for word and without names.
//
//   data-thanks-limit="3"   show at most this many (newest first); leave it out to show all
//   [data-thanks-list]      where the cards go
//   [data-thanks-count]     gets "16 people", the number of thank-yous so far
//   [data-thanks-shown]     unhidden once that number is known and above zero
//   [data-thanks-status]    gets a line when there's nothing to show (only on the full page)
//
// A block marked `hidden` stays hidden until it has at least one quote, so pages never show
// an empty box. Quotes are added as text, never as HTML.
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
    article.className = 'testimonial';
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
      return;
    }
    var list = block.querySelector('[data-thanks-list]');
    if (!list) return;
    quotes.forEach(function (q) {
      if (q && typeof q.text === 'string' && q.text) list.appendChild(card(q));
    });
    status(block, '');
    block.hidden = false;
  }

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
      });
    });
})();
