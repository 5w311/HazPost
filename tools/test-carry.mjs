#!/usr/bin/env node
/**
 * What You Carry — date arithmetic, the conditional item, and the hard No.
 *
 *   node tools/test-carry.mjs
 *
 * Three things are worth a test here.
 *
 * The day arithmetic, because it is the only computation in the module and it
 * is the kind that looks right and is wrong at a month end, a year end or a
 * leap day. It is tested against a fixed "today" rather than the clock, so the
 * suite gives the same answer in December as in June.
 *
 * The 397.19 conditional, because an item that appears when it should not is a
 * driver looking for paperwork nobody owes them, and one that stays hidden
 * when it should not is worse.
 *
 * And the absence of any image capture, because that boundary is worth a
 * mechanical check rather than a memory of having agreed to it.
 *
 * Like tools/test-incident.mjs this extracts the <script> from index.html and
 * evaluates it in a vm context, so the functions under test are the ones that
 * ship. Top-level `let`/`const` are lexical and invisible to the context —
 * only function declarations become properties of it — so state is set through
 * the app's own setters and constants are read out of the source text.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "index.html"), "utf8");

let failures = 0, checks = 0;

function ok(cond, what, detail) {
  checks++;
  if (cond) return true;
  failures++;
  console.error(`  FAIL  ${what}`);
  if (detail) console.error(`        ${String(detail).replace(/\n/g, "\n        ")}`);
  return false;
}

const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want), what, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ */

function makeContext({ storage = {} } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, style: {}, innerHTML: "", textContent: "", className: "", hidden: false, value: "", addEventListener() {}, setAttribute() {} });
    return els.get(id);
  };
  const store = { ...storage };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const fetch = async (url) => {
    const name = String(url).replace(/^.*\//, "").split("?")[0];
    try {
      const body = readFileSync(join(ROOT, name), "utf8");
      return { ok: true, status: 200, statusText: "OK", json: async () => JSON.parse(body), text: async () => body };
    } catch {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => { throw new Error("404"); }, text: async () => "" };
    }
  };
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch, localStorage,
    location: { href: "https://example.test/HazPost/" },
    navigator: { onLine: true },
    document: { getElementById: el, addEventListener() {}, hidden: false },
    confirm: () => true,          /* clearDates() asks; the test always says yes */
    URL, Date, Math, JSON,
    __store: store,               /* so the test can read what was persisted */
  };
  ctx.window = ctx;
  ctx.window.addEventListener = () => {};
  ctx.window.scrollTo = () => {};
  return vm.createContext(ctx);
}

function runApp(opts) {
  const m = SRC.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error("could not find the app <script> in index.html");
  const ctx = makeContext(opts);
  vm.runInContext(m[1], ctx, { filename: "index.html#script" });
  return ctx;
}

/* ------------------------------------------------------------------ */

console.log("HazPost — What You Carry\n");

const app = runApp();
await app.loadCarry();
await app.loadData();

ok(typeof app.carStopView === "function", "the module's views are defined");
ok(/172\.704\(c\)\(4\)/.test(app.carTrainView()), "carry.json loaded and the verbatim text is in the training view");

/* ---------------- parsing: unset, malformed, impossible ---------------- */
console.log("Dates in — unset, malformed and impossible all read as not set");
{
  const bad = ["", null, undefined, "   ", "not a date", "2026", "2026-08", "08/14/2026",
               "2026-8-14", "20260814", "2026-13-01", "2026-00-10", "2026-02-30",
               "2025-02-29", "2026-01-32", "2026-01-00", "abcd-ef-gh", "2026-08-14T00:00:00Z"];
  let clean = true;
  for (const v of bad) if (app.parseISODate(v) !== null) { clean = false; ok(false, `parseISODate rejects ${JSON.stringify(v)}`); }
  if (clean) { checks++; console.log(`  ${bad.length} malformed inputs all read as not set`); }

  ok(app.parseISODate("2026-08-14") !== null, "a well-formed date parses");
  ok(app.parseISODate("2024-02-29") !== null, "29 February in a leap year parses");
  eq(app.daysUntil("", "2026-08-14"), null, "an unset date has no day count");
  eq(app.daysUntil("banana", "2026-08-14"), null, "an unparseable date has no day count");
  eq(app.expStatus(app.daysUntil("", "2026-08-14")).txt, "Not set", "and its badge says Not set");
  eq(app.expStatus(app.daysUntil("banana", "2026-08-14")).txt, "Not set", "so does an unparseable one — no error state");
}

