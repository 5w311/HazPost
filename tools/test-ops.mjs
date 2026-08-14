#!/usr/bin/env node
/**
 * On the Road — 49 CFR Part 397 Subpart A, against hasTier1, opsCheck,
 * opsRules and opsHeadline.
 *
 *   node tools/test-ops.mjs
 *
 * Part 397 is mostly prose, and the module's whole job is to cross one fact
 * about the trailer with one fact about where the truck is sitting. That is
 * eight combinations, and all eight are walked here — by cite and by tone,
 * never by wording.
 *
 * Tone carries meaning in this module and the tests lean on it: "stop" is a
 * prohibition, "care" is a conditional requirement, "ok" is a rule that does
 * not reach you. The Tier 2 attendance case is the one where that matters
 * most — 397.5(c) is cited in every Tier 2 combination, and only the tone
 * distinguishes "you must stay with the vehicle" from "this rule is not about
 * you here", which is the non-obvious result the module exists to state.
 */

import { report, appWith, assertLoaded, json, sourceList } from "./test-harness.mjs";

const r = report("HazPost — On the Road, 49 CFR Part 397 Subpart A");

const HM = json("hazmat.json").records;

const M = {
  d11:      "UN0004",   // Division 1.1 — Tier 1
  d12:      "UN0035",   // Division 1.2 — Tier 1
  d13:      "UN0159",   // Division 1.3 — Tier 1
  d14:      "UN0012",   // Division 1.4 — NOT Tier 1
  d15:      "UN0331",   // Division 1.5 — NOT Tier 1
  gasoline: "UN1203",   // Class 3 — Tier 2 when placarded
  acid:     "UN1830",   // Class 8
  oxidizer: "UN1479",   // Division 5.1 — a 397.13 smoking class
};

/* The locations are read out of the app so a place added there turns up here
   without anyone remembering to come and add it. */
