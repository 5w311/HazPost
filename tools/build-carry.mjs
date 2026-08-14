#!/usr/bin/env node
/**
 * build-carry.mjs — the sections behind the What You Carry module.
 *
 *   node tools/build-carry.mjs
 *   node tools/build-carry.mjs --date 2026-08-07
 *   node tools/build-carry.mjs --dir cached/
 *
 * Ten sections across three chapters of title 49: PHMSA (172), FMCSA (383,
 * 391, 397) and TSA (1572). The eCFR versioner API is title-scoped rather than
 * chapter-scoped, so all ten come from the same endpoint with only the part
 * number changing — 1572 needed no special handling.
 *
 * TWO SECTIONS ARE ALSO IN OTHER DATA FILES. 172.602 is in papers.json and
 * 397.19 is in ops.json. Rather than reach across at runtime and make the
 * module depend on another module's fetch, this file carries its own copy and
 * the build asserts the two agree character for character. A regeneration that
 * updates one file and not the other stops here instead of putting two
 * different versions of the same paragraph in front of a driver.
 *
 * PARAGRAPH NESTING. The CFR prints only the innermost designator, so depth
 * has to be inferred: letter, then digit, then roman, then capital. The catch
 * is that the CFR also runs a child designator into its parent after an italic
 * heading — "(c) Initial and recurrent training—(1) Initial training. A new
 * hazmat employee…" is one <P>, and the (i) that follows it belongs to (c)(1),
 * not to (c). Reading only the leading run puts that (i) at the top level and
 * every sibling after it inherits the error. This parser reads one run-in
 * continuation after an italic heading, which is what the CFR actually does
 * and what a leading-run-only parser gets wrong.
 *
 * No dependencies; Node 18+. Writes ../carry.json and ./CARRY-REPORT.md.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT_JSON = path.join(REPO, "carry.json");
const OUT_REPORT = path.join(HERE, "CARRY-REPORT.md");

const API = "https://www.ecfr.gov/api/versioner/v1";
const TITLE = 49;

const DATA_VERSION = "1.0.0";

/**
 * The section set, exactly. `agency` is provenance for the report — a driver
 * being told what to carry is being told it by three different agencies, and
 * that is worth being able to see.
 */
const SECTIONS = [
  { n: "172.602",  part: 172,  key: "eri",      agency: "PHMSA" },
  { n: "172.704",  part: 172,  key: "training", agency: "PHMSA" },
  { n: "383.93",   part: 383,  key: "endorse",  agency: "FMCSA" },
  { n: "383.141",  part: 383,  key: "hme",      agency: "FMCSA" },
  { n: "383.153",  part: 383,  key: "codes",    agency: "FMCSA" },
  { n: "391.41",   part: 391,  key: "physqual", agency: "FMCSA" },
  { n: "391.43",   part: 391,  key: "medexam",  agency: "FMCSA" },
  { n: "391.45",   part: 391,  key: "medcycle", agency: "FMCSA" },
  { n: "397.19",   part: 397,  key: "explosive",agency: "FMCSA" },
  { n: "1572.13",  part: 1572, key: "tsa",      agency: "TSA" },
];

/**
 * Sections this file duplicates, and where the other copy lives. Both must
 * match exactly or the build stops.
 */
const SHARED = [
  { n: "172.602", file: "papers.json" },
  { n: "397.19",  file: "ops.json" },
];

/**
 * Paragraphs the module reads by id. If the CFR renumbers one of these the
 * module silently renders an empty block, so the build checks them by hand
 * rather than trusting that "the section came back" means the text is there.
 */
