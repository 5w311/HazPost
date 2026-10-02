#!/usr/bin/env node
/**
 * Packing group and packages, read off the shipping paper.
 *
 *   node tools/test-pg-packages.mjs
 *
 * 353 entries in the 172.101 table allow more than one packing group, and only
 * the paper says which one a shipment is. HazPost asks for it then and only
 * then, never picks one from a range itself, and an unanswered range stays a
 * visible gap rather than turning into a guess. The packages are the number
 * and type 172.202(a)(7) puts on the paper — "12 DR" — and are optional, so a
 * line packed in anything else can still go on the load.
 *
 * Everything runs through the app's own seams: the add form (pick, pickPG,
 * addLine), the line screen (openLine, setLinePG), the saved load, and the
 * engines that read the answer (basicDescription, papCheckView, segCatFor).
 */

import { report, appWith, runApp, json } from "./test-harness.mjs";

const r = report("HazPost — packing group and packages from the paper");

const HM = json("hazmat.json").records;
const rec = (id) => HM.find((x) => x.id === id);
const text = (html) => String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/* the basic description is inline spans, so it is read without the spaces text() adds */
const strip = (html) => String(html).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const main = (app) => app.__els.get("main").innerHTML;
const saved = (app) => { const raw = app.__store["hazpost.load.v1"]; return raw ? JSON.parse(raw).lines : []; };
const field = (app, id, v) => { app.document.getElementById(id).value = v; };

/* The add form, filled in the way a driver would. */
async function addForm() {
  const app = await appWith({});
  app.openScreen("load", "add");
  return app;
}
function fill(app, { id, wt = "", fac = "A", pkN = "", pkT = "", pg }) {
  app.pick(id);
  if (pg) app.pickPG(pg);
  field(app, "wtIn", wt); field(app, "fac", fac); field(app, "pkN", pkN); field(app, "pkT", pkT);
  app.addLine();
}

const explosive = HM.find((x) => /^1\./.test(x.base) && (x.pg === "—" || !x.pg));
const ranged = HM.filter((x) => /,/.test(x.pg || ""));

r.section("Which entries ask, and what the line carries");
{
  const app = runApp({});
  r.eq(app.pgList(rec("UN1479")), ["I", "II", "III"], "UN1479 allows PG I, II and III");
  r.eq(app.linePG(rec("UN1479")), null, "and carries none until the paper says");
  r.eq(app.linePG({ ...rec("UN1479"), pgPaper: "II" }), "II", "the paper's answer is the line's packing group");
  r.eq(app.linePG({ ...rec("UN1479"), pgPaper: "IV" }), null, "an answer the entry does not allow is no answer");
  r.eq(app.pgList(rec("UN1203")), ["II"], "UN1203 allows one, PG II");
  r.eq(app.linePG({ ...rec("UN1203"), pgPaper: "III" }), "II", "and a single-PG entry answers for itself, whatever else is attached");
  r.ok(explosive, "the table has an explosive with no packing group", "none found");
  r.eq(app.pgList(explosive), [], `${explosive.id} has no packing group`);
  r.eq(app.linePG(explosive), "", "and nothing to ask");
  r.eq(HM.filter((x) => app.pgList(x).length > 1).length, ranged.length,
    `exactly the ${ranged.length} entries whose column 5 holds a range ask the question`);
  r.ok(ranged.length > 300, "which is several hundred entries", String(ranged.length));
}

r.section("The add form asks only when the entry allows several");
{
  const app = await addForm();
  app.pick("UN1479");
  const q = app.__els.get("pgPick").innerHTML;
  r.ok(/aria-label="Packing group"/.test(q), "picking UN1479 shows the packing-group question");
  r.eq((q.match(/<button/g) || []).length, 3, "with one button per allowed group");
  r.ok(/PG I</.test(q) && /PG II</.test(q) && /PG III</.test(q), "PG I, PG II and PG III");
  r.ok(!/class="on"/.test(q), "and none of them chosen for the driver");
  app.pick("UN1203");
  r.eq(app.__els.get("pgPick").innerHTML, "", "picking UN1203, with one packing group, asks nothing");
  app.pick(explosive.id);
  r.eq(app.__els.get("pgPick").innerHTML, "", `picking ${explosive.id}, with none, asks nothing`);
  app.pick("UN1479");
  app.suggest("14");
  r.eq(app.__els.get("pgPick").innerHTML, "", "typing a new search clears the question with the pick");
}

