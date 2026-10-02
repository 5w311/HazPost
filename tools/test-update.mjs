#!/usr/bin/env node
/**
 * The update check, and the release discipline it depends on.
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
 *    paying for the big fetch once.
 *  - It runs silently on load and every time the app returns to the
 *    foreground, and out loud on a tap. Either way it can only surface an
 *    update. Installing one takes a second, explicit tap.
 *  - version.txt, APP_VERSION and the worker's APP_BUILD are one number. The
 *    worker's copy is what makes sw.js change on every release, and only a
 *    changed sw.js gets installed on a phone.
 *  - CI runs the whole suite on every pull request and every push to main.
 */

import { report, appWith, SRC, ROOT } from "./test-harness.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const r = report("HazPost — the update check and the release discipline");

const APP = (SRC.match(/^const APP_VERSION = "([^"]+)";$/m) || [])[1];
const tick = () => new Promise((res) => setTimeout(res, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const foot = (app) => app.verFootText();
/* A booted app whose own timers — the notes that give way after a few
   seconds, the install fallback — run as usual but do not hold the test
   process open once the assertions are done. */
async function boot() {
  const app = await appWith({});
  app.setTimeout = (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); t.unref?.(); return t; };
  await settle();
  return app;
}
const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => body, json: async () => JSON.parse(body) });

/** Answer version.txt (and optionally index.html) with what a test needs, and
    let everything else through to the repo as usual. */
function serve(app, { version, page, fail } = {}) {
  const real = app.fetch;
  app.fetch = async (url, opts) => {
    const name = String(url).split("?")[0].replace(/^.*\//, "");
    if (fail && fail.includes(name)) { app.__fetches.push({ url: String(url), opts: opts || {} }); throw new TypeError("Failed to fetch"); }
    if (name === "version.txt" && version !== undefined) { app.__fetches.push({ url: String(url), opts: opts || {} }); return version === 404 ? reply("", false) : reply(version); }
    if (name === "index.html" && page !== undefined) { app.__fetches.push({ url: String(url), opts: opts || {} }); return reply(page); }
    return real(url, opts);
  };
}
const asked = (app, name) => app.__fetches.filter((f) => String(f.url).split("?")[0].endsWith("/" + name));

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

r.section("One number in three places");
{
  const vfile = readFileSync(join(ROOT, "version.txt"), "utf8");
  r.ok(/^\d+\.\d+\.\d+\n?$/.test(vfile), "version.txt holds exactly one dotted version and nothing else", JSON.stringify(vfile));
  r.eq(vfile.trim(), APP, `version.txt matches APP_VERSION (${APP})`);
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const build = (sw.match(/^const APP_BUILD = "([^"]+)";$/m) || [])[1];
  r.eq(build, APP, `sw.js's APP_BUILD matches APP_VERSION (${APP}), so every release changes sw.js`);
  r.ok(!readFileSync(join(ROOT, "sw.js"), "utf8").match(/const SHELL[^;]*version\.txt/), "version.txt is not precached — it must always come from the server");
}

r.section("The service worker hands the check straight to the network");
{
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const listeners = {};
  const scope = "https://example.test/HazPost/";
  const self = { registration: { scope }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim() {} } };
  const cache = { match: async () => undefined, put: async () => {}, keys: async () => [] };
  vm.runInNewContext(sw, { self, caches: { open: async () => cache, keys: async () => [] }, URL,
    Response: class { constructor(b, o) { Object.assign(this, o || {}); } }, fetch: async () => { throw new TypeError("offline"); }, console, setTimeout, Promise });
  const intercepted = (url, mode = "cors") => {
    let took = false;
    listeners.fetch({ request: { method: "GET", url, mode }, respondWith: (p) => { took = true; Promise.resolve(p).catch(() => {}); } });
    return took;
  };
  r.ok(typeof listeners.fetch === "function", "sw.js registers a fetch handler");
  r.ok(!intercepted(scope + "version.txt?_cb=1"), "version.txt with a cache-buster is passed through");
  r.ok(!intercepted(scope + "version.txt"), "version.txt without one is passed through too");
  r.ok(!intercepted(scope + "index.html?_cb=1"), "the index.html fallback is passed through, never answered or stored by the cache");
  r.ok(intercepted(scope + "hazmat.json"), "while the app's data is still served from the cache");
  r.ok(intercepted(scope, "navigate"), "and so are navigations, which must work offline");
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

r.section("Two checks at once are one check");
{
  const app = await boot();
  const n = asked(app, "version.txt").length;
  serve(app, { version: "9.9.9" });
  await Promise.all([app.checkForUpdate(true), app.checkForUpdate(true), app.checkForUpdate(false)]);
  r.eq(asked(app, "version.txt").length, n + 1, "the foreground check landing on top of the load check asks the server once");
}

r.section("With a service worker: the check never waits on it, and the second tap hands over");
{
  /* A stand-in registration. update() that never settles is what Chrome does
     while a newly found worker installs; a check that awaited it would hold
     its in-flight guard for seconds and swallow every check behind it. */
  const slow = await boot();
  vm.runInContext("swReg = { update: () => new Promise(() => {}), waiting: null }", slow);
  serve(slow, { version: "9.9.9" });
  const done = await Promise.race([slow.checkForUpdate(true).then(() => true), new Promise((res) => setTimeout(() => res(false), 1000))]);
  r.ok(done, "the check finishes while the worker is still installing");
  r.eq(foot(slow), "Update available (v9.9.9) — tap to install", "and names the version from version.txt");

  const ready = await boot();
  const sent = [];
  ready.location.reload = () => sent.push("reload");
  vm.runInContext("swReg = { update: async () => {}, waiting: { postMessage: (m) => __sent.push(m) } }", Object.assign(ready, { __sent: sent }));
  serve(ready, { version: "9.9.9" });
  await ready.checkForUpdate(true);
  r.eq(sent, [], "finding the update sends the waiting worker nothing");
  ready.tapVersion();
  await settle();
  r.eq(sent, ["skip"], "the install tap tells the waiting worker to take over");
  r.eq(foot(ready), "Updating…", "and the footer says it is updating");

  const quietWorker = await boot();
  vm.runInContext("swReg = { update: async () => {}, waiting: null }", quietWorker);
  quietWorker.markUpdateReady();
  r.eq(foot(quietWorker), "Update available — tap to install",
    "a worker that finished installing is offered even when version.txt could not say which version");
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
