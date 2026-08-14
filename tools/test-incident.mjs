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
 * HOW IT RUNS. tools/test-harness.mjs extracts the app's <script> from
 * index.html and evaluates it in a vm context against stub globals, so the
 * functions under test are the ones that ship. Note the constraint documented
 * there: top-level `let`/`const` bindings are lexical and never become
 * properties of the vm context — only function declarations do. That is why
 * the checklist keys are read out of the source text rather than off the
 * context, and why INC is populated by calling the app's own loadIncident()
 * through the stub fetch.
 */

import { report, runApp, SRC } from "./test-harness.mjs";

const r = report("HazPost — Incident Response invariants");

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

function scanForbidden(html, where) {
  const text = String(html);
  let clean = true;
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      clean = false;
      const at = text.indexOf(m[0]);
      const around = text.slice(Math.max(0, at - 90), at + m[0].length + 90).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      r.ok(false, `${where} says something meaning no report is required`,
        `matched ${re}\n…${around}…`);
    }
  }
  if (clean) r.pass();
  return clean;
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

const app = runApp();
await app.loadIncident();
r.ok(typeof app.incNowView === "function", "the module's views are defined");

/* incident.json really did load — otherwise every view below is the fallback
   and the assertions would pass vacuously. */
const loaded = app.incNoticeView();
r.ok(/171\.15\(b\)\(5\)/.test(loaded), "incident.json loaded and the verbatim text is in the notice view");

const KEYS = triggerKeys();
r.note(`checklist: ${KEYS.length} triggers — ${KEYS.join(", ")}`);
r.note(`subsets:   ${1 << KEYS.length}`);

/* ---------------- INVARIANT 1 — the landing view is who to call ---------------- */
r.section("INVARIANT 1 — the default view is who to call, 911 first, as a tel: link");
{
  const now = app.incNowView();
  const tel911 = now.indexOf('href="tel:911"');
  r.ok(tel911 >= 0, "the landing view has a tel:911 link");

  const firstTel = now.indexOf('href="tel:');
  r.ok(firstTel === tel911, "911 is the first tel: link on the landing view",
    firstTel >= 0 ? `first tel: link is ${now.slice(firstTel, firstTel + 40)}` : "no tel: link at all");

  /* nothing to answer, tick or dismiss above it */
  const firstOnclick = now.indexOf("onclick");
  r.ok(firstOnclick === -1 || firstOnclick > tel911, "nothing tappable precedes 911");
  const firstInput = now.indexOf("<input");
  r.ok(firstInput === -1 || firstInput > tel911, "no question precedes 911");
  r.ok(!/class="trig/.test(now), "the checklist is not on the landing view");
  r.ok(!/<details/.test(now.slice(0, tel911)), "nothing is folded shut ahead of 911");

  /* the first element of the view, not merely somewhere on it */
  r.ok(now.trimStart().startsWith('<a class="call urgent" href="tel:911"'),
    "911 is the first element rendered", now.trimStart().slice(0, 80));

  /* the router's default tab, and the tab it maps to */
  r.ok(/let view = "home",[^\n]*incTab = "now"/.test(SRC), "incTab defaults to the landing view");
  r.ok(/incTab==='now' \? incNowView\(\)/.test(SRC), "the landing tab renders incNowView()");

  /* the module must survive the shipping paper's number being absent */
  r.ok(/172\.604/.test(now), "the landing view points at the shipping paper's emergency number");
  r.ok(/HazPost does not have it/.test(now), "the landing view says HazPost does not have that number");

  /* the carrier number, stored and not */
  r.ok(/carTel/.test(now), "the landing view offers to store the carrier safety desk number");
  const withCarrier = runApp({ storage: { "hazpost.carrier.v1": JSON.stringify({ tel: "555-0100", name: "Night dispatch" }) } });
  await withCarrier.loadIncident();
  const now2 = withCarrier.incNowView();
  r.ok(/href="tel:5550100"/.test(now2), "a stored carrier number becomes a tel: link");
  r.ok(now2.indexOf('href="tel:911"') < now2.indexOf('href="tel:5550100"'), "911 still comes first");
  r.ok(/Night dispatch/.test(now2), "the stored label is shown");

  /* and it survives a reload — same key, fresh context, no re-entry */
  const relaunched = runApp({ storage: { "hazpost.carrier.v1": JSON.stringify({ tel: "555-0100", name: "Night dispatch" }) } });
  r.ok(/href="tel:5550100"/.test(relaunched.incNowView()), "the carrier number persists across a relaunch");

  /* the fallback path, when incident.json never arrived */
  const dead = runApp();
  const un = dead.incUnavailable();
  r.ok(un.trimStart().startsWith('<a class="call urgent" href="tel:911"'), "911 is first even when incident.json fails");
}

/* ---------------- INVARIANT 2 — no all-clear, on any path ---------------- */
r.section("INVARIANT 2 — no code path says a report is unnecessary");
{
  /* the empty checklist: the case the invariant is named for */
  const v = app.incidentVerdict({});
  r.ok(v.kind === "unsettled", "an empty checklist is unsettled, not cleared", `kind=${v.kind}`);
  r.ok(/carrier/i.test(v.action), "the empty-checklist verdict still ends in a phone call", v.action);

  const empty = app.incVerdictHTML({});
  scanForbidden(empty, "the empty-checklist verdict");
  r.ok(/171\.15\(b\)\(5\)/.test(empty), "the empty-checklist verdict cites 171.15(b)(5)");
  r.ok(/HazPost cannot make that judgment/i.test(empty), "the empty-checklist verdict says HazPost cannot judge it");
  r.ok(/carrier'?s safety desk/i.test(empty), "the empty-checklist verdict routes to the carrier");

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
        r.ok(false, `verdict for {${Object.keys(picked).join(",")}} matched ${re}`);
        break;
      }
    }
  }
  r.ok(bad === 0, `all ${all.length} checklists produce a verdict that ends in a phone call`, `${bad} did not`);

  /* every view, whole */
  scanForbidden(app.incNowView(), "the landing view");
  scanForbidden(app.incNoticeView(), "the notice view");
  scanForbidden(app.incWrittenView(), "the written report view");
  scanForbidden(runApp().incUnavailable(), "the data-unavailable view");

  /* the written report is the wider net, and the module has to say so */
  const w = app.incWrittenView();
  r.ok(/171\.16\(a\)\(2\)|unintentional release/i.test(w), "the written view names the unintentional-release trigger");
  r.ok(/171\.16\(d\)/.test(w) && /HazPost does not apply them/i.test(w),
    "the 171.16(d) exceptions are quoted, not applied");
  r.ok(/neither prefills nor reproduces Form 5800\.1/i.test(w), "the module disclaims producing Form 5800.1");
  r.ok(!/<form\b/i.test(w) && !/name="5800/i.test(w), "no 5800.1 form is rendered");
}

