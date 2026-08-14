#!/usr/bin/env node
/**
 * The test suite.
 *
 *   node tools/test.mjs
 *
 * Runs every tools/test-*.mjs and fails if any of them does. There is no test
 * framework and no dependency to install — the app has none either, and a
 * suite that needs a package install is a suite that stops being run.
 *
 * Each file reports its own check count through HAZPOST_TEST_TALLY rather than
 * having its output captured and parsed, so the runner can print a total
 * without swallowing the live output on the way.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

const tests = readdirSync(HERE).filter((f) => /^test-.+\.mjs$/.test(f) && f !== "test-harness.mjs").sort();
if (!tests.length) {
  console.error("no tools/test-*.mjs found");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "hazpost-tests-"));
const rows = [];
let failedFiles = 0;

for (const t of tests) {
  const tally = join(tmp, `${t}.tally`);
  writeFileSync(tally, "");
  const res = spawnSync(process.execPath, [join(HERE, t)], {
    stdio: "inherit",
    env: { ...process.env, HAZPOST_TEST_TALLY: tally },
  });

  let checks = 0, failures = 0;
  try {
    const raw = readFileSync(tally, "utf8").trim();
    if (raw) { const [c, f] = raw.split(/\s+/).map(Number); checks = c || 0; failures = f || 0; }
  } catch { /* the file died before it could report — the exit code still counts */ }
  try { unlinkSync(tally); } catch { /* ignore */ }

  const ok = res.status === 0;
  if (!ok) failedFiles++;
  rows.push({ file: t, checks, failures, ok });
}
rmSync(tmp, { recursive: true, force: true });

const width = Math.max(...rows.map((x) => x.file.length));
console.log("─".repeat(width + 26));
for (const x of rows) {
  const mark = x.ok ? "ok  " : "FAIL";
  const detail = x.checks ? `${String(x.checks).padStart(5)} checks` : "    — no report";
  console.log(`${mark}  ${x.file.padEnd(width)}  ${detail}${x.failures ? `  (${x.failures} failed)` : ""}`);
}
console.log("─".repeat(width + 26));

const total = rows.reduce((n, x) => n + x.checks, 0);
const totalFail = rows.reduce((n, x) => n + x.failures, 0);
console.log(
  `${rows.length - failedFiles}/${rows.length} files passed, ` +
  `${total.toLocaleString()} checks${totalFail ? `, ${totalFail} failed` : ""}`
);

process.exit(failedFiles ? 1 : 0);
