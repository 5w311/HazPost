#!/usr/bin/env node
/**
 * The update check, the install, and the release discipline they depend on.
 *
 *   node tools/test-update.mjs
 *
 * Held to the same standard as FuelPost's:
 *
 *  - The check asks for version.txt, seven bytes, never the whole app, and
 *    reads it strictly. A captive portal, a 404 page or index.html served by
 *    mistake are all "text that came back 200"; read loosely, any of them
 *    becomes a version number on a driver's screen.
 *  - If version.txt is missing or unreadable it falls back to reading
 *    APP_VERSION out of the live index.html. Losing the check is worse than
 *    paying for the big fetch once. Neither fetch may hang the check.
 *  - It runs silently on load and every time the app returns to the
 *    foreground, and out loud on a tap. Either way it can only surface an
 *    update. Installing one takes a second, explicit tap, and that tap always
 *    lands on the new build or says why not — it never spins.
 *  - version.txt, APP_VERSION and the worker's APP_BUILD are one number. The
 *    worker's copy is what makes sw.js change on every release, and only a
 *    changed sw.js gets installed on a phone.
 *  - CI runs the whole suite on every pull request and every push to main.
 *
 * And because HazPost has an offline cache where FuelPost has none, the
 * worker is held to FuelPost's "the reload cannot land on a stale copy": it
 * caches the live build past the browser's HTTP cache, or nothing, and serves
 * its own build and no other.
 */

import { report, appWith, SRC, ROOT } from "./test-harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const r = report("HazPost — the update check, the install and the release discipline");

const APP = (SRC.match(/^const APP_VERSION = "([^"]+)";$/m) || [])[1];
const SW_SRC = readFileSync(join(ROOT, "sw.js"), "utf8");
const BUILD = (SW_SRC.match(/^const APP_BUILD = "([^"]+)";$/m) || [])[1];
const CACHE = `hazpost-${(SW_SRC.match(/^const VERSION = "([^"]+)";$/m) || [])[1]}`;
const listOf = (name) => [...(SW_SRC.match(new RegExp(String.raw`const ${name}\s*=\s*\[([\s\S]*?)\];`)) || ["", ""])[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const SHELL = listOf("SHELL");
const OPTIONAL = listOf("OPTIONAL");
const SCOPE = "https://example.test/HazPost/";
const buildOf = (html) => (String(html).match(/^\s*const\s+APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/m) || [])[1] || null;
const pageOf = (v) => SRC.replace(/^const APP_VERSION = "[^"]+";$/m, `const APP_VERSION = "${v}";`);

const tick = () => new Promise((res) => setTimeout(res, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const foot = (app) => app.verFootText();
const skips = (sw) => sw.sent.filter((m) => m === "skip").length;

/* A booted app whose own timers — the notes that give way after a few
   seconds, the install fallback — run as usual but do not hold the test
   process open once the assertions are done. */
async function boot({ serviceWorker = null } = {}) {
  const app = await appWith({ serviceWorker });
  app.setTimeout = (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); t.unref?.(); return t; };
  await settle();
  return app;
}

/* The app's timers on a clock the test turns by hand, so a 30-second bound is
   tested as a 30-second bound without anyone waiting 30 seconds. Promises
   settle between timers, as they would in a browser. */
function clockFor(app) {
  let now = 0, seq = 0;
  const timers = new Map();
  app.setTimeout = (f, ms = 0, ...a) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), f, a }); return id; };
  app.clearTimeout = (id) => { timers.delete(id); };
  return {
    get now() { return now; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.f(...next.t.a);
      }
      now = end;
      await settle();
    },
  };
}

/* Reloads and navigations, counted rather than performed. */
function watchNav(app) {
  const nav = { reloads: 0, before: app.location.href };
  app.location.reload = () => { nav.reloads++; };
  return nav;
}

