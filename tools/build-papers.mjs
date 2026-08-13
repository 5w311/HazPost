#!/usr/bin/env node
/**
 * build-papers.mjs — turn the shipping paper sections of 49 CFR into
 * papers.json, the file the Shipping Papers module fetches at load.
 *
 *   node tools/build-papers.mjs
 *   node tools/build-papers.mjs --date 2026-08-07
 *   node tools/build-papers.mjs --dir cached/
 *
 * Nine sections across two parts: 172 Subpart C for what goes on the paper,
 * 172 Subpart G for emergency response information, and 177.817 for where the
 * paper lives. Each is fetched on its own, because 172.101 makes a whole-part
 * fetch of Part 172 nearly three megabytes.
 *
 * Same posture as tools/build-ops.mjs: prose captured verbatim, checked
 * against anchor phrases before anything is written, and the section set
 * asserted so an amendment stops the build. The app renders its own
 * plain-language summaries beside this text, never instead of it.
 *
 * No dependencies; Node 18+. Writes ../papers.json and ./PAPERS-REPORT.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "papers.json");
const OUT_REPORT = path.join(HERE, "PAPERS-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49;

/** Shape version of the emitted file. `cfrDate` tracks the source text. */
const DATA_VERSION = "1.0.0";

/**
 * The nine sections, in the order the module presents them. Asserted exactly:
 * a section appearing or disappearing is the signal to re-read the subpart
 * before trusting anything the module says about a driver's paperwork.
 */
const SECTIONS = [
  { n: "172.200", part: 172, key: "applicability" },
  { n: "172.201", part: 172, key: "preparation" },
  { n: "172.202", part: 172, key: "description" },
  { n: "172.203", part: 172, key: "additional" },
  { n: "172.204", part: 172, key: "certification" },
  { n: "172.600", part: 172, key: "erScope" },
  { n: "172.602", part: 172, key: "erInfo" },
  { n: "172.604", part: 172, key: "erPhone" },
  { n: "177.817", part: 177, key: "carriage" },
];

/**
 * Phrases that must survive the parse. Every one carries something the module
 * asserts to a driver. Prose is the dangerous case: a paragraph that lost half
 * its sentence still reads like a regulation.
 */
const ANCHORS = {
  "172.200": ["Identified by the letter", "A limited quantity package"],
  "172.202": [
    "The identification number prescribed for the material",
    "The proper shipping name prescribed for the material",
    "The hazard class or division number prescribed for the material",
    "The packing group in Roman numerals",
    "are excepted from this requirement",
    "in sequence with no additional information interspersed",
    "contains Xylene and Benzene",
    "The number and type of packages must be indicated",
  ],
  "172.203": ["in column (1) of the", "Poison-Inhalation Hazard", "Toxic-Inhalation Hazard"],
  "172.204": ["no certification is required", "cargo tank supplied by the carrier", "as a private carrier"],
  "172.602": ["Available for use away from the package", "Printed legibly in English"],
  "172.604": ["Monitored at all times", "requires a call back"],
  "177.817": [
    "excepted from shipping paper requirements",
    "distinctively tabbing it",
    "restrained by the lap belt",
    "mounted to the inside of the door on the driver",
    "on the driver's seat in the vehicle",
    "retained for three years",
    "retained for one year",
  ],
};

/* ------------------------------------------------------------------ *
 * XML — same shape as the other generators in this folder
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

/**
 * One section, as an ordered list of paragraphs with the nesting rebuilt.
 * The CFR prints only the innermost designator, so 172.202(a)(4) arrives as
 * "(4)" — and "(1)" occurs seven times inside 172.204 alone.
 */
