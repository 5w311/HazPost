/**
 * The test harness. Shared by every tools/test-*.mjs.
 *
 * HazPost is one HTML file with no build step and no module boundary, so there
 * is nothing to import. The harness extracts the app's <script> and evaluates
 * it in a vm context against stub globals, which means the functions under test
 * are the ones that ship rather than copies of them. Nothing in this repo
 * re-implements an engine for the benefit of a test.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE. Top-level `let` and `const`
 * bindings are lexical and never become properties of a vm context — only
 * function declarations do. So `HM`, `SEG`, `OPS`, `PAPERS`, `CAR`, `load` and
 * `opsPlace` cannot be read or written from a test. Everything reaches them
 * through the app's own seams:
 *
 *   loadData()            populates all six data files through the stub fetch,
 *                         and calls restoreLoad() once HM is in hand
 *   restoreLoad()         rebuilds `load` from localStorage against HM
 *   setOpsPlace(k)        sets the On the Road location
 *   setLineState(i, v)    answers the physical-state question on one line
 *   setDate(k, v)         sets one of the What You Carry dates
 *
 * Driving a load in therefore means seeding `hazpost.load.v1` and letting the
 * app restore it, which exercises the real persistence path as a side effect —
 * a load that cannot be restored is a load no test can build.
 *
 * Values that exist only in the source text are read out of the source with
 * `sourceList` and friends, which has the useful property that adding a case to
 * the app picks it up here without anyone remembering to come and update a test.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = readFileSync(join(ROOT, "index.html"), "utf8");

/* File text is cached; the JSON is re-parsed per fetch so no two contexts can
   ever share a mutable object. */
const fileCache = new Map();
function fileText(name) {
  if (!fileCache.has(name)) {
    try { fileCache.set(name, readFileSync(join(ROOT, name), "utf8")); }
    catch { fileCache.set(name, null); }
  }
  return fileCache.get(name);
}

export function json(name) {
  const t = fileText(name);
  if (t === null) throw new Error(`${name} is not in the repo`);
  return JSON.parse(t);
}

/* ------------------------------------------------------------------ */

function makeContext({ storage = {}, offline = false } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, style: {}, innerHTML: "", textContent: "", className: "",
        hidden: false, value: "", disabled: false,
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
      });
    }
    return els.get(id);
  };

  const store = { ...storage };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  /* Serves the repo off disk, so loadData() in a test is the same loadData()
     a phone runs. A file that is not in the repo 404s, which is how the
     failure paths get exercised. */
  const fetch = async (url) => {
    const name = String(url).replace(/^.*\//, "").split("?")[0];
    const body = offline ? null : fileText(name);
    if (body === null) {
      return { ok: false, status: 404, statusText: "Not Found",
        json: async () => { throw new Error("404"); }, text: async () => "" };
    }
    return { ok: true, status: 200, statusText: "OK",
      json: async () => JSON.parse(body), text: async () => body };
  };

  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch, localStorage,
    location: { href: "https://example.test/HazPost/" },
    navigator: { onLine: !offline },     /* no serviceWorker key: registerSW() returns at the door */
    document: { getElementById: el, addEventListener() {}, hidden: false },
    confirm: () => true,                 /* clearLoad()/clearDates() ask; tests always say yes */
    URL, Date, Math, JSON,
    __store: store,                      /* so a test can read what was persisted */
    __els: els,
  };
  ctx.window = ctx;                      /* `"caches" in window` — no caches key, so readCacheMeta() returns */
  ctx.window.addEventListener = () => {};
  ctx.window.scrollTo = () => {};
  return vm.createContext(ctx);
}

/** A fresh app, evaluated but with no data loaded yet. */
export function runApp(opts) {
  const m = SRC.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error("could not find the app <script> in index.html");
  const ctx = makeContext(opts);
  vm.runInContext(m[1], ctx, { filename: "index.html#script" });
  return ctx;
}

/**
 * A fresh app with data loaded and a load on the trailer.
 *
 * `lines` are {id, wt, fac, st} exactly as the app persists them — they are
 * written to localStorage and restored through restoreLoad(), so a line whose
 * id is not in the 172.101 table is dropped here just as it would be on a
 * phone. That is deliberate: a test cannot conjure a material the table does
 * not have.
 */