const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => body, json: async () => JSON.parse(body) });
const nameOf = (url) => String(url).split("?")[0].replace(/^.*\//, "");

/** Answer version.txt (and optionally index.html) with what a test needs, and
    let everything else through to the repo as usual. */
function serve(app, { version, page, fail } = {}) {
  const real = app.fetch;
  app.fetch = async (url, opts) => {
    const name = nameOf(url);
    if (fail && fail.includes(name)) { app.__fetches.push({ url: String(url), opts: opts || {} }); throw new TypeError("Failed to fetch"); }
    if (name === "version.txt" && version !== undefined) { app.__fetches.push({ url: String(url), opts: opts || {} }); return version === 404 ? reply("", false) : reply(version); }
    if (name === "index.html" && page !== undefined) { app.__fetches.push({ url: String(url), opts: opts || {} }); return reply(page); }
    return real(url, opts);
  };
}

/** Requests for these files never answer — a dock with one bar — until the
    app gives up on them through the AbortSignal it passed. */
function hang(app, names) {
  const real = app.fetch;
  app.fetch = (url, opts) => {
    if (!names.includes(nameOf(url))) return real(url, opts);
    app.__fetches.push({ url: String(url), opts: opts || {} });
    return new Promise((res, rej) => {
      opts?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
}
const asked = (app, name) => app.__fetches.filter((f) => String(f.url).split("?")[0].endsWith("/" + name));

/**
 * A stand-in for navigator.serviceWorker, enough to walk every install path:
 * one registration, a controller that answers "version" with the build it
 * serves (or, as v1.9.0 and older do, does not answer on the port at all),
 * and workers that record every message the page sends them. A test swaps
 * reg.update for one that finds a worker, rejects, or never settles.
 */
function fakeSW({ controller = APP, waiting = false, register = true } = {}) {
  const sent = [];
  const listeners = {};
  const worker = (build, state) => ({
    build, state,
    postMessage(m, ports) {
      sent.push(m);
      if (m === "version" && build && ports && ports[0]) ports[0].postMessage({ type: "version", version: "v-test", build });
    },
    addEventListener() {},
  });
  const reg = {
    installing: null,
    waiting: waiting ? worker("9.9.9", "installed") : null,
    updates: 0,
    update: async () => { reg.updates++; return reg; },
    addEventListener() {},
  };
  const container = {
    controller: controller === null ? null : worker(controller, "activated"),
    register: register ? async () => reg : () => new Promise(() => {}),
    getRegistration: async () => reg,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
  };
  return { container, reg, sent, worker, fire: (t) => (listeners[t] || []).forEach((f) => f()) };
}

/**
 * sw.js itself, in a vm, against a server that answers from the repo — or
 * from `pages`, keyed by path under the scope ("" is the scope itself), to
 * put another build on the server — and a Cache Storage kept in maps. Every
 * request the worker sends is kept, so a test can read its URL and cache mode.
 */
function swWorld({ pages = {} } = {}) {
  const listeners = {};
  const store = new Map();
  const world = { pages, offline: false, sent: [], listeners };
  const keyOf = (q) => (typeof q === "string" ? q : q.url);
  const fileOrNull = (rel) => { try { return readFileSync(join(ROOT, rel)); } catch { return null; } };
  async function net(q, init) {
    const req = q instanceof Request ? q : new Request(keyOf(q), init);
    world.sent.push(req);
    if (world.offline || !req.url.startsWith(SCOPE)) throw new TypeError("Failed to fetch");   // fonts: no CDN here
    const rel = new URL(req.url).pathname.slice(new URL(SCOPE).pathname.length);
    const body = rel in world.pages ? world.pages[rel] : fileOrNull(rel || "index.html");
    const res = body === null ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
    return Object.defineProperty(res, "url", { value: req.url });   /* as a browser's would: the URL it was fetched from */
  }
  const open = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      match: async (q) => m.get(keyOf(q))?.clone(),
      put: async (q, res) => { m.set(keyOf(q), res); },
      add: async (q) => { const res = await net(q); if (!res.ok) throw new TypeError("bad response"); m.set(keyOf(q), res); },
      keys: async () => [...m.keys()],
    };
  };
  const later = (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; };
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting() { world.skipped = true; },
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(SW_SRC, {
    self, fetch: net, Request, Response, URL, console, setTimeout: later, Promise,
    caches: { open: async (n) => open(n), keys: async () => [...store.keys()], delete: async (n) => store.delete(n) },
  });
  world.cached = (name = CACHE) => (store.has(name) ? [...store.get(name).keys()] : []);
  world.page = async (key, name = CACHE) => { const res = store.get(name)?.get(key); return res ? res.clone().text() : null; };
  world.install = () => { let p; listeners.install({ waitUntil: (x) => { p = x; } }); return p; };
  /** What the worker does with a GET: the response it answers with, or null
      when it lets the request through to the network untouched. */
  world.fetch = (url, mode = "cors") => {
    let p = null;
    /* A real Request, so the worker can derive its own from it; Node will not
       construct one in navigate mode, so that is laid over the top. */
    const request = new Request(url, mode === "navigate" ? { redirect: "manual" } : {});
    if (mode !== "cors") Object.defineProperty(request, "mode", { value: mode });
    listeners.fetch({ request, respondWith: (x) => { p = Promise.resolve(x); } });
    return p;
  };
  return world;
}

/* ================================================================== */

r.section("parseVersionFile — strict by design");
{
  const app = await appWith({});
  const p = app.parseVersionFile;
  r.eq(p("0.12.0"), "0.12.0", "a bare version parses");
  r.eq(p("0.12.0\n"), "0.12.0", "a trailing newline is fine");
  r.eq(p("  0.12.0  \n"), "0.12.0", "surrounding whitespace is fine");
  r.eq(p("<!doctype html><title>404</title>"), null, "an HTML error page is rejected");
  r.eq(p("<html><body>Sign in to continue</body></html>"), null, "a captive portal login page is rejected");
  r.eq(p('<script>const APP_VERSION = "0.12.0";</script>'), null, "index.html served by mistake is rejected");
  r.eq(p(""), null, "an empty body is rejected");
  r.eq(p("  \n "), null, "whitespace only is rejected");
  r.eq(p("0.12.0 beta"), null, "a version with extra text is rejected");
  r.eq(p("0.12"), null, "a two-part version is rejected");
  r.eq(p("v0.12.0"), null, "a v-prefixed version is rejected");
  r.ok(p(null) === null && p(undefined) === null && p({}) === null, "a non-string is rejected");
}

r.section("extractVersion — the fallback reads only the real declaration");
{
  const app = await appWith({});
  const x = app.extractVersion;
  r.eq(x(SRC), APP, `it reads ${APP} out of the shipped index.html`);
  r.eq(x('const APP_VERSION = "2.0.0";'), "2.0.0", "double quotes");
  r.eq(x("const APP_VERSION = '1.6.4';"), "1.6.4", "single quotes");
  r.eq(x("const   APP_VERSION   =   '1.7.0'  ;"), "1.7.0", "extra whitespace");
  r.eq(x("<html>" + "x".repeat(5000) + '\nconst APP_VERSION = "9.9.9";\n' + "y".repeat(5000)), "9.9.9", "deep in a large document");
  r.eq(x("<html><body>404 not found</body></html>"), null, "null on a page without one");
  r.eq(x('const APP_VERSION_OLD = "1.0.0";'), null, "not a similarly named constant");
  r.eq(x('// const APP_VERSION = "9.9.9" example\nconst APP_VERSION = "1.6.4";'), "1.6.4",
    "not a comment that mentions the declaration first");
  r.eq(x('const APP_VERSION = "soon";'), null, "and not a value that is not a version");
}

r.section("isNewer — a reload only ever moves forward");
{
  const app = await appWith({});
  const n = app.isNewer;
  r.ok(n("0.12.1", "0.12.0") && n("0.13.0", "0.12.9") && n("1.0.0", "0.99.99"), "later patch, minor and major are newer");
  r.ok(n("0.10.0", "0.9.0"), "numerically, not as text: 0.10.0 is newer than 0.9.0");
  r.ok(!n("0.12.0", "0.12.0") && !n("0.11.9", "0.12.0"), "the same version, or an earlier one, is not");
}

r.section("One number in three places");
{
  const vfile = readFileSync(join(ROOT, "version.txt"), "utf8");
  r.ok(/^\d+\.\d+\.\d+\n?$/.test(vfile), "version.txt holds exactly one dotted version and nothing else", JSON.stringify(vfile));
  r.eq(vfile.trim(), APP, `version.txt matches APP_VERSION (${APP})`);
  r.eq(BUILD, APP, `sw.js's APP_BUILD matches APP_VERSION (${APP}), so every release changes sw.js`);
  r.ok(SHELL.length > 0 && !SHELL.includes("version.txt"), "version.txt is not precached — it must always come from the server");
}

r.section("The worker caches the live build, past every cache, or nothing");
{
  const w = swWorld();
  await w.install();
  const own = w.sent.filter((q) => q.url.startsWith(SCOPE));
  const files = [...SHELL, ...OPTIONAL];
  r.ok(files.every((p) => own.some((q) => q.url.split("?")[0] === new URL(p, SCOPE).href)), "install fetches every shell file and icon");
  const stale = own.filter((q) => q.cache !== "no-cache").map((q) => `${q.url} (${q.cache})`);
  r.eq(stale, [], "every one with cache: \"no-cache\" — GitHub Pages sends max-age=600, and the browser's HTTP cache must not answer for the server");
  const unstamped = own.filter((q) => new URL(q.url).searchParams.get("v") !== BUILD).map((q) => q.url);
  r.eq(unstamped, [], `every one stamped ?v=${BUILD}, a key no CDN edge has an older copy under`);
  const keys = w.cached();
  r.ok(files.every((p) => keys.includes(new URL(p, SCOPE).href)), "each is stored under the URL the app asks for");
  r.ok(!keys.some((k) => k.includes("?v=")), "never under the stamped one");
  r.eq(buildOf(await w.page(SCOPE)), BUILD, "and the page stored is this worker's own build");
}
for (const [what, pages] of [
  ["index.html from another build", { "index.html": pageOf("0.0.1") }],
  ["the scope URL serving another build", { "": pageOf("0.0.1") }],
  ["a page with no version at all (an error page served 200)", { "index.html": "<html><body>Something went wrong</body></html>" }],
]) {
  const w = swWorld({ pages });
  let err = null;
  try { await w.install(); } catch (e) { err = e; }
  r.ok(!!err, `${what} fails the install, so the old worker stays in charge`);
  r.eq(w.cached(), [], "and nothing at all is written to the new cache");
}

r.section("Between installs, the worker serves its own build and nothing else");
{
  const w = swWorld();
  await w.install();
  w.sent.length = 0;
  const res = await w.fetch(SCOPE + "hazmat.json");
  r.ok(res && res.ok, "a cached data file is answered from the cache");
  await settle();
  const reval = w.sent.find((q) => q.url === SCOPE + "hazmat.json");
  r.ok(reval && reval.cache === "no-cache", "and refreshed from the server, not from the HTTP cache", reval && reval.cache);

  w.pages[""] = w.pages["index.html"] = pageOf("9.9.9");
  w.sent.length = 0;
  const nav = await w.fetch(SCOPE, "navigate");
  r.eq(buildOf(await nav.text()), BUILD, "after a deploy, the app still opens on the build this worker cached");
  await settle();
  const navReval = w.sent.find((q) => q.url === SCOPE);
  r.ok(navReval && navReval.cache === "no-cache" && navReval.redirect === "manual",
    "its refresh asks the server and keeps the navigation's redirect mode, so a redirected navigation still lands",
    navReval && `${navReval.cache} / ${navReval.redirect}`);
  r.eq(buildOf(await w.page(SCOPE)), BUILD, "and the newer page its background refresh fetched is not written over it");
  r.eq(buildOf(await w.page(SCOPE + "index.html")), BUILD, "under either URL");
}
{
  const w = swWorld({ pages: { "": pageOf("9.9.9") } });
  const nav = await w.fetch(SCOPE, "navigate");
  r.eq(buildOf(await nav.text()), "9.9.9", "with nothing cached, a page from the network is shown");
  await settle();
  r.eq(w.cached(), [], "but a page of another build is never stored");
  const mine = swWorld();
  await mine.fetch(SCOPE, "navigate");
  await settle();
  r.ok(mine.cached().includes(SCOPE), "while a page of the worker's own build is");
}

r.section("The worker hands the check and the cache-busted reload to the network");
{
  const w = swWorld();
  await w.install();
  r.eq(w.fetch(SCOPE + "version.txt?_cb=1"), null, "version.txt with a cache-buster is passed through");
  r.eq(w.fetch(SCOPE + "version.txt"), null, "version.txt without one is passed through too");
  r.eq(w.fetch(SCOPE + "index.html?_cb=1"), null, "the index.html fallback is passed through, never answered or stored by the cache");
  r.ok(w.fetch(SCOPE + "hazmat.json") !== null, "while the app's data is still served from the cache");

  w.sent.length = 0;
  const res = await w.fetch(SCOPE + "?_cb=123", "navigate");
  r.ok(res && res.ok && w.sent.some((q) => q.url === SCOPE + "?_cb=123"), "a cache-busted navigation goes to the network");
  await settle();
  r.ok(!w.cached().some((k) => k.includes("_cb")), "and is never stored — each one would be another copy of the app");
  w.offline = true;
  const off = await w.fetch(SCOPE + "?_cb=456", "navigate");
  r.eq(buildOf(off && await off.text()), BUILD, "offline, it falls back to the cached app like any navigation");
}
{
  const w = swWorld();
  const got = [];
  w.listeners.message({ data: "version", ports: [{ postMessage: (m) => got.push(m) }] });
  r.eq(got.map((m) => m.build), [BUILD], "asked over a port, a worker says which build it serves");
}

r.section("On load: silent, and quiet when there is nothing new");
{
  const app = await boot();
  const v = asked(app, "version.txt");
  r.eq(v.length, 1, "the app asks for version.txt once on load");
  r.ok(/\?_cb=\d+$/.test(v[0].url) && v[0].opts.cache === "no-store", "cache-busted and no-store, so only the live server can answer");
  r.ok(v[0].url.startsWith("https://example.test/HazPost/"), "resolved against the page, not the domain root");
  r.eq(asked(app, "index.html").length, 0, "with a good version.txt the page is not fetched");
  r.eq(foot(app), `HazPost v${APP}`, "the footer shows the running version");
  app.render();
  r.ok(/id="verBanner"[^>]* hidden>/.test(app.__els.get("main").innerHTML), "and no update banner");
}

r.section("A newer version found silently is offered, never installed");
{
  const app = await boot();
  const before = app.location.href;
  serve(app, { version: "9.9.9\n" });
  await app.checkForUpdate(true);
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "the footer names the version on offer");
  app.render();
  const h = app.__els.get("main").innerHTML;
  r.ok(/id="verBanner"[^>]*>Update available \(v9\.9\.9\) — tap to install</.test(h) && !/id="verBanner"[^>]* hidden>/.test(h),
    "the banner on Load shows it too");
  r.ok(/class="verfoot live"/.test(h), "and the footer is lit");
  r.eq(app.location.href, before, "nothing navigated: a check never installs");
  serve(app, { version: `${APP}\n` });
  await app.checkForUpdate(true);
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "the offer persists until the driver acts on it");
}