/* ---------------- the arithmetic ---------------- */
console.log("\nDay counts — boundaries, both directions");
{
  const T = "2026-08-14";
  const cases = [
    ["2026-08-14", 0,    "exactly today"],
    ["2026-08-15", 1,    "one day out"],
    ["2026-08-13", -1,   "one day past"],
    ["2026-08-31", 17,   "later the same month"],
    ["2026-09-01", 18,   "across a month boundary"],
    ["2026-08-01", -13,  "back across a month boundary"],
    ["2027-01-01", 140,  "across a year boundary"],
    ["2025-12-31", -226, "back across a year boundary"],
    ["2026-03-01", -166, "back across February"],
    ["2027-08-14", 365,  "one year out"],
    ["2029-08-14", 1096, "three years out, over a leap day"],
  ];
  for (const [d, want, what] of cases) eq(app.daysUntil(d, T), want, `${what}: ${T} → ${d}`);

  /* 2028 is a leap year, so a February crossing has to count 29 days */
  eq(app.daysUntil("2028-03-01", "2028-02-01"), 29, "February 2028 is 29 days long");
  eq(app.daysUntil("2027-03-01", "2027-02-01"), 28, "February 2027 is 28 days long");

  /* the count is symmetric and self-consistent */
  eq(app.daysUntil("2026-08-14", "2027-08-14"), -365, "counting backwards agrees with counting forwards");
}

console.log("\nBadges — expired, 60, 180, fine, and the singular");
{
  const cases = [
    [null, "none", "Not set"],
    [-400, "bad",  "Expired 400 days ago"],
    [-2,   "bad",  "Expired 2 days ago"],
    [-1,   "bad",  "Expired 1 day ago"],
    [0,    "bad",  "Expires today"],
    [1,    "bad",  "1 day left"],
    [2,    "bad",  "2 days left"],
    [60,   "bad",  "60 days left"],
    [61,   "soon", "61 days left"],
    [180,  "soon", "180 days left"],
    [181,  "ok",   "181 days left"],
    [1800, "ok",   "1800 days left"],
  ];
  for (const [d, cls, txt] of cases) {
    const s = app.expStatus(d);
    eq([s.cls, s.txt], [cls, txt], `${d === null ? "unset" : d} → ${cls} / "${txt}"`);
  }
  ok(!/\b1 days\b/.test(app.expStatus(1).txt) && !/\b1 days\b/.test(app.expStatus(-1).txt),
    "one day is never rendered as \"1 days\"");
}

/* ---------------- training: last + 3 years, not today + 3 ---------------- */
console.log("\nTraining — due three years after the last training, not three years from today");
{
  eq(app.addYears("2024-04-01", 3), "2027-04-01", "three years on from an ordinary date");
  eq(app.addYears("2023-12-31", 3), "2026-12-31", "across a year end");
  eq(app.addYears("2024-02-29", 3), "2027-02-28", "29 February clamps back to the 28th rather than rolling into March");
  eq(app.addYears("2024-02-29", 4), "2028-02-29", "and lands on the 29th again when the target year is a leap year");
  eq(app.addYears("", 3), null, "an unset training date has no due date");
  eq(app.addYears("nope", 3), null, "an unparseable one has no due date either");

  /* the whole row, which is what the view renders */
  const field = { k: "train", addYears: 3 };
  const today = "2026-08-14";

  const r = app.expRow(field, { train: "2024-04-01" }, today);
  eq(r.due, "2027-04-01", "the row's due date is last training + 3 years");
  eq(r.days, app.daysUntil("2027-04-01", today), "and the countdown runs to that date");
  ok(r.days !== app.daysUntil(app.addYears(today, 3), today), "not to three years from today");

  /* a training date already more than three years old must read as expired */
  const stale = app.expRow(field, { train: "2020-01-01" }, today);
  eq(stale.due, "2023-01-01", "a stale training date still computes its due date");
  ok(stale.days < 0 && stale.status.cls === "bad", "and reads as expired", JSON.stringify(stale.status));

  /* trained today: due in three years, comfortably fine */
  const fresh = app.expRow(field, { train: today }, today);
  eq(fresh.due, "2029-08-14", "trained today is due in three years");
  eq(fresh.status.cls, "ok", "and reads as fine");

  /* an unset training date produces no due date and no countdown */
  const unset = app.expRow(field, {}, today);
  eq([unset.due, unset.days, unset.status.txt], [null, null, "Not set"], "an unset training date is simply not set");

  /* a plain expiry field is not shifted at all */
  const plain = app.expRow({ k: "med" }, { med: "2026-10-01" }, today);
  eq([plain.due, plain.days], ["2026-10-01", 48], "an ordinary expiry date is used as typed");
}

