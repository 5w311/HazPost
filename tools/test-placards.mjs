#!/usr/bin/env node
/**
 * Placarding — 49 CFR 172.504, against compute().
 *
 *   node tools/test-placards.mjs
 *
 * This is the engine that answers the question the app exists for, so the
 * assertions are about outcomes: which placards, whether DANGEROUS is on
 * offer, and which paragraph the answer came from. Wording is not asserted —
 * a test that fails when a sentence is reworded gets deleted within a month
 * and takes the real assertions with it. Cites are asserted, because a
 * conclusion that arrives without its paragraph is a conclusion this app is
 * not allowed to give.
 *
 * Every load is driven in through localStorage and restoreLoad(), so every
 * material here is a real 172.101 entry — a test cannot conjure a material the
 * shipped table does not have.
 */

import { report, appWith, assertLoaded, json } from "./test-harness.mjs";

const r = report("HazPost — Placarding, 49 CFR 172.504");

/* Real entries, named once. The comment is what each is here to exercise. */
const M = {
  gasoline: "UN1203",   // Class 3, PG II, Table 2
  acid:     "UN1830",   // Class 8, Table 2
  oxidizer: "UN1479",   // Division 5.1, Table 2 — the 2,205 lb case
  sodium:   "UN1428",   // Division 4.3, TABLE 1 — placards at any quantity
  class9:   "UN1841",   // Class 9, Table 2
  infect:   "UN2814",   // Division 6.2 — counts toward the aggregate, hangs nothing
  d15:      "UN0331",   // 1.5D, Table 2
  d12:      "UN0035",   // 1.2D, Table 1
  b12:      "UN0107",   // 1.2B, Table 1 — the 177.848(i) near miss
  corrPih:  "UN1744",   // Class 8 that is also poisonous by inhalation, Zone A
};

const HM = json("hazmat.json").records;
for (const [k, id] of Object.entries(M)) {
  r.ok(!!HM.find((x) => x.id === id), `the shipped table has ${id} (${k})`);
}

const line = (id, wt, fac = "A") => ({ id, wt, fac });
const cites = (res) => res.why.map((w) => w.cite);
const hasCite = (res, c) => cites(res).includes(c);

/* ------------------------------------------------------------------ */

r.section("Sanity — the engine is answering from real data");
{
  const ctx = await appWith({ lines: [line(M.gasoline, 1200)] });
  assertLoaded(r, ctx, "placards");
  const res = ctx.compute();
  r.ok(res !== null, "a load produces a result");

  const empty = await appWith({ lines: [] });
  r.eq(empty.compute(), null, "an empty trailer computes nothing rather than an empty answer");
}

/* ---------------- the 1,001 lb threshold ---------------- */
r.section("172.504(c) — the 1,001 lb Table 2 aggregate");
{
  const under = (await appWith({ lines: [line(M.gasoline, 900)] })).compute();
  r.sameSet(under.placards, [], "900 lb of gasoline alone requires no placard");
  r.eq(under.agg, 900, "and the aggregate is the weight typed");
  r.eq(under.dangerOption, null, "with no DANGEROUS option");
  r.ok(hasCite(under, "172.504(c)"), "the under-threshold answer cites 172.504(c)");

  const over = (await appWith({ lines: [line(M.gasoline, 1200)] })).compute();
  r.sameSet(over.placards, ["flam3"], "1,200 lb of gasoline requires FLAMMABLE");
  r.eq(over.dangerOption, null, "one category is not two, so no DANGEROUS option");
  r.ok(hasCite(over, "172.504(c)"), "the over-threshold answer cites 172.504(c)");

  /* the boundary itself: 1,000 is under, 1,001 is over */
  const at1000 = (await appWith({ lines: [line(M.gasoline, 1000)] })).compute();
  r.sameSet(at1000.placards, [], "1,000 lb is under the threshold");
  const at1001 = (await appWith({ lines: [line(M.gasoline, 1001)] })).compute();
  r.sameSet(at1001.placards, ["flam3"], "1,001 lb is at it, and the rule says at or over");
}

r.section("Aggregation across categories");
{
  const res = (await appWith({
    lines: [line(M.gasoline, 600), line(M.acid, 500)],
  })).compute();
  r.eq(res.agg, 1100, "600 lb of gasoline and 500 lb of acid aggregate to 1,100");
  r.sameSet(res.placards, ["flam3", "corr8"], "and both placards are required");
  r.ok(res.dangerOption !== null, "two categories put DANGEROUS on offer");
  r.sameSet((res.dangerOption || {}).cats || [], ["3", "8"], "and it covers both of them");
  r.ok(hasCite(res, "172.504(b)"), "the DANGEROUS option cites 172.504(b)");

  /* neither line reaches 1,001 on its own — the aggregate is the point */
  const alone = (await appWith({ lines: [line(M.gasoline, 600)] })).compute();
  r.sameSet(alone.placards, [], "600 lb of gasoline on its own requires nothing");
}