r.section("The tap: the first checks, the second installs");
{
  const app = await boot();
  const before = app.location.href;
  serve(app, { version: "9.9.9" });
  app.tapVersion();
  r.eq(foot(app), "Checking for updates…", "the first tap says it is checking");
  app.tapVersion();
  await settle();
  r.eq(asked(app, "version.txt").length, 2, "a second tap mid-check does not start another");
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "and the check ends on the offer");
  r.eq(app.location.href, before, "the checking tap did not install anything");
  app.tapVersion();
  r.ok(/\?_cb=\d+$/.test(app.location.href) && app.location.href !== before,
    "the next tap installs — with no worker to hand over to, a cache-busted reload", app.location.href);
}

r.section("A tap that finds nothing says so, and only when it really asked");
{
  const latest = await boot();
  const pending = latest.checkForUpdate(false);
  r.eq(foot(latest), "Checking for updates…", "while the check runs");
  await pending;
  r.eq(foot(latest), `You're on the latest (v${APP})`, "the same version: you're on the latest, with the number");

  const portal = await boot();
  serve(portal, { version: "<html><body>Sign in to continue</body></html>" });
  await portal.checkForUpdate(false);
  r.eq(asked(portal, "index.html").length, 1, "an unreadable version.txt falls back to the live index.html");
  r.ok(/\?_cb=\d+$/.test(asked(portal, "index.html")[0].url) && asked(portal, "index.html")[0].opts.cache === "no-store",
    "which is cache-busted and no-store too");
  r.eq(foot(portal), `You're on the latest (v${APP})`, "and the version read out of it settles the answer");

  const gone = await boot();
  serve(gone, { version: 404, page: "<html>nothing here</html>" });
  await gone.checkForUpdate(false);
  r.eq(foot(gone), "Couldn't check for updates", "neither readable: it couldn't check — never \"on the latest\"");

  const offline = await boot();
  serve(offline, { fail: ["version.txt", "index.html"] });
  await offline.checkForUpdate(false);
  r.eq(foot(offline), "Couldn't check for updates", "offline: it couldn't check");

  const quiet = await boot();
  serve(quiet, { fail: ["version.txt", "index.html"] });
  await quiet.checkForUpdate(true);
  r.eq(foot(quiet), `HazPost v${APP}`, "a silent check that fails leaves the footer alone");
}

