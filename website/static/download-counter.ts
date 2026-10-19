// Counts clicks on the download buttons (/download/*) for the usage dashboard, then sends the
// browser on to the same path with ?go=1, where vercel.json's redirect to the GitHub installer
// applies (those redirects only match with `go`, because Vercel runs vercel.json redirects before
// middleware and the counter would otherwise never see the click). The count is sent after the
// response, gives up after 3 seconds, and any failure is swallowed: it can never delay or break a
// download. What's sent: which button, the site that sent the visitor (from download-source.js,
// or the Referer header), the page the button was on, and the visitor's country as Vercel reports
// it. No IP address, no cookies, nothing about the person.

export const config = { matcher: "/download/:path*" };

const USAGE = "https://usage-dashboard.charles-west.workers.dev/v1/events";
const BUTTONS = {
  mac: { platform: "mac" },
  windows: { platform: "windows" },
  linux: { platform: "linux", label: ".deb" },
  "linux-appimage": { platform: "linux", label: "AppImage" },
};
const BOTS = /bot|crawl|spider|slurp|preview|monitor|headless|curl|wget|python|go-http/i;
const OWN_SITE = /(^|\.)openextract\.app$|\.vercel\.app$/;

export default function downloadCounter(request, context) {
  try {
    const url = new URL(request.url);
    const button = BUTTONS[url.pathname.replace(/^\/download\/|\/+$/g, "")];
    // Already counted and on its way to GitHub (or a path with no button): nothing to do here.
    if (!button || url.searchParams.has("go")) return next();
    if (request.method === "GET" && !BOTS.test(request.headers.get("user-agent") ?? "")) {
      const body = JSON.stringify({
        app: "openextract",
        country: request.headers.get("x-vercel-ip-country") || undefined,
        events: [
          {
            name: "download_click",
            platform: button.platform,
            props: { label: button.label, via: via(url, request), page: page(url) },
          },
        ],
      });
      context?.waitUntil?.(
        fetch(USAGE, {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(3000),
        }).catch(() => {}),
      );
    }
  } catch {
    // Counting must never get in the way of the download.
  }
  return onToGitHub(request);
}

/** On to vercel.json's redirect for this button: same path, with ?go=1. */
function onToGitHub(request) {
  try {
    const url = new URL(request.url);
    return new Response(null, { status: 302, headers: { Location: `${url.pathname}?go=1`, "Cache-Control": "no-store" } });
  } catch {
    return next();
  }
}

/** Let the request carry on untouched. */
function next() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}

/** The site that sent the visitor: from the link (download-source.js), else the Referer. */
function via(url, request) {
  const given = url.searchParams.get("via");
  if (given && /^[a-z0-9.-]{1,60}$/i.test(given)) return given.toLowerCase();
  const referer = request.headers.get("referer");
  if (!referer) return "direct";
  try {
    const host = new URL(referer).hostname.replace(/^www\./, "");
    return OWN_SITE.test(host) ? "unknown" : host;
  } catch {
    return "unknown";
  }
}

/** The page the button was on, e.g. "/" or "/how-it-works". */
function page(url) {
  const from = url.searchParams.get("from");
  return from && /^\/[\w./-]{0,60}$/.test(from) ? from : undefined;
}
