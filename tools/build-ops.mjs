#!/usr/bin/env node
/**
 * build-ops.mjs — turn 49 CFR Part 397 Subpart A into ops.json, the file the
 * On the Road module fetches at load.
 *
 *   node tools/build-ops.mjs
 *   node tools/build-ops.mjs --date 2026-07-22
 *   node tools/build-ops.mjs --xml cached.xml
 *
 * Part 397 is prose, not a table, which changes what the risk is. A misparsed
 * cell in a grid tends to look wrong; a paragraph that lost half its sentence
 * still reads like a regulation. So the text is captured verbatim, paragraph
 * by paragraph, and checked against anchor phrases before anything is written.
 * The app renders its own plain-language summaries beside this text, never
 * instead of it — a driver can always see the actual words.
 *
 * No dependencies; Node 18+. Writes ../ops.json and ./OPS-REPORT.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "ops.json");
const OUT_REPORT = path.join(HERE, "OPS-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49, PART = 397;

/** Shape version of the emitted file. `cfrDate` tracks the source text. */
const DATA_VERSION = "1.0.0";

/**
 * Subpart A, in order. Asserted exactly: a section appearing or disappearing
 * is the signal that the part was amended, and this module's whole decision
 * tree hangs off 397.5 and 397.7.
 */
const SUBPART_A = [
  { n: "397.1", key: "application" },
  { n: "397.2", key: "fmcsr" },
  { n: "397.3", key: "stateLocal" },
  { n: "397.5", key: "attendance" },
  { n: "397.7", key: "parking" },
  { n: "397.9", key: "reserved", reserved: true },
  { n: "397.11", key: "fires" },
  { n: "397.13", key: "smoking" },
  { n: "397.15", key: "fueling" },
  { n: "397.17", key: "tires" },
  { n: "397.19", key: "documents" },
];

/**
 * Phrases that must survive the parse. Every one of these carries a decision
 * the module makes, so losing one silently would be worse than failing loudly.
 */
const ANCHORS = {
  "397.1": ["must be marked or placarded in accordance with"],
  "397.5": [
    "must be attended at all times by its driver",
    "if all the following conditions exist",
    "in a safe haven",
    "is aware of the nature of the explosives",
    "unobstructed field of view",
    "other than Division 1.1, 1.2, or 1.3",
    "incident and necessary",
    "awake, and not in a sleeper berth",
    "specifically approved in writing by local, State, or Federal governmental authorities",
  ],
  "397.7": [
    "within 5 feet of the traveled portion",
    "including premises of fueling or eating facility",
    "knowledge and consent of the person who is in charge",
    "Within 300 feet of a bridge, tunnel, dwelling, or place where people work, congregate, or assemble",
    "brief periods when the necessities of operation require",
    "other than Division 1.1, 1.2, or 1.3 materials must not be parked",
  ],
  "397.11": ["within 300 feet of an open fire"],
  "397.13": ["within 25 feet of", "Class 1 materials, Class 5 materials"],
  "397.15": ["engine must not be operating", "in control of the fueling process"],
  "397.17": ["at the beginning of each trip and each time the vehicle is parked"],
  "397.19": ["A copy of the rules in this part", "must sign a receipt"],
};

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

function text(xml) {
  return decode(xml.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const fail = (msg) => { throw new Error(msg); };

/** Split the part into its DIV8 SECTION blocks, in document order. */
function sectionBlocks(xml) {
  const out = [];
  const re = /<DIV8\s+N="([^"]+)"\s+TYPE="SECTION"[\s\S]*?(?=<DIV8\s|<DIV6\s|<\/DIV5>|$)/g;
  let m;
  while ((m = re.exec(xml))) out.push({ n: m[1], xml: m[0] });
  return out;
}

/** Subpart headings, so the module can say what it does not cover. */
function subparts(xml) {
  const out = [];
  const re = /<DIV6\s+N="([^"]+)"\s+TYPE="SUBPART"[^>]*>\s*<HEAD>([\s\S]*?)<\/HEAD>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ id: m[1], head: text(m[2]) });
  return out;
}

