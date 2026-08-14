#!/usr/bin/env node
/**
 * Segregation — 49 CFR 177.848, against segCheck() and the shipped tables.
 *
 *   node tools/test-segregation.mjs
 *
 * Two kinds of assertion live here.
 *
 * The engine: which segregation row each line lands on, and what a pair
 * resolves to. Category mapping is asserted against `raw` — the unfiltered set
 * of rows a line occupies — because that is the decision the module makes
 * before any question is asked, and asserting it directly beats inferring it
 * from a verdict two steps downstream.
 *
 * The shipped data: that segregation.json is square, symmetric and made only
 * of legal markers. tools/build-segregation.mjs asserts that at generation
 * time, which is a different guarantee — it says the generator was right about
 * what it wrote, not that what shipped is what it wrote.
 */

import { report, appWith, assertLoaded, json } from "./test-harness.mjs";

const r = report("HazPost — Segregation, 49 CFR 177.848");

const SEG = json("segregation.json");
const HM = json("hazmat.json").records;

/* The 172.101 entries used below, and what each is here to exercise. */
const M = {
  sc42:     "UN1361",   // Division 4.2 primary, no subsidiary
  acid:     "UN1830",   // Class 8 primary — the liquids-only row
  amine:    "UN2733",   // Class 3 with a Class 8 SUBSIDIARY — the case that matters
  gasoline: "UN1203",   // Class 3, no subsidiary
  gasNoZone:"UN3539",   // Division 2.3 with no inhalation zone on file
  gasZoneB: "UN1026",   // Division 2.3 Zone B, subsidiary 2.1
  gasZoneD: "UN1005",   // Division 2.3 Zone D — not a row at all
  pihA:     "UN1051",   // Division 6.1, PG I, Zone A — all three, so it is a row
  pihB:     "UN1098",   // Division 6.1, PG I, Zone B — not a row
  tox2:     "UN1181",   // Division 6.1 non-inhalation, PG II — not a row
  infect:   "UN2814",   // Division 6.2 — no row
  class9:   "UN1841",   // Class 9 — no row
  comb:     "NA1993",   // combustible liquid — no row
};
for (const [k, id] of Object.entries(M)) {
  r.ok(!!HM.find((x) => x.id === id), `the shipped table has ${id} (${k})`);
}

const line = (id, st) => ({ id, wt: 100, fac: "A", ...(st ? { st } : {}) });
const idx = (k) => SEG.categories.findIndex((c) => c.key === k);
const cell = (a, b) => SEG.table[idx(a)][idx(b)];

/** Row keys a line occupies, before the state question filters anything. */
const rowsFor = (seg, i) => seg.mapped[i].raw.map((x) => x.key);

/* ------------------------------------------------------------------ */

r.section("Sanity");
{
  const ctx = await appWith({ lines: [line(M.gasoline)] });
  assertLoaded(r, ctx, "segregation");
  r.ok(SEG.categories.length === 18, "segregation.json carries 18 categories");
  r.ok(ctx.segCheck().mapped.length === 1, "segCheck maps the load it was given");
}

/* ---------------- the subsidiary path ---------------- */
r.section("177.848(e)(6) — the subsidiary hazard is the whole point");
{
  /* Primary against primary is blank here. If the engine only ever compared
     primaries, this load would read as clear. */
  r.eq(cell("4.2", "3"), "", "Division 4.2 against Class 3 is a blank cell — no restriction");
  r.eq(cell("4.2", "8L"), "X", "Division 4.2 against Class 8 liquids is X");

  const ctx = await appWith({ lines: [line(M.sc42), line(M.amine)] });
  ctx.setLineState(1, "liquid");
  const seg = ctx.segCheck();

  r.eq(seg.pairs.length, 1, "the pair is found");
  const p = seg.pairs[0] || { via: [] };
  r.eq(p.code, "X", "UN1361 with UN2733 resolves to X");
  r.ok(p.bySub === true, "and the engine records that a subsidiary is what did it");

  /* The attribution is the reason this is worth testing. A bare X with no
     explanation leaves a driver with no way to see why two apparently
     compatible lines cannot ride together. */
  const via = p.via.map((v) => `${v.key}/${v.from}`);
  r.sameSet(via, ["4.2/primary", "8L/subsidiary 8"],
    "the verdict names the subsidiary Class 8 as the trigger, not a primary-to-primary reading");
  r.ok(p.via.some((v) => v.sub && /subsidiary 8/.test(v.from)),
    "and the subsidiary side is flagged as such");

  /* the same load with the primaries alone would be clear */
  const primaries = await appWith({ lines: [line(M.sc42), line(M.gasoline)] });
  r.eq(primaries.segCheck().pairs.length, 0,
    "4.2 with a Class 3 that has no subsidiary is genuinely clear");
}