const PLACES = [...sourceList("OPS_PLACES").matchAll(/\{k:"([a-z]+)"/g)].map((m) => m[1]);
r.sameSet(PLACES, ["road", "private", "carrier", "haven"], "the four locations the module offers");

for (const [k, id] of Object.entries(M)) {
  const rec = HM.find((x) => x.id === id);
  r.ok(!!rec, `the shipped table has ${id} (${k})`);
}

const line = (id, wt = 5000) => ({ id, wt, fac: "A" });
const cites = (rules) => rules.map((x) => x.cite);
const toneOf = (rules, cite) => (rules.find((x) => x.cite === cite) || {}).tone;

/** The rule set for one combination, driven through the app's own seams. */
async function at(lines, place) {
  const ctx = await appWith({ lines, place });
  const st = ctx.opsCheck();
  return { ctx, st, rules: ctx.opsRules(st), head: ctx.opsHeadline(st) };
}

/* ------------------------------------------------------------------ */

r.section("Sanity, and the tier itself");
{
  const ctx = await appWith({ lines: [line(M.gasoline)] });
  assertLoaded(r, ctx, "ops");
  r.ok(ctx.OPS === undefined, "OPS is lexical and not reachable — the harness note holds");
  r.ok(/Part 397/.test(ctx.opsRefView()), "ops.json loaded: the reference view has Part 397 in it");

  r.ok(ctx.hasTier1([{ base: "1.1" }]) === true, "Division 1.1 is Tier 1");
  r.ok(ctx.hasTier1([{ base: "1.2" }]) === true, "Division 1.2 is Tier 1");
  r.ok(ctx.hasTier1([{ base: "1.3" }]) === true, "Division 1.3 is Tier 1");
  r.ok(ctx.hasTier1([{ base: "1.4" }]) === false, "Division 1.4 is not");
  r.ok(ctx.hasTier1([{ base: "1.5" }]) === false, "Division 1.5 is not");
  r.ok(ctx.hasTier1([{ base: "1.6" }]) === false, "Division 1.6 is not");
  r.ok(ctx.hasTier1([{ base: "3" }, { base: "1.2" }]) === true, "one line is enough");
  r.ok(ctx.hasTier1([]) === false, "an empty trailer is not Tier 1");

  /* through the real load path, not a hand-made object */
  for (const k of ["d11", "d12", "d13"]) {
    const a = await at([line(M[k])], "road");
    r.ok(a.st.tier1 === true, `${M[k]} puts the load in Tier 1`);
  }
  for (const k of ["d14", "d15"]) {
    const a = await at([line(M[k])], "road");
    r.ok(a.st.tier1 === false, `${M[k]} does not`);
  }
}

/* ---------------- Tier 1, all four locations ---------------- */
r.section("Tier 1 — Division 1.1, 1.2 or 1.3 aboard");
{
  const expected = {
    /* place: [attendance cite, attendance tone, the rest of the cites] */
    road:    { att: "397.5(a), (b)(1)",   tone: "stop", also: ["397.7(a)(1)", "397.7(a)(3)"] },
    private: { att: "397.5(a), (b)(1)",   tone: "stop", also: ["397.7(a)(1)", "397.7(a)(2)", "397.7(a)(3)"] },
    carrier: { att: "397.5(b)(1)–(3)",    tone: "care", also: ["397.7(a)(1)", "397.7(a)(2)", "397.7(a)(3)"] },
    haven:   { att: "397.5(b)",           tone: "care", also: ["397.7(a)(1)", "397.7(a)(2)", "397.7(a)(3)"] },
  };

  for (const place of PLACES) {
    const e = expected[place];
    const { rules, head } = await at([line(M.d11)], place);

    r.sameSet(cites(rules), [e.att, ...e.also], `Tier 1 at ${place}: the rule set`);
    r.eq(toneOf(rules, e.att), e.tone, `Tier 1 at ${place}: attendance is ${e.tone}`);

    /* the two that must never go missing, wherever the truck is */
    r.ok(cites(rules).includes("397.7(a)(1)"), `Tier 1 at ${place}: the 5-foot rule is present`);
    r.ok(cites(rules).includes("397.7(a)(3)"), `Tier 1 at ${place}: the 300-foot rule is present`);
    r.eq(toneOf(rules, "397.7(a)(3)"), "stop", `Tier 1 at ${place}: 300 feet is a prohibition`);

    /* Tier 1 never gets the Tier 2 paragraphs */
    r.ok(!cites(rules).includes("397.5(c)"), `Tier 1 at ${place}: 397.5(c) is a Tier 2 rule and is absent`);
    r.ok(!cites(rules).includes("397.7(b)"), `Tier 1 at ${place}: 397.7(b) is absent`);

    r.ok(head !== null, `Tier 1 at ${place}: the compound conclusion fires`);
    r.ok(!!(head && head.t && head.p), `Tier 1 at ${place}: and it has something to say`);
  }

  /* attendance is required outright wherever the 397.5(b) exception cannot
     reach, and conditional exactly where it can */
  const strict = [], conditional = [];
  for (const place of PLACES) {
    const { rules } = await at([line(M.d11)], place);
    (toneOf(rules, expected[place].att) === "stop" ? strict : conditional).push(place);
  }
  r.sameSet(strict, ["road", "private"],
    "attendance is unconditional on a public roadway and on other private property");
  r.sameSet(conditional, ["carrier", "haven"],
    "and conditional only where 397.5(b) can reach — carrier/shipper/consignee property and a safe haven");

  /* the 5-foot rule is a flat prohibition on the roadway and a caution off it */
  r.eq(toneOf((await at([line(M.d11)], "road")).rules, "397.7(a)(1)"), "stop",
    "on the roadway the 5-foot rule is flat — 397.7(a)(1) has no brief-necessity escape");
  for (const place of ["private", "carrier", "haven"]) {
    r.eq(toneOf((await at([line(M.d11)], place)).rules, "397.7(a)(1)"), "care",
      `off the roadway at ${place} it is a caution, because a nose can still stick out`);
  }

  /* consent is a prohibition on other private property, a caution on your own */
  r.eq(toneOf((await at([line(M.d11)], "private")).rules, "397.7(a)(2)"), "stop",
    "private property needs informed consent");
  for (const place of ["carrier", "haven"]) {
    r.eq(toneOf((await at([line(M.d11)], place)).rules, "397.7(a)(2)"), "care",
      `at ${place} consent is normally implicit but still has to be informed`);
  }
  r.ok(!cites((await at([line(M.d11)], "road")).rules).includes("397.7(a)(2)"),
    "and the consent rule is absent on a public roadway, where there is nobody to consent");
}

/* ---------------- Tier 2, all four locations ---------------- */
r.section("Tier 2 — placarded, no 1.1, 1.2 or 1.3");
{
  const load = [line(M.gasoline, 5000)];

  for (const place of PLACES) {
    const { st, rules, head } = await at(load, place);
    r.ok(st.tier1 === false, `Tier 2 at ${place}: not the strict tier`);
    r.ok(st.placarded === true, `Tier 2 at ${place}: the load is placarded, so Part 397 applies`);
    r.sameSet(cites(rules), ["397.5(c)", "397.7(b)"], `Tier 2 at ${place}: two rules, and only two`);
    r.ok(!cites(rules).some((c) => /397\.5\(a\)|397\.5\(b\)|397\.7\(a\)/.test(c)),
      `Tier 2 at ${place}: none of the Tier 1 paragraphs appear`);
    r.eq(head, null, `Tier 2 at ${place}: no compound conclusion — it does not compound`);
  }

  /* The result the module exists to state. 397.5(c) is cited in all four
     combinations; only the tone says whether it reaches you. */
  r.eq(toneOf((await at(load, "road")).rules, "397.5(c)"), "care",
    "on a public street, highway or shoulder, 397.5(c) requires attendance by the driver");
  for (const place of ["private", "carrier", "haven"]) {
    r.eq(toneOf((await at(load, place)).rules, "397.5(c)"), "ok",
      `parked off the roadway at ${place}, 397.5(c) does not reach the driver at all`);
  }

  r.eq(toneOf((await at(load, "road")).rules, "397.7(b)"), "care",
    "and the 5-foot rule bites on the roadway");
  for (const place of ["private", "carrier", "haven"]) {
    r.eq(toneOf((await at(load, place)).rules, "397.7(b)"), "ok",
      `off it at ${place} the 5-foot rule is a caution about the entrance, not a bar`);
  }
}

/* ---------------- no placards ---------------- */
r.section("397.1(a) — a load that needs no placards");
{
  const ctx = await appWith({ lines: [line(M.gasoline, 900)], place: "road" });
  const st = ctx.opsCheck();
  r.ok(st.placarded === false, "900 lb of gasoline needs no placard");
  r.ok(st.tier1 === false, "and is not Tier 1");

  const view = ctx.opsWhereView();
  r.ok(/397\.1\(a\)/.test(view), "the module answers with 397.1(a) rather than a rule set");
  r.ok(/segv clear/.test(view), "and says most of Part 397 does not apply");
  r.ok(!/What applies right now/.test(view), "no operational rules are rendered at all");
  r.ok(/397\.3/.test(view), "but 397.3 is still named — state and local law binds regardless");

  /* one more line, and it does apply */
  const over = await appWith({ lines: [line(M.gasoline, 900), line(M.acid, 200)], place: "road" });
  r.ok(over.opsCheck().placarded === true, "one more pickup crosses 1,001 lb and Part 397 arrives");
  r.ok(/What applies right now/.test(over.opsWhereView()), "and the rules are rendered");
}

r.section("Before a location is chosen");
{
  const ctx = await appWith({ lines: [line(M.gasoline)] });
  const st = ctx.opsCheck();
  r.eq(st.place, null, "no location is assumed");
  r.ok(/Where are you stopping/.test(ctx.opsWhereView()), "the module asks");
  r.ok(!/What applies right now/.test(ctx.opsWhereView()),
    "and renders no rules until it is answered — half the question is not an answer");

  ctx.setOpsPlace("haven");
  r.eq(ctx.opsCheck().place, "haven", "setOpsPlace answers it");
  r.ok(/What applies right now/.test(ctx.opsWhereView()), "and then the rules appear");

  /* the answer rides with the load */
  r.ok(JSON.parse(ctx.__store["hazpost.load.v1"]).opsPlace === "haven",
    "and it is persisted with the load rather than asked again next launch");
}

/* ---------------- 397.13 ---------------- */
r.section("397.13 — the smoking classes, named not guessed");
{
  const one = await appWith({ lines: [line(M.gasoline)], place: "road" });
  r.sameSet(one.opsCheck().smoking, ["Class 3"], "Class 3 is one of the classes 397.13 names");

  const two = await appWith({ lines: [line(M.gasoline), line(M.oxidizer)], place: "road" });
  r.sameSet(two.opsCheck().smoking, ["Class 3", "Class 5"], "so is Class 5");

  const expl = await appWith({ lines: [line(M.d11)], place: "road" });
  r.sameSet(expl.opsCheck().smoking, ["Class 1"], "and Class 1");

  const none = await appWith({ lines: [line(M.acid)], place: "road" });
  r.sameSet(none.opsCheck().smoking, [], "Class 8 is not on the 397.13 list");
}

r.section("A Class 1 subsidiary does not make the load Tier 1");
{
  const bare = HM.find((x) => String(x.subs || "").split(/,\s*/).some((t) => t === "1" || /^1\./.test(t)));
  r.ok(!!bare, "the table has an entry with a Class 1 subsidiary");
  const ctx = await appWith({ lines: [line(bare.id)], place: "road" });
  const st = ctx.opsCheck();
  r.ok(st.cls1sub.length === 1, `${bare.id} is flagged as carrying a Class 1 subsidiary`);
  r.ok(st.tier1 === false,
    "but the tier follows column 3, not the subsidiary — it is not Tier 1");
  r.ok(/Class 1 subsidiary/.test(ctx.opsWhereView()),
    "and the module says so rather than deciding silently");
}

r.finish();