/* ---------------- persistence and clearing ---------------- */
console.log("\nPersistence — stored on the phone, and cleared when asked");
{
  const a = runApp();
  await a.loadCarry();
  a.setDate("hme", "2027-03-01");
  a.setDate("med", "2026-11-30");
  const raw = a.__store["hazpost.dates.v1"];
  ok(!!raw, "setting a date writes it to localStorage");
  eq(JSON.parse(raw), { hme: "2027-03-01", med: "2026-11-30" }, "and stores exactly what was typed");

  /* a fresh launch reading the same storage */
  const b = runApp({ storage: { "hazpost.dates.v1": raw } });
  await b.loadCarry();
  const v = b.carExpView();
  ok(v.includes('id="date-hme" value="2027-03-01"'), "the date comes back on the next launch");
  ok(v.includes('id="date-med" value="2026-11-30"'), "so does the second one");

  /* garbage in storage is dropped on the way in rather than rendered */
  const c = runApp({ storage: { "hazpost.dates.v1": JSON.stringify({ hme: "yesterday", cdl: "2028-01-01", junk: "x" }) } });
  await c.loadCarry();
  const cv = c.carExpView();
  ok(cv.includes('id="date-cdl" value="2028-01-01"'), "a good stored date survives a bad neighbour");
  ok(cv.includes('id="date-hme" value=""'), "a stored value that will not parse comes back empty, not broken");

  const d = runApp({ storage: { "hazpost.dates.v1": "{not json" } });
  await d.loadCarry();
  ok(d.carExpView().includes('id="date-hme" value=""'), "unreadable storage is survivable");

  /* clearing */
  a.clearDates();
  ok(!a.__store["hazpost.dates.v1"], "clearing removes the key entirely");
  ok(a.carExpView().includes('id="date-hme" value=""'), "and the fields come back empty");

  /* the dates are their own key — clearing the load must not take them */
  const e = runApp();
  await e.loadCarry();
  e.setDate("cdl", "2029-05-05");
  e.clearLoad();
  ok(e.__store["hazpost.dates.v1"], "clearing the load leaves the dates alone");
}

/* ---------------- the 397.19 conditional ---------------- */
console.log("\n397.19 — shown only when Division 1.1, 1.2 or 1.3 is on the load");
{
  const app2 = runApp();
  await app2.loadData();
  await app2.loadCarry();

  const marker = "397.19";
  const withLoad = async (ids) => {
    const a = runApp({ storage: { "hazpost.load.v1": JSON.stringify({ lines: ids.map((id) => ({ id, wt: 5000, fac: "A" })) }) } });
    await a.loadData();
    await a.loadCarry();
    return a;
  };

  /* find real 172.101 entries by division, so the test runs against the
     shipped table rather than a hand-made record */
  const hm = JSON.parse(readFileSync(join(ROOT, "hazmat.json"), "utf8"));
  const pick = (base) => (hm.records || hm).find((r) => r.base === base);
  const byDiv = {};
  for (const b of ["1.1", "1.2", "1.3", "1.4", "3", "8"]) byDiv[b] = pick(b);
  for (const [b, r] of Object.entries(byDiv)) ok(!!r, `the table has a Division ${b} entry to test with`);

  const empty = await withLoad([]);
  ok(!empty.carStopView().includes(marker), "no load — the explosives item is absent");
  ok(empty.carStopView().includes("which is empty right now"), "and the view says the load builder is empty");

  const ordinary = await withLoad([byDiv["3"].id, byDiv["8"].id]);
  ok(!ordinary.carStopView().includes(marker), "Class 3 and Class 8 — absent");

  const div14 = await withLoad([byDiv["1.4"].id]);
  ok(!div14.carStopView().includes(marker), "Division 1.4 is not 1.1/1.2/1.3 — absent");

  for (const b of ["1.1", "1.2", "1.3"]) {
    const a = await withLoad([byDiv[b].id]);
    const v = a.carStopView();
    ok(v.includes(marker), `Division ${b} — the item appears`);
    ok(v.includes("cond-tag"), `Division ${b} — and is marked conditional`);
    ok(v.includes("written route plan"), `Division ${b} — and names the route plan`);
  }

  const mixed = await withLoad([byDiv["3"].id, byDiv["1.2"].id]);
  ok(mixed.carStopView().includes(marker), "one explosive line among others is enough");

  /* the two modules must answer this question the same way */
  const m = await withLoad([byDiv["1.3"].id]);
  ok(m.opsCheck().tier1 === true && m.carStopView().includes(marker),
    "On the Road and What You Carry agree on the same load");
  const n = await withLoad([byDiv["1.4"].id]);
  ok(n.opsCheck().tier1 === false && !n.carStopView().includes(marker),
    "and agree when it is absent");
}

