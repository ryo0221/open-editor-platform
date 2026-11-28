import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { classifySpecs, developmentSpecs } from '../e2e/areas.mjs';
import {
  cadCar,
  compareFailures,
  femMesherProblem,
  nightlyGroups,
  packageSuites,
  skippedSuites,
  suitePorts,
  summarizeReport,
} from '../e2e/nightly.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const groups = nightlyGroups(root);
const steps = Object.values(groups).flatMap((group) => group.steps);
const suitesSource = readFileSync(
  new URL('../../tests/playwright/suites.ts', import.meta.url),
  'utf8',
);

/** Suite entries of tests/playwright/suites.ts with their source text. */
function suiteEntries() {
  const entries = [...suitesSource.matchAll(/^ {2}'?([\w.-]+)'?: \(\) =>/gm)];
  return entries.map((entry, index) => ({
    name: entry[1],
    body: suitesSource.slice(entry.index, entries[index + 1]?.index ?? suitesSource.length),
  }));
}

test('every suite with specs outside tests/e2e runs at night or says why not', () => {
  const outside = suiteEntries().filter(
    ({ body }) =>
      /packagePreview\(/.test(body) ||
      [...body.matchAll(/testDir: '([^']+)'/g)].some((match) => match[1] !== './tests/e2e') ||
      /\.\.\.(?:scale|reactUiScale)\b/.test(body),
  );
  assert(outside.length > 10);
  for (const { name } of outside)
    assert(
      packageSuites.includes(name) || name in skippedSuites,
      `${name} is not in the nightly run`,
    );
  for (const name of packageSuites)
    assert(
      outside.some((entry) => entry.name === name),
      `${name} is not a package suite`,
    );
});

test('the groups run every development spec and every named suite once', () => {
  const suites = steps.map((step) => step.suite);
  assert.deepEqual(
    suites.filter((suite) => suite === 'office' || suite === 'engineering'),
    ['office', 'engineering'],
  );
  // Heavy development specs run by file across groups 2–4.
  const heavyFiles = developmentSpecs(classifySpecs(root))
    .filter((spec) => spec.heavy)
    .map((spec) => spec.file);
  const named = steps
    .filter((step) => step.suite === 'engineering-heavy')
    .flatMap((step) => step.args);
  for (const file of heavyFiles) assert(named.includes(file), `${file} is not in a group`);
  const once = steps
    .filter((step) => !['engineering-heavy'].includes(step.suite))
    .map((s) => s.name);
  assert.equal(new Set(once).size, once.length);
  for (const suite of ['host', 'cad.hosts', 'story-timeline', 'ci'])
    assert(suites.includes(suite), suite);
});

test('cad-playground splits into the whole car and the rest by title', () => {
  const titles = [
    ...readFileSync(
      new URL('../../tests/e2e/cad-playground.spec.ts', import.meta.url),
      'utf8',
    ).matchAll(/^test\(\s*'((?:[^'\\]|\\.)*)'/gm),
  ].map((match) => match[1]);
  const car = titles.filter((title) => new RegExp(cadCar).test(title));
  assert(car.length >= 5, car.join('\n'));
  for (const title of car) assert.match(title, /CR7[b-g]/);
  const rest = steps.find((step) => step.name === 'cad-playground-rest');
  assert.deepEqual(rest.args.slice(1), ['--grep-invert', cadCar]);
});

test('ports cover the development and Host servers', () => {
  const ports = suitePorts(root);
  for (const port of ['4173', '4175', '4176', '4177', '4180', '5173'])
    assert(ports.includes(port), port);
});

test('a report summary counts statuses and keys failures', () => {
  const report = {
    suites: [
      {
        title: 'a.spec.ts',
        specs: [
          {
            file: 'a.spec.ts',
            title: 'one',
            tests: [{ projectName: 'desktop', status: 'unexpected' }],
          },
          {
            file: 'a.spec.ts',
            title: 'two',
            tests: [{ projectName: 'desktop', status: 'expected' }],
          },
          {
            file: 'a.spec.ts',
            title: 'three',
            tests: [{ projectName: 'desktop', status: 'skipped' }],
          },
        ],
      },
    ],
    errors: [{ message: 'web server\nstack' }],
  };
  const summary = summarizeReport(report);
  assert.deepEqual(summary.counts, { expected: 1, unexpected: 1, flaky: 0, skipped: 1 });
  assert.deepEqual(summary.failures, ['desktop › a.spec.ts › one']);
  assert.deepEqual(summary.passed, ['desktop › a.spec.ts › two']);
  assert.deepEqual(summary.errors, ['web server']);
});

test('new and fixed failures count only tests that passed as fixed', () => {
  const result = compareFailures(['a', 'b'], ['b', 'c', 'd'], new Set(['a', 'b', 'c']));
  assert.deepEqual(result, { added: ['a'], fixed: ['c'] });
});

test('the mesher dist is served only when it holds the pinned build', () => {
  const dist = mkdtempSync(join(tmpdir(), 'fem-mesher-'));
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const spec = {
    js: 'fem-mesher.mjs',
    wasm: 'fem-mesher.wasm',
    jsSha256: sha('js'),
    wasmSha256: sha('wasm'),
  };
  assert.match(femMesherProblem(dist, spec), /fem-mesher\.mjs is missing/);
  writeFileSync(join(dist, 'fem-mesher.mjs'), 'js');
  assert.match(femMesherProblem(dist, spec), /fem-mesher\.wasm is missing/);
  writeFileSync(join(dist, 'fem-mesher.wasm'), 'other');
  assert.match(femMesherProblem(dist, spec), /fem-mesher\.wasm is not the pinned build/);
  writeFileSync(join(dist, 'fem-mesher.wasm'), 'wasm');
  assert.equal(femMesherProblem(dist, spec), undefined);
});