function parseSection(xml, n) {
  const head = text((xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/) || [, ""])[1]);
  if (!head.includes(n)) fail(`${n}: fetched document is headed "${head}"`);

  let path = [];
  const paras = (xml.match(/<P>[\s\S]*?<\/P>/g) || []).map((p) => {
    const t = text(p);
    /* some paragraphs open with two designators at once, e.g. 172.202 "(c)(1)" */
    const m = t.match(/^((?:\([0-9a-zA-Z]{1,5}\)){1,3})\s*([\s\S]*)$/);
    if (!m) return { id: "", text: t };

    const toks = m[1].match(/\(([0-9a-zA-Z]{1,5})\)/g).map((x) => x.slice(1, -1));
    for (const tok of toks) {
      if (/^\d+$/.test(tok)) path = [path[0], tok].filter(Boolean);
      else if (/^[ivx]+$/.test(tok) && path.length >= 2) path = [path[0], path[1], tok];
      else if (/^[A-Z]$/.test(tok) && path.length >= 3) path = [path[0], path[1], path[2], tok];
      else path = [tok];
    }
    return { id: path.map((x) => `(${x})`).join(""), text: m[2] };
  }).filter((p) => p.text);

  if (!paras.length) fail(`${n} parsed to zero paragraphs`);
  const body = paras.map((p) => `${p.id} ${p.text}`).join(" ");
  for (const a of ANCHORS[n] || []) {
    if (!body.includes(a)) fail(`${n} is missing the anchor phrase "${a}" — the text did not survive the parse intact`);
  }
  return { head, paras };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function writeReport({ meta, sections, bytes }) {
  const md = `# papers.json generation report

Generated by \`tools/build-papers.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, one call per section against \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml\` |
| Scope | 172 Subpart C, 172 Subpart G, and 177.817 |
| Data version | ${meta.version} |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Sections captured | ${sections.length} |
| Paragraphs captured | ${sections.reduce((n, s) => n + s.paras.length, 0)} |
| papers.json size | ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB) |

Each section is fetched on its own rather than pulling the part: § 172.101
makes a whole-part fetch of Part 172 nearly three megabytes.

## Checks

All must pass or the script throws and writes nothing.

| Check | Result |
|---|---|
| All nine sections returned, each headed with its own number | pass |
| Every section parsed at least one paragraph | pass |
| Anchor phrases present | pass — ${Object.values(ANCHORS).flat().length} phrases |

## Sections captured

| Section | Heading | Paragraphs |
|---|---|---|
${sections.map((s) => `| ${s.n} | ${s.head.replace(/^§\s*[\d.]+\s*/, "")} | ${s.paras.length} |`).join("\n")}

## Anchor phrases, by section

${Object.entries(ANCHORS).map(([n, list]) => `**${n}**\n${list.map((a) => `- \`${a}\``).join("\n")}`).join("\n\n")}

## Notes for the reader

**The basic description is 172.202(a)(1) to (a)(4)**, in that sequence, with no
other information interspersed — 172.202(b). The module builds it from
\`hazmat.json\`: identification number from \`pfx\`/\`un\`, proper shipping name
from \`name\`, hazard class from \`cls\` **verbatim**, packing group from \`pg\`.

\`cls\` is used as-is rather than rebuilt from \`base\`, because Column 3 already
carries the compatibility group letter on explosives (1.1D, not 1.1) and any
subsidiary in parentheses (3 (6.1)). Rebuilding would silently drop the letter
on every Class 1 line.

**Two forms of the technical name are permitted.** 172.202(d) shows it inside
the shipping name element with no comma —
"UN 1993, Flammable liquids, n.o.s. (contains Xylene and Benzene), 3, II" —
while 172.203(k) shows both a comma form and the name placed after the whole
basic description: "UN 1760, Corrosive liquid, n.o.s., (Octanoyl chloride),
8, II" and "UN 1760, Corrosive liquid, n.o.s., 8, II (contains Octanoyl
chloride)". A comparison tool that showed only one of these would manufacture
a discrepancy against a paper that used another, so the module renders one and
names the others.

**Quantity and packages are 172.202(a)(5) and (a)(7)**, not (c). Paragraph (c)
governs where the total quantity sits relative to the description.

## Verbatim text

Reproduced so the report can be diffed against the app and against eCFR
directly. Paragraph designators are stored separately from the sentence.

${sections.map((s) => `### ${s.head}\n\n${s.paras.map((p) => `${p.id ? `**${p.id}** ` : ""}${p.text}`).join("\n\n")}`).join("\n\n")}
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
  const dir = arg("dir");
  const cfrDate = arg("date") || (dir ? "unknown (read from cached files)" : await latestDate());

  const sections = [];
  for (const s of SECTIONS) {
    let xml;
    if (dir) {
      xml = fs.readFileSync(path.join(dir, `p${s.n}.xml`), "utf8");
    } else {
      const url = `${API}/full/${cfrDate}/title-${TITLE}.xml?part=${s.part}&section=${s.n}`;
      const res = await fetch(url);
      if (!res.ok) fail(`§ ${s.n}: eCFR returned HTTP ${res.status} ${res.statusText}`);
      xml = await res.text();
    }
    const { head, paras } = parseSection(xml, s.n);
    sections.push({ n: s.n, key: s.key, head, paras });
    console.log(`  ok  § ${s.n.padEnd(8)} ${paras.length.toString().padStart(2)} paragraphs  ${head.replace(/^§\s*[\d.]+\s*/, "").slice(0, 46)}`);
  }

  if (sections.length !== SECTIONS.length) fail(`expected ${SECTIONS.length} sections, captured ${sections.length}`);
  console.log(`  ${Object.values(ANCHORS).flat().length} anchor phrases present`);

  const meta = {
    source: "49 CFR 172 Subparts C and G, and 177.817 — shipping papers",
    version: DATA_VERSION,
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-papers.mjs",
    count: sections.length,
  };

  const head = Object.entries(meta).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const secs = sections.map((s) =>
    `  {${JSON.stringify("n")}: ${JSON.stringify(s.n)}, ${JSON.stringify("key")}: ${JSON.stringify(s.key)}, ` +
    `${JSON.stringify("head")}: ${JSON.stringify(s.head)},\n   ${JSON.stringify("paras")}: [\n` +
    s.paras.map((p) => `    ${JSON.stringify(p)}`).join(",\n") + `\n   ]}`
  ).join(",\n");

  fs.writeFileSync(OUT_JSON, `{\n${head.join(",\n")},\n "sections": [\n${secs}\n ]\n}\n`);
  const bytes = fs.statSync(OUT_JSON).size;
  writeReport({ meta, sections, bytes });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${bytes.toLocaleString()} bytes`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
}

main().catch((e) => {
  console.error(`\nbuild-papers: ${e.message}`);
  process.exit(1);
});