r.section("A check that gets no answer gives up, and says so");
{
  const app = await boot();
  hang(app, ["version.txt", "index.html"]);
  const clock = clockFor(app);
  const done = app.checkForUpdate(false);
  await clock.advance(7999);
  r.eq(foot(app), "Checking for updates…", "a version.txt that does not answer is waited on for 8 s");
  r.ok(!!asked(app, "version.txt").at(-1).opts.signal, "through a signal that can call it off");
  await clock.advance(1);
  r.eq(asked(app, "index.html").length, 1, "then given up on, and the page is tried");
  await clock.advance(8000);
  await done;
  r.eq(foot(app), "Couldn't check for updates", "and a page that does not answer either ends it: couldn't check");
  app.tapVersion();
  r.eq(foot(app), "Checking for updates…", "the next tap checks again — nothing was left holding the check");
}

r.section("Two checks at once are one check");
{
  const app = await boot();
  const n = asked(app, "version.txt").length;
  serve(app, { version: "9.9.9" });
  await Promise.all([app.checkForUpdate(true), app.checkForUpdate(true), app.checkForUpdate(false)]);
  r.eq(asked(app, "version.txt").length, n + 1, "the foreground check landing on top of the load check asks the server once");
}
{
  const app = await boot();
  let answer;
  const real = app.fetch;
  app.fetch = (url, opts) => {
    if (nameOf(url) !== "version.txt") return real(url, opts);
    app.__fetches.push({ url: String(url), opts: opts || {} });
    return new Promise((res) => { answer = () => res(reply(APP)); });
  };
  const n = asked(app, "version.txt").length;
  (app.__docListeners.visibilitychange || []).forEach((f) => f());
  app.tapVersion();
  r.eq(foot(app), "Checking for updates…", "a tap on top of a silent check joins it out loud");
  r.eq(asked(app, "version.txt").length, n + 1, "without asking the server twice");
  answer();
  await settle();
  r.eq(foot(app), `You're on the latest (v${APP})`, "and reports what that check found");
}

