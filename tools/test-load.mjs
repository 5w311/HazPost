#!/usr/bin/env node
/**
 * The Load screen and the tab shell, against the engines they summarise.
 *
 *   node tools/test-load.mjs
 *
 * Load is the front door. It shows the placards on top and one summary row
 * per check, and each row is built from the same functions its detail screen
 * uses. A summary that says less than the screen behind it is the failure
 * this file exists to catch, so most of what follows is one rule asserted
 * from several directions: no row reads as clear while the detail screen
 * shows a prohibition, an open question, or a rule that bites.
 *
 * The shell is asserted through render() itself, against the harness's stub
 * elements: the tab bar is always drawn, Emergency is always reachable, and
 * it always opens on 911 — including when hazmat.json never arrived.
 */

import { report, appWith, runApp, json } from "./test-harness.mjs";

const r = report("HazPost — Load screen and tabs");

const line = (id, wt = 100, fac = "A", st) => ({ id, wt, fac, ...(st ? { st } : {}) });
const text = (html) => String(html).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const main = (app) => app.__els.get("main").innerHTML;
const bodyStart = (app) => {
  const h = main(app);
  const i = h.indexOf('<div class="body">');
  return i < 0 ? "" : h.slice(i + '<div class="body">'.length).trimStart();
};

const M = {
  gasoline: "UN1203",   // Class 3
  acid:     "UN1830",   // Class 8 — the liquids-only row, so it asks
  oxidizer: "UN1479",   // Division 5.1
  blasting: "UN0081",   // Division 1.1D, Table 1
  cyanide:  "UN1689",   // Division 6.1 solid — no row; the cyanide rule is not in the table
  class9:   "UN3082",   // Class 9
};

/* the sample load the empty screen offers */
const SAMPLE = [line(M.gasoline, 650, "A"), line(M.acid, 500, "A"), line(M.oxidizer, 2400, "B")];

/* ------------------------------------------------------------------ */

r.section("The summary rows mirror the engines");
{
  const app = await appWith({ lines: SAMPLE });
  const res = app.compute();
  r.eq(res.placards.length, 3, "the sample load needs three placards");
  r.ok(/3 required/.test(text(app.summaryList(res))), "and the Placards row says 3 required");
  r.eq(text(app.segSummary()), "Keep apart · 1 question",
    "the proven O pair shows, and the unanswered Class 8 line is an open question after it");
  r.eq(app.papSummary(), "Compare 3", "three lines to compare against the paper");
  r.eq(app.opsSummary(), "Standard", "placarded, no 1.1, 1.2 or 1.3");
  r.eq(app.dangerSet(res).map(app.plcName), ["DANGEROUS", "OXIDIZER"],
    "DANGEROUS stands in for Flammable and Corrosive, and the blocked oxidizer keeps its own");

  app.setLineState(1, "liquid");
  r.eq(text(app.segSummary()), "Keep apart", "answered liquid, the O pairs remain");
}

r.section("No clear state while a question is open");
{
  /* the acid's row is the question itself, so no pair is proven yet —
     the engine has nothing on the table, and still must not say clear */
  const app = await appWith({ lines: [line(M.acid), line(M.oxidizer)] });
  const seg = app.segCheck();
  r.eq(seg.pairs.length, 0, "nothing is proven before the answer");
  r.eq(seg.outstanding.length, 1, "one line is waiting on liquid or solid");
  const v = text(app.segSummary());
  r.eq(v, "Check 1 rule · 1 question",
    "the row says so — the Class 8 liquid placement rule is raised before the answer, and the question stays on the row");
  r.ok(!/No conflicts/.test(v), "and never No conflicts");
}

r.section("An X is proven whatever else is open");
{
  const app = await appWith({ lines: [line(M.blasting, 100), line(M.gasoline, 800)] });
  r.eq(text(app.segSummary()), "Not allowed", "1.1D with Class 3 reads Not allowed");
  r.ok(/val bad/.test(app.segSummary()), "in red");
  r.eq(app.opsSummary(), "Explosives rules", "and On the road knows it is Division 1.1");
  r.ok(/1 required/.test(text(app.summaryList(app.compute()))), "Table 1 placards at any amount — 1 required");
}

r.section("A rule with no table cell still reaches the row");
{
  const app = await appWith({ lines: [line(M.cyanide, 1200), line(M.acid, 500, "B")] });
  const seg = app.segCheck();
  r.eq(seg.pairs.length, 0, "the 177.848 table has nothing to say about this pair");
  const bad = app.segAdvisoryList(seg.mapped).filter((a) => a[0] === "bad");
  r.ok(bad.some((a) => /Cyanides may not be loaded with acids/.test(a[1])), "the cyanide rule is raised");
  r.eq(text(app.segSummary()), "Check 1 rule", "so the row sends the driver to read it");
}

r.section("Class 9 is optional, and says so");
{
  const app = await appWith({ lines: [line(M.class9, 1500)] });
  const res = app.compute();
  r.ok(res.placards.includes("misc9"), "compute() puts Class 9 in the set over the threshold");
  r.ok(/Class 9 optional/.test(text(app.summaryList(res))), "the row does not count it as required");
  r.ok(/Optional/.test(app.plcHTML("misc9", 80)), "and the placard is captioned Optional");
}

r.section("Under the threshold");
{
  const app = await appWith({ lines: [line(M.gasoline, 400), line(M.acid, 300)] });
  r.ok(/None required/.test(text(app.summaryList(app.compute()))), "None required");
  r.eq(app.opsSummary(), "Not placarded", "and Part 397 is not reaching the load");
}