/* ---------------- 2,205 lb from one facility ---------------- */
r.section("172.504(b)(2) — 2,205 lb from a single loading point");
{
  const oneFac = (await appWith({
    lines: [line(M.gasoline, 600), line(M.oxidizer, 2400, "A")],
  })).compute();
  r.ok(oneFac.placards.includes("oxy51"), "2,400 lb of oxidizer from one facility requires OXIDIZER");
  r.ok(oneFac.placards.includes("flam3"), "and FLAMMABLE for the gasoline");
  r.eq(oneFac.dangerOption, null,
    "and with only one category left eligible, DANGEROUS is off the table entirely");
  r.ok(hasCite(oneFac, "172.504(b)(2)"), "the block cites 172.504(b)(2)");

  const split = (await appWith({
    lines: [line(M.gasoline, 600), line(M.oxidizer, 1200, "A"), line(M.oxidizer, 1200, "B")],
  })).compute();
  r.eq(split.agg, 3000, "the same 2,400 lb split across two facilities still aggregates to 3,000");
  r.ok(split.dangerOption !== null, "but DANGEROUS comes back");
  r.sameSet((split.dangerOption || {}).cats || [], ["3", "5.1"], "covering both categories");
  r.ok(!hasCite(split, "172.504(b)(2)"), "and nothing cites the single-loading-point rule");
}
{
  /* the boundary: 2,204 lb from one facility does not block, 2,205 does */
  const under = (await appWith({
    lines: [line(M.gasoline, 600), line(M.oxidizer, 2204, "A")],
  })).compute();
  r.ok(under.dangerOption !== null, "2,204 lb from one facility does not block DANGEROUS");
  const at = (await appWith({
    lines: [line(M.gasoline, 600), line(M.oxidizer, 2205, "A")],
  })).compute();
  r.eq(at.dangerOption, null, "2,205 lb does — the rule is at or more");

  /* three categories, one blocked, leaves two: the option survives, narrowed */
  const three = (await appWith({
    lines: [line(M.gasoline, 600), line(M.acid, 600), line(M.oxidizer, 2400, "A")],
  })).compute();
  r.ok(three.dangerOption !== null, "with three categories, blocking one leaves DANGEROUS available");
  r.sameSet((three.dangerOption || {}).cats || [], ["3", "8"], "for the two that are not blocked");
  r.sameSet((three.dangerOption || {}).blocked || [], ["5.1"], "and it names the one that is");
  r.ok(three.placards.includes("oxy51"), "the blocked category still hangs its own placard");
}

/* ---------------- Table 1 ---------------- */
r.section("172.504(e) Table 1 — any quantity");
{
  const tiny = (await appWith({ lines: [line(M.sodium, 5)] })).compute();
  r.sameSet(tiny.placards, ["wet43"], "5 lb of sodium requires DANGEROUS WHEN WET");
  r.eq(tiny.t2cats, 0, "and there is no Table 2 line on the trailer at all");
  r.ok(hasCite(tiny, "172.504(e) Table 1"), "the answer cites Table 1");

  const mixed = (await appWith({
    lines: [line(M.sodium, 5), line(M.gasoline, 500)],
  })).compute();
  r.sameSet(mixed.placards, ["wet43"],
    "5 lb of sodium with 500 lb of gasoline requires only the Table 1 placard");
  r.eq(mixed.agg, 500, "because the Table 2 aggregate is still under 1,001");
  r.ok(hasCite(mixed, "172.504(c)"), "and the answer says so");

  /* push the same load over and the Table 2 placard joins it */
  const both = (await appWith({
    lines: [line(M.sodium, 5), line(M.gasoline, 1500)],
  })).compute();
  r.sameSet(both.placards, ["wet43", "flam3"], "over 1,001 lb both are required");
}

