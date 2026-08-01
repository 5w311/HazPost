#!/usr/bin/env node
/**
 * build-segregation.mjs — turn the 49 CFR 177.848 segregation tables into
 * segregation.json, the file the segregation module fetches at load.
 *
 *   node tools/build-segregation.mjs
 *   node tools/build-segregation.mjs --date 2026-07-22
 *   node tools/build-segregation.mjs --xml cached.xml
 *
 * Two tables come out of § 177.848:
 *
 *   paragraph (d)  the 18 x 18 segregation table
 *   paragraph (f)  the 13 x 13 Class 1 compatibility table
 *
 * Neither is transcribed. Both are parsed from the eCFR versioner API and
 * checked before anything is written — square, symmetric, and every cell a
 * legal marker. A hand-typed copy of an 18 x 18 grid is 324 chances to put a
 * driver next to the wrong load, and symmetry is the cheapest catch there is:
 * the table means the same thing read either way, so any parsing or column
 * alignment slip shows up as a mismatched pair.
 *
 * No dependencies; Node 18+. Writes ../segregation.json and
 * ./SEGREGATION-REPORT.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "segregation.json");
const OUT_REPORT = path.join(HERE, "SEGREGATION-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49, PART = 177, SECTION = "177.848";

/**
 * Shape version of the emitted file, surfaced in the app. Bump when the
 * structure or the category keys change — `cfrDate` tracks the source text
 * and moves on its own schedule.
 */
const DATA_VERSION = "1.0.0";

/* ------------------------------------------------------------------ *
 * The 18 categories, in table order.
 *
 * `key` is HazPost's stable identifier; `match` is asserted against the
 * division text the CFR table actually carries in that row, so a future
 * amendment that inserts or reorders a row aborts the build instead of
 * silently shifting every marker one column sideways.
 *
 * These are NOT the placard categories. They are narrower: 2.3 splits by
 * inhalation zone, 6.1 is one narrow row, Class 8 is liquids only.
 * ------------------------------------------------------------------ */
const CATEGORIES = [
  { key: "1.1-1.2", match: "1.1 and 1.2", label: "1.1/1.2", note: "A" },
  { key: "1.3", match: "1.3", label: "1.3" },
  { key: "1.4", match: "1.4", label: "1.4" },
  { key: "1.5", match: "1.5", label: "1.5", note: "A" },
  { key: "1.6", match: "1.6", label: "1.6" },
  { key: "2.1", match: "2.1", label: "2.1" },
  { key: "2.2", match: "2.2", label: "2.2" },
  { key: "2.3A", match: "2.3", label: "2.3A" },
  { key: "2.3B", match: "2.3", label: "2.3B" },
  { key: "3", match: "3", label: "3" },
  { key: "4.1", match: "4.1", label: "4.1" },
  { key: "4.2", match: "4.2", label: "4.2" },
  { key: "4.3", match: "4.3", label: "4.3" },
  { key: "5.1", match: "5.1", label: "5.1", note: "A" },
  { key: "5.2", match: "5.2", label: "5.2" },
  { key: "6.1I-A", match: "6.1", label: "6.1L" },
  { key: "7", match: "7", label: "7" },
  { key: "8L", match: "8", label: "8L" },
];

/** Column headers, as they should read once normalised. Asserted in order. */
const COLUMN_HEADS = [
  "1.1 1.2", "1.3", "1.4", "1.5", "1.6", "2.1", "2.2",
  "2.3 gas zone a", "2.3 gas zone b", "3", "4.1", "4.2", "4.3",
  "5.1", "5.2", "6.1 liquids pg i zone a", "7", "8 liquids only",
];

const SEG_MARKERS = ["X", "O", "*", ""];
const COMPAT_GROUPS = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "N", "S"];
/** Cells in paragraph (f): X, blank, or a reference to a numbered rule in (g). */
const COMPAT_CELL = /^(X|X\(\d\)|\d|\d\/\d)?$/;

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[e] ?? m;
  });
}