r.section("Once an update is on offer, the server is not asked again");
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  const n = asked(app, "version.txt").length, u = sw.reg.updates;
  (app.__docListeners.visibilitychange || []).forEach((f) => f());
  await settle();
  r.eq(asked(app, "version.txt").length, n, "coming back to the foreground does not fetch version.txt again — as FuelPost stops");
  r.eq(sw.reg.updates, u + 1, "but the worker check still runs, so the new build keeps downloading");
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "and the offer stands");
}

r.section("With a service worker: the check never waits on it");
{
  const sw = fakeSW();
  sw.reg.update = () => new Promise(() => {});
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  const done = await Promise.race([app.checkForUpdate(true).then(() => true), new Promise((res) => setTimeout(() => res(false), 1000))]);
  r.ok(done, "a worker check that never settles does not hold the version check open");
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "which names the version from version.txt");
}

r.section("The install tap hands over to a waiting worker, and only the tap does");
{
  const sw = fakeSW({ waiting: true });
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  r.eq(foot(app), "Update available — tap to install", "a worker waiting from an earlier visit is offered on load");
  r.eq(skips(sw), 0, "and sent nothing");
  sw.fire("controllerchange");
  await settle();
  r.eq(nav.reloads, 0, "a takeover the driver did not ask for never reloads");

  app.tapVersion();
  await settle();
  r.eq(skips(sw), 1, "the install tap tells the waiting worker to take over");
  r.eq(foot(app), "Updating…", "and the footer says it is updating");
  r.eq(nav.reloads, 0, "nothing reloads until the new worker is in control");
  app.tapVersion();
  await settle();
  r.eq(skips(sw), 1, "a tap while updating does nothing more");
  sw.fire("controllerchange");
  r.eq(nav.reloads, 1, "then the page reloads onto it");
  sw.fire("controllerchange");
  r.eq(nav.reloads, 1, "once");
}
{
  const sw = fakeSW({ waiting: true });
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(5999);
  r.eq(nav.reloads, 0, "if the handover never lands…");
  await clock.advance(1);
  r.eq(nav.reloads, 1, "…the page reloads itself after 6 s: the driver already asked for it");
}
{
  const sw = fakeSW({ waiting: true, register: false });
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  app.tapVersion();
  await settle();
  r.eq(app.location.href, nav.before, "a registration still pending is not taken for no worker: no cache-busted navigation");
  r.eq(skips(sw), 1, "the tap asks for the registration and hands over to its waiting worker");
}
{
  const sw = fakeSW({ controller: null });
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  app.tapVersion();
  await settle();
  r.ok(/\?_cb=\d+$/.test(app.location.href), "with no worker in control, the install tap is a cache-busted navigation", app.location.href);
}
{
  const sw = fakeSW({ waiting: true });
  const app = await boot({ serviceWorker: sw.container });
  hang(app, ["version.txt", "index.html"]);
  (app.__docListeners.visibilitychange || []).forEach((f) => f());
  app.tapVersion();
  await settle();
  r.eq(skips(sw), 1, "a silent check stuck on a weak signal does not swallow the install tap");
}