export async function appWith({ lines = [], place = null, dates = null, carrier = null, offline = false } = {}) {
  const storage = {};
  if (lines.length) storage["hazpost.load.v1"] = JSON.stringify({ saved: "2026-08-14T00:00:00.000Z", lines });
  if (dates) storage["hazpost.dates.v1"] = JSON.stringify(dates);
  if (carrier) storage["hazpost.carrier.v1"] = JSON.stringify(carrier);

  const ctx = runApp({ storage, offline });
  await ctx.loadData();
  if (place) ctx.setOpsPlace(place);
  return ctx;
}

/* ------------------------------------------------------------------ */

/** Read an array of object literals out of the app source by const name. */
export function sourceList(name) {
  const m = SRC.match(new RegExp(String.raw`const ${name}\s*=\s*\[([\s\S]*?)\n\];`));
  if (!m) throw new Error(`could not find const ${name} in index.html`);
  return m[1];
}

/** Read the keys of an object literal out of the app source by const name. */
export function sourceKeys(name) {
  const m = SRC.match(new RegExp(String.raw`const ${name}\s*=\s*\{([\s\S]*?)\n\};`));
  if (!m) throw new Error(`could not find const ${name} in index.html`);
  return [...m[1].matchAll(/(?:^|[\s,{])"?([A-Za-z0-9_.\-]+)"?\s*:/gm)].map((x) => x[1]);
}

/* ------------------------------------------------------------------ */

/**
 * The reporter. One per test file.
 *
 * Counts are written to the file named by HAZPOST_TEST_TALLY when the runner
 * sets it, which is how tools/test.mjs reports a total without swallowing the
 * live output of each file.
 */
export function report(title) {
  let failures = 0, checks = 0;
  console.log(`${title}\n`);

  const fail = (what, detail) => {
    failures++;
    console.error(`  FAIL  ${what}`);
    if (detail !== undefined && detail !== null && detail !== "") {
      console.error(`        ${String(detail).replace(/\n/g, "\n        ")}`);
    }
  };

  const api = {
    /** A heading. Costs no checks. */
    section(t) { console.log(`\n${t}`); },
    /** A line of context. Costs no checks. */
    note(m) { console.log(`  ${m}`); },
    /** Credit n checks that were verified in a loop rather than one at a time. */
    pass(n = 1) { checks += n; },

    ok(cond, what, detail) {
      checks++;
      if (cond) return true;
      fail(what, detail);
      return false;
    },

    eq(got, want, what) {
      checks++;
      if (JSON.stringify(got) === JSON.stringify(want)) return true;
      fail(what, `got  ${JSON.stringify(got)}\nwant ${JSON.stringify(want)}`);
      return false;
    },

    /** Set membership, order-insensitive — placard sets and category lists. */
    sameSet(got, want, what) {
      checks++;
      const a = [...new Set(got)].sort(), b = [...new Set(want)].sort();
      if (JSON.stringify(a) === JSON.stringify(b)) return true;
      fail(what, `got  ${JSON.stringify(a)}\nwant ${JSON.stringify(b)}`);
      return false;
    },

    get failures() { return failures; },
    get checks() { return checks; },

    finish() {
      const tally = process.env.HAZPOST_TEST_TALLY;
      if (tally) {
        try { appendFileSync(tally, `${checks} ${failures}\n`); } catch { /* runner will just report fewer */ }
      }
      console.log("");
      if (failures) {
        console.error(`FAILED — ${failures} of ${checks} checks\n`);
        process.exit(1);
      }
      console.log(`ok — ${checks} checks passed\n`);
    },
  };
  return api;
}

/**
 * Every test file asserts this first. Without it a data file that failed to
 * load leaves the engines answering from an empty table, and every later
 * assertion passes vacuously against a fallback.
 */
export function assertLoaded(r, ctx, what) {
  const state = ctx.dataNote();
  r.ok(/^Material data: [\d,]+ entries/.test(state), `${what}: hazmat.json loaded`, state);
  return state;
}