/* ---------------- physical state ---------------- */
r.section("The state question gates the verdict — Class 8 as a primary");
{
  const unanswered = await appWith({ lines: [line(M.sc42), line(M.acid)] });
  const seg = unanswered.segCheck();
  r.eq(seg.pairs.length, 0, "with the state unanswered nothing is proven yet");
  r.eq(seg.outstanding.length, 1, "and the question is outstanding");
  r.ok(!/segv clear/.test(unanswered.segLoadView()),
    "no code path shows an all-clear while a state question is open");
  r.ok(/segv pend/.test(unanswered.segLoadView()), "it shows the pending verdict instead");

  const liquid = await appWith({ lines: [line(M.sc42), line(M.acid)] });
  liquid.setLineState(1, "liquid");
  const lseg = liquid.segCheck();
  r.eq(lseg.pairs.map((x) => x.code), ["X"], "answered liquid, the conflict appears");
  r.eq(lseg.outstanding.length, 0, "and nothing is outstanding");
  r.ok(/segv clear/.test(liquid.segLoadView()) === false, "the load is not clear — it has an X");

  const solid = await appWith({ lines: [line(M.sc42), line(M.acid)] });
  solid.setLineState(1, "solid");
  const sseg = solid.segCheck();
  r.eq(sseg.pairs.length, 0, "answered solid, the line drops off the liquids-only row");
  r.eq(sseg.outstanding.length, 0, "and the question is settled");
  r.ok(/segv clear/.test(solid.segLoadView()),
    "now an all-clear is honest, because every question has an answer");
  r.eq(rowsFor(sseg, 1), ["8L"], "the row it would have occupied is still recorded");
  r.eq(sseg.mapped[1].cats.length, 0, "it just does not occupy it as a solid");
}

r.section("…and the same when Class 8 arrives as a subsidiary");
{
  const unanswered = await appWith({ lines: [line(M.sc42), line(M.amine)] });
  const seg = unanswered.segCheck();
  r.eq(seg.pairs.length, 0, "unanswered, nothing is proven");
  r.eq(seg.outstanding.length, 1, "the question is outstanding on the subsidiary");
  r.ok(((seg.outstanding[0] || { pending: [{}] }).pending[0] || {}).sub === true,
    "and it is flagged as a subsidiary question");
  r.ok(!/segv clear/.test(unanswered.segLoadView()),
    "no all-clear while a subsidiary state question is open");

  const solid = await appWith({ lines: [line(M.sc42), line(M.amine)] });
  solid.setLineState(1, "solid");
  r.eq(solid.segCheck().pairs.length, 0, "answered solid, the conflict goes away");
  r.ok(/segv clear/.test(solid.segLoadView()), "and the all-clear becomes honest");

  /* state is answered per line, and a line that needs no answer never asks */
  const noAsk = await appWith({ lines: [line(M.sc42), line(M.gasoline)] });
  r.eq(noAsk.segCheck().outstanding.length, 0, "a load with no liquids-only row asks nothing");

  /* the question is only asked where the answer could change the outcome */
  const lone = await appWith({ lines: [line(M.acid), line(M.gasoline)] });
  r.eq(lone.segCheck().outstanding.length, 0,
    "a Class 8 line with nothing it could ever conflict with is not asked");
  r.eq(rowsFor(lone.segCheck(), 0), ["8L"], "though it is still mapped to the row");
}