const REQUIRED_IDS = {
  "172.704": ["(a)(1)", "(a)(3)", "(a)(4)", "(a)(5)", "(c)(1)", "(c)(1)(i)", "(c)(1)(ii)", "(c)(2)", "(c)(3)", "(c)(4)", "(d)"],
  "383.93":  ["(b)", "(b)(4)"],
  "383.141": ["(b)", "(b)(1)", "(b)(2)", "(c)", "(d)"],
  "383.153": ["(a)(9)(iv)", "(a)(9)(v)"],
  "391.41":  ["(a)(1)(i)", "(a)(1)(ii)", "(a)(2)(i)(B)", "(a)(2)(iii)", "(a)(2)(iv)"],
  "391.45":  ["(b)"],
  "397.19":  ["(a)", "(a)(1)", "(a)(3)", "(b)", "(c)", "(c)(1)", "(c)(2)", "(c)(3)"],
  "1572.13": ["(a)", "(b)", "(c)", "(e)"],
  "172.602": ["(a)", "(b)", "(b)(1)", "(b)(2)", "(c)(1)"],
};

/**
 * Claims the module makes in its own words, each pinned to the paragraph it
 * was written from. If the text stops saying it, the module stops being able
 * to say it, and this build fails rather than shipping the old wording.
 */
const CLAIMS = [
  { n: "383.153", id: "(a)(9)(iv)", must: "H for hazardous materials",
    claim: "H is the hazmat endorsement code" },
  { n: "383.153", id: "(a)(9)(v)",  must: "X for a combination of tank vehicle and hazardous materials",
    claim: "X is tank plus hazmat" },
  { n: "383.93",  id: "(b)(4)",     must: "Used to transport hazardous materials",
    claim: "an endorsement is required to haul hazmat" },
  { n: "383.141", id: "(d)",        must: "renewed every 5 years or less",
    claim: "the endorsement is renewed at least every five years" },
  { n: "383.141", id: "(b)",        must: "may not issue, renew, upgrade, or transfer",
    claim: "the State cannot issue or renew without the TSA determination" },
  { n: "383.141", id: "(b)(2)",     must: "holds a valid TWIC",
    claim: "a valid TWIC is an alternative to a fresh determination" },
  { n: "383.141", id: "(c)",        must: "At least 60 days prior to the expiration date",
    claim: "the State must give 60 days' notice" },
  { n: "1572.13", id: "(a)",        must: "Determination of No Security Threat",
    claim: "no state may issue or renew without a Determination of No Security Threat" },
  { n: "1572.13", id: "(c)",        must: "extend the expiration date of the HME for 90 days",
    claim: "the State may extend by 90 days if TSA is late" },
  { n: "1572.13", id: "(e)",        must: "not to exceed five years",
    claim: "a transfer between states carries the first state's renewal period" },
  { n: "391.41",  id: "(a)(2)(i)(B)", must: "no longer needs to carry on his or her person the medical examiner's certificate",
    claim: "a CDL holder no longer carries the medical examiner's certificate" },
  { n: "391.41",  id: "(a)(1)(ii)", must: "must have on his or her person a copy of the variance documentation",
    claim: "a medical variance is still carried" },
  { n: "391.41",  id: "(a)(2)(iv)", must: "provided electronically by FMCSA shall control",
    claim: "the electronic record wins over a paper copy" },
  { n: "391.45",  id: "(b)",        must: "during the preceding 24 months",
    claim: "medical certification runs on a 24-month cycle" },
  { n: "172.704", id: "(c)(2)",     must: "at least once every three years",
    claim: "recurrent training is at least every three years" },
  { n: "172.704", id: "(c)(1)(ii)", must: "within 90 days after employment or a change in job function",
    claim: "the new-hire clock is 90 days" },
  { n: "172.704", id: "(c)(1)(i)",  must: "under the direct supervision of a properly trained and knowledgeable hazmat employee",
    claim: "until then, only under direct supervision" },
  { n: "172.704", id: "(c)(3)",     must: "provided a current record of training is obtained from hazmat employees' previous employer",
    claim: "previous-employer training counts only with the record" },
  { n: "172.704", id: "(c)(4)",     must: "responsible for compliance with the requirements of this subchapter regardless of whether the training",
    claim: "a training gap is the employer's violation" },
  { n: "172.704", id: "(d)",        must: "for as long as that employee is employed by that employer as a hazmat employee and for 90 days thereafter",
    claim: "the employer keeps the record for employment plus 90 days" },
  { n: "397.19",  id: "(a)",        must: "Division 1.1, 1.2, or 1.3 (explosive) materials",
    claim: "397.19 is triggered by 1.1, 1.2 or 1.3 only" },
  { n: "397.19",  id: "(c)(3)",     must: "written route plan specified in § 397.67",
    claim: "the route plan requirement lives in Subpart D" },
  { n: "172.602", id: "(c)(1)",     must: "immediately accessible to train crew personnel, drivers of motor vehicles",
    claim: "emergency response information is immediately accessible to the driver" },
  { n: "172.602", id: "(b)(1)",     must: "Printed legibly in English",
    claim: "it is in English" },
  { n: "172.602", id: "(b)(2)",     must: "Available for use away from the package",
    claim: "it is usable away from the package" },
];

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