r.section("A range is never added without the paper's answer");
{
  const app = await addForm();
  fill(app, { id: "UN1479", wt: "2400", fac: "B" });
  r.eq(saved(app).length, 0, "UN1479 with no packing group is refused");
  r.ok(/packing group/i.test(app.__alerts.at(-1) || "") && /will not guess/i.test(app.__alerts.at(-1) || ""),
    "and the driver is told why", app.__alerts.at(-1));

  app.pickPG("IV");
  r.ok(!/class="on"/.test(app.__els.get("pgPick").innerHTML), "a group the entry does not allow cannot be chosen");
  app.pickPG("II");
  r.ok(/class="on" aria-pressed="true"[^>]*>PG II</.test(app.__els.get("pgPick").innerHTML), "PG II shows as chosen");
  app.addLine();
  r.eq(saved(app), [{ id: "UN1479", wt: 2400, fac: "B", pgPaper: "II" }], "and the line is added with it");

  const one = await addForm();
  fill(one, { id: "UN1203", wt: "650" });
  r.eq(saved(one), [{ id: "UN1203", wt: 650, fac: "A" }], "a single-PG entry is added with nothing extra stored");
}

r.section("Packages: a number and a type, or neither");
{
  const cases = [
    ["a number with no type", { pkN: "12", pkT: "" }],
    ["a type with no number", { pkN: "", pkT: "DR" }],
    ["zero packages", { pkN: "0", pkT: "DR" }],
    ["a fraction", { pkN: "1.5", pkT: "CS" }],
    ["words", { pkN: "twelve", pkT: "CT" }],
    ["a type not on the list", { pkN: "12", pkT: "XX" }],
  ];
  for (const [label, pk] of cases) {
    const app = await addForm();
    fill(app, { id: "UN1203", wt: "650", ...pk });
    r.eq(saved(app).length, 0, `${label} is refused`);
    r.ok(/number and a type/.test(app.__alerts.at(-1) || ""), "with the same message", app.__alerts.at(-1));
  }
  for (const t of ["DR", "CS", "CT", "BG", "PL"]) {
    const app = await addForm();
    fill(app, { id: "UN1203", wt: "650", pkN: "1,200", pkT: t });
    r.eq(saved(app), [{ id: "UN1203", wt: 650, fac: "A", pkgCount: 1200, pkgType: t }], `1,200 ${t} is stored as a count and a type`);
  }
  const app = await addForm();
  fill(app, { id: "UN1203", wt: "650" });
  r.eq(saved(app), [{ id: "UN1203", wt: 650, fac: "A" }], "leaving both empty is fine — the packages are optional");
}

r.section("Saved and restored; anything else is dropped, and old loads are unchanged");
{
  const good = { id: "UN1479", wt: 100, fac: "A", pgPaper: "III", pkgCount: 3, pkgType: "BG" };
  const app = await appWith({ lines: [good] });
  app.saveLoad();
  r.eq(saved(app), [good], "a packing group and packages survive a save and a restore");

  const bad = [
    ["a packing group on a single-PG entry", { id: "UN1203", wt: 100, fac: "A", pgPaper: "III" }, { id: "UN1203", wt: 100, fac: "A" }],
    ["a packing group the entry does not allow", { id: "UN1479", wt: 100, fac: "A", pgPaper: "IV" }, { id: "UN1479", wt: 100, fac: "A" }],
    ["a count of zero", { id: "UN1203", wt: 100, fac: "A", pkgCount: 0, pkgType: "DR" }, { id: "UN1203", wt: 100, fac: "A" }],
    ["a count saved as words", { id: "UN1203", wt: 100, fac: "A", pkgCount: "abc", pkgType: "DR" }, { id: "UN1203", wt: 100, fac: "A" }],
    ["a type not on the list", { id: "UN1203", wt: 100, fac: "A", pkgCount: 4, pkgType: "XX" }, { id: "UN1203", wt: 100, fac: "A" }],
    ["a count with no type", { id: "UN1203", wt: 100, fac: "A", pkgCount: 4 }, { id: "UN1203", wt: 100, fac: "A" }],
  ];
  for (const [label, line, want] of bad) {
    const a = await appWith({ lines: [line] });
    a.saveLoad();
    r.eq(saved(a), [want], `${label} is dropped, and the line kept`);
  }
  const old = await appWith({ lines: [{ id: "UN1479", wt: 2400, fac: "B" }, { id: "UN1203", wt: 650, fac: "A", st: "liquid" }] });
  old.saveLoad();
  r.eq(saved(old), [{ id: "UN1479", wt: 2400, fac: "B" }, { id: "UN1203", wt: 650, fac: "A", st: "liquid" }],
    "a load saved before this change restores and saves back exactly as it was");
}

