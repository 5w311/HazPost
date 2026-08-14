#!/usr/bin/env node
/**
 * The test suite.
 *
 *   node tools/test.mjs
 *
 * Runs every tools/test-*.mjs and fails if any of them does. There is no test
 * framework and no dependency to install — the app has none either, and a
 * suite that needs a package install is a suite that stops being run.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

const tests = readdirSync(HERE).filter((f) => /^test-.+\.mjs$/.test(f)).sort();
if (!tests.length) {
  console.error("no tools/test-*.mjs found");
  process.exit(1);
}

let failed = 0;
for (const t of tests) {
  const res = spawnSync(process.execPath, [join(HERE, t)], { stdio: "inherit" });
  if (res.status !== 0) failed++;
}

console.log(`${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