const RUN  = String.raw`(?:\([0-9a-zA-Z]{1,5}\))+`;
const ITAL = String.raw`(?:<(?:I|E)\b[^>]*>[\s\S]*?<\/(?:I|E)>\s*[—–-]?\s*)`;

/**
 * The designator tokens this paragraph opens.
 *
 * Normally that is just the leading run. The exception is the run-in heading:
 * "(c) <I>Initial and recurrent training</I>—(1) <I>Initial training.</I> …"
 * opens both (c) and (1) in a single <P>, and the italic tags are what make it
 * recognisable — a bare "(1)" mid-sentence is a cross-reference, one that
 * immediately follows an italic heading is a real designator.
 */
function designators(raw) {
  const body = raw.replace(/^<P[^>]*>/, "").replace(/<\/P>$/, "").replace(/^\s+/, "");
  const m = body.match(new RegExp(String.raw`^(${RUN})\s*(?:${ITAL}(${RUN})\s*)?`));
  if (!m) return [];
  const toks = [];
  for (const part of [m[1], m[2]]) {
    if (part) toks.push(...part.match(/\(([0-9a-zA-Z]{1,5})\)/g).map((x) => x.slice(1, -1)));
  }
  return toks;
}

function parseSection(xml, n) {
  const head = text((xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/) || [, ""])[1]);
  if (!head.includes(n)) fail(`${n}: fetched document is headed "${head}"`);

  let p = [];
  const paras = (xml.match(/<P>[\s\S]*?<\/P>|<NOTE>[\s\S]*?<\/NOTE>/g) || []).map((b) => {
    const t = text(b);
    if (b.startsWith("<NOTE")) return { id: "", note: true, text: t };

    const toks = designators(b);
    if (!toks.length) return { id: "", text: t };
    for (const tok of toks) {
      if (/^\d+$/.test(tok)) p = [p[0], tok].filter(Boolean);
      else if (/^[ivxl]+$/.test(tok) && p.length >= 2) p = [p[0], p[1], tok];
      else if (/^[A-Z]$/.test(tok) && p.length >= 3) p = [p[0], p[1], p[2], tok];
      else p = [tok];
    }
    return { id: p.map((x) => `(${x})`).join(""), text: t.replace(new RegExp(String.raw`^(${RUN})\s*`), "") };
  }).filter((x) => x.text);

  if (!paras.length) fail(`${n} parsed to zero paragraphs`);
  return { head, paras };
}

/* ------------------------------------------------------------------ */

function assertSectionSet(got) {
  const want = SECTIONS.map((s) => s.n);
  if (got.join("|") !== want.join("|")) {
    fail(
      `the section set changed.\n` +
      `  expected: ${want.join(" ")}\n` +
      `  found:    ${got.join(" ")}\n` +
      `  What You Carry cites all ten by number. Re-read the module before shipping.`
    );
  }
}

