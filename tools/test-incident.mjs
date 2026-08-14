#!/usr/bin/env node
/**
 * Incident Response invariants — 49 CFR 171.15, 171.16.
 *
 *   node tools/test-incident.mjs
 *
 * This is not a rendering test. It exists for one paragraph:
 *
 *   171.15(b)(5) — "A situation exists of such a nature (e.g., a continuing
 *   danger to life exists at the scene of the incident) that, in the judgment
 *   of the person in possession of the hazardous material, it should be
 *   reported to the NRC even though it does not meet the criteria of
 *   paragraphs (b)(1), (2), (3) or (4) of this section"
 *
 * An empty checklist therefore is not an answer. It is an unanswered question
 * belonging to a human who can see the scene. HazPost cannot see the scene, so
 * no code path in the module may produce text meaning no report is required.
 * That is asserted here over every subset of the checklist — 2^n of them — and
 * over every view the module can render, including the one it falls back to
 * when incident.json fails to load.
 *
 * Two more invariants are asserted alongside it: that the landing view is who
 * to call, with 911 first and as a tel: link and nothing to answer or dismiss
 * ahead of it; and that the NRC is presented as a regulatory notification
 * rather than a call for help.
 *
 * HOW IT RUNS. index.html is a single file with no build step and no module
 * boundary, so the test extracts its <script> and evaluates it in a vm context
 * against stub globals. Nothing is copied out of the app and re-implemented
 * here: the functions under test are the ones that ship. Note that top-level
 * `let`/`const` bindings are lexical and never become properties of the vm
 * context — only function declarations do. That is why the checklist keys are
 * read out of the source text rather than off the context, and why INC is
 * populated by calling the app's own loadIncident() through a stub fetch.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "index.html"), "utf8");

/* ------------------------------------------------------------------ *
 * The phrases that may never appear.
 *
 * Blunt substring-ish patterns, deliberately. A test that tried to tell an
 * assertion from its denial ("that is not the same as no report") would be a
 * test with an opinion, and the whole point is that this one has none: if the
 * words are on the screen at all, a driver reading in a hurry can come away
 * with them. The copy is written to avoid the shapes rather than to argue with
 * the matcher.
 *
 * The scan covers verbatim CFR text too, which the module quotes in full. No
 * pattern below fires on 171.15 or 171.16 as published — checked, and if the
 * CFR is ever amended into one of these shapes that is worth a human look
 * rather than a silent exemption.
 * ------------------------------------------------------------------ */
const FORBIDDEN = [
  /\bnot\s+reportable\b/i,
  /\bnon-?reportable\b/i,
  /\bno\s+report\b/i,
  /\bnot\s+a\s+reportable\s+incident\b/i,
  /\bnot\s+required\s+to\s+(report|call|notify|file)\b/i,
  /\bno\s+(need|obligation|duty|requirement)\s+to\s+(report|call|notify|file)\b/i,
  /\b(don'?t|do\s+not|does\s+not|doesn'?t|did\s+not|didn'?t)\s+(have\s+to\s+|need\s+to\s+)?(report|call|notify|file)\b/i,
  /\bno\s+(telephone\s+|phone\s+)?(notice|notification|call|reporting)\s+(is\s+)?(required|needed|necessary|due)\b/i,
  /\b(notice|report|call|notification|reporting)\s+is\s+not\s+(required|needed|necessary|due)\b/i,
  /\bnothing\s+to\s+report\b/i,
  /\bno\s+action\s+(is\s+)?(required|needed|necessary)\b/i,
  /\bno\s+further\s+action\b/i,
  /\byou'?re?\s+(in\s+the\s+)?clear\b/i,
  /\bin\s+the\s+clear\b/i,
  /\bnothing\s+further\s+is\s+(required|needed)\b/i,
];

/* ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;

function ok(cond, what, detail) {
  checks++;
  if (cond) return true;
  failures++;
  console.error(`  FAIL  ${what}`);
  if (detail) console.error(`        ${String(detail).replace(/\n/g, "\n        ")}`);
  return false;
}

function scanForbidden(html, where) {
  const text = String(html);
  let clean = true;
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      clean = false;
      const at = text.indexOf(m[0]);
      const ctx = text.slice(Math.max(0, at - 90), at + m[0].length + 90).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      ok(false, `${where} says something meaning no report is required`,
        `matched ${re}\n…${ctx}…`);
    }
  }
  if (clean) checks++;
  return clean;
}

/* ---- a DOM and a network, in the smallest amounts that will do ---- */

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

  /* Serves the repo off disk. The app's own fetch calls run against it, so
     loadIncident() in the test is the same loadIncident() a phone runs. */
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
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch,
    localStorage,
    location: { href: "https://example.test/HazPost/" },
    navigator: { onLine: true },   /* no serviceWorker key: registerSW() returns at the door */
    document: {
      getElementById: el,
      addEventListener() {},
      hidden: false,
    },
    URL, Response: undefined, Date, Math, JSON,
  };
  ctx.window = ctx;               /* `"caches" in window` — no caches key, so readCacheMeta() returns */
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