r.section("Another window installed it: the tap is a reload, forward only");
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  sw.container.controller = sw.worker("9.9.9", "activated");
  sw.fire("controllerchange");
  await settle();
  r.eq(nav.reloads, 0, "another window installing an update does not reload this one");
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "it offers the build that took over");
  app.tapVersion();
  await settle();
  r.eq(nav.reloads, 1, "and the install tap is a plain reload onto it");
  r.eq(skips(sw), 0, "with nothing to hand over");
  r.eq(app.location.href, nav.before, "and no trip to the network");
}
{
  const sw = fakeSW({ controller: null });
  const app = await boot({ serviceWorker: sw.container });
  sw.container.controller = sw.worker(APP, "activated");
  sw.fire("controllerchange");
  await settle();
  r.eq(foot(app), `HazPost v${APP}`, "the first worker taking control on a first visit offers nothing");
  sw.container.controller = sw.worker("0.0.1", "activated");
  sw.fire("controllerchange");
  await settle();
  r.eq(foot(app), `HazPost v${APP}`, "nor does an older build taking over: there is nothing to go forward to");
}
{
  const sw = fakeSW({ controller: "9.9.9" });
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  app.tapVersion();
  await settle();
  r.eq(nav.reloads, 1, "a worker already serving a newer build than the page: the tap reloads onto it");
}
{
  const sw = fakeSW({ controller: "0.0.1" });
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  app.tapVersion();
  await settle();
  r.eq(nav.reloads, 0, "a worker behind the page is never reloaded into");
}