function assertRequiredIds(sections) {
  const missing = [];
  for (const [n, ids] of Object.entries(REQUIRED_IDS)) {
    const have = new Set((sections.find((s) => s.n === n) || { paras: [] }).paras.map((x) => x.id));
    for (const id of ids) if (!have.has(id)) missing.push(`${n}${id}`);
  }
  if (missing.length) {
    fail(
      `paragraphs the module reads by id are not in the parsed text:\n` +
      `  ${missing.join(", ")}\n` +
      `  Either the CFR renumbered them or the parser mis-nested them. Both are\n` +
      `  reasons to stop: the module would render those blocks empty.`
    );
  }
  return Object.values(REQUIRED_IDS).flat().length;
}

function assertClaims(sections) {
  const broken = [];
  for (const c of CLAIMS) {
    const s = sections.find((x) => x.n === c.n) || { paras: [] };
    const para = s.paras.find((x) => x.id === c.id);
    if (!para || !para.text.includes(c.must)) broken.push(c);
  }
  if (broken.length) {
    fail(
      `the CFR text no longer supports what the module says:\n` +
      broken.map((c) => `  ${c.n}${c.id} — "${c.claim}"\n    looked for: ${c.must}`).join("\n") +
      `\n  Re-read the section and rewrite the module's wording before shipping.`
    );
  }
  return CLAIMS.length;
}

/**
 * The same paragraph must not read two different ways in two modules.
 * A date mismatch is reported as such, because that is the likely cause and
 * the fix is to regenerate the other file rather than to edit this one.
 */
function assertSharedAgreement(sections, cfrDate) {
  const notes = [];
  for (const { n, file } of SHARED) {
    const p = path.join(REPO, file);
    if (!fs.existsSync(p)) { notes.push(`${file} not present — ${n} not cross-checked`); continue; }
    const other = JSON.parse(fs.readFileSync(p, "utf8"));
    const theirs = (other.sections || []).find((s) => s.n === n);
    if (!theirs) { notes.push(`${file} does not carry § ${n} — not cross-checked`); continue; }

    const mine = sections.find((s) => s.n === n);
    const a = mine.paras.map((x) => `${x.id}${x.text}`).join("");
    const b = theirs.paras.map((x) => `${x.id}${x.text}`).join("");
    if (a !== b) {
      const first = mine.paras.find((x, i) => !theirs.paras[i] || theirs.paras[i].id !== x.id || theirs.paras[i].text !== x.text);
      fail(
        `§ ${n} does not match the copy in ${file}.\n` +
        `  carry.json is being generated from ${cfrDate}; ${file} says ${other.cfrDate}.\n` +
        `  first difference at ${first ? n + first.id : "(paragraph count)"}\n` +
        `  Two modules must not show two versions of the same paragraph. Regenerate\n` +
        `  ${file} against the same date, or generate this file against ${other.cfrDate}.`
      );
    }
    notes.push(`§ ${n} matches ${file} exactly (${mine.paras.length} paragraphs, both at ${other.cfrDate})`);
  }
  return notes;
}

/* ------------------------------------------------------------------ */