/**
 * One section, as an ordered list of paragraphs with their designators.
 * `(a)`, `(b)(1)`, `(d)(2)(iii)` — the designator is what a cite points at,
 * so it is kept separate from the sentence rather than glued to the front.
 */
function parseSection(block) {
  const head = text((block.xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/) || [, ""])[1]);

  /* The CFR prints only the innermost designator on each line — 397.5(b)(1)
     appears as "(1)". The nesting has to be rebuilt or every cite the module
     shows would be ambiguous, since "(1)" occurs four times in that section
     alone. Depth is implied by the token: letter, then digit, then roman. */
  let path = [];
  const paras = (block.xml.match(/<P>[\s\S]*?<\/P>/g) || []).map((p) => {
    const t = text(p);
    const m = t.match(/^\(([0-9a-zA-Z]{1,4})\)\s*([\s\S]*)$/);
    if (!m) return { id: "", text: t };
    const tok = m[1];

    if (/^\d+$/.test(tok)) {
      path = [path[0], tok].filter(Boolean);                    // second level
    } else if (/^[ivx]+$/.test(tok) && path.length >= 2) {
      path = [path[0], path[1], tok];                           // third level;
      /* "(i)" is both a letter and a roman numeral — it is only the numeral
         when a digit level is already open, which is why depth is checked. */
    } else {
      path = [tok];                                             // first level
    }
    return { id: path.map((x) => `(${x})`).join(""), text: m[2] };
  }).filter((p) => p.text);

  return { head, paras };
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function build(xml, notes) {
  const blocks = sectionBlocks(xml);
  const inA = blocks.filter((b) => SUBPART_A.some((s) => s.n === b.n));

  /* the section set is the amendment tripwire */
  const got = inA.map((b) => b.n);
  const want = SUBPART_A.map((s) => s.n);
  const missing = want.filter((n) => !got.includes(n));
  const extra = blocks
    .filter((b) => /^397\.(1|2|3|5|7|9|1[0-9])$/.test(b.n) && !want.includes(b.n))
    .map((b) => b.n);
  if (missing.length || extra.length || got.join() !== want.join()) {
    fail(
      `Part 397 Subpart A is not the expected 11 sections.\n` +
      `  expected: ${want.join(", ")}\n` +
      `  found:    ${got.join(", ")}\n` +
      (missing.length ? `  missing:  ${missing.join(", ")}\n` : "") +
      (extra.length ? `  extra:    ${extra.join(", ")}\n` : "") +
      `  The part has been amended — re-read Subpart A before trusting this build.`
    );
  }

  const sections = inA.map((b) => {
    const meta = SUBPART_A.find((s) => s.n === b.n);
    const { head, paras } = parseSection(b);
    const body = paras.map((p) => `${p.id} ${p.text}`.trim()).join(" ");

    if (meta.reserved) {
      if (paras.length) notes.push(`${b.n} is marked [Reserved] here but returned ${paras.length} paragraph(s) — check the source.`);
    } else {
      if (!paras.length) fail(`${b.n} parsed to zero paragraphs`);
      for (const a of ANCHORS[b.n] || []) {
        if (!body.includes(a)) fail(`${b.n} is missing the anchor phrase "${a}" — the text did not survive the parse intact`);
      }
    }
    return { n: b.n, key: meta.key, head, ...(meta.reserved ? { reserved: true } : {}), paras };
  });

  return { sections, subparts: subparts(xml) };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function writeReport({ meta, sections, subs, notes, bytes }) {
  const md = `# ops.json generation report

Generated by \`tools/build-ops.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml?part=${PART}\` |
| Scope | Part ${PART} **Subpart A** only |
| Data version | ${meta.version} |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Sections captured | ${sections.length} |
| Paragraphs captured | ${sections.reduce((n, s) => n + s.paras.length, 0)} |
| ops.json size | ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB) |

## Checks

All must pass or the script throws and writes nothing.

| Check | Result |
|---|---|
| Subpart A is exactly the expected 11 sections, in order | pass |
| No unexpected 397.x section in the Subpart A range | pass |
| Every non-reserved section parsed at least one paragraph | pass |
| Anchor phrases present in every operative section | pass — ${Object.values(ANCHORS).flat().length} phrases |

The section-set check is the amendment tripwire. This module's entire decision
tree hangs off 397.5 and 397.7, so a section appearing or disappearing has to
stop the build rather than quietly change what a driver is told.

The anchor phrases are the second line. Prose is the dangerous case: a grid
cell that parses wrong usually looks wrong, but a paragraph that lost half its
sentence still reads like a regulation. Every anchor is a phrase the app makes
a decision on.

## Sections captured

| Section | Heading | Paragraphs |
|---|---|---|
${sections.map((s) => `| ${s.n} | ${s.head.replace(/^§\s*[\d.]+\s*/, "")} | ${s.reserved ? "_reserved_" : s.paras.length} |`).join("\n")}

## Anchor phrases, by section

${Object.entries(ANCHORS).map(([n, list]) => `**${n}**\n${list.map((a) => `- \`${a}\``).join("\n")}`).join("\n\n")}

## Out of scope

Captured as headings only, so the module can say they exist:

${subs.filter((s) => s.id !== "A").map((s) => `- **Subpart ${s.id}** — ${s.head.replace(/^Subpart\s+\w+—?/, "").trim() || "[Reserved]"}`).join("\n")}

Subparts C and D are routing and the national route registry; Subpart E is
preemption procedure. None is implemented.

${notes.length ? `## Notes\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : ""}
## Verbatim text

Reproduced here so the report can be diffed against the app and against eCFR
directly. Paragraph designators are stored separately from the sentence.

${sections.map((s) => `### ${s.head}\n\n${s.reserved ? "_[Reserved]_" : s.paras.map((p) => `${p.id ? `**${p.id}** ` : ""}${p.text}`).join("\n\n")}`).join("\n\n")}
`;
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

async function main() {
  const cached = arg("xml");
  let xml, cfrDate;

  if (cached) {
    xml = fs.readFileSync(cached, "utf8");
    cfrDate = arg("date") || "unknown (read from a cached file)";
    console.log(`reading ${cached}`);
  } else {
    cfrDate = arg("date") || (await latestDate());
    const url = `${API}/full/${cfrDate}/title-${TITLE}.xml?part=${PART}`;
    console.log(`fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`eCFR returned HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
    console.log(`  ${xml.length.toLocaleString()} bytes of XML`);
  }

  const notes = [];
  const { sections, subparts: subs } = build(xml, notes);
  console.log(`  Subpart A: ${sections.length} sections, ${sections.reduce((n, s) => n + s.paras.length, 0)} paragraphs`);
  console.log(`  section set matches the expected 11`);
  console.log(`  ${Object.values(ANCHORS).flat().length} anchor phrases present`);
  console.log(`  other subparts noted: ${subs.filter((s) => s.id !== "A").map((s) => s.id).join(", ")}`);
  notes.forEach((n) => console.log(`  note: ${n}`));

  const meta = {
    source: "49 CFR Part 397 Subpart A — Transportation of Hazardous Materials; Driving and Parking",
    version: DATA_VERSION,
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-ops.mjs",
    count: sections.length,
  };

  const head = Object.entries(meta).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const secs = sections.map((s) =>
    `  {${JSON.stringify("n")}: ${JSON.stringify(s.n)}, ${JSON.stringify("key")}: ${JSON.stringify(s.key)}, ` +
    `${JSON.stringify("head")}: ${JSON.stringify(s.head)}` +
    (s.reserved ? `, ${JSON.stringify("reserved")}: true` : "") +
    `,\n   ${JSON.stringify("paras")}: [\n${s.paras.map((p) => `    ${JSON.stringify(p)}`).join(",\n")}\n   ]}`
  ).join(",\n");
  const others = subs.filter((s) => s.id !== "A").map((s) => `  ${JSON.stringify(s)}`).join(",\n");

  fs.writeFileSync(OUT_JSON,
    `{\n${head.join(",\n")},\n "sections": [\n${secs}\n ],\n "otherSubparts": [\n${others}\n ]\n}\n`);

  const bytes = fs.statSync(OUT_JSON).size;
  writeReport({ meta, sections, subs, notes, bytes });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${bytes.toLocaleString()} bytes`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
}

main().catch((e) => {
  console.error(`\nbuild-ops: ${e.message}`);
  process.exit(1);
});