/* ---------------- INVARIANT 3 — the NRC is not an emergency number ---------------- */
r.section("INVARIANT 3 — the NRC is a regulatory notification, said on the landing view");
{
  const now = app.incNowView();
  r.ok(/not an emergency number/i.test(now), "the landing view says the NRC is not an emergency number");
  r.ok(/regulatory notification/i.test(now), "the landing view calls it a regulatory notification");
  r.ok(/nobody is dispatched/i.test(now), "the landing view says nobody is dispatched");
  r.ok(/12 hours/i.test(now), "the landing view gives the 12-hour window");
  r.ok(/171\.15\(a\)/.test(now), "the landing view cites 171.15(a)");

  /* said in our words AND quoted — the standing rule for this app */
  r.ok(/As soon as practical but no later than 12 hours/.test(now),
    "171.15(a) is quoted verbatim alongside the plain-language version");

  /* the NRC must not sit on the landing view dressed as a number to call now */
  const tels = [...now.matchAll(/href="tel:([^"]*)"/g)].map((m) => m[1]);
  r.ok(tels.length === 1 && tels[0] === "911",
    "911 is the only tel: link on the landing view", `found: ${tels.join(", ") || "none"}`);
  r.ok(!/8004248802/.test(now), "the NRC number is not a tap-to-call on the landing view");

  /* it becomes one on the notice tab, where the question is being answered */
  const required = app.incVerdictHTML({ [KEYS[0]]: true });
  r.ok(/href="tel:8004248802"/.test(required), "the NRC is dialable from a verdict that requires the call");
  r.ok(/12 hours/.test(required), "the required verdict repeats the 12-hour window");
}

r.finish();
