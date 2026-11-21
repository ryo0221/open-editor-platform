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

/** Run-level errors of a Playwright JSON report (global setup, web servers, config). */
export function runErrors(report) {
  return (report.errors ?? []).map(
    (error) => String(error.message ?? error.value ?? JSON.stringify(error)).split('\n')[0],
  );
}

/**
 * Branch-only failures, failures on both sides, failures the branch fixed, and tests that
 * exist on one side only (`notOnBranch` means the branch run did not report them).
 */
export function compareStatuses(branch, base) {
  const failed = (status) => status === 'unexpected';
  const result = { branchOnly: [], both: [], fixed: [], notOnBase: [], notOnBranch: [] };
  for (const key of base.keys()) if (!branch.has(key)) result.notOnBranch.push(key);
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
  const reports = [branchFile, baseFile].map((file) => JSON.parse(readFileSync(file, 'utf8')));
  // A run that broke before or around its tests (a server that did not start, a config
  // error) says so in `errors`; its test list is incomplete and cannot be compared.
  const broken = reports.flatMap((report, index) =>
    runErrors(report).map((message) => `${[branchFile, baseFile][index]}: ${message}`),
  );
  if (broken.length) {
    console.error('Run-level errors; the reports cannot be compared:');
    for (const line of broken) console.error(`  ${line}`);
    return 1;
  }
  const result = compareStatuses(testStatuses(reports[0]), testStatuses(reports[1]));
  const section = (title, keys) => {
    console.log(`${title}: ${keys.length}`);
    for (const key of keys) console.log(`  ${key}`);
  };
  section('Fail on the branch only', result.branchOnly);
  section('Fail on the branch, test not on the base (new or renamed)', result.notOnBase);
  section('Fail on both (not caused by the branch)', result.both);
  section('Fail on the base only (fixed by the branch)', result.fixed);
  section(
    'On the base, not reported by the branch run (removed, renamed or not run)',
    result.notOnBranch,
  );
  return result.branchOnly.length + result.notOnBase.length + result.notOnBranch.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
