// /ai/thanks?session_id=cs_...: asks /api/ai-key for the key this checkout bought, and shows it.
(function () {
  'use strict';

  /** What to say about a key: which iPhone, and until when. */
  function describe(got) {
    var phone = 'the iPhone with phone code ' + got.phone;
    if (got.kind === 'week') return 'For ' + phone + ', through ' + got.until + '.';
    return 'For ' + phone + ', for good.';
  }

  /** The text "Copy it for your AI app" puts on the clipboard: the key, with a line saying what it is. */
  function message(key) {
    return 'Here is my OpenExtract AI key: ' + key;
  }

  function start() {
    var root = document.querySelector('[data-ai-key]');
    if (!root) return;
    var status = root.querySelector('[data-status]');
    var session = new URLSearchParams(location.search).get('session_id') || '';
    var attempts = 0;

    function load() {
      attempts += 1;
      fetch('/api/ai-key?session_id=' + encodeURIComponent(session), { cache: 'no-store' })
        .then(function (res) { return res.json().then(function (body) { return { res: res, body: body }; }); })
        .then(function (r) {
          if (r.res.ok && r.body.key) return showKey(r.body);
          // Stripe can take a moment to mark a fresh payment paid: try again a few times
          if (r.res.status === 402 && attempts < 6) return setTimeout(load, 3000);
          status.textContent = r.body.error || 'Your key couldn’t be shown. Reload this page to try again.';
        })
        .catch(function () { status.textContent = 'Your key couldn’t be shown. Reload this page to try again.'; });
    }

    function showKey(got) {
      status.hidden = true;
      root.querySelector('[data-got]').hidden = false;
      root.querySelector('[data-for]').textContent = describe(got);
      root.querySelector('[data-key]').textContent = got.key;
      root.addEventListener('click', function (event) {
        var button = event.target.closest('[data-copy]');
        if (!button) return;
        var text = button.getAttribute('data-copy') === 'message' ? message(got.key) : got.key;
        navigator.clipboard.writeText(text).then(function () {
          root.querySelector('[data-copied]').textContent = 'Copied.';
        }, function () {
          root.querySelector('[data-copied]').textContent = 'Select the key above and copy it.';
        });
      });
    }

    load();
  }

  if (typeof module !== 'undefined') module.exports = { describe: describe, message: message };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