r.section("A missing data file says Unavailable, and takes nothing down with it");
{
  const app = runApp({ storage: { "hazpost.load.v1": JSON.stringify({ lines: SAMPLE }) } });
  const real = app.fetch;
  app.fetch = async (url) => /segregation\.json/.test(String(url))
    ? { ok: false, status: 404, statusText: "Not Found", json: async () => { throw new Error("404"); }, text: async () => "" }
    : real(url);
  await app.loadData();
  r.eq(text(app.segSummary()), "Unavailable", "no segregation.json, no verdict — and no throw");
  let threw = null;
  try { app.render(); } catch (e) { threw = e; }
  r.ok(!threw, "the Load screen still renders", threw && threw.message);
  r.ok(/Hang these placards/.test(main(app)), "with the placards on it");
}

r.section("The lines and their total");
{
  const app = await appWith({ lines: SAMPLE });
  app.render();
  const h = main(app);
  r.ok(/From the paper/.test(h) && /3,550 lb/.test(h), "the header totals the gross weights entered, 3,550 lb");
  r.eq((h.match(/class="lrow"/g) || []).length, 3, "one row per line");
}

r.section("The tab bar, and Emergency on every path");
{
  const app = await appWith({ lines: SAMPLE });
  app.render();
  const tabs = app.__els.get("tabBar").innerHTML;
  r.eq((tabs.match(/<button/g) || []).length, 4, "four tabs");
  r.ok(/class="emg[^"]*"[^>]*onclick="goTab\('emergency'\)"/.test(tabs), "Emergency is one of them, marked for red");

  app.openScreen("emergency", "notice");
  r.ok(/Did any of these happen/.test(main(app)), "Do I report? opens as its own screen");
  app.goTab("load");
  app.goTab("emergency");
  r.ok(bodyStart(app).startsWith('<a class="call urgent" href="tel:911"'),
    "tapping Emergency again lands on 911, not on the checklist left open");

  for (const s of ["placards", "seg", "papers", "ops"]) {
    app.openScreen("load", s);
    r.ok(/onclick="goTab\('emergency'\)"/.test(app.__els.get("tabBar").innerHTML), `Emergency is one tap from Load → ${s}`);
  }
}

r.section("Emergency with no data at all");
{
  const dead = runApp({ offline: true });
  await dead.loadData();
  dead.render();
  r.ok(/Couldn't load the material data/.test(main(dead)), "Load says the table did not arrive");
  r.ok(/goTab\('emergency'\)/.test(main(dead)), "and points at Emergency");
  dead.goTab("emergency");
  r.ok(bodyStart(dead).startsWith('<a class="call urgent" href="tel:911"'),
    "Emergency still opens on 911 with every data file missing");
}

r.section("An inhalation hazard outside 6.1 and 2.3 is never described by its class alone");
{
  /* Bromine is Class 8 with a Zone A inhalation hazard: 172.505(a) puts
     POISON INHALATION HAZARD on the trailer at any amount, on top of its
     CORROSIVE — and compute() does. The line screen and Look Up must agree. */
  const app = await appWith({ lines: [line("UN1744", 40)] });
  const res = app.compute();
  r.ok(res.placards.includes("pih61"), "compute() requires the inhalation placard at 40 lb");
  r.ok(/1 required/.test(text(app.summaryList(res))), "and the Placards row counts it");
  app.openLine(0);
  const lv = text(main(app));
  r.ok(/POISON INHALATION HAZARD at any amount/.test(lv), "the line screen says so");
  r.ok(/Inhalation hazard\s*Zone A/.test(lv), "names the zone");
  r.ok(/172\.505\(a\)/.test(lv), "and cites 172.505(a)");
  const rec = (id) => json("hazmat.json").records.find((x) => x.id === id);
  const lk = app.lkResult(rec("UN1744"));
  r.ok(/Placard at any amount/.test(lk) && /POISON INHALATION HAZARD at any amount/.test(text(lk)), "Look Up says the same");
  r.ok(/172\.505\(a\)/.test(lk), "with the same cite");
  const nine = app.lkResult(rec("UN3082"));
  r.ok(/Placard optional/.test(nine) && !/1,001 lb aggregate/.test(nine), "Look Up calls Class 9 optional, not a 1,001 lb placard");
}

r.section("A corrupted saved load cannot lock the app");
{
  for (const [label, raw] of [["null", "null"], ["a null line and a weight saved as text",
      JSON.stringify({ lines: [null, { id: "UN1203", wt: "650", fac: "A" }] })]]) {
    const app = runApp({ storage: { "hazpost.load.v1": raw } });
    let threw = null;
    try { await app.loadData(); } catch (e) { threw = e; }
    r.ok(!threw, `${label}: loadData() does not throw`, threw && threw.message);
    app.render();
    r.ok(!/Couldn't load the material data/.test(main(app)), `${label}: the app opens normally`);
    if (label !== "null") r.ok(/From the paper/.test(main(app)) && /650 lb/.test(main(app)) && !/0650/.test(main(app)),
      `${label}: the good line comes back with a numeric weight`);
  }
}

r.section("Removing the last line leaves nothing behind");
{
  const app = await appWith({ lines: [line("UN1203", 650)] });
  app.setOpsPlace("private");
  app.openLine(0);
  app.removeLine(0);
  r.ok(/Nothing on the trailer yet/.test(main(app)), "Load is empty again");
  app.demo();
  r.eq(app.opsCheck().place, null, "a new load does not inherit the last stop");
}

r.finish();
