/**
 * HazPost service worker.
 *
 * Placarding calls get made on docks and in yards with no signal, so the app
 * has to answer from cache first, every time, and refresh quietly in the
 * background when there is a connection.
 *
 * PATHS — read this before changing anything here.
 *
 * HazPost is a GitHub Pages *project* site: it lives at /HazPost/, not at a
 * domain root. Every URL in this file is therefore relative, and every
 * relative URL is resolved explicitly against `self.registration.scope`
 * (which is /HazPost/ in production and / when the repo is served at a root
 * for local testing). Hardcoding "/index.html" would resolve to the domain
 * root, precache the GitHub Pages 404 page, and serve that to drivers — the
 * classic project-page failure.
 *
 * RELEASING: bump APP_VERSION in index.html, version.txt and APP_BUILD below
 * to the same number, and bump VERSION. The first three are one number and
 * tools/test-update.mjs fails if they drift. VERSION names the cache: a new
 * worker installs into a fresh cache and drops the old ones on activate.
 */

const VERSION = "v1.10.0";

/**
 * The app build this worker ships with. It must equal APP_VERSION in
 * index.html and the whole of version.txt; tools/test-update.mjs holds the
 * three together. It is also what makes sw.js change on every release, and a
 * byte change in sw.js is the only thing that makes a browser install a new
 * worker, so a release that skipped it would never reach a phone.
 */
const APP_BUILD = "0.12.0";
const CACHE = `hazpost-${VERSION}`;

/** Where the cache-refresh timestamp lives, for the offline indicator. */
const META_PATH = "__cache-meta";

/** Resolve a scope-relative path to an absolute URL. */
const url = (p) => new URL(p, self.registration.scope).toString();

/** The APP_VERSION a page declares, or null. The same anchored pattern as
 *  extractVersion() in index.html. */
const buildOf = (html) => (String(html).match(/^\s*const\s+APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/m) || [])[1] || null;

/** Is this the app shell — the page itself, by whatever URL it was asked for? */
const isShell = (request) => request.mode === "navigate" || request.url === url("./") || request.url === url("index.html");

/**
 * Fetch a file for the cache past every cache between here and the server.
 *
 * GitHub Pages sends max-age=600 on everything, so for ten minutes after any
 * fetch the browser's HTTP cache answers a plain request with the copy it
 * already holds. A worker installed in that window would precache the build
 * it is replacing and reload the driver straight back into it. cache:
 * "no-cache" makes the browser check with the server every time, and the
 * ?v= stamp is a key the CDN has never seen, so its edge cannot answer from
 * an older deploy either. Callers store the response under the plain URL,
 * which is what the app asks for.
 */
async function fetchFresh(p) {
  const u = new URL(url(p));
  u.searchParams.set("v", APP_BUILD);
  const res = await fetch(new Request(u.toString(), { cache: "no-cache" }));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res;
}

/**
 * The app shell. If any of these fail the install fails and the old worker
 * stays in charge — better a stale app that works than a half-cached one.
 */
const SHELL = ["./", "index.html", "hazmat.json", "segregation.json", "ops.json", "papers.json", "incident.json", "carry.json", "manifest.json"];

/**
 * Wanted, but not worth failing an install over: icons a running app never
 * requests, and the Google Fonts stylesheet, which is cross-origin and may be
 * blocked or simply unreachable at install time.
 */
const OPTIONAL = [
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/* ------------------------------------------------------------------ */

async function writeMeta(cache, patch) {
  let meta = {};
  try {
    const prev = await cache.match(url(META_PATH));
    if (prev) meta = await prev.json();
  } catch { /* first run, or a meta entry we can't read — start fresh */ }
  const next = { ...meta, ...patch, version: VERSION };
  await cache.put(
    url(META_PATH),
    new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } })
  );
}

/** Cap on the optional half of install. */
const OPTIONAL_TIMEOUT = 10000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // The shell must land in full or the install fails and the previous
    // worker stays in charge.
    const shell = await Promise.all(SHELL.map(async (p) => [url(p), await fetchFresh(p)]));

    // This worker's own build, or no install at all. A page from any other
    // build — a deploy still propagating, a release that bumped sw.js but not
    // the page — is refused before anything is written, so the old worker
    // stays in charge and the next check tries again. Installing it would
    // reload the driver into a build this worker was not written for.
    for (const [key, res] of shell) {
      if (key !== url("./") && key !== url("index.html")) continue;
      const got = buildOf(await res.clone().text());
      if (got !== APP_BUILD) throw new Error(`${key} is build ${got}; this worker is ${APP_BUILD}`);
    }

    const cache = await caches.open(CACHE);
    await Promise.all(shell.map(([key, res]) => cache.put(key, res)));

    const now = new Date().toISOString();
    await writeMeta(cache, { refreshed: now, installed: now });

    // Icons and fonts are best effort and never fatal — but the worker does
    // not become active until install settles, so they get a deadline too.
    // A CDN that hangs must not hold back a release: the app is already
    // usable the moment the shell is cached.
    await Promise.race([
      Promise.allSettled([...OPTIONAL.map(async (p) => cache.put(url(p), await fetchFresh(p))), cacheFonts(cache)]),
      new Promise((r) => setTimeout(r, OPTIONAL_TIMEOUT)),
    ]);

    // Deliberately NO skipWaiting() here. A worker that activates on its own
    // claims the open page, which then keeps running the previous index.html
    // against assets from the new cache — or gets reloaded out from under a
    // driver halfway through typing a load off a shipping paper. The new
    // worker waits until the page asks, and the page only asks when the
    // driver taps the version footer. See the "skip" message below.
  })());
});

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&family=Atkinson+Hyperlegible+Mono:wght@400..700&family=Source+Serif+4:ital,wght@0,400;1,400&display=swap";

