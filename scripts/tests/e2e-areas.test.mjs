import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { classifySpecs, corePackages, engineeringPackages, workspaceGraph } from '../e2e/areas.mjs';
import { planRun } from '../e2e/affected.mjs';
import { compareStatuses, runErrors, testStatuses } from '../e2e/compare.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const specs = classifySpecs(root);
const graph = workspaceGraph(root);
const plan = (...changed) => planRun(changed, specs, graph);
const names = (list) => list.map((spec) => spec.name);

test('area lists name existing workspace packages', () => {
  for (const name of [...corePackages, ...engineeringPackages])
    assert(existsSync(new URL(`../../packages/${name}/package.json`, import.meta.url)), name);
});

test('every e2e spec has an area, known owners and a suite for extra servers', () => {
  assert(specs.length > 200);
  for (const spec of specs) {
    for (const owner of spec.owners) assert(graph.users.has(owner), `${spec.name}: ${owner}`);
    assert(spec.broad || spec.owners.length, `${spec.name} has no owners`);
    if (spec.heavy) assert.equal(spec.area, 'engineering', spec.name);
    if (spec.needs.length) assert(spec.suite, `${spec.name} opens ${spec.needs} without a suite`);
  }
});

test('an engineering change runs its own specs, not the office ones', () => {
  assert.deepEqual(names(plan('packages/pcb/src/index.ts').run), ['pcb-playground']);
  const cad = plan('packages/cad-core/src/index.ts');
  const run = names(cad.run);
  for (const name of ['cad-playground', 'simulation-playground', 'estimate-editor'])
    assert(run.includes(name), name);
  assert(!run.some((name) => /^(document|design|office|reuse|issue2)-/.test(name)), run.join());
  assert.deepEqual(cad.deferred, []);
});

test('an office change leaves engineering specs out', () => {
  const run = names(plan('packages/document/src/index.ts').run);
  assert(run.includes('document-performance') && run.includes('issue2-document'));
  assert(!run.some((name) => /^(cad|bim|pcb|simulation|gulliver|drawing)-/.test(name)), run.join());
});

test('a core change runs every light spec and leaves heavy specs to the full run', () => {
  const core = plan('packages/editor-core/src/index.ts');
  assert(names(core.run).includes('pcb-playground'));
  assert.deepEqual(names(core.deferred).sort(), names(specs.filter((spec) => spec.heavy)).sort());
});

test('specs, helpers, Playground sources, shared configuration and documents', () => {
  assert.deepEqual(names(plan('tests/e2e/v1.spec.ts').run), ['v1']);
  assert(plan('tests/e2e/fixtures.ts').run.length > 100);
  assert.deepEqual(names(plan('apps/playground/src/pcb/host.tsx').run), ['pcb-playground']);
  assert(names(plan('apps/playground/src/cad-host.tsx').run).includes('cad-playground'));
  const shared = plan('tests/playwright/suites.ts');
  assert.equal(shared.run.length + shared.deferred.length, specs.length);
  const app = plan('apps/playground/src/App.tsx');
  assert.equal(app.run.length, specs.filter((spec) => !spec.heavy).length);
  assert.deepEqual(plan('docs/README.md', 'apps/playground/src/model.test.ts').run, []);
});

test('Artifact Host sources reach the specs of the surface they mount', () => {
  assert(names(plan('apps/artifact-host/src/bim.tsx').run).includes('bim-hosts'));
  assert(names(plan('apps/artifact-host/src/estimate-bim.ts').run).includes('estimate-editor'));
  const shared = plan('apps/artifact-host/src/HostApp.tsx');
  assert(names(shared.run).includes('bim-hosts'));
  assert(names(shared.deferred).includes('cad-hosts'));
});

test('fixtures outside tests/e2e reach the specs that bundle or read them', () => {
  const spatial = names(plan('tests/fixtures/spatial/host.css').run).sort();
  assert.deepEqual(spatial, ['spatial-wasm', 'spatial-wasm-mobile']);
  assert(names(plan('scripts/fixtures/gulliver-people.ts').run).includes('gulliver-people'));
  // A fixture directory no tests/e2e spec names: every light spec, to be safe.
  const unknown = plan('tests/fixtures/react-ui-scale/x.ts');
  assert.equal(unknown.run.length, specs.filter((spec) => !spec.heavy).length);
});

test('Host Vite configurations and helper imports reach their specs', () => {
  const host = plan('vite.artifact-host.config.ts');
  assert(names(host.run).includes('bim-hosts') && names(host.deferred).includes('cad-hosts'));
  assert(names(plan('packages/templates/src/index.ts').run).includes('design-reuse-graphics'));
});

test('comparison counts only failures that happen on the branch alone', () => {
  const report = (statuses) => ({
    suites: [
      {
        title: 'a.spec.ts',
        specs: Object.entries(statuses).map(([title, status]) => ({
          title,
          file: 'a.spec.ts',
          tests: [{ projectName: 'desktop', status }],
        })),
      },
    ],
  });
  const result = compareStatuses(
    testStatuses(
      report({ one: 'unexpected', two: 'unexpected', three: 'expected', four: 'unexpected' }),
    ),
    testStatuses(report({ one: 'expected', two: 'unexpected', three: 'unexpected' })),
  );
  assert.deepEqual(result.branchOnly, ['desktop › a.spec.ts › one']);
  assert.deepEqual(result.both, ['desktop › a.spec.ts › two']);
  assert.deepEqual(result.fixed, ['desktop › a.spec.ts › three']);
  assert.deepEqual(result.notOnBase, ['desktop › a.spec.ts › four']);
  const partial = compareStatuses(
    testStatuses(report({ one: 'expected' })),
    testStatuses(report({ one: 'expected', two: 'expected' })),
  );
  assert.deepEqual(partial.notOnBranch, ['desktop › a.spec.ts › two']);
  assert.deepEqual(
    runErrors({ errors: [{ message: 'Process from config.webServer exited\nmore' }] }),
    ['Process from config.webServer exited'],
  );
});
