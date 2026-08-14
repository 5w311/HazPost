#!/usr/bin/env node
/**
 * Data integrity — the six generated JSON files, as they ship.
 *
 *   node tools/test-data.mjs
 *
 * The build scripts assert their own output at generation time. This asserts
 * the files in the repo, which is a different guarantee: it catches a file that
 * was edited by hand, regenerated against a different CFR date than its
 * neighbours, or added without being precached.
 *
 * That last one is the worst failure this app has. A data file that ships but
 * is not in the sw.js SHELL list works perfectly online and simply is not there
 * in a yard with no signal — which is the exact situation the app was built for.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { report, ROOT, json } from "./test-harness.mjs";

const r = report("HazPost — data integrity");

/**
 * The generated files, and which array `count` is counting. A file added to
 * the app without being added here is caught by the SHELL sweep at the bottom.
 */
const FILES = [
  { name: "hazmat.json",      arr: "records",    generator: "tools/build-hazmat.mjs" },
  { name: "segregation.json", arr: "categories", generator: "tools/build-segregation.mjs" },
  { name: "ops.json",         arr: "sections",   generator: "tools/build-ops.mjs" },
  { name: "papers.json",      arr: "sections",   generator: "tools/build-papers.mjs" },
  { name: "incident.json",    arr: "sections",   generator: "tools/build-incident.mjs" },
  { name: "carry.json",       arr: "sections",   generator: "tools/build-carry.mjs" },
];

const META = ["source", "version", "cfrDate", "generated", "generator"];
const docs = {};

/* ------------------------------------------------------------------ */

r.section("Provenance — every file says where it came from");
for (const f of FILES) {
  r.ok(existsSync(join(ROOT, f.name)), `${f.name} is in the repo`);
  let doc;
  try { doc = json(f.name); } catch (e) { r.ok(false, `${f.name} is valid JSON`, e.message); continue; }
  docs[f.name] = doc;
  r.ok(true, `${f.name} is valid JSON`);

  for (const k of META) {
    r.ok(typeof doc[k] === "string" && doc[k].length > 0, `${f.name} carries ${k}`);
  }
  r.ok(typeof doc.count === "number" && doc.count > 0, `${f.name} carries a count`);

  r.eq(doc.generator, f.generator, `${f.name} names its generator`);
  r.ok(existsSync(join(ROOT, doc.generator)), `${f.name}'s generator is in the repo and can be re-run`);

  r.ok(/^\d{4}-\d{2}-\d{2}$/.test(doc.cfrDate), `${f.name} cfrDate is a plain calendar date`);
  r.ok(/^\d{4}-\d{2}-\d{2}$/.test(doc.generated), `${f.name} generated is a plain calendar date`);
  r.ok(/^\d+\.\d+\.\d+$/.test(doc.version), `${f.name} version is a three-part version`);
  r.ok(doc.cfrDate <= doc.generated,
    `${f.name} was generated on or after the CFR edition it carries`,
    `cfrDate ${doc.cfrDate}, generated ${doc.generated}`);
}

r.section("The count is the count");
for (const f of FILES) {
  const doc = docs[f.name];
  if (!doc) continue;
  const arr = doc[f.arr];
  r.ok(Array.isArray(arr), `${f.name} has a ${f.arr} array`);
  r.eq(doc.count, (arr || []).length,
    `${f.name} count matches its ${arr ? arr.length : "?"} ${f.arr}`);
}

r.section("All six agree on the CFR edition");
{
  const dates = FILES.map((f) => ({ name: f.name, date: docs[f.name] && docs[f.name].cfrDate }));
  const distinct = [...new Set(dates.map((d) => d.date))];
  r.eq(distinct.length, 1,
    "every data file was generated against the same CFR date",
    dates.map((d) => `${d.name} ${d.date}`).join("\n"));

  /* Not a style point. Two files at two editions means two modules can quote
     the same rule differently on the same trailer — build-carry.mjs asserts
     this at generation time for the sections it shares, and this asserts it
     across the set that shipped. */
  r.note(distinct.length === 1 ? `all at ${distinct[0]}` : `mixed: ${distinct.join(", ")}`);
}

/* ------------------------------------------------------------------ */

r.section("Precaching — a file that is not in SHELL is not there offline");
{
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const m = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/);
  r.ok(!!m, "sw.js has a SHELL list");
  const shell = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  r.ok(shell.length > 0, "and it is not empty");
  r.note(`SHELL: ${shell.join(" ")}`);

  for (const f of FILES) {
    r.ok(shell.includes(f.name), `${f.name} is precached`);
  }
  r.ok(shell.includes("index.html"), "index.html is precached");
  r.ok(shell.includes("./"), "and so is the directory itself, for a navigation to /HazPost/");

  /* the other direction: nothing in SHELL may be missing from the repo, or
     the install fails outright and the old worker stays in charge forever */
  const missing = shell.filter((p) => p !== "./" && !existsSync(join(ROOT, p)));
  r.eq(missing, [], "every path in SHELL exists in the repo", missing.join(", "));

  /* the optional list is best-effort, but a typo there is still worth knowing */
  const om = sw.match(/const OPTIONAL\s*=\s*\[([\s\S]*?)\];/);
  const optional = om ? [...om[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  const omissing = optional.filter((p) => !existsSync(join(ROOT, p)));
  r.eq(omissing, [], "every path in OPTIONAL exists too", omissing.join(", "));

  /* every .json the app fetches is one of the six, or the manifest */
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const fetched = [...src.matchAll(/^const [A-Z_]+_URL = "([^"]+)";$/gm)].map((x) => x[1]);
  r.sameSet(fetched, FILES.map((f) => f.name),
    "the app fetches exactly the six generated files and no others");
}

r.section("Release constants");
{
  const src = readFileSync(join(ROOT, "index.html"), "utf8");
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const app = (src.match(/const APP_VERSION = "([^"]+)"/) || [])[1];
  const ver = (sw.match(/const VERSION = "([^"]+)"/) || [])[1];
  r.ok(/^\d+\.\d+\.\d+$/.test(app || ""), "index.html carries a well-formed APP_VERSION", app);
  r.ok(/^v\d+\.\d+\.\d+$/.test(ver || ""), "sw.js carries a well-formed cache VERSION", ver);
  r.ok(sw.includes(`hazpost-${"${VERSION}"}`) || /hazpost-\$\{VERSION\}/.test(sw),
    "and the cache name carries it, so a bump forces a fresh install");
}

r.finish();