r.section("Nothing to hand over: the tap fetches it, and every wait has a bound");
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  const nav = watchNav(app);
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(0);
  r.eq(foot(app), "Update isn't ready yet — tap to retry",
    "the server has no new worker yet (a deploy still reaching the CDN): said at once, not after a 30-second spin");
  r.eq(nav.reloads + skips(sw), 0, "and nothing reloaded or handed over");
  await clock.advance(5000);
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "then the offer comes back");
  sw.fire("controllerchange");
  await settle();
  r.eq(nav.reloads, 0, "and the tap's licence to reload went with it");
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.update = async () => { throw new TypeError("Failed to update a ServiceWorker"); };
  app.tapVersion();
  await settle();
  r.eq(foot(app), "Couldn't connect — tap to retry", "offline: it says it couldn't connect");
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.update = () => new Promise(() => {});
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(9999);
  r.eq(foot(app), "Updating…", "an update() that does not settle is waited on…");
  await clock.advance(1);
  r.eq(foot(app), "Couldn't connect — tap to retry", "…for 10 s, then given up on");
  app.tapVersion();
  r.eq(foot(app), "Updating…", "and a tap tries again");
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.update = async () => { sw.reg.installing = sw.worker("9.9.9", "installing"); return sw.reg; };
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(3000);
  r.eq(foot(app), "Updating…", "a worker the tap finds is waited on while it installs");
  sw.reg.waiting = sw.reg.installing;
  sw.reg.installing = null;
  await clock.advance(250);
  r.eq(skips(sw), 1, "and told to take over as soon as it is waiting");
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.installing = sw.worker("9.9.9", "installing");
  const u = sw.reg.updates;
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(1000);
  r.eq(sw.reg.updates, u, "a worker the background check already found is not fetched again");
  sw.reg.waiting = sw.reg.installing;
  sw.reg.installing = null;
  await clock.advance(250);
  r.eq(skips(sw), 1, "the tap waits for it to finish and hands over");
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.update = async () => { sw.reg.installing = sw.worker("9.9.9", "installing"); return sw.reg; };
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(500);
  sw.reg.installing = null;               /* the install failed: the worker went redundant */
  await clock.advance(250);
  r.eq(foot(app), "Update didn't finish — tap to retry", "a worker that fails to install is reported as soon as it fails");
  r.ok(clock.now < 1000, "not when a timer runs out", `${clock.now} ms`);
}
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  sw.reg.update = async () => { sw.reg.installing = sw.worker("9.9.9", "installing"); return sw.reg; };
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(29999);
  r.eq(foot(app), "Updating…", "an install that never finishes is waited on…");
  await clock.advance(1);
  r.eq(foot(app), "Update didn't finish — tap to retry", "…for 30 s, and no longer");
}
{
  const sw = fakeSW({ controller: null });
  sw.container.controller = sw.worker(null, "activated");   /* v1.9.0 and older: no answer on the port */
  const app = await boot({ serviceWorker: sw.container });
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  const clock = clockFor(app);
  app.tapVersion();
  await clock.advance(999);
  r.eq(foot(app), "Updating…", "a worker too old to say its build…");
  await clock.advance(1);
  r.eq(foot(app), "Update isn't ready yet — tap to retry", "…costs a second, then the tap carries on without its answer");
}

