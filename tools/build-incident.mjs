#!/usr/bin/env node
/**
 * build-incident.mjs — turn 49 CFR 171.15 and 171.16 into incident.json.
 *
 *   node tools/build-incident.mjs
 *   node tools/build-incident.mjs --date 2026-08-07
 *   node tools/build-incident.mjs --dir cached/
 *
 * 171.15 is the immediate telephone notice; 171.16 is the detailed written
 * report, which is broader. The Incident Response module quotes both verbatim
 * and builds its trigger checklist directly from the captured paragraphs, so
 * the words a driver taps are the words the rule uses.
 *
 * The structural assertion here is stricter than in the other generators. The
 * exact paragraph tree under 171.15(b) must match, because a new reportable
 * incident appearing in that list is precisely the amendment this module must
 * not miss — a checklist quietly one trigger short is worse than no checklist.
 *
 * No dependencies; Node 18+. Writes ../incident.json and ./INCIDENT-REPORT.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "incident.json");
const OUT_REPORT = path.join(HERE, "INCIDENT-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49, PART = 171;

const DATA_VERSION = "1.0.0";

const SECTIONS = [
  { n: "171.15", key: "notice" },
  { n: "171.16", key: "written" },
];

/**
 * The paragraph tree under 171.15(b), exactly. Not a subset check — an
 * addition fails just as loudly as a removal.
 */
const B_STRUCTURE = [
  "(b)", "(b)(1)",
  "(b)(1)(i)", "(b)(1)(ii)", "(b)(1)(iii)", "(b)(1)(iv)", "(b)(1)(v)",
  "(b)(2)", "(b)(3)", "(b)(4)", "(b)(5)", "(b)(6)",
];

/** Phrases that must survive the parse. */
const ANCHORS = {
  "171.15": [
    "no later than 12 hours",
    "800-424-8802",
    "during the course of transportation in commerce (including loading, unloading, and temporary storage)",
    "A person is killed",
    "an injury requiring admittance to a hospital",
    "evacuated for one hour or more",
    "closed or shut down for one hour or more",
    "in the judgment of the person in possession of the hazardous material",
    "a continuing danger to life exists at the scene",
    "must also make the report required by",
  ],
  "171.16": [
    "within 30 days of discovery",
    "Any of the circumstances set forth in",
    "An unintentional release of a hazardous material or the discharge of any quantity of hazardous waste",
    "1,000 gallons or greater",
    "An undeclared hazardous material is discovered",
    "Unless a telephone report is required",
  ],
};

/* ------------------------------------------------------------------ */

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
 * Paragraphs in document order with the nesting rebuilt, plus any <NOTE>.
 * The note under 171.15 carries the EPA reportable-quantity cross-reference,
 * which is a separate duty with a separate trigger — dropping it because it is
 * not a <P> would lose a rule that bites where 171.15 does not.
 */
function parseSection(xml, n) {
  const head = text((xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/) || [, ""])[1]);
  if (!head.includes(n)) fail(`${n}: fetched document is headed "${head}"`);

  let p = [];
  const blocks = xml.match(/<P>[\s\S]*?<\/P>|<NOTE>[\s\S]*?<\/NOTE>/g) || [];
  const paras = blocks.map((b) => {
    const isNote = b.startsWith("<NOTE");
    const t = text(b);
    if (isNote) return { id: "", note: true, text: t };

    const m = t.match(/^((?:\([0-9a-zA-Z]{1,5}\)){1,3})\s*([\s\S]*)$/);
    if (!m) return { id: "", text: t };
    for (const tok of m[1].match(/\(([0-9a-zA-Z]{1,5})\)/g).map((x) => x.slice(1, -1))) {
      if (/^\d+$/.test(tok)) p = [p[0], tok].filter(Boolean);
      else if (/^[ivx]+$/.test(tok) && p.length >= 2) p = [p[0], p[1], tok];
      else if (/^[A-Z]$/.test(tok) && p.length >= 3) p = [p[0], p[1], p[2], tok];
      else p = [tok];
    }
    return { id: p.map((x) => `(${x})`).join(""), text: m[2] };
  }).filter((x) => x.text);

  if (!paras.length) fail(`${n} parsed to zero paragraphs`);
  const body = paras.map((x) => `${x.id} ${x.text}`).join(" ");
  for (const a of ANCHORS[n] || []) {
    if (!body.includes(a)) fail(`${n} is missing the anchor phrase "${a}" — the text did not survive the parse intact`);
  }
  return { head, paras };
}

/**
 * The reason this generator exists. If the reportable-incident list has
 * changed shape, the module's checklist is wrong and the build must stop.
 */
function assertTriggerStructure(paras) {
  const got = paras.filter((x) => x.id.startsWith("(b)")).map((x) => x.id);
  if (got.join("|") !== B_STRUCTURE.join("|")) {
    fail(
      `171.15(b) does not have the expected paragraph structure.\n` +
      `  expected: ${B_STRUCTURE.join(" ")}\n` +
      `  found:    ${got.join(" ")}\n` +
      `  A reportable incident has been added, removed or renumbered. The driver\n` +
      `  checklist is built from this list — re-read 171.15(b) before shipping.`
    );
  }
  return got.length;
}

/* ------------------------------------------------------------------ */

