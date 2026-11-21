import console from 'node:console';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Compare two Playwright JSON reports of the same specs: the branch under test and its
// base (main). Only failures that happen on the branch alone count against the change.
//
//   node scripts/e2e/compare.mjs work/e2e/branch.json work/e2e/main.json

/** Final status of every test in a Playwright JSON report, keyed by project, file and title. */
export function testStatuses(report) {
  const statuses = new Map();
  const visit = (suite, titles) => {
    const path = suite.title && !suite.title.endsWith('.ts') ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        statuses.set(
          [test.projectName, spec.file, ...path, spec.title].join(' › '),
          test.status, // expected | unexpected | flaky | skipped
        );
    for (const child of suite.suites ?? []) visit(child, path);
  };
  for (const suite of report.suites ?? []) visit(suite, []);
  return statuses;
}

/** Branch-only failures, failures on both sides and failures the branch fixed. */
export function compareStatuses(branch, base) {
  const failed = (status) => status === 'unexpected';
  const result = { branchOnly: [], both: [], fixed: [], notOnBase: [] };
  for (const [key, status] of branch) {
    if (!failed(status)) {
      if (failed(base.get(key))) result.fixed.push(key);
      continue;
    }
    if (!base.has(key)) result.notOnBase.push(key);
    else if (failed(base.get(key))) result.both.push(key);
    else result.branchOnly.push(key);
  }
  return result;
}

function main([branchFile, baseFile]) {
  if (!branchFile || !baseFile) {
    console.error('Usage: node scripts/e2e/compare.mjs <branch.json> <base.json>');
    return 2;
  }
  const read = (file) => testStatuses(JSON.parse(readFileSync(file, 'utf8')));
  const result = compareStatuses(read(branchFile), read(baseFile));
  const section = (title, keys) => {
    console.log(`${title}: ${keys.length}`);
    for (const key of keys) console.log(`  ${key}`);
  };
  section('Fail on the branch only', result.branchOnly);
  section('Fail on the branch, test not on the base (new or renamed)', result.notOnBase);
  section('Fail on both (not caused by the branch)', result.both);
  section('Fail on the base only (fixed by the branch)', result.fixed);
  return result.branchOnly.length + result.notOnBase.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