r.section("Screen readers hear it");
{
  const app = await boot();
  app.render();
  const btn = (h) => (h.match(/<button[^>]*id="verFoot"[^>]*>/) || [""])[0];
  const idle = btn(app.__els.get("main").innerHTML);
  r.ok(/aria-live="polite"/.test(idle), "the version footer is a polite live region, so the check's outcome is announced");
  r.ok(idle.includes(`aria-label="HazPost v${APP} — tap to check for updates"`), "showing the version, its name says what a tap does");
  serve(app, { version: "9.9.9" });
  await app.checkForUpdate(true);
  app.render();
  r.ok(!/aria-label=/.test(btn(app.__els.get("main").innerHTML)),
    "with an update on offer its name is the offer itself — never \"check\" on a tap that installs");
  r.ok(!("aria-label" in app.__els.get("verFoot").attrs), "and repainting it in place drops the label the same way");
}

r.section("A worker that finishes installing replaces a stale note at once");
{
  const sw = fakeSW();
  const app = await boot({ serviceWorker: sw.container });
  await app.checkForUpdate(false);
  r.eq(foot(app), `You're on the latest (v${APP})`, "a check that found nothing says so");
  app.markUpdateReady();
  r.eq(foot(app), "Update available — tap to install", "a worker finishing a moment later is offered straight away, version unknown");
}

r.section("Coming back to the foreground checks again, silently");
{
  const app = await boot();
  const vis = app.__docListeners.visibilitychange || [];
  r.ok(vis.length >= 1, "the app listens for visibilitychange");
  const n = asked(app, "version.txt").length;
  serve(app, { version: "9.9.9" });
  vis.forEach((f) => f());
  r.eq(foot(app), `HazPost v${APP}`, "no Checking… for a check the driver did not ask for");
  await settle();
  r.eq(asked(app, "version.txt").length, n + 1, "and version.txt is asked again");
  r.eq(foot(app), "Update available (v9.9.9) — tap to install", "which surfaces the update");
}

r.section("CI runs the whole suite on every pull request");
{
  const WF = join(ROOT, ".github", "workflows", "tests.yml");
  r.ok(existsSync(WF), "the workflow exists", WF);
  const wf = existsSync(WF) ? readFileSync(WF, "utf8") : "";
  r.ok(/run:\s*node tools\/test\.mjs\s*$/m.test(wf), "it runs tools/test.mjs");
  r.ok(!/node tools\/test-[a-z0-9-]+\.mjs/.test(wf), "the whole suite, not one file");
  r.ok(/^on:[\s\S]*?^\s{2}pull_request:/m.test(wf), "it fires on pull requests");
  r.ok(/^\s{2}push:\s*\n\s+branches:\s*\[main\]/m.test(wf), "and on pushes to main");
  r.ok(/uses: actions\/checkout@v\d/.test(wf), "it checks the repo out");
  r.ok(/uses: actions\/setup-node@v\d/.test(wf) && /node-version:\s*'?22/.test(wf), "on Node 22, the version the suite runs on locally");
  r.ok(/timeout-minutes:\s*\d+/.test(wf), "bounded, so a hang fails instead of running on");
  r.ok(/permissions:\s*\n\s+contents:\s*read/.test(wf), "and allowed to read the code, nothing more");
  r.ok(!/npm (install|ci)\b/.test(wf) && !existsSync(join(ROOT, "package.json")), "no install step and no package.json: plain node, as it runs here");
}

r.finish();