function cellText(xml) {
  return decode(xml.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every <TABLE> in the section, as arrays of rows of cell text. */
function parseTables(xml) {
  return (xml.match(/<TABLE[\s\S]*?<\/TABLE>/gi) || []).map((t) => {
    const caption = (t.match(/<CAPTION[\s\S]*?<\/CAPTION>/i) || [""])[0];
    const rows = (t.match(/<TR[\s>][\s\S]*?<\/TR>/gi) || []).map((tr) =>
      (tr.match(/<T[DH][\s>][\s\S]*?<\/T[DH]>/gi) || []).map(cellText)
    );
    return { caption: cellText(caption), rows: rows.filter((r) => r.length) };
  });
}

function findTable(tables, re, what) {
  const hit = tables.find((t) => re.test(t.caption));
  if (!hit) throw new Error(`could not find the ${what} in § ${SECTION}`);
  return hit;
}

/* ------------------------------------------------------------------ *
 * Checks. Any failure throws and nothing is written.
 * ------------------------------------------------------------------ */

const fail = (msg) => { throw new Error(msg); };

function assertSquare(grid, n, what) {
  if (grid.length !== n) fail(`${what}: expected ${n} rows, parsed ${grid.length}`);
  grid.forEach((row, i) => {
    if (row.length !== n) fail(`${what}: row ${i} has ${row.length} cells, expected ${n}`);
  });
}

/**
 * The table means the same thing read down or across, so grid[i][j] must equal
 * grid[j][i]. This is the check that catches a dropped cell or a misaligned
 * column, which is exactly the failure mode that matters here.
 */
function assertSymmetric(grid, labels, what) {
  const bad = [];
  for (let i = 0; i < grid.length; i++) {
    for (let j = i + 1; j < grid.length; j++) {
      if (grid[i][j] !== grid[j][i]) {
        bad.push(`${labels[i]} x ${labels[j]} = ${JSON.stringify(grid[i][j])} but ` +
                 `${labels[j]} x ${labels[i]} = ${JSON.stringify(grid[j][i])}`);
      }
    }
  }
  if (bad.length) fail(`${what} is not symmetric:\n  ` + bad.join("\n  "));
  return grid.length * (grid.length - 1) / 2;
}

function assertMarkers(grid, ok, labels, what) {
  const bad = [];
  grid.forEach((row, i) => row.forEach((c, j) => {
    const legal = Array.isArray(ok) ? ok.includes(c) : ok.test(c);
    if (!legal) bad.push(`${labels[i]} x ${labels[j]} = ${JSON.stringify(c)}`);
  }));
  if (bad.length) fail(`${what} has illegal cells:\n  ` + bad.join("\n  "));
}

/* ------------------------------------------------------------------ *
 * Paragraph (d) — the segregation table
 * ------------------------------------------------------------------ */

function buildSegregation(tables, notes) {
  const t = findTable(tables, /Segregation Table for Hazardous Materials/i, "segregation table");
  const [head, ...body] = t.rows;

  /* Header: "Class or division", a spillover cell, "Notes", then 18 columns. */
  const rawHeads = head.slice(3);
  if (rawHeads.length !== 18) fail(`segregation header has ${rawHeads.length} category columns, expected 18`);
  rawHeads.forEach((h, i) => {
    if (h.toLowerCase() !== COLUMN_HEADS[i]) {
      fail(`segregation column ${i} reads "${h}", expected "${COLUMN_HEADS[i]}" — ` +
           `the CFR table may have been amended; re-check the category list before trusting this build`);
    }
    /* the column header is the precise wording of the axis, e.g. "8 liquids
       only" — the row name alone loses the qualifier that makes it narrow */
    CATEGORIES[i].axis = h;
  });

  if (body.length !== 18) fail(`segregation table has ${body.length} data rows, expected 18`);

  const grid = [];
  body.forEach((row, i) => {
    if (row.length !== 21) fail(`segregation row ${i} has ${row.length} cells, expected 21`);
    const [name, division, note] = row;
    const cat = CATEGORIES[i];
    if (division !== cat.match) {
      fail(`segregation row ${i} is division "${division}", expected "${cat.match}" — rows may have been reordered`);
    }
    if ((note || "") !== (cat.note || "")) {
      notes.noteMismatch.push({ key: cat.key, cfr: note || "(none)", expected: cat.note || "(none)" });
    }
    cat.name = name;                 /* the CFR's own wording for the row */
    cat.division = division;
    grid.push(row.slice(3));
  });

  const labels = CATEGORIES.map((c) => c.key);
  assertSquare(grid, 18, "segregation table");
  assertMarkers(grid, SEG_MARKERS, labels, "segregation table");
  const pairs = assertSymmetric(grid, labels, "segregation table");

  return { grid, pairs };
}

/* ------------------------------------------------------------------ *
 * Paragraph (f) — Class 1 compatibility
 * ------------------------------------------------------------------ */

function buildCompat(tables) {
  const t = findTable(tables, /Compatibility Table For Class 1/i, "Class 1 compatibility table");
  const [head, ...body] = t.rows;

  const groups = head.slice(1);
  if (groups.join("") !== COMPAT_GROUPS.join("")) {
    fail(`compatibility groups read ${JSON.stringify(groups)}, expected ${JSON.stringify(COMPAT_GROUPS)}`);
  }
  if (body.length !== 13) fail(`compatibility table has ${body.length} data rows, expected 13`);

  const grid = [];
  body.forEach((row, i) => {
    if (row[0] !== COMPAT_GROUPS[i]) fail(`compatibility row ${i} is group "${row[0]}", expected "${COMPAT_GROUPS[i]}"`);
    grid.push(row.slice(1));
  });

  assertSquare(grid, 13, "compatibility table");
  assertMarkers(grid, COMPAT_CELL, COMPAT_GROUPS, "compatibility table");
  const pairs = assertSymmetric(grid, COMPAT_GROUPS, "compatibility table");

  return { grid, pairs };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function grid2md(grid, labels, heads) {
  const cell = (c) => (c === "" ? "·" : c);
  let out = "| |" + heads.join("|") + "|\n|" + "---|".repeat(heads.length + 1) + "\n";
  grid.forEach((row, i) => { out += `| **${labels[i]}** |` + row.map(cell).join("|") + "|\n"; });
  return out;
}

function writeReport({ meta, seg, compat, notes, bytes, spot }) {
  const counts = {};
  seg.grid.flat().forEach((c) => { counts[c || "(blank)"] = (counts[c || "(blank)"] || 0) + 1; });

  const md = `# segregation.json generation report

Generated by \`tools/build-segregation.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml?part=${PART}&section=${SECTION}\` |
| Data version | ${meta.version} |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Segregation table — 177.848(d) | 18 × 18, ${18 * 18} cells |
| Class 1 compatibility — 177.848(f) | 13 × 13, ${13 * 13} cells |
| segregation.json size | ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB) |

## Checks

All of these must pass or the script throws and writes nothing.

| Check | Result |
|---|---|
| Segregation table is 18 × 18 | pass |
| Segregation column headers match the expected 18, in order | pass |
| Segregation row divisions match the expected 18, in order | pass |
| Every segregation cell is \`X\`, \`O\`, \`*\` or blank | pass |
| **Segregation table is symmetric** | pass — ${seg.pairs} pairs checked |
| Compatibility table is 13 × 13 | pass |
| Compatibility groups are A B C D E F G H J K L N S | pass |
| Every compatibility cell is \`X\`, blank, or a rule reference | pass |
| Compatibility table is symmetric | pass — ${compat.pairs} pairs checked |

Symmetry is the check that earns its keep. The table means the same thing read
down or across, so a dropped cell or a column that slipped by one shows up
immediately as a mismatched pair rather than as a wrong answer on a trailer.

## Marker distribution — 177.848(d)

| Marker | Meaning | Cells |
|---|---|---|
| \`X\` | may not be loaded, transported or stored together | ${counts.X || 0} |
| \`O\` | may travel together only if separated so leaks cannot commingle | ${counts.O || 0} |
| \`*\` | both are Class 1 — the compatibility table in (f) governs | ${counts["*"] || 0} |
| blank | no restriction | ${counts["(blank)"] || 0} |

## Spot checks

Cells named in the task brief, read back out of the generated file.

| Pair | Expected | Generated |
|---|---|---|
${spot.map((s) => `| ${s.a} × ${s.b} | ${s.want || "blank"} | ${s.got || "blank"}${s.ok ? "" : " — **MISMATCH**"} |`).join("\n")}

## The 18 categories

These are the row and column axes of paragraph (d). They are narrower than the
placard categories in \`hazmat.json\` — 2.3 splits by inhalation zone, 6.1 is a
single narrow row, Class 8 covers liquids only — so the segregation module maps
load lines to these separately rather than reusing \`base\`.

| # | Key | CFR row | Note |
|---|---|---|---|
${CATEGORIES.map((c, i) => `| ${i} | \`${c.key}\` | ${c.name} — ${c.axis} | ${c.note || ""} |`).join("\n")}

Note A (177.848(e)(5)): notwithstanding an \`X\`, ammonium nitrate (UN1942) and
ammonium nitrate fertilizer may be loaded with Division 1.1 or 1.5 materials
unless § 177.835(c) prohibits it.

${notes.noteMismatch.length ? `**Note column mismatches:** ${notes.noteMismatch.map((n) => `\`${n.key}\` CFR says ${n.cfr}, expected ${n.expected}`).join("; ")}\n` : ""}
## Anything not in the table

A class or division absent from the 18 categories has no segregation
restriction at all. That includes Division 6.2, Class 9 and combustible
liquids. The module says so on screen rather than leaving a driver to wonder
whether it simply failed to check.

## Segregation table — 177.848(d)

${grid2md(seg.grid, CATEGORIES.map((c) => c.label), CATEGORIES.map((c) => c.label))}
## Class 1 compatibility — 177.848(f)

Numbered cells refer to the rules in 177.848(g), which this build does not
implement — the module presents this table as reference only.

${grid2md(compat.grid, COMPAT_GROUPS, COMPAT_GROUPS)}`;

  fs.writeFileSync(OUT_REPORT, md);
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

/** Cells the task brief calls out, verified against the generated grid. */
const SPOT = [
  ["8L", "4.2", "X"], ["8L", "5.1", "O"], ["3", "5.1", "O"],
  ["3", "6.1I-A", "X"], ["7", "2.1", "O"], ["2.2", "1.3", ""],
  ["4.1", "8L", "O"],
];

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

  const tables = parseTables(xml);
  console.log(`  ${tables.length} tables in the section`);

  const notes = { noteMismatch: [] };
  const seg = buildSegregation(tables, notes);
  console.log(`  segregation table 18x18 — square, symmetric (${seg.pairs} pairs), markers legal`);
  const compat = buildCompat(tables);
  console.log(`  compatibility table 13x13 — square, symmetric (${compat.pairs} pairs), cells legal`);

  const idx = (k) => CATEGORIES.findIndex((c) => c.key === k);
  const spot = SPOT.map(([a, b, want]) => {
    const got = seg.grid[idx(a)][idx(b)];
    return { a, b, want, got, ok: got === want };
  });
  spot.forEach((s) => console.log(`  ${s.ok ? "ok  " : "FAIL"} ${s.a} x ${s.b} = ${JSON.stringify(s.got)} (expected ${JSON.stringify(s.want)})`));
  const bad = spot.filter((s) => !s.ok);
  if (bad.length) throw new Error(`${bad.length} spot check(s) failed — nothing written`);

  const meta = {
    source: "49 CFR 177.848 — Segregation of hazardous materials",
    version: DATA_VERSION,
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-segregation.mjs",
    count: CATEGORIES.length,
  };

  const doc = {
    ...meta,
    markers: {
      X: "May not be loaded, transported or stored together in the same vehicle. No method of separation makes it legal.",
      O: "May travel together only if separated so that, if a package leaks under normal transport conditions, the contents could not commingle.",
      "*": "Both are Class 1. Segregation is governed by the compatibility table in 177.848(f), not this one.",
      "": "No restriction.",
    },
    categories: CATEGORIES.map(({ key, label, name, division, axis, note }) => ({
      key, label, name, division, axis, ...(note ? { note } : {}),
    })),
    table: seg.grid,
    compat: { groups: COMPAT_GROUPS, table: compat.grid },
  };

  /* One row per line so an amendment produces a diff a reviewer can read. */
  const head = Object.entries(doc).filter(([k]) => !["table", "compat", "categories"].includes(k))
    .map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const cats = doc.categories.map((c) => "  " + JSON.stringify(c)).join(",\n");
  const rows = doc.table.map((r) => "  " + JSON.stringify(r)).join(",\n");
  const crows = doc.compat.table.map((r) => "  " + JSON.stringify(r)).join(",\n");
  fs.writeFileSync(OUT_JSON,
    `{\n${head.join(",\n")},\n "categories": [\n${cats}\n ],\n "table": [\n${rows}\n ],\n` +
    ` "compat": {\n  "groups": ${JSON.stringify(COMPAT_GROUPS)},\n  "table": [\n${crows}\n  ]\n }\n}\n`);

  const bytes = fs.statSync(OUT_JSON).size;
  writeReport({ meta, seg, compat, notes, bytes, spot });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${bytes.toLocaleString()} bytes`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
}

main().catch((e) => {
  console.error(`\nbuild-segregation: ${e.message}`);
  process.exit(1);
});
