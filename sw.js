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
 * Bump VERSION on every release. The cache name carries it, so a new worker
 * installs into a fresh cache and drops the old ones on activate.
 */

const VERSION = "v1.0.0";
const CACHE = `hazpost-${VERSION}`;

/** Where the cache-refresh timestamp lives, for the offline indicator. */
const META_PATH = "__cache-meta";

/** Resolve a scope-relative path to an absolute URL. */
const url = (p) => new URL(p, self.registration.scope).toString();

/**
 * The app shell. If any of these fail the install fails and the old worker
 * stays in charge — better a stale app that works than a half-cached one.
 */
const SHELL = ["./", "index.html", "hazmat.json", "manifest.json"];

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
    const cache = await caches.open(CACHE);

    // The shell must land in full or the install fails and the previous
    // worker stays in charge.
    await cache.addAll(SHELL.map(url));

    const now = new Date().toISOString();
    await writeMeta(cache, { refreshed: now, installed: now });

    // Icons and fonts are best effort and never fatal — but the worker does
    // not become active until install settles, so they get a deadline too.
    // A CDN that hangs must not hold back a release: the app is already
    // usable the moment the shell is cached.
    await Promise.race([
      Promise.allSettled([...OPTIONAL.map((p) => cache.add(url(p))), cacheFonts(cache)]),
      new Promise((r) => setTimeout(r, OPTIONAL_TIMEOUT)),
    ]);

    // Take over as soon as the new worker is ready rather than waiting for
    // every tab to close — a driver reopening the app should get the update.
    await self.skipWaiting();
  })());
});

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700;800&family=Barlow+Condensed:wght@600;700&family=Roboto+Mono:wght@400;500;700&display=swap";

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

  const fresh = fetch(request)
    .then(async (res) => {
      // Opaque responses (no-cors) have status 0; they are still worth storing
      // for fonts, but a failed same-origin request must not overwrite a good
      // cache entry.
      if (res && (res.ok || res.type === "opaque")) {
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

  // Navigations: always land on the cached shell when the network is gone,
  // whatever path within scope was requested.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await staleWhileRevalidate(request);
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

/** Lets the page ask which version is actually serving it. */
self.addEventListener("message", (event) => {
  if (event.data === "version") event.source?.postMessage({ type: "version", version: VERSION });
});
