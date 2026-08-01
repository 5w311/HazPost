#!/usr/bin/env node
/**
 * build-hazmat.mjs — turn the 49 CFR 172.101 Hazardous Materials Table into
 * hazmat.json, the file HazPost fetches at load.
 *
 *   node tools/build-hazmat.mjs                 # latest published eCFR text
 *   node tools/build-hazmat.mjs --date 2026-07-22
 *   node tools/build-hazmat.mjs --xml cached.xml
 *
 * Source is the eCFR versioner API at ecfr.gov. No dependencies; Node 18+.
 * Writes ../hazmat.json and ./GENERATION-REPORT.md, and prints a summary.
 *
 * What this script decides, and the paragraph it decides it from, is set out
 * in MAPPING below. Every entry it drops or has to judge is listed by name in
 * the report — placarding advice is only as trustworthy as the record of how
 * it was derived.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "hazmat.json");
const OUT_REPORT = path.join(HERE, "GENERATION-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49, PART = 172, SECTION = "172.101";

/* ------------------------------------------------------------------ *
 * MAPPING — 49 CFR 172.504(e)
 *
 * Table 1 places a placard on the vehicle at any quantity. Table 2 places one
 * once 1,001 lb aggregate of Table 2 material is aboard. `base` is HazPost's
 * placard-category key; `plc` is the placard design key defined in index.html.
 * ------------------------------------------------------------------ */

/* Table 1 to 172.504(e) */
const TABLE1 = {
  "1.1": { base: "1.1", plc: "expl11" },
  "1.2": { base: "1.2", plc: "expl12" },
  "1.3": { base: "1.3", plc: "expl13" },
  "2.3": { base: "2.3", plc: "gas23" },
  "4.3": { base: "4.3", plc: "wet43" },
  // 5.2 and 6.1 reach Table 1 only under a condition, handled in classify()
  // 7 reaches Table 1 only with a RADIOACTIVE YELLOW-III label, ditto
};

/* Table 2 to 172.504(e) */
const TABLE2 = {
  "1.4": { base: "1.4", plc: "expl14" },
  "1.5": { base: "1.5", plc: "expl15" },
  "1.6": { base: "1.6", plc: "expl16" },
  "2.1": { base: "2.1", plc: "flamgas21" },
  "2.2": { base: "2.2", plc: "nfgas22" },
  "3": { base: "3", plc: "flam3" },
  comb: { base: "comb", plc: "comb3" },
  "4.1": { base: "4.1", plc: "fs41" },
  "4.2": { base: "4.2", plc: "sc42" },
  "5.1": { base: "5.1", plc: "oxy51" },
  "5.2": { base: "5.2", plc: "operox52" },
  "6.1": { base: "6.1t2", plc: "tox61" }, // non-inhalation 6.1
  "6.2": { base: "6.2", plc: "none" }, // Table 2 names this placard "NONE"
  "8": { base: "8", plc: "corr8" },
  "9": { base: "9", plc: "misc9" },
};

/* 172.504(f)(7) — OXYGEN may be displayed instead of NON-FLAMMABLE GAS, but
   only for these two shipping descriptions. */
const OXYGEN_IDS = new Set(["UN1072", "UN1073"]);

/* Table 1 to 172.504(e): "5.2 (Organic peroxide, Type B, liquid or solid,
   temperature controlled)". Exactly two shipping descriptions match. */
const PEROXIDE_T1_IDS = new Set(["UN3111", "UN3112"]);

/* 172.504(e) Table 1 footnote — the RADIOACTIVE placard is keyed to the
   package label, which the 172.101 table does not carry. */
const RADIOACTIVE_COND =
  "Table 1 applies only when a package bears a RADIOACTIVE YELLOW-III label, " +
  "and to unpackaged LSA-I or SCO-I, exclusive-use shipments under 173.427, " +
  "173.441 and 173.457, and closed vehicles under 173.443(d). Check the labels.";

/* 172.102(c)(1) special provisions 1-4 and 6 assign the inhalation hazard zone. */
const PIH_ZONE = { 1: "Zone A", 2: "Zone B", 3: "Zone C", 4: "Zone D", 6: "Yes" };

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? m;
  });
}