/* ---------------- the boundary that is not negotiable ---------------- */
console.log("\nNo document wallet — no image capture anywhere in the module");
{
  const views = [app.carStopView(), app.carExpView(), app.carTrainView(), runApp().carUnavailable()].join("\n");
  const banned = [
    [/type=["']file["']/i, "a file input"],
    [/capture\s*=/i, "a capture attribute"],
    [/accept=["'][^"']*image/i, "an image accept filter"],
    [/getUserMedia/i, "camera access"],
    [/<canvas/i, "a canvas"],
    [/FileReader/i, "a file reader"],
    [/toDataURL|readAsDataURL/i, "an image encode"],
    [/<input[^>]*type=["']?(?!date)(?!tel)(?!hidden)[a-z]/i, "an input that is not a date"],
  ];
  let clean = true;
  for (const [re, what] of banned) if (re.test(views)) { clean = false; ok(false, `the module renders ${what}`); }
  if (clean) { checks++; console.log("  no file input, no camera, no canvas, no encode — date inputs only"); }

  const inputs = [...views.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
  ok(inputs.length > 0, "the module does render date inputs");
  ok(inputs.every((i) => /type="date"/.test(i)), "and every input in it is a date input",
    inputs.filter((i) => !/type="date"/.test(i)).join("\n"));

  /* and it says so, because the reason matters more than the absence */
  const exp = app.carExpView();
  ok(/No photographs of anything, ever/i.test(exp), "the module states the boundary in plain words");
  ok(/on this phone only/i.test(exp), "and says the dates never leave the device");
  ok(/no notifications/i.test(exp), "and that there are no notifications");
}

/* ---------------- framing ---------------- */
console.log("\nFraming — the employer's duty, not the driver's");
{
  const stop = app.carStopView(), train = app.carTrainView();
  ok(/no training certificate you are expected to have/i.test(stop),
    "the At a stop tab says there is no training certificate to produce");
  ok(/172\.704\(c\)\(4\)/.test(stop) && /carrier's violation/i.test(stop),
    "and that a gap is the carrier's violation");
  ok(/None of this is yours to do/i.test(train), "the training tab leads with whose job it is");
  ok(/current record of it is obtained from the previous employer/i.test(train),
    "and surfaces the previous-employer record rather than burying it");
  ok(/23 June 2025/.test(stop) && /no longer carries the medical examiner's certificate/i.test(stop),
    "the medical item reflects the June 2025 change");
  ok(/electronic record controls/i.test(stop), "and says which record wins");

  /* Every section HazPost cites in its own voice must be one the data carries,
     so no card can claim a paragraph the module cannot show. Scoped to the
     cite spans on purpose: the verbatim text is full of cross-references to
     sections that are not in this file and never needed to be. */
  const carry = JSON.parse(readFileSync(join(ROOT, "carry.json"), "utf8"));
  const have = new Set(carry.sections.map((s) => s.n));
  const spans = [...[stop, train, app.carExpView()].join("\n").matchAll(/<span class="cite">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  ok(spans.length >= 8, "the module carries cite spans to check", `${spans.length} found`);
  const shown = new Set(spans.flatMap((s) => [...s.matchAll(/(\d+\.\d+)/g)].map((m) => m[1])));
  /* 177.817 is linked across to the Shipping Papers module rather than quoted
     here, and 391.46 / 391.44 are named in a note as the 12-month cases. */
  const linked = new Set(["177.817", "391.44", "391.46"]);
  const orphan = [...shown].filter((n) => !have.has(n) && !linked.has(n));
  ok(orphan.length === 0, "every section the module cites in its own voice is in carry.json", orphan.join(", "));
}

/* ------------------------------------------------------------------ */

console.log("");
if (failures) {
  console.error(`FAILED — ${failures} of ${checks} checks\n`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed\n`);