/* ---------------- category mapping ---------------- */
r.section("Mapping a line to a row — 172.101 in, 177.848 out");
{
  const rows = async (id) => {
    const ctx = await appWith({ lines: [line(id)] });
    return rowsFor(ctx.segCheck(), 0);
  };

  r.eq(await rows(M.gasNoZone), ["2.3A"],
    "Division 2.3 with no inhalation zone on file maps to Zone A, the stricter row");
  {
    const ctx = await appWith({ lines: [line(M.gasNoZone)] });
    r.ok(ctx.segCheck().notes.some((n) => /Zone A/.test(n)),
      "and the assumption is stated rather than made silently");
  }
  r.eq(await rows(M.gasZoneB), ["2.3B", "2.1"], "Zone B maps to the Zone B row, plus its subsidiary");
  r.eq(await rows(M.gasZoneD), ["8L"],
    "Zone D is not a row at all — only the Class 8 subsidiary survives");

  r.eq(await rows(M.pihA), ["6.1I-A", "3"],
    "Division 6.1 maps to a row only with liquid, PG I and Zone A together");
  r.eq(await rows(M.pihB), ["3"],
    "PG I but Zone B is not the row — the three conditions are an AND");
  r.eq(await rows(M.tox2), ["3"], "non-inhalation Division 6.1 at PG II is not the row either");

  r.eq(await rows(M.infect), [], "Division 6.2 has no row, so no restriction");
  r.eq(await rows(M.class9), [], "Class 9 has no row");
  r.eq(await rows(M.comb), [], "combustible liquid has no row");
  r.eq(await rows(M.acid), ["8L"], "Class 8 maps to the liquids row");
  r.eq(await rows(M.amine), ["3", "8L"], "a Class 3 with a Class 8 subsidiary occupies both");

  /* the classes with no row produce no restriction against anything */
  for (const id of [M.infect, M.class9, M.comb]) {
    const ctx = await appWith({ lines: [line(id), line(M.sc42)] });
    r.ok(ctx.segCheck().pairs.length === 0, `${id} against Division 4.2 is unrestricted`);
  }
}

r.section("…and the mapping function directly, where the table has no example");
{
  /* The 6.1 row is liquids, PG I and Zone A — three conditions joined by AND.
     Two of the three can be falsified with real entries above. The third
     cannot: every Zone A Division 6.1 entry in the shipped table is also PG I,
     so dropping the PG I condition changes no answer on any load that can be
     built. Mutation testing found that hole, and this closes it by calling the
     mapping function directly rather than through a material that would have
     to exist for the test to bite. */
  const ctx = await appWith({ lines: [line(M.gasoline)] });
  const map = (tok, l) => ctx.segCatFor(tok, { id: "TEST", pfx: "UN", un: "0000", ...l }, { notes: [] });

  r.eq(map("6.1", { pg: "I", pih: "Zone A" }), "6.1I-A", "PG I and Zone A together are the row");
  r.eq(map("6.1", { pg: "II", pih: "Zone A" }), null, "Zone A without PG I is not");
  r.eq(map("6.1", { pg: "III", pih: "Zone A" }), null, "nor is PG III with Zone A");
  r.eq(map("6.1", { pg: "I", pih: "Zone B" }), null, "PG I without Zone A is not");
  r.eq(map("6.1", { pg: "I" }), null, "PG I with no zone at all is not");
  r.eq(map("6.1", {}), null, "and neither is a bare Division 6.1");
  r.eq(map("6.1", { pg: "I, II", pih: "Zone A" }), "6.1I-A",
    "a collapsed range that includes PG I still reaches the row");

  /* the inhalation zones, all four */
  r.eq(map("2.3", { pih: "Zone A" }), "2.3A", "Division 2.3 Zone A");
  r.eq(map("2.3", { pih: "Zone B" }), "2.3B", "Division 2.3 Zone B");
  r.eq(map("2.3", { pih: "Zone C" }), null, "Zone C is not a row");
  r.eq(map("2.3", { pih: "Zone D" }), null, "Zone D is not a row");
  r.eq(map("2.3", {}), "2.3A", "and no zone at all falls to the stricter row");

  /* the placard-category keys that are not plain divisions */
  r.eq(map("2.2oxy", {}), "2.2", "oxygen maps onto the Division 2.2 row");
  r.eq(map("5.2tc", {}), "5.2", "temperature-controlled organic peroxide onto the 5.2 row");
  r.eq(map("6.1t2", { pg: "II" }), null, "non-inhalation 6.1 is not the 6.1 row");
  r.eq(map("comb", {}), null, "combustible liquid has no row");
  r.eq(map("8", {}), "8L", "Class 8 maps to the liquids row and the state question follows");
  r.eq(map("1.1", {}), "1.1-1.2", "Divisions 1.1 and 1.2 share a row");
  r.eq(map("1.2", {}), "1.1-1.2", "both of them");
  r.eq(map("1.3", {}), "1.3", "1.3 has its own");
  r.eq(map("9", {}), null, "Class 9 has none");
  r.eq(map("6.2", {}), null, "nor does Division 6.2");

  /* every row key the mapper can return has to be a row that exists */
  const keys = new Set(SEG.categories.map((c) => c.key));
  const produced = ["1.1-1.2", "1.3", "1.4", "1.5", "1.6", "2.1", "2.2", "2.3A", "2.3B",
                    "3", "4.1", "4.2", "4.3", "5.1", "5.2", "6.1I-A", "7", "8L"];
  r.sameSet(produced, [...keys], "every key the mapper can return is a row in the shipped table");
}