/** Strip inline markup (<E>, <I>, <sub>, <sup>, <br/>) and normalise whitespace. */
function cellText(xml) {
  return decode(xml.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull out the <TABLE> whose <CAPTION> names the Hazardous Materials Table. */
function extractHmtTable(xml) {
  const tables = xml.match(/<TABLE[\s\S]*?<\/TABLE>/gi) || [];
  const hit = tables.find((t) => {
    const cap = t.match(/<CAPTION[\s\S]*?<\/CAPTION>/i);
    return cap && /172\.101\s+Hazardous Materials Table/i.test(cellText(cap[0]));
  });
  if (!hit) throw new Error("could not find the 172.101 Hazardous Materials Table in the XML");
  return hit;
}

/** Parse the table body into 14-column rows. Bails out if the shape shifts. */
function parseRows(tableXml) {
  const body = tableXml.match(/<TBODY[\s\S]*?<\/TBODY>/i);
  if (!body) throw new Error("the Hazardous Materials Table has no TBODY");
  const trs = body[0].match(/<TR[\s>][\s\S]*?<\/TR>/gi) || [];
  const rows = [];
  const widths = new Set();
  for (const tr of trs) {
    const tds = tr.match(/<TD[\s>][\s\S]*?<\/TD>/gi) || [];
    if (!tds.length) continue;
    widths.add(tds.length);
    rows.push(tds.map(cellText));
  }
  if (!rows.length) throw new Error("the Hazardous Materials Table body has no rows");
  const bad = [...widths].filter((w) => w !== 14);
  if (bad.length) throw new Error(`expected 14 columns per row, saw widths ${[...widths].join(", ")}`);
  // drop the "(1) (2) (3)..." column-number row the table repeats as its first body row
  return rows.filter((r) => !/^\(\d+[A-C]?\)$/.test(r[3]) || r[1] !== "(2)");
}

const COL = { sym: 0, name: 1, cls: 2, id: 3, pg: 4, labels: 5, sp: 6 };
const isBlank = (v) => !v || !v.trim();

/**
 * The printed table repeats one shipping name across several packing-group
 * rows, leaving columns 1-4 blank on the continuations. Fold each run back
 * into the entry it belongs to.
 */
function groupEntries(rows) {
  const groups = [];
  const forbidden = [];
  let cur = null;
  let orphans = 0;
  let xrefs = 0;
  for (const r of rows) {
    if (!isBlank(r[COL.id])) {
      cur = { head: r, rows: [r] };
      groups.push(cur);
    } else if (/^forbidden$/i.test(r[COL.cls] || "")) {
      // no ID number, no packaging, no placard — may not be offered at all
      forbidden.push({ id: "—", name: r[COL.name].trim() });
      cur = null;
    } else if (
      isBlank(r[COL.sym]) && isBlank(r[COL.name]) && isBlank(r[COL.cls]) &&
      (!isBlank(r[COL.pg]) || !isBlank(r[COL.labels]))
    ) {
      if (cur) cur.rows.push(r);
      else orphans++;
    } else {
      xrefs++; // a "see also" line pointing at another shipping name
    }
  }
  return { groups, forbidden, orphans, xrefs };
}

/* ------------------------------------------------------------------ *
 * Field derivation
 * ------------------------------------------------------------------ */

/* The label codes that can legitimately appear in column 6, per the Label
   Substitution Table at the head of 172.101. Matching against the real set
   rather than a loose digit pattern keeps punctuation slips in the source
   text from inventing a hazard class — the table ships a few, e.g. UN1052
   reads "8.6.1" where it means "8, 6.1". */
const LABEL_CODE = /1\.[1-6][A-S]?|2\.[1-3]|4\.[1-3]|5\.[1-2]|6\.[1-2]|[13789]/g;
const LABEL_EXACT = /^(?:1\.[1-6][A-S]?|2\.[1-3]|4\.[1-3]|5\.[1-2]|6\.[1-2]|[13789])$/;

/** Label codes for one row. "None"/"Empty"/"" yield []. */
function labelCodes(raw, onOddity) {
  if (isBlank(raw)) return [];
  const s = raw.trim();
  if (/^(none|empty)$/i.test(s)) return [];
  const codes = s.match(LABEL_CODE) || [];
  const tidy = s.split(/[,;]/).map((t) => t.trim()).filter(Boolean).every((t) => LABEL_EXACT.test(t));
  if (!tidy && onOddity) onOddity(s, codes);
  return codes;
}

/** Special provisions are comma-separated codes; 1-4 and 6 carry the PIH zone. */
function pihZone(sp) {
  if (isBlank(sp)) return null;
  for (const tok of sp.split(",").map((t) => t.trim())) {
    if (Object.prototype.hasOwnProperty.call(PIH_ZONE, tok)) return PIH_ZONE[tok];
  }
  return null;
}

/** "1.1D" -> {division:"1.1", group:"D"}; "3" -> {division:"3"}. */
function splitClass(raw) {
  const s = (raw || "").trim();
  if (/^comb\.?\s*liq/i.test(s)) return { division: "comb", group: "" };
  const m = s.match(/^(\d(?:\.\d)?)([A-Z]?)$/);
  return m ? { division: m[1], group: m[2] || "" } : null;
}

/**
 * Decide the placard category for one row. Returns null when the material has
 * no placarding relevance, with `why` explaining the drop.
 */
function classify({ division, idNum, labels, pih }) {
  const t1 = TABLE1[division];
  if (t1) return { ...t1, t1: true };

  if (division === "5.2") {
    return PEROXIDE_T1_IDS.has(idNum)
      ? { base: "5.2tc", plc: "operox52", t1: true }
      : { ...TABLE2["5.2"], t1: false };
  }

  if (division === "6.1") {
    // Table 1 covers 6.1 "material poisonous by inhalation"; everything else
    // in 6.1 is the Table 2 POISON category.
    return pih
      ? { base: "6.1", plc: "pih61", t1: true }
      : { ...TABLE2["6.1"], t1: false };
  }

  if (division === "7") {
    // Excepted and empty radioactive packages carry no label and no placard.
    if (!labels.length) return { base: "7", plc: "none", t1: false };
    return { base: "7", plc: "radio7", t1: true, cond: RADIOACTIVE_COND };
  }

  if (division === "2.2" && OXYGEN_IDS.has(idNum)) {
    return { base: "2.2oxy", plc: "oxygen22", t1: false };
  }

  if (division === "1.4") {
    // 172.504(f)(6): no EXPLOSIVES 1.4 placard for 1.4S material that is not
    // required to be labelled 1.4S.
    if (!labels.length) return { base: "1.4", plc: "none", t1: false };
    return { ...TABLE2["1.4"], t1: false };
  }

  if (division === "6.2") {
    // Table 2 names the 6.2 placard "NONE". UN3373 is not even labelled.
    return { ...TABLE2["6.2"], t1: false };
  }

  const t2 = TABLE2[division];
  return t2 ? { ...t2, t1: false } : null;
}

const PG_ORDER = ["I", "II", "III"];

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function buildRecords(groups, notes) {
  const records = [];
  const idCount = new Map();

  for (const g of groups) {
    const head = g.head;
    const rawId = head[COL.id].trim();
    const name = head[COL.name].trim();
    const rawClass = head[COL.cls].trim();
    const sym = head[COL.sym].replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim();

    if (/^forbidden$/i.test(rawClass)) {
      notes.forbidden.push({ id: rawId || "—", name });
      continue;
    }

    const parsed = splitClass(rawClass);
    if (!parsed) {
      notes.skipped.push({
        id: rawId || "—", name,
        why: rawClass ? `unrecognised hazard class "${rawClass}"` : "no hazard class assigned in column 3",
      });
      continue;
    }

    const idm = rawId.match(/^(UN|NA|ID)\s*(\d+)$/i);
    if (!idm) {
      notes.skipped.push({ id: rawId || "—", name, why: "no usable identification number in column 4" });
      continue;
    }
    const pfx = idm[1].toUpperCase();
    const num = idm[2];
    const idNum = pfx + num;

    // One signature per row; rows that agree collapse into a single record
    // carrying the packing-group range.
    const buckets = new Map();
    for (const r of g.rows) {
      const rawLabels = isBlank(r[COL.labels]) ? head[COL.labels] : r[COL.labels];
      const labels = labelCodes(rawLabels, (cell, codes) =>
        notes.labelOddity.push({ id: idNum, name, cell, read: codes.join(", ") || "(none)" })
      );
      const pih = pihZone(isBlank(r[COL.sp]) ? head[COL.sp] : r[COL.sp]);
      const cat = classify({ division: parsed.division, idNum, labels, pih });
      if (!cat) {
        notes.skipped.push({ id: idNum, name, why: `division ${parsed.division} is in neither placarding table` });
        continue;
      }
      const subs = labels.filter((l) => l !== rawClass && l !== parsed.division);
      const sig = JSON.stringify([cat.base, cat.plc, cat.t1, cat.cond || "", subs, pih || ""]);
      if (!buckets.has(sig)) buckets.set(sig, { cat, subs, pih, pgs: [] });
      const pg = (r[COL.pg] || "").trim();
      if (pg) buckets.get(sig).pgs.push(pg);
    }
    if (!buckets.size) continue;

    if (buckets.size > 1) {
      notes.pgSplit.push({ id: idNum, name, parts: buckets.size });
    } else if (g.rows.length > 1) {
      notes.pgMerged.push({ id: idNum, name, pgs: [...buckets.values()][0].pgs.join(", ") });
    }

    for (const b of buckets.values()) {
      let id = idNum;
      const n = (idCount.get(idNum) || 0) + 1;
      idCount.set(idNum, n);
      if (n > 1) {
        id = `${idNum}-${n}`;
        notes.sharedIds.push({ id, base: idNum, name });
      }

      const pgs = PG_ORDER.filter((p) => b.pgs.includes(p));
      const rec = {
        id, un: num, pfx, name,
        cls: b.subs.length ? `${rawClass} (${b.subs.join(", ")})` : rawClass,
        base: b.cat.base,
        pg: pgs.length ? pgs.join(", ") : "—",
        plc: b.cat.plc,
      };
      if (b.cat.t1) rec.t1 = true;
      if (sym) rec.sym = sym;
      if (b.pih) rec.pih = b.pih;
      if (b.subs.length) rec.subs = b.subs.join(", ");
      if (b.cat.cond) rec.cond = b.cat.cond;
      records.push(rec);

      if (b.cat.plc === "none") notes.noPlacard.push({ id, name, cls: rawClass });
      if (b.cat.cond) notes.conditional.push({ id, name });
    }
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function tally(records, key) {
  const m = new Map();
  for (const r of records) m.set(r[key], (m.get(r[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function list(rows, render, cap = 0) {
  if (!rows.length) return "_None._\n";
  const shown = cap && rows.length > cap ? rows.slice(0, cap) : rows;
  let out = shown.map(render).join("\n") + "\n";
  if (shown.length < rows.length) out += `- …and ${rows.length - shown.length} more.\n`;
  return out;
}

function writeReport({ records, notes, meta, bytes, rowCount, groupCount, checks }) {
  const t1 = records.filter((r) => r.t1).length;
  const kb = (bytes / 1024).toFixed(1);
  const mb = (bytes / 1024 / 1024).toFixed(2);
  // a record is "clean" when no judgment call was logged against it
  const judged = new Set(
    [notes.noPlacard, notes.conditional, notes.sharedIds, notes.pgSplit].flat().map((r) => r.id)
  );
  const clean = records.filter((r) => !judged.has(r.id)).length;

  const md = `# hazmat.json generation report

Generated by \`tools/build-hazmat.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml?part=${PART}&section=${SECTION}\` |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Table body rows parsed | ${rowCount.toLocaleString()} |
| Entries with an ID number | ${groupCount.toLocaleString()} |
| Forbidden entries (no ID, no placard) | ${notes.forbidden.length.toLocaleString()} |
| "See also" cross-reference lines | ${notes.xrefs.toLocaleString()} |
| **Records written** | **${records.length.toLocaleString()}** |
| Table 1 records (placard at any quantity) | ${t1.toLocaleString()} |
| Table 2 records (1,001 lb aggregate) | ${(records.length - t1).toLocaleString()} |
| hazmat.json size | ${bytes.toLocaleString()} bytes (${kb} KB, ${mb} MB) |

## Verification scenarios

These run on every build. A failure aborts the script and nothing is written.

| Check | Expected | Result |
|---|---|---|
${checks.map((c) => `| ${c.what} | ${c.want} | ${c.ok ? "pass" : "**FAIL** — " + c.got} |`).join("\n")}

## Mapped cleanly

${clean.toLocaleString()} of ${records.length.toLocaleString()} records took their placard category straight from the
column 3 hazard class via the 172.504(e) tables, with nothing to decide. The
remaining ${(records.length - clean).toLocaleString()} needed a judgment call and are listed by name below.

### By placard category

| \`base\` | Table | Records |
|---|---|---|
${tally(records, "base")
  .map(([b, n]) => {
    const t = records.filter((r) => r.base === b);
    const mixed = t.some((r) => r.t1) && t.some((r) => !r.t1);
    return `| \`${b}\` | ${mixed ? "1 / 2" : t[0].t1 ? "1" : "2"} | ${n.toLocaleString()} |`;
  })
  .join("\n")}

### By placard key

| \`plc\` | Records |
|---|---|
${tally(records, "plc").map(([p, n]) => `| \`${p}\` | ${n.toLocaleString()} |`).join("\n")}

## Skipped

### Forbidden materials — ${notes.forbidden.length}

Column 3 reads "Forbidden": no ID number, no packing group, no label codes.
These may not be offered for transport at all, so there is no placard to
advise. Kept out of hazmat.json.

${list(notes.forbidden, (r) => `- ${r.name}`, 30)}
### Other entries dropped — ${notes.skipped.length}

${list(notes.skipped, (r) => `- \`${r.id}\` ${r.name} — ${r.why}`)}
## Judgment calls

### Entries that hang no placard — ${notes.noPlacard.length}

Written to hazmat.json with \`plc: "none"\` so a driver can still look them up.
They count toward the 1,001 lb Table 2 aggregate but put nothing on the trailer.

${list(notes.noPlacard, (r) => `- \`${r.id}\` (${r.cls}) ${r.name}`)}
### Conditional Table 1 — ${notes.conditional.length}

Class 7 reaches Table 1 only for a package bearing a RADIOACTIVE YELLOW-III
label, which the 172.101 table does not record. These are marked \`t1: true\`
with a \`cond\` string the app shows alongside the placard: over-stating the
requirement and naming the condition beats silently under-placarding.

${list(notes.conditional, (r) => `- \`${r.id}\` ${r.name}`)}
### ID numbers shared by several shipping names — ${notes.sharedIds.length}

One identification number, more than one proper shipping name. Each gets its
own record under a suffixed \`id\`; \`un\` still holds the bare number so search
and the shipping-paper lookup keep working.

${list(notes.sharedIds, (r) => `- \`${r.id}\` ${r.name} (shares ${r.base})`)}
### Packing groups collapsed into one record — ${notes.pgMerged.length}