/* ---------------- Class 9 ---------------- */
r.section("172.504(f)(9) — Class 9 is not required domestically");
{
  const nine = (await appWith({ lines: [line(M.class9, 1500)] })).compute();
  r.ok(nine.placards.includes("misc9"), "Class 9 over the threshold appears in the placard set");
  r.ok(hasCite(nine, "172.504(f)(9)"), "with the note that it is not required domestically");

  const ninePlusOne = (await appWith({
    lines: [line(M.class9, 600), line(M.gasoline, 600)],
  })).compute();
  r.eq(ninePlusOne.agg, 1200, "Class 9 counts toward the aggregate");
  r.ok(ninePlusOne.placards.includes("flam3"), "and the other category is placarded");
  r.eq(ninePlusOne.dangerOption, null,
    "but Class 9 plus one other category does not offer DANGEROUS — that needs two that are not Class 9");

  const ninePlusTwo = (await appWith({
    lines: [line(M.class9, 400), line(M.gasoline, 400), line(M.acid, 400)],
  })).compute();
  r.ok(ninePlusTwo.dangerOption !== null, "Class 9 plus two others does offer it");
  r.sameSet((ninePlusTwo.dangerOption || {}).cats || [], ["3", "8"], "over the two non-Class-9 categories only");
}

r.section("Categories that count but hang nothing");
{
  const res = (await appWith({ lines: [line(M.infect, 1500)] })).compute();
  r.eq(res.agg, 1500, "Division 6.2 counts toward the 1,001 lb aggregate");
  r.sameSet(res.placards, [], "and hangs no placard, because Table 2 names none for it");
  r.ok(hasCite(res, "172.504(e) Table 2"), "the answer says which paragraph decided that");
  r.eq(res.dangerOption, null, "a category with no placard cannot make up a DANGEROUS pair");
}

/* ---------------- 172.505(a) ---------------- */
r.section("172.505(a) — the inhalation placard rides on top");
{
  const res = (await appWith({ lines: [line(M.corrPih, 1500)] })).compute();
  r.ok(res.placards.includes("corr8"), "a poisonous-by-inhalation Class 8 keeps its CORROSIVE placard");
  r.ok(res.placards.includes("pih61"), "and gains POISON INHALATION HAZARD on top of it");
  r.ok(hasCite(res, "172.505(a)"), "cited to 172.505(a)");

  /* and it does not double up on a material whose own placard already says it */
  const own = (await appWith({ lines: [line("UN1017", 5)] })).compute();
  r.ok(own.placards.includes("gas23"), "a Division 2.3 line hangs POISON GAS");
  r.ok(!hasCite(own, "172.505(a)"),
    "and does not also get a 172.505(a) note — its own Table 1 placard already carries it");
}

/* ---------------- 177.848(i) and 172.504(f)(1) ---------------- */
r.section("177.848(i) — 1.5D with 1.2D rides as 1.1D");
{
  const ctx = await appWith({ lines: [line(M.d15, 1500), line(M.d12, 500)] });
  r.ok(ctx.rule848i([{ cls: "1.5D" }, { cls: "1.2D" }]) === true,
    "rule848i fires on 1.5D with 1.2D");

  const res = ctx.compute();
  r.ok(res.placards.includes("expl11"), "the trailer takes EXPLOSIVES 1.1");
  r.ok(!res.placards.includes("expl12"), "and not 1.2");
  r.ok(!res.placards.includes("expl15"), "and not 1.5");
  r.ok(hasCite(res, "177.848(i)"), "cited to 177.848(i), which is where the re-division lives");
  r.ok(!hasCite(res, "172.504(f)(1)"),
    "and the lowest-division note is suppressed — no line on this load carries 1.1");
}

r.section("…and does not fire on a different compatibility group");
{
  const ctx = await appWith({ lines: [line(M.d15, 1500), line(M.b12, 500)] });
  r.ok(ctx.rule848i([{ cls: "1.5D" }, { cls: "1.2B" }]) === false,
    "rule848i does not fire on 1.5D with 1.2B");

  const res = ctx.compute();
  r.ok(!res.placards.includes("expl11"), "nothing is promoted to 1.1");
  r.sameSet(res.placards, ["expl12"], "and 172.504(f)(1) leaves the lowest division on board, 1.2");
  r.ok(hasCite(res, "172.504(f)(1)"), "cited to the lowest-division rule this time");

  /* same pair, but the 1.5 line under the Table 2 threshold */
  const light = (await appWith({ lines: [line(M.d15, 500), line(M.b12, 500)] })).compute();
  r.sameSet(light.placards, ["expl12"],
    "a 1.5D line under 1,001 lb hangs nothing on its own, so only the Table 1 line placards");

  /* and the 1.5D group letter has to match on both sides */
  r.ok(ctx.rule848i([{ cls: "1.5B" }, { cls: "1.2D" }]) === false, "1.5B with 1.2D does not fire either");
  r.ok(ctx.rule848i([{ cls: "1.5D" }]) === false, "1.5D on its own does not fire");
  r.ok(ctx.rule848i([{ cls: "1.2D" }]) === false, "nor does 1.2D on its own");
}

r.finish();