function writeReport({ meta, sections, bytes, triggerCount }) {
  const s15 = sections.find((s) => s.n === "171.15");
  const s16 = sections.find((s) => s.n === "171.16");
  const para = (s, id) => (s.paras.find((p) => p.id === id) || {}).text || "";

  const md = `# incident.json generation report

Generated by \`tools/build-incident.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml?part=${PART}&section=…\` |
| Scope | § 171.15 immediate notice, § 171.16 detailed written report |
| Data version | ${meta.version} |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Paragraphs captured | ${sections.reduce((n, s) => n + s.paras.length, 0)} |
| incident.json size | ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB) |

## Checks

| Check | Result |
|---|---|
| Both sections returned, each headed with its own number | pass |
| **171.15(b) paragraph tree matches exactly** | pass — ${triggerCount} paragraphs |
| \`<NOTE>\` under 171.15 captured | ${s15.paras.some((p) => p.note) ? "pass" : "**missing**"} |
| Anchor phrases present | pass — ${Object.values(ANCHORS).flat().length} phrases |

The structural check on 171.15(b) is stricter than a subset match: an addition
fails as loudly as a removal. The module's trigger checklist is built from this
list, and a checklist quietly one trigger short is worse than no checklist.

## The reportable incidents — 171.15(b)

Stem: *${para(s15, "(b)")}*

| ¶ | Trigger | In the driver checklist |
|---|---|---|
${B_STRUCTURE.filter((id) => id !== "(b)").map((id) => {
  const t = para(s15, id);
  const inList = /^\(b\)\(1\)\(/.test(id) || ["(b)(2)", "(b)(3)", "(b)(4)"].includes(id);
  const why = id === "(b)(1)" ? "stem, shown above the five" :
    id === "(b)(5)" ? "**no** — this is the judgment trigger, always on" :
    id === "(b)(6)" ? "**no** — aircraft only, named in the reference text" : "yes";
  return `| ${id} | ${t.slice(0, 96)}${t.length > 96 ? "…" : ""} | ${inList ? "yes" : why} |`;
}).join("\n")}

**(b)(5) is why this module cannot return an all clear.** Notice is required
when, in the judgment of the person in possession, a situation should be
reported *even though it meets none of the other criteria*. No checklist can
compute the absence of that. The module may confirm a duty exists; it may never
confirm one does not.

## The written report is broader — 171.16(a)

${["(a)(1)", "(a)(2)", "(a)(3)", "(a)(4)", "(a)(5)"].map((id) => `- **${id}** ${para(s16, id)}`).join("\n")}

Only (a)(1) overlaps the telephone notice. The rest generate a Form 5800.1
with no phone call ever having been required.

## …and 171.16(d) carves back out

${para(s16, "(d)")}

These exceptions are conditional and compound — package capacity, quantity
released, packing group of the actual shipment. HazPost has none of those
facts, so the module presents 171.16(d) verbatim rather than computing whether
it applies.

## Verbatim text

${sections.map((s) => `### ${s.head}\n\n${s.paras.map((p) => p.note ? `> **Note.** ${p.text}` : `${p.id ? `**${p.id}** ` : ""}${p.text}`).join("\n\n")}`).join("\n\n")}
`;
  fs.writeFileSync(OUT_REPORT, md);
}

/* ------------------------------------------------------------------ */

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
    if (dir) xml = fs.readFileSync(path.join(dir, `i${s.n}.xml`), "utf8");
    else {
      const url = `${API}/full/${cfrDate}/title-${TITLE}.xml?part=${PART}&section=${s.n}`;
      const res = await fetch(url);
      if (!res.ok) fail(`§ ${s.n}: eCFR returned HTTP ${res.status} ${res.statusText}`);
      xml = await res.text();
    }
    const { head, paras } = parseSection(xml, s.n);
    sections.push({ n: s.n, key: s.key, head, paras });
    console.log(`  ok  § ${s.n}  ${paras.length} paragraphs${paras.some((p) => p.note) ? " (incl. note)" : ""}`);
  }

  const triggerCount = assertTriggerStructure(sections.find((s) => s.n === "171.15").paras);
  console.log(`  171.15(b) structure matches exactly — ${triggerCount} paragraphs`);
  console.log(`  ${Object.values(ANCHORS).flat().length} anchor phrases present`);

  const meta = {
    source: "49 CFR 171.15 and 171.16 — hazardous materials incident reporting",
    version: DATA_VERSION,
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-incident.mjs",
    count: sections.length,
    nrc: { tollFree: "800-424-8802", toll: "202-267-2675" },
  };

  const head = Object.entries(meta).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const secs = sections.map((s) =>
    `  {${JSON.stringify("n")}: ${JSON.stringify(s.n)}, ${JSON.stringify("key")}: ${JSON.stringify(s.key)}, ` +
    `${JSON.stringify("head")}: ${JSON.stringify(s.head)},\n   ${JSON.stringify("paras")}: [\n` +
    s.paras.map((p) => `    ${JSON.stringify(p)}`).join(",\n") + `\n   ]}`
  ).join(",\n");

  fs.writeFileSync(OUT_JSON, `{\n${head.join(",\n")},\n "sections": [\n${secs}\n ]\n}\n`);
  const bytes = fs.statSync(OUT_JSON).size;
  writeReport({ meta, sections, bytes, triggerCount });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${bytes.toLocaleString()} bytes`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
}

main().catch((e) => {
  console.error(`\nbuild-incident: ${e.message}`);
  process.exit(1);
});