/* The checklist keys are a top-level const and so are invisible to the vm
   context. Read them out of the source instead — which also means a trigger
   added to the module is picked up by this test without anyone remembering to
   come here and add it. */
function triggerKeys() {
  const block = SRC.match(/const INC_TRIGGERS = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("could not find INC_TRIGGERS in index.html");
  const keys = [...block[1].matchAll(/\{k:"([a-z0-9]+)"/gi)].map((x) => x[1]);
  if (!keys.length) throw new Error("INC_TRIGGERS parsed to zero keys");
  return keys;
}

function subsets(keys) {
  const out = [];
  for (let mask = 0; mask < (1 << keys.length); mask++) {
    const picked = {};
    keys.forEach((k, i) => { if (mask & (1 << i)) picked[k] = true; });
    out.push(picked);
  }
  return out;
}

/* ------------------------------------------------------------------ */

console.log("HazPost — Incident Response invariants\n");

const app = runApp();
await app.loadIncident();
ok(typeof app.incNowView === "function", "the module's views are defined");

/* incident.json really did load — otherwise every view below is the fallback
   and the assertions would pass vacuously. */
const loaded = app.incNoticeView();
ok(/171\.15\(b\)\(5\)/.test(loaded), "incident.json loaded and the verbatim text is in the notice view");

const KEYS = triggerKeys();
console.log(`  checklist: ${KEYS.length} triggers — ${KEYS.join(", ")}`);
console.log(`  subsets:   ${1 << KEYS.length}\n`);

/* ---------------- INVARIANT 1 — the landing view is who to call ---------------- */
console.log("INVARIANT 1 — the default view is who to call, 911 first, as a tel: link");
{
  const now = app.incNowView();
  const tel911 = now.indexOf('href="tel:911"');
  ok(tel911 >= 0, "the landing view has a tel:911 link");

  const firstTel = now.indexOf('href="tel:');
  ok(firstTel === tel911, "911 is the first tel: link on the landing view",
    firstTel >= 0 ? `first tel: link is ${now.slice(firstTel, firstTel + 40)}` : "no tel: link at all");

  /* nothing to answer, tick or dismiss above it */
  const firstOnclick = now.indexOf("onclick");
  ok(firstOnclick === -1 || firstOnclick > tel911, "nothing tappable precedes 911");
  const firstInput = now.indexOf("<input");
  ok(firstInput === -1 || firstInput > tel911, "no question precedes 911");
  ok(!/class="trig/.test(now), "the checklist is not on the landing view");
  ok(!/<details/.test(now.slice(0, tel911)), "nothing is folded shut ahead of 911");

  /* the first element of the view, not merely somewhere on it */
  ok(now.trimStart().startsWith('<a class="call urgent" href="tel:911"'),
    "911 is the first element rendered", now.trimStart().slice(0, 80));

  /* the router's default tab, and the tab it maps to */
  ok(/let view = "home",[^\n]*incTab = "now"/.test(SRC), "incTab defaults to the landing view");
  ok(/incTab==='now' \? incNowView\(\)/.test(SRC), "the landing tab renders incNowView()");

  /* the module must survive the shipping paper's number being absent */
  ok(/172\.604/.test(now), "the landing view points at the shipping paper's emergency number");
  ok(/HazPost does not have it/.test(now), "the landing view says HazPost does not have that number");

  /* the carrier number, stored and not */
  ok(/carTel/.test(now), "the landing view offers to store the carrier safety desk number");
  const withCarrier = runApp({ storage: { "hazpost.carrier.v1": JSON.stringify({ tel: "555-0100", name: "Night dispatch" }) } });
  await withCarrier.loadIncident();
  const now2 = withCarrier.incNowView();
  ok(/href="tel:5550100"/.test(now2), "a stored carrier number becomes a tel: link");
  ok(now2.indexOf('href="tel:911"') < now2.indexOf('href="tel:5550100"'), "911 still comes first");
  ok(/Night dispatch/.test(now2), "the stored label is shown");

  /* and it survives a reload — same key, fresh context, no re-entry */
  const relaunched = runApp({ storage: { "hazpost.carrier.v1": JSON.stringify({ tel: "555-0100", name: "Night dispatch" }) } });
  ok(/href="tel:5550100"/.test(relaunched.incNowView()), "the carrier number persists across a relaunch");

  /* the fallback path, when incident.json never arrived */
  const dead = runApp();
  const un = dead.incUnavailable();
  ok(un.trimStart().startsWith('<a class="call urgent" href="tel:911"'), "911 is first even when incident.json fails");
}

/* ---------------- INVARIANT 2 — no all-clear, on any path ---------------- */
console.log("\nINVARIANT 2 — no code path says a report is unnecessary");
{
  /* the empty checklist: the case the invariant is named for */
  const v = app.incidentVerdict({});
  ok(v.kind === "unsettled", "an empty checklist is unsettled, not cleared", `kind=${v.kind}`);
  ok(/carrier/i.test(v.action), "the empty-checklist verdict still ends in a phone call", v.action);

  const empty = app.incVerdictHTML({});
  scanForbidden(empty, "the empty-checklist verdict");
  ok(/171\.15\(b\)\(5\)/.test(empty), "the empty-checklist verdict cites 171.15(b)(5)");
  ok(/HazPost cannot make that judgment/i.test(empty), "the empty-checklist verdict says HazPost cannot judge it");
  ok(/carrier'?s safety desk/i.test(empty), "the empty-checklist verdict routes to the carrier");

  /* and then every other checklist there is */
  const all = subsets(KEYS);
  let bad = 0;
  for (const picked of all) {
    const verdict = app.incidentVerdict(picked);
    if (verdict.kind !== "required" && verdict.kind !== "unsettled") { bad++; continue; }
    if (!verdict.action || !/(call|telephone|notice)/i.test(verdict.action)) { bad++; continue; }
    for (const re of FORBIDDEN) {
      if (re.test(app.incVerdictHTML(picked))) {
        bad++;
        ok(false, `verdict for {${Object.keys(picked).join(",")}} matched ${re}`);
        break;
      }
    }
  }
  ok(bad === 0, `all ${all.length} checklists produce a verdict that ends in a phone call`, `${bad} did not`);

  /* every view, whole */
  scanForbidden(app.incNowView(), "the landing view");
  scanForbidden(app.incNoticeView(), "the notice view");
  scanForbidden(app.incWrittenView(), "the written report view");
  scanForbidden(runApp().incUnavailable(), "the data-unavailable view");

  /* the written report is the wider net, and the module has to say so */
  const w = app.incWrittenView();
  ok(/171\.16\(a\)\(2\)|unintentional release/i.test(w), "the written view names the unintentional-release trigger");
  ok(/171\.16\(d\)/.test(w) && /HazPost does not apply them/i.test(w),
    "the 171.16(d) exceptions are quoted, not applied");
  ok(/neither prefills nor reproduces Form 5800\.1/i.test(w), "the module disclaims producing Form 5800.1");
  ok(!/<form\b/i.test(w) && !/name="5800/i.test(w), "no 5800.1 form is rendered");
}

/* ---------------- INVARIANT 3 — the NRC is not an emergency number ---------------- */
console.log("\nINVARIANT 3 — the NRC is a regulatory notification, said on the landing view");
{
  const now = app.incNowView();
  ok(/not an emergency number/i.test(now), "the landing view says the NRC is not an emergency number");
  ok(/regulatory notification/i.test(now), "the landing view calls it a regulatory notification");
  ok(/nobody is dispatched/i.test(now), "the landing view says nobody is dispatched");
  ok(/12 hours/i.test(now), "the landing view gives the 12-hour window");
  ok(/171\.15\(a\)/.test(now), "the landing view cites 171.15(a)");

  /* said in our words AND quoted — the standing rule for this app */
  ok(/As soon as practical but no later than 12 hours/.test(now),
    "171.15(a) is quoted verbatim alongside the plain-language version");

  /* the NRC must not sit on the landing view dressed as a number to call now */
  const tels = [...now.matchAll(/href="tel:([^"]*)"/g)].map((m) => m[1]);
  ok(tels.length === 1 && tels[0] === "911",
    "911 is the only tel: link on the landing view", `found: ${tels.join(", ") || "none"}`);
  ok(!/8004248802/.test(now), "the NRC number is not a tap-to-call on the landing view");

  /* it becomes one on the notice tab, where the question is being answered */
  const required = app.incVerdictHTML({ [KEYS[0]]: true });
  ok(/href="tel:8004248802"/.test(required), "the NRC is dialable from a verdict that requires the call");
  ok(/12 hours/.test(required), "the required verdict repeats the 12-hour window");
}

/* ------------------------------------------------------------------ */

console.log("");
if (failures) {
  console.error(`FAILED — ${failures} of ${checks} checks\n`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed\n`);
