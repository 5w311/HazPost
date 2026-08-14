#!/usr/bin/env node
/**
 * Shipping Papers — 49 CFR 172 Subpart C, against basicDescription().
 *
 *   node tools/test-papers.mjs
 *
 * Five regression guards on the 172.202(b) sequence, each covering a distinct
 * way this can go wrong. The module is a comparison tool: if it renders a
 * description that differs from a correctly written paper, a driver calls a
 * shipper about nothing, and the next mismatch — the real one — gets ignored.
 * So the failure mode these guard against is a false mismatch, not a crash.
 *
 * The plain text of the description is asserted by stripping the markup, which
 * is not a snapshot of the rendering — the elements and their order are the
 * regulatory content of 172.202(b), and the separators are part of the rule.
 */

import { report, appWith, assertLoaded, json } from "./test-harness.mjs";

const r = report("HazPost — Shipping Papers, 49 CFR 172 Subpart C");

const HM = json("hazmat.json").records;
const rec = (id) => HM.find((x) => x.id === id);

const strip = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const flagCites = (d) => d.flags.map((f) => f.cite);

const ctx = await appWith({ lines: [{ id: "UN1203", wt: 5000, fac: "A" }] });
assertLoaded(r, ctx, "papers");
r.ok(/177\.817/.test(ctx.papWhereView()), "papers.json loaded: 177.817 is in the placement view");

const describe = (id) => {
  const m = rec(id);
  if (!m) throw new Error(`${id} is not in the shipped table`);
  return { d: ctx.basicDescription(m), m };
};

/* ------------------------------------------------------------------ */

r.section("172.202(a)(1)–(a)(4) — the four elements, in order");
{
  const { d } = describe("UN1203");
  r.eq(strip(d.html), "UN1203, Gasoline, 3, II", "UN1203 reads UN1203, Gasoline, 3, II");
  r.eq(d.seq, ["ID number", "Shipping name", "Hazard class", "Packing group"],
    "and the four elements are in the order the rule sets");

  /* The name is the roman-only proper shipping name, not the whole of column
     2. Column 2 for UN1203 carries an italic qualifier that is not part of
     the name — rendering it would read as a mismatch against a correct paper. */
  r.ok(!/ethyl alcohol/i.test(strip(d.html)),
    "the italic qualifier in column 2 is not rendered as part of the name");
  r.ok(flagCites(d).includes("172.101(c)(10)"),
    "and the module says why, so the difference is not read as an error");
  r.eq(rec("UN1203").psn, "Gasoline", "hazmat.json carries the roman-only name separately");
}

