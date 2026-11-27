// /ai/buy: the phone code from the add-on's link (?phone=7F3KQ9M2), and the two payment links with it.
// Stripe keeps the code as the checkout's client_reference_id, and /api/ai-key puts it in the key.
(function () {
  'use strict';
  var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  /** A phone code as typed, in its stored form, or null. The same rules as the add-on and api/_lib/ai-key.js. */
  function cleanCode(text) {
    var code = String(text == null ? '' : text).replace(/\s+/g, '').replace(/-/g, '').toUpperCase()
      .replace(/O/g, '0').replace(/[IL]/g, '1');
    if (code.length !== 8) return null;
    for (var i = 0; i < code.length; i++) if (CROCKFORD.indexOf(code[i]) < 0) return null;
    return code;
  }

  /** A payment link with the phone code added (Stripe takes client_reference_id from the address). */
  function payLink(base, code) {
    if (!/^https:\/\/buy\.stripe\.com\//.test(base || '') || !code) return null;
    return base + (base.indexOf('?') < 0 ? '?' : '&') + 'client_reference_id=' + encodeURIComponent(code);
  }

  function show(root, code) {
    var links = { phone: root.getAttribute('data-link-phone'), week: root.getAttribute('data-link-week') };
    var open = !!(payLink(links.phone, 'X') && payLink(links.week, 'X'));
    root.querySelector('[data-code-shown]').textContent = code ? code.slice(0, 4) + '-' + code.slice(4) : '—';
    root.querySelector('[data-code-form]').hidden = !!code;
    root.querySelector('[data-closed]').hidden = open;
    var buttons = root.querySelectorAll('[data-buy]');
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      var href = open ? payLink(links[button.getAttribute('data-buy')], code) : null;
      if (href) {
        button.setAttribute('href', href);
        button.removeAttribute('aria-disabled');
      } else {
        button.setAttribute('href', '#');
        button.setAttribute('aria-disabled', 'true');
      }
    }
  }

  function start() {
    var root = document.querySelector('[data-ai-buy]');
    if (!root) return;
    var code = cleanCode(new URLSearchParams(location.search).get('phone'));
    show(root, code);
    root.querySelector('[data-code-form]').addEventListener('submit', function (event) {
      event.preventDefault();
      var typed = cleanCode(root.querySelector('#code').value);
      if (!typed) {
        root.querySelector('#code').setCustomValidity('A phone code is eight letters and numbers, like 7F3K-Q9M2.');
        root.querySelector('#code').reportValidity();
        return;
      }
      history.replaceState(null, '', '?phone=' + typed);
      show(root, typed);
    });
    root.querySelector('#code').addEventListener('input', function () { this.setCustomValidity(''); });
    root.addEventListener('click', function (event) {
      var button = event.target.closest('[data-buy]');
      if (button && button.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
  }

  if (typeof module !== 'undefined') module.exports = { cleanCode: cleanCode, payLink: payLink, show: show };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
