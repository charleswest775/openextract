/* Remembers, for this tab only, which site brought the visitor (a site's name, never a full URL)
   and adds it to the download links, so the download counter (download-counter.mjs) can say where
   downloads come from. No cookies: sessionStorage is cleared when the tab closes. Without this
   script the buttons work exactly the same, the counter just knows less. */
(function () {
  var KEY = "openextract-via";
  var own = location.hostname.replace(/^www\./, "");
  var via = null;
  try {
    via = sessionStorage.getItem(KEY);
  } catch (e) {}

  if (!via) {
    var params = new URLSearchParams(location.search);
    var tagged = (params.get("utm_source") || params.get("ref") || "").toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 60);
    var host = "";
    try {
      host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
    } catch (e) {}
    // First page of the visit: a tagged link, else another site, else no referrer at all.
    via = tagged || (host && host !== own ? host : host ? null : "direct");
    if (via) {
      try {
        sessionStorage.setItem(KEY, via);
      } catch (e) {}
    }
  }

  var links = document.querySelectorAll('a[href^="/download/"]');
  for (var i = 0; i < links.length; i++) {
    var url = new URL(links[i].getAttribute("href"), location.origin);
    if (via) url.searchParams.set("via", via);
    url.searchParams.set("from", location.pathname);
    links[i].setAttribute("href", url.pathname + url.search);
  }
})();