The printed table splits these across several packing-group rows. Hazard class,
subsidiary labels and inhalation zone are identical on every row, so per the
brief they collapse to one record carrying the packing-group range.

${list(notes.pgMerged, (r) => `- \`${r.id}\` ${r.name} — PG ${r.pgs}`, 25)}
### Label-code cells that needed a tolerant read — ${notes.labelOddity.length}

Column 6 in these rows is not a clean comma-separated list of label codes.
The codes were matched against the Label Substitution Table rather than a
loose digit pattern, so a stray separator cannot invent a hazard class.

${list(notes.labelOddity, (r) => `- \`${r.id}\` ${r.name} — column 6 reads \`${r.cell}\`, read as \`${r.read}\``)}
### Entries split by packing group — ${notes.pgSplit.length}

Placarding actually differs between packing groups here, so each gets its own
record.

${list(notes.pgSplit, (r) => `- \`${r.id}\` ${r.name} — ${r.parts} records`)}
### Continuation rows with no parent entry — ${notes.orphans}

Packing-group rows appearing before any entry row. Non-zero means the table
shape changed and the parser needs a look.

## Rules applied

| Decision | Authority |
|---|---|
| Divisions 1.1, 1.2, 1.3 → Table 1 | 172.504(e) Table 1 |
| Division 2.3 → Table 1 | 172.504(e) Table 1 |
| Division 4.3 → Table 1 | 172.504(e) Table 1 |
| Division 5.2 Type B temperature controlled → Table 1 (UN3111, UN3112) | 172.504(e) Table 1 |
| Division 6.1 poisonous by inhalation → Table 1 | 172.504(e) Table 1 |
| Class 7 with YELLOW-III label → Table 1 | 172.504(e) Table 1 + footnote |
| Inhalation hazard zone read from special provisions 1-4, 6 | 172.102(c)(1) |
| Everything else placardable → Table 2 | 172.504(e) Table 2 |
| Division 6.2 placard is "NONE" | 172.504(e) Table 2 |
| Unlabelled 1.4S hangs no EXPLOSIVES 1.4 placard | 172.504(f)(6) |
| OXYGEN placard for UN1072 / UN1073 | 172.504(f)(7) |
| Combustible liquid → COMBUSTIBLE | 172.504(e) Table 2 |
`;
  fs.writeFileSync(OUT_REPORT, md);
}

/* ------------------------------------------------------------------ *
 * Verification — these must pass or the build fails
 * ------------------------------------------------------------------ */

function verify(records) {
  const by = (id) => records.find((r) => r.id === id);
  const cases = [
    { what: "Gasoline UN1203", want: "class 3, Table 2", id: "UN1203", cls: "3", t1: false },
    { what: "Chlorine UN1017", want: "division 2.3, Table 1", id: "UN1017", cls: "2.3", t1: true },
    { what: "Sodium UN1428", want: "division 4.3, Table 1", id: "UN1428", cls: "4.3", t1: true },
    { what: "TNT UN0209", want: "division 1.1, Table 1", id: "UN0209", cls: "1.1", t1: true },
  ];
  return cases.map((c) => {
    const r = by(c.id);
    if (!r) return { ...c, ok: false, got: "no record" };
    const div = (r.cls.match(/^(\d(?:\.\d)?)/) || [])[1];
    const ok = div === c.cls && !!r.t1 === c.t1;
    return { ...c, ok, got: `class ${r.cls}, base ${r.base}, Table ${r.t1 ? 1 : 2}` };
  });
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

async function latestDate() {
  const res = await fetch(`${API}/titles.json`);
  if (!res.ok) throw new Error(`titles.json: HTTP ${res.status}`);
  const t = (await res.json()).titles.find((x) => x.number === TITLE);
  if (!t) throw new Error(`title ${TITLE} not listed by the eCFR API`);
  return t.latest_issue_date;
}

async function main() {
  const cached = arg("xml");
  let xml, cfrDate;

  if (cached) {
    xml = fs.readFileSync(cached, "utf8");
    cfrDate = arg("date") || "unknown (read from a cached file)";
    console.log(`reading ${cached}`);
  } else {
    cfrDate = arg("date") || (await latestDate());
    const url = `${API}/full/${cfrDate}/title-${TITLE}.xml?part=${PART}&section=${SECTION}`;
    console.log(`fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`eCFR returned HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
    console.log(`  ${xml.length.toLocaleString()} bytes of XML`);
  }

  const rows = parseRows(extractHmtTable(xml));
  const { groups, forbidden, orphans, xrefs } = groupEntries(rows);
  console.log(`  ${rows.length.toLocaleString()} body rows, ${groups.length.toLocaleString()} entries, ${forbidden.length} forbidden, ${xrefs} cross-references`);

  const notes = {
    forbidden, skipped: [], noPlacard: [], conditional: [],
    sharedIds: [], pgMerged: [], pgSplit: [], labelOddity: [], orphans, xrefs,
  };
  const records = buildRecords(groups, notes);
  records.sort((a, b) => a.un.localeCompare(b.un) || a.name.localeCompare(b.name));

  const checks = verify(records);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.what}: ${c.got}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    throw new Error(`${failed.length} verification scenario(s) failed — nothing written`);
  }

  const meta = {
    source: "49 CFR 172.101 Hazardous Materials Table",
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-hazmat.mjs",
    count: records.length,
  };
  // One record per line: still compact, but a re-run against a new eCFR date
  // produces a diff a reviewer can actually read.
  const head = Object.entries(meta).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = records.map((r) => "  " + JSON.stringify(r)).join(",\n");
  fs.writeFileSync(OUT_JSON, `{\n ${head.join(",\n ")},\n "records": [\n${body}\n ]\n}\n`);
  const bytes = fs.statSync(OUT_JSON).size;

  writeReport({ records, notes, meta, bytes, rowCount: rows.length, groupCount: groups.length, checks });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${records.length.toLocaleString()} records, ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
  if (bytes > 2 * 1024 * 1024) console.log(`\nNOTE: hazmat.json is over 2 MB.`);
}

main().catch((e) => {
  console.error(`\nbuild-hazmat: ${e.message}`);
  process.exit(1);
});