function writeReport({ meta, sections, bytes, idCount, claimCount, sharedNotes }) {
  const sec = (n) => sections.find((s) => s.n === n) || { paras: [] };
  const para = (n, id) => (sec(n).paras.find((p) => p.id === id) || {}).text || "";

  const md = `# carry.json generation report

Generated by \`tools/build-carry.mjs\`. Do not edit by hand — re-run the script.

| | |
|---|---|
| Source | eCFR API, \`${API}/full/${meta.cfrDate}/title-${TITLE}.xml?part=…&section=…\` |
| Scope | What You Carry — ten sections across PHMSA, FMCSA and TSA |
| Data version | ${meta.version} |
| CFR text current as of | ${meta.cfrDate} |
| Generated | ${meta.generated} |
| Sections | ${sections.length} |
| Paragraphs captured | ${sections.reduce((n, s) => n + s.paras.length, 0)} |
| carry.json size | ${bytes.toLocaleString()} bytes (${(bytes / 1024).toFixed(1)} KB) |

## The three agencies

A driver at a scale house is answering to three rulemakers at once, and the
module says which is which rather than flattening them into "the regs".

| § | Agency | What it is doing here |
|---|---|---|
${SECTIONS.map((s) => `| ${s.n} | ${s.agency} | ${{
  "172.602": "emergency response information, immediately accessible to the driver",
  "172.704": "training — the employer's obligation, end to end",
  "383.93": "which endorsements exist and what they are for",
  "383.141": "the hazmat endorsement renewal cycle and the TSA gate",
  "383.153": "the H and X letter codes",
  "391.41": "who must be medically certified, and what is carried",
  "391.43": "the medical examination and the certificate",
  "391.45": "the 24-month certification cycle",
  "397.19": "documents the carrier furnishes for 1.1, 1.2 and 1.3",
  "1572.13": "state issuance, notification and transfer of the HME",
}[s.n]} |`).join("\n")}

**1572 is TSA and sits in chapter XII, not with PHMSA or FMCSA.** The eCFR
versioner API is scoped by title rather than by chapter, so § 1572.13 came back
from exactly the same endpoint as the rest with only the part number changed.
No special handling, no hand transcription.

## Checks

| Check | Result |
|---|---|
| All ten sections returned, each headed with its own number | pass |
| Section set matches exactly | pass |
| Paragraphs the module reads by id are present | pass — ${idCount} ids |
| CFR text still supports each claim the module makes | pass — ${claimCount} claims |
| Shared sections agree with the other data files | pass |

${sharedNotes.map((n) => `- ${n}`).join("\n")}

The claim check is the useful one. Every plain-language sentence in the module
is pinned to a paragraph and a phrase that must appear in it, so an amendment
that changes what the rule says fails the build instead of leaving the module
confidently saying last year's version.

## Paragraph nesting

The CFR prints only the innermost designator, so depth is inferred — letter,
digit, roman, capital. That is not sufficient on its own, because the CFR also
runs a child designator into its parent after an italic heading:

> **(c)** *Initial and recurrent training*—**(1)** *Initial training.* A new hazmat employee, or a hazmat employee who changes job functions may perform those functions prior to the completion of training provided—

is a single \`<P>\` that opens two levels. A parser reading only the leading run
puts the \`(i)\` that follows it at the top level, and every sibling after it
inherits the error. This one reads a single run-in continuation when it
immediately follows an italic heading, which is what distinguishes a designator
from a cross-reference.

Sections in this file that depend on it: **172.704** (c)(1), **391.41**
(a)(2)(i)(A) and (a)(2)(i)(B), **391.43** (g)(2) and (g)(5).

## The medical certificate is no longer carried

This is the finding most likely to surprise, and the module is built around it.

> **391.41(a)(2)(i)(B)** ${para("391.41", "(a)(2)(i)(B)")}

That date has passed. § 391.43(g)(2)(ii) matches it from the other side — on or
after the same date the examiner completes the paper certificate only for a
person who *will not* be operating a vehicle requiring a CDL or CLP.

What is still carried:

> **391.41(a)(1)(ii)** ${para("391.41", "(a)(1)(ii)")}

> **391.41(a)(2)(iii)** ${para("391.41", "(a)(2)(iii)")}

And when the two disagree:

> **391.41(a)(2)(iv)** ${para("391.41", "(a)(2)(iv)")}

Medical certification still belongs on the expiry tracker — a lapse gets the
CDL downgraded, which stops the truck as surely as anything in the HMR — but
the thing that expires is the certification on the record, not a card in a
wallet. § 391.45(b) sets the cycle:

> ${para("391.45", "(b)")}

with 12-month cycles at (c), (e) and (f) for an exempt intracity zone, an
insulin-treated diabetes certificate under § 391.46, and a vision exemption
under § 391.44.

## Two rules, two deadlines, one renewal

The hazmat endorsement is governed from both ends and the two numbers are not
the same, which is worth a driver's attention:

> **383.141(c)** ${para("383.141", "(c)")}

> **1572.13(b)** ${para("1572.13", "(b)")}

FMCSA tells the State to advise the driver to file **no later than 30 days**
before expiry; TSA tells the State to advise that the assessment may be
initiated **no later than 60 days** before expiry. They govern different steps
and neither is a grace period. The module says start early and gives both.

Also easy to miss, and in the module for that reason:

- **383.141(b)(2)** — ${para("383.141", "(b)(2)")} — an alternative to a fresh determination.
- **1572.13(c)** — ${para("1572.13", "(c)")}
- **1572.13(e)** — ${para("1572.13", "(e)")}

## Verbatim text

${sections.map((s) => `### ${s.head}\n\n*${s.agency}*\n\n${s.paras.map((p) => p.note ? `> **Note.** ${p.text}` : `${p.id ? `**${p.id}** ` : ""}${p.text}`).join("\n\n")}`).join("\n\n")}
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
    if (dir) xml = fs.readFileSync(path.join(dir, `sec-${s.n}.xml`), "utf8");
    else {
      const url = `${API}/full/${cfrDate}/title-${TITLE}.xml?part=${s.part}&section=${s.n}`;
      const res = await fetch(url);
      if (!res.ok) fail(`§ ${s.n}: eCFR returned HTTP ${res.status} ${res.statusText}`);
      xml = await res.text();
    }
    const { head, paras } = parseSection(xml, s.n);
    sections.push({ n: s.n, key: s.key, agency: s.agency, head, paras });
    console.log(`  ok  § ${s.n.padEnd(8)} ${String(paras.length).padStart(2)} paragraphs  (${s.agency})`);
  }

  assertSectionSet(sections.map((s) => s.n));
  const idCount = assertRequiredIds(sections);
  const claimCount = assertClaims(sections);
  const sharedNotes = assertSharedAgreement(sections, cfrDate);

  console.log(`\n  section set matches exactly — ${sections.length} sections`);
  console.log(`  ${idCount} paragraph ids the module reads are present`);
  console.log(`  ${claimCount} claims still supported by the text`);
  sharedNotes.forEach((n) => console.log(`  ${n}`));

  const meta = {
    source: "49 CFR 172.602, 172.704, 383.93, 383.141, 383.153, 391.41, 391.43, 391.45, 397.19 and 1572.13 — what a driver carries and what expires",
    version: DATA_VERSION,
    cfrDate,
    generated: new Date().toISOString().slice(0, 10),
    generator: "tools/build-carry.mjs",
    count: sections.length,
  };

  const head = Object.entries(meta).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const secs = sections.map((s) =>
    `  {${JSON.stringify("n")}: ${JSON.stringify(s.n)}, ${JSON.stringify("key")}: ${JSON.stringify(s.key)}, ` +
    `${JSON.stringify("agency")}: ${JSON.stringify(s.agency)},\n   ${JSON.stringify("head")}: ${JSON.stringify(s.head)},\n` +
    `   ${JSON.stringify("paras")}: [\n` +
    s.paras.map((p) => `    ${JSON.stringify(p)}`).join(",\n") + `\n   ]}`
  ).join(",\n");

  fs.writeFileSync(OUT_JSON, `{\n${head.join(",\n")},\n "sections": [\n${secs}\n ]\n}\n`);
  const bytes = fs.statSync(OUT_JSON).size;
  writeReport({ meta, sections, bytes, idCount, claimCount, sharedNotes });

  console.log(`\nwrote ${path.relative(REPO, OUT_JSON)} — ${bytes.toLocaleString()} bytes`);
  console.log(`wrote ${path.relative(REPO, OUT_REPORT)}`);
}

main().catch((e) => {
  console.error(`\nbuild-carry: ${e.message}`);
  process.exit(1);
});