/**
 * Cache the Google Fonts stylesheet and the font files it points at.
 *
 * The gstatic URLs are minted per user-agent and only appear inside the
 * stylesheet, so they cannot be listed ahead of time — the CSS has to be read
 * to find them. If the font CDN is unreachable this does nothing at all: the
 * stylesheet is decoration, and the app falls back to system sans-serif.
 */
async function cacheFonts(cache) {
  let css = "";
  try {
    const res = await fetch(FONT_CSS, { mode: "cors" });
    if (!res.ok) return;
    css = await res.clone().text();
    await cache.put(FONT_CSS, res);
  } catch {
    return; // offline at install, or the CDN is blocked
  }
  const files = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)"']+/g) || [])];
  await Promise.allSettled(files.map((u) => cache.add(u)));
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith("hazpost-") && n !== CACHE).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ */

function isFont(u) {
  return FONT_HOSTS.includes(u.hostname);
}

/** In scope means: same origin, and under the registration scope. */
function inScope(u) {
  return u.href.startsWith(self.registration.scope);
}

/**
 * Cache first, then refresh in the background.
 *
 * A cached response is returned immediately and the network copy is written
 * back for next time. Nothing in this app is time-sensitive within a single
 * session — hazmat.json changes when the CFR is amended — so answering
 * instantly and being one launch behind is the right trade.
 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  // ignoreVary: every URL here has exactly one representation, and Google
  // Fonts varies its stylesheet on User-Agent — without this, the cached CSS
  // never matches the page's own request for it.
  const cached = await cache.match(request, { ignoreVary: true });

  // Our own files revalidate with the server rather than taking the browser
  // HTTP cache's word for it (see fetchFresh). Derived from the request
  // itself, not rebuilt from its URL: a navigation keeps redirect "manual", so
  // a redirect still reaches the browser as one instead of failing the page.
  // The fonts never change under a URL, so they take whatever the browser has.
  const own = inScope(new URL(request.url));
  const fresh = fetch(own ? new Request(request, { cache: "no-cache" }) : request)
    .then(async (res) => {
      // Opaque responses (no-cors) have status 0; they are still worth storing
      // for fonts, but a failed same-origin request must not overwrite a good
      // cache entry.
      if (res && (res.ok || res.type === "opaque")) {
        // A worker serves its own build and nothing else. A newer page goes
        // to the screen when there is nothing cached to show, but it is not
        // written into this cache: it arrives with its own worker, on the
        // driver's tap. Caching it here would run new code against this
        // build's data, and a later install could swap it back.
        if (own && isShell(request) && buildOf(await res.clone().text()) !== APP_BUILD) return res;
        await cache.put(request, res.clone());
        if (request.url === url("hazmat.json")) {
          await writeMeta(cache, { refreshed: new Date().toISOString() });
        }
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    fresh.catch(() => {}); // keep it running, don't let the rejection escape
    return cached;
  }
  const res = await fresh;
  if (res) return res;
  throw new Error(`offline and uncached: ${request.url}`);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const u = new URL(request.url);

  // The update check, and anything else marked _cb, must only ever be
  // answered by the live server — never from this cache, and never written
  // into it. Passing it through untouched leaves the request's own
  // cache:"no-store" in charge.
  const live = u.searchParams.has("_cb") || (inScope(u) && u.pathname.endsWith("/version.txt"));
  if (live && request.mode !== "navigate") return;

  // Navigations: always land on the cached shell when the network is gone,
  // whatever path within scope was requested. A _cb navigation goes to the
  // network and is never cached; offline it falls back like any other.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return live ? await fetch(request) : await staleWhileRevalidate(request);
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(url("index.html"), { ignoreVary: true })) ||
          (await cache.match(url("./"), { ignoreVary: true })) ||
          new Response("HazPost is not cached yet. Open it once with a connection.", {
            status: 503, headers: { "Content-Type": "text/plain" },
          });
      }
    })());
    return;
  }

  if (!inScope(u) && !isFont(u)) return; // not ours — let the network have it

  event.respondWith(
    staleWhileRevalidate(request).catch(
      () => new Response("", { status: 504, statusText: "Offline and uncached" })
    )
  );
});

self.addEventListener("message", (event) => {
  /** Which build and cache generation this worker serves. The page asks
   *  before an install: a worker already serving a newer build than the page
   *  means a reload is the whole update. Answered on the port the page sent,
   *  or to the page itself. */
  const reply = (msg) => (event.ports && event.ports[0] ? event.ports[0].postMessage(msg) : event.source?.postMessage(msg));
  if (event.data === "version") reply({ type: "version", version: VERSION, build: APP_BUILD });

  /** The page's explicit go-ahead to take over. Sent only when the driver taps
   *  the version footer, never by a background check: activating here triggers
   *  clients.claim(), which the page answers with a reload. */
  if (event.data === "skip") self.skipWaiting();
});