r.section("A Class 1 subsidiary with no division on file");
{
  const bare = HM.find((x) => String(x.subs || "").split(/,\s*/).includes("1"));
  r.ok(!!bare, "the table has an entry with a bare Class 1 subsidiary");
  const ctx = await appWith({ lines: [line(bare.id)] });
  const seg = ctx.segCheck();
  r.ok(rowsFor(seg, 0).includes("1.1-1.2"),
    `${bare.id} is read onto the 1.1/1.2 row, the strictest explosives row`);
  r.ok(seg.notes.some((n) => /1\.1\/1\.2/.test(n)),
    "and the judgment is stated on screen rather than made silently");
}

/* ---------------- the shipped tables ---------------- */
r.section("segregation.json — the table that actually ships");
{
  const T = SEG.table, n = SEG.categories.length;
  r.eq(n, 18, "18 categories");
  r.eq(T.length, 18, "18 rows");
  r.ok(T.every((row) => row.length === 18), "every row is 18 wide");

  const legal = new Set(Object.keys(SEG.markers));
  r.sameSet([...legal], ["X", "O", "*", ""], "the marker set is X, O, star and blank");

  let illegal = 0, asym = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (!legal.has(T[a][b])) illegal++;
      if (T[a][b] !== T[b][a]) asym++;
    }
  }
  r.eq(illegal, 0, "every one of the 324 cells is a legal marker");
  r.eq(asym, 0, "and the table is symmetric across the diagonal");
  r.note(`${n * n} cells checked`);

  r.ok(SEG.categories.every((c) => c.key && c.label && c.name),
    "every category carries a key, a label and a name");
  r.eq(new Set(SEG.categories.map((c) => c.key)).size, 18, "and the keys are unique");

  /* spot checks against the printed table, both directions */
  const spot = [
    ["1.1-1.2", "3", "X"], ["4.2", "8L", "X"], ["2.3A", "8L", "X"], ["6.1I-A", "3", "X"],
    ["5.1", "3", "O"], ["4.3", "8L", "O"], ["2.3B", "8L", "O"],
    ["1.1-1.2", "1.3", "*"], ["3", "8L", ""],
  ];
  for (const [a, b, want] of spot) {
    r.eq(cell(a, b), want, `${a} against ${b} is "${want}"`);
    r.eq(cell(b, a), want, `…and ${b} against ${a} reads the same`);
  }
}

r.section("The 177.848(f) compatibility table");
{
  const C = SEG.compat, T = C.table, n = C.groups.length;
  r.eq(n, 13, "13 compatibility groups");
  r.sameSet(C.groups, ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "N", "S"],
    "and they are the groups 177.848(f) prints");
  r.eq(T.length, 13, "13 rows");
  r.ok(T.every((row) => row.length === 13), "every row is 13 wide");

  /* A cell is blank, X, X(rule), or a slash-separated list of rule numbers —
     and every rule it names has to exist. */
  const ruleKeys = new Set(Object.keys(C.rules));
  const bad = [];
  let asym = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const v = String(T[a][b]);
      if (T[a][b] !== T[b][a]) asym++;
      if (v === "" || v === "X") continue;
      const m = v.match(/^X\((\d)\)$/);
      if (m) { if (!ruleKeys.has(m[1])) bad.push(`${C.groups[a]}x${C.groups[b]}=${v}`); continue; }
      if (/^\d(\/\d)*$/.test(v)) {
        for (const d of v.split("/")) if (!ruleKeys.has(d)) bad.push(`${C.groups[a]}x${C.groups[b]}=${v}`);
        continue;
      }
      bad.push(`${C.groups[a]}x${C.groups[b]}=${v}`);
    }
  }
  r.eq(bad, [], "every one of the 169 cells is blank, X, X(rule) or a list of real rule numbers");
  r.eq(asym, 0, "and the compatibility table is symmetric too");
  r.note(`${n * n} cells checked`);

  r.sameSet(Object.keys(C.rules), ["1", "2", "3", "4", "5", "6"], "six numbered rules, 1 through 6");
  r.ok(C.blankMeans && C.xMeans, "the table's own gloss on blank and X came across");
  r.ok(/lower numerical division/.test(C.divisionRollup || ""), "(h) came across");
  r.ok(/Division 1\.5 materials, compatibility group D/.test(C.fifteenWithTwelve || ""), "(i) came across");

  /* the L row is the one with its own rule, and it is on the diagonal */
  r.eq(T[C.groups.indexOf("L")][C.groups.indexOf("L")], "1",
    "group L against itself is rule 1 — only an identical explosive");
}

r.finish();