r.section("The line row and the line screen");
{
  const app = await appWith({ lines: [
    { id: "UN1479", wt: 2400, fac: "B", pgPaper: "II", pkgCount: 48, pkgType: "BG" },
    { id: "UN1203", wt: 650, fac: "A" },
    { id: "UN1993", wt: 300, fac: "A" },
  ] });
  app.render();
  const rows = text(main(app));
  r.ok(/UN1479 · PG II · 48 BG · 2,400 lb/.test(rows), "the row reads UN1479 · PG II · 48 BG · 2,400 lb", rows.slice(0, 200));
  r.ok(/UN1203 · PG II · 650 lb/.test(rows), "a single-PG line shows the table's group, and no packages");
  r.ok(/UN1993 · PG \? · 300 lb/.test(rows), "an unanswered range shows PG ?");

  app.openLine(2);
  const l = main(app);
  r.ok(/Not entered — PG I, II, III/.test(text(l)), "the line screen says the packing group is not entered");
  r.ok(/onclick="setLinePG\(2,'III'\)"/.test(l), "and offers the allowed groups to answer from the paper");
  app.setLinePG(2, "III");
  r.eq(saved(app)[2], { id: "UN1993", wt: 300, fac: "A", pgPaper: "III" }, "answering it saves it with the line");
  app.openLine(2);
  r.ok(/III, from the paper/.test(text(main(app))), "and the line screen says where it came from");
  app.setLinePG(2, "IV");
  r.eq(saved(app)[2].pgPaper, "III", "a group the entry does not allow changes nothing");
  app.setLinePG(1, "I");
  r.ok(!("pgPaper" in saved(app)[1]), "and a single-PG line cannot be given one");

  app.openLine(0);
  r.ok(/Packages 48 BG, bags/.test(text(main(app))), "the line screen shows 48 BG, bags");
  app.openLine(1);
  r.ok(/Packages Not entered/.test(text(main(app))), "and Not entered where there are none");
  r.ok(!/aria-label="Packing group"/.test(main(app)), "with no packing-group question on a single-PG line");
}

r.section("Shipping Papers uses the packing group from the paper");
{
  const app = runApp({});
  const answered = app.basicDescription({ ...rec("UN1479"), pgPaper: "II" });
  r.ok(/, 5\.1, II$/.test(strip(answered.html)), "UN1479 with PG II from the paper ends 5.1, II", strip(answered.html));
  r.ok(!/…I \/ II \/ III…/.test(strip(answered.html)), "with no gap left for the packing group");
  r.ok(answered.flags.some((f) => f.cite === "172.202(a)(4)" && /entered from the paper/.test(f.txt) && f.tone === ""),
    "and a neutral note that the group came from the paper");
  r.ok(!answered.flags.some((f) => f.tone === "warn" && /covers packing groups/.test(f.txt)), "not the warning that HazPost cannot tell");
  const open = app.basicDescription(rec("UN1479"));
  r.ok(/…I \/ II \/ III…/.test(strip(open.html)), "unanswered, the range is still a gap");
  r.ok(open.flags.some((f) => f.tone === "warn" && /set it on the line/.test(f.txt)), "and the warning says where to set it");

  const withPkgs = await appWith({ lines: [
    { id: "UN1479", wt: 2400, fac: "B", pgPaper: "II", pkgCount: 48, pkgType: "BG" },
    { id: "UN1203", wt: 650, fac: "A" },
  ] });
  const v = text(withPkgs.papCheckView());
  r.ok(/The packages you entered from the paper\./.test(v) && /UN1479 — 48 BG, bags/.test(v) && /UN1203 — not entered/.test(v),
    "the packages card lists what was entered against each line", v.slice(v.indexOf("packages you entered") - 10, v.indexOf("packages you entered") + 200));
  const none = await appWith({ lines: [{ id: "UN1203", wt: 650, fac: "A" }] });
  r.ok(/You can enter the packages on each line/.test(text(none.papCheckView())), "and says how to add them where there are none");
}

r.section("Segregation reads the packing group the line carries");
{
  const app = runApp({});
  const ctx = () => ({ notes: [] });
  const zoneA = { id: "T", un: "0000", pih: "Zone A" };
  r.eq(app.segCatFor("6.1", { ...zoneA, pg: "I" }, ctx()), "6.1I-A", "PG I, Zone A is the 6.1 row");
  r.eq(app.segCatFor("6.1", { ...zoneA, pg: "II" }, ctx()), null, "PG II, Zone A is not");
  r.eq(app.segCatFor("6.1", { ...zoneA, pg: "I, II" }, ctx()), "6.1I-A", "an unanswered range that includes PG I stays on the stricter row");
  r.eq(app.segCatFor("6.1", { ...zoneA, pg: "I, II", pgPaper: "II" }, ctx()), null, "PG II from the paper takes it off");
  r.eq(app.segCatFor("6.1", { ...zoneA, pg: "I, II", pgPaper: "I" }, ctx()), "6.1I-A", "PG I from the paper keeps it on");
}

r.section("The suggestion list tells per-PG entries apart");
{
  const app = await addForm();
  app.suggest("1197");
  const s = text(app.__els.get("sugg").innerHTML);
  r.ok(/UN1197 Extracts, liquid, for flavor or aroma · 3 · PG II/.test(s) && /· PG III/.test(s),
    "UN1197's two entries show PG II and PG III", s);
}

r.section("The demo load shows both");
{
  const app = await appWith({});
  app.demo();
  const d = saved(app);
  r.eq(d.map((l) => l.pkgType && `${l.pkgCount} ${l.pkgType}`), ["4 DR", "2 DR", "48 BG"], "every demo line has packages");
  r.eq(d.find((l) => l.id === "UN1479").pgPaper, "II", "and UN1479 has its packing group from the paper");
}

r.finish();