r.section("172.202(d) — the technical name attaches with no comma");
{
  const { d } = describe("UN1993");
  r.eq(strip(d.html),
    "UN1993, Flammable liquids, n.o.s. (contains …technical name…), 3, …I / II / III…",
    "UN1993 shows a gap for the technical name");
  r.ok(flagCites(d).includes("172.203(k), (k)(1)"), "cited to 172.203(k)");

  /* 172.202(d)'s own example is "…n.o.s. (contains Xylene and Benzene), 3, II"
     — no comma between the name and the parenthetical. The parenthetical is
     appended inside the shipping-name element rather than joined as a fifth
     element, which is what keeps the separator out. */
  r.ok(/<\/span> <span class="e-gap">\(contains/.test(d.html),
    "the parenthetical follows the shipping name with a space, not a separator");
  r.ok(!/<span class="e-c">, <\/span><span class="e-gap">\(contains/.test(d.html),
    "there is no comma between the shipping name and the technical-name gap");
  r.eq(d.seq.filter((s) => s === "Shipping name").length, 1,
    "and the technical name is not counted as an element of its own");
  r.ok(flagCites(d).includes("172.202(d), 172.203(k)"),
    "the module names the other permitted punctuations rather than calling them wrong");

  /* the collapsed packing-group range renders as a gap, not as three elements */
  r.ok(/…I \/ II \/ III…/.test(strip(d.html)),
    "a collapsed packing group range renders as one gap");
  r.ok(!/, I, II, III/.test(strip(d.html)),
    "and never as commas, which would read as extra elements in the sequence");
}

r.section("172.202(a)(3) — the subsidiary rides in the hazard class, verbatim");
{
  const { d } = describe("UN1230");
  r.eq(strip(d.html), "UN1230, Methanol, 3 (6.1), II", "UN1230 shows the class as 3 (6.1)");
  r.ok(flagCites(d).includes("172.202(a)(3)"), "with the subsidiary explained");
  r.eq(rec("UN1230").cls, "3 (6.1)", "the parenthetical comes from column 3 as printed");
}

r.section("172.203(m) — poison by inhalation carries the zone");
{
  const { d } = describe("UN1017");
  r.eq(strip(d.html), "UN1017, Chlorine, 2.3 (5.1, 8)",
    "UN1017 shows 2.3 (5.1, 8) and stops there");
  r.eq(d.seq, ["ID number", "Shipping name", "Hazard class"],
    "no packing group element at all");
  r.ok(flagCites(d).includes("172.202(a)(4)"),
    "and the absence is called correct rather than left looking like an omission");

  const pih = d.flags.find((f) => f.cite === "172.203(m)");
  r.ok(!!pih, "the poison-inhalation flag is raised");
  r.ok(/Zone B/.test(pih.txt), "and it names Zone B — the zone is what sets an isolation distance");
  r.eq(rec("UN1017").pih, "Zone B", "read from the table, not inferred");
}

r.section("Class 1 keeps its compatibility group letter");
{
  /* THE IMPORTANT ONE. An earlier draft of this logic rebuilt the hazard class
     from the `base` field, which renders "1.1" and silently drops the
     compatibility group letter on every Class 1 line — a description that
     would never match the paper, on the load where a mismatch matters most.
     Column 3 is used verbatim for exactly this reason. Do not "simplify" it
     back to a lookup on base. */
  const { d, m } = describe("UN0004");
  r.eq(strip(d.html), "UN0004, Ammonium picrate, 1.1D",
    "UN0004 shows 1.1D with the compatibility group letter intact");
  r.ok(/1\.1D/.test(strip(d.html)), "the letter is present");
  r.eq(m.base, "1.1", "the base field alone would have rendered 1.1");
  r.ok(strip(d.html).split(", ")[2] === "1.1D",
    "the hazard class element is column 3 verbatim, not rebuilt from base");
  r.eq(d.seq, ["ID number", "Shipping name", "Hazard class"], "and Class 1 takes no packing group");
  r.ok(flagCites(d).includes("172.202(a)(4)"), "which the module says is correct");

  /* every Class 1 entry in the shipped table keeps its letter */
  const cls1 = HM.filter((x) => /^1\./.test(x.base));
  r.note(`sweeping ${cls1.length} Class 1 entries`);
  const dropped = cls1.filter((x) => {
    const t = strip(ctx.basicDescription(x).html);
    return /^1\.[1-6][A-S]\b/.test(x.cls) && !t.includes(x.cls);
  });
  r.eq(dropped.length, 0,
    `all ${cls1.length} Class 1 entries render their column 3 exactly`,
    dropped.slice(0, 5).map((x) => x.id).join(", "));
}

r.section("172.200(b) — a load excepted from the subpart says so");
{
  /* Symbol A or W takes an entry out of Subpart C except by air or water. */
  const excepted = HM.find((x) => (x.sym || "").split(/[\s,]+/).includes("A"));
  r.ok(!!excepted, "the shipped table has a symbol-A entry");
  r.ok(!!ctx.papExcepted(excepted), "papExcepted recognises it");
  r.eq(ctx.papExcepted(excepted).mode, "air", "symbol A is the air exception");

  const w = HM.find((x) => {
    const s = (x.sym || "").split(/[\s,]+/);
    return s.includes("W") && !s.includes("A");
  });
  r.ok(!!w, "the shipped table has a symbol-W entry that is not also symbol A");
  r.eq(ctx.papExcepted(w).mode, "water", "symbol W is the water exception");

  r.eq(ctx.papExcepted(rec("UN1203")), null, "and an ordinary entry is not excepted");

  const ctx2 = await appWith({ lines: [{ id: excepted.id, wt: 5000, fac: "A" }] });
  const view = ctx2.papCheckView();
  r.ok(/172\.200\(b\)/.test(view), "a load of only excepted lines answers with 172.200(b)");
  r.ok(/segv clear/.test(view), "and says no shipping paper description is required");
  r.ok(!/Expected basic description/.test(view), "rather than rendering the description check");
  r.ok(/hazardous substance, hazardous waste or marine pollutant/i.test(view),
    "with the three things that exception does not cover");

  /* one line that is not excepted and the check comes back */
  const mixed = await appWith({
    lines: [{ id: excepted.id, wt: 5000, fac: "A" }, { id: "UN1203", wt: 5000, fac: "A" }],
  });
  const mview = mixed.papCheckView();
  r.ok(/Expected basic description/.test(mview), "a mixed load still renders the check");
  r.ok(/Not in the subpart by highway/.test(mview), "and separates out the excepted line");
}

r.section("An empty trailer");
{
  const empty = await appWith({ lines: [] });
  const view = empty.papCheckView();
  r.ok(/Nothing on the trailer/.test(view), "the module says so rather than describing nothing");
  r.ok(!/Expected basic description/.test(view), "and renders no description block");
}

r.section("The whole table renders without throwing");
{
  r.note(`sweeping all ${HM.length} entries`);
  /* A description that crashes on one of 2,479 entries is a description a
     driver cannot get, and only a sweep finds it. */
  const bad = [];
  for (const m of HM) {
    try {
      const d = ctx.basicDescription(m);
      if (!d.html || !d.seq.length) bad.push(m.id);
      else if (!strip(d.html).startsWith(`${m.pfx}${m.un}`)) bad.push(m.id);
    } catch (e) { bad.push(`${m.id}: ${e.message}`); }
  }
  r.eq(bad, [], `all ${HM.length} entries produce a description that starts with their own ID`,
    bad.slice(0, 5).join(", "));

  /* and every one names its elements in the order the rule sets */
  const ORDER = ["ID number", "Shipping name", "Hazard class", "Packing group"];
  const outOfOrder = HM.filter((m) => {
    const seq = ctx.basicDescription(m).seq;
    return seq.join("|") !== ORDER.slice(0, seq.length).join("|");
  });
  r.eq(outOfOrder.length, 0, "and every sequence is a prefix of the 172.202(b) order",
    outOfOrder.slice(0, 5).map((x) => x.id).join(", "));
}

r.finish();
