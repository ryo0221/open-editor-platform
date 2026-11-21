import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import {
  classifySpecs,
  corePackages,
  dependents,
  engineeringPackages,
  kindPackages,
  removedDependencies,
  workspaceGraph,
} from '../e2e/areas.mjs';
import { planCommands, planRun } from '../e2e/affected.mjs';
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
  // Fixture modules that build on another one (brobdingnag imports lilliput).
  const lilliput = plan('scripts/fixtures/gulliver-lilliput.ts');
  const reached = names([...lilliput.run, ...lilliput.deferred]);
  for (const name of [
    'gulliver-lilliput',
    'gulliver-brobdingnag',
    'gulliver-houyhnhnm',
    'gulliver-lagado',
  ])
    assert(reached.includes(name), name);
  // A fixture directory no tests/e2e spec names: every light spec, to be safe.
  const unknown = plan('tests/fixtures/react-ui-scale/x.ts');
  assert.equal(unknown.run.length, specs.filter((spec) => !spec.heavy).length);
});

test('Host Vite configurations and helper imports reach their specs', () => {
  const host = plan('vite.artifact-host.config.ts');
  assert(names(host.run).includes('bim-hosts') && names(host.deferred).includes('cad-hosts'));
  assert(names(plan('packages/templates/src/index.ts').run).includes('design-reuse-graphics'));
  // A helper another helper imports dynamically.
  const view = names(plan('tests/e2e/reuse-view-fixtures.ts').run);
  assert(view.includes('template-structure') && view.includes('template-structure-mobile'));
  // A literal dynamic import, and the packages a bundled fixture host mounts.
  assert(names(plan('packages/design/src/index.ts').run).includes('animation-2d'));
  const whiteboard = names(plan('packages/whiteboard/src/index.ts').run);
  assert(whiteboard.includes('spatial-wasm') && whiteboard.includes('spatial-wasm-mobile'));
});

test('Host-only specs go to E2E_SUITE=host; reference apps reach their surface specs', () => {
  for (const name of ['host-api', 'host-integration', 'authoring', 'novel-workspace']) {
    const spec = specs.find((entry) => entry.name === name);
    assert.equal(spec.suite, 'host', name);
    assert.deepEqual(spec.needs, [4177], name);
  }
  const commands = planCommands(planRun([], specs, graph, { all: true }));
  const host = commands.named.find((entry) => entry.suite === 'host');
  assert(host.files.includes('tests/e2e/host-api.spec.ts'));
  assert(!commands.dev.includes('tests/e2e/host-api.spec.ts'));
  const animation = names(plan('apps/animation-reference/src/main.tsx').run);
  for (const name of ['animation-2d', 'animation-connection', 'animation-layer-actions'])
    assert(animation.includes(name), name);
  assert(!animation.some((name) => /^(cad|bim|pcb)-/.test(name)), animation.join());
  assert(names(plan('apps/graph-reference/src/host.tsx').run).includes('structured-graph'));
});

const reached = (...changed) => {
  const result = plan(...changed);
  return new Set(names([...result.run, ...result.deferred]));
};
const packageChange = (name) => reached(`packages/${name}/src/index.ts`);

test('every kind a Host lists maps to its definition package', () => {
  for (const app of ['playground', 'artifact-host'])
    for (const area of ['office', 'engineering']) {
      const file = join(root, 'apps', app, 'src/kinds', `${area}.ts`);
      const text = readFileSync(file, 'utf8');
      for (const [, pkg] of text.matchAll(/@editor-platform\/([a-z0-9-]+)\/kind['"]/g)) {
        const kind = readFileSync(join(root, 'packages', pkg, 'src/kind.ts'), 'utf8');
        for (const [, name] of kind.matchAll(/^\s*kind: '([\w-]+)'/gm)) {
          assert(kindPackages[name], `${app} ${area}: no kindPackages entry for ${name}`);
          assert(kindPackages[name].includes(pkg), `kindPackages.${name} lacks ${pkg}`);
        }
      }
    }
  for (const list of Object.values(kindPackages))
    for (const name of list) assert(graph.users.has(name), name);
});

test('a Host kind file selects its kind, an area list the packages it lists', () => {
  const data = reached('apps/playground/src/kinds/office/data.tsx');
  assert(data.has('issue2-data') && !data.has('cad-playground'), [...data].join());
  assert(!data.has('document-performance'), 'data.tsx selects document specs');
  const review = reached('apps/playground/src/kinds/office/review.tsx');
  assert(
    review.has('review-viewer-pdf') || [...review].some((name) => /^review-viewer-/.test(name)),
  );
  assert(!review.has('cad-playground'), 'a core kind package stands for its own kind only');
  // Ryo's review (#46): the engineering list reaches Estimate through app/estimate-bim.ts.
  const engineering = reached('apps/playground/src/kinds/engineering.ts');
  for (const name of ['estimate-editor', 'cad-playground', 'bim-hosts', 'pcb-playground'])
    assert(engineering.has(name), name);
  const office = reached('apps/playground/src/kinds/office.ts');
  assert(office.has('document-performance') && office.has('fiction-map-r0'));
  assert(!office.has('pcb-playground'), 'the office list selects engineering specs');
  const host = reached('apps/artifact-host/src/kinds/office/surfaces.tsx');
  assert(host.has('estimate-editor') && host.has('host-integration'));
  assert(reached('apps/artifact-host/src/kinds/engineering/surfaces.tsx').has('bim-hosts'));
  assert.deepEqual([...reached('apps/playground/src/kinds/office/data.test.ts')], []);
  // Shared kinds files keep the Playground rule: every light spec.
  const shared = plan('apps/playground/src/kinds/surfaces.tsx');
  assert.equal(shared.run.length, specs.filter((spec) => !spec.heavy).length);
});

test('cut dependencies: the moved-to package selects both sides', () => {
  // KR2: character no longer uses animation-core for easing (video export still does).
  assert(!packageChange('animation-core').has('character-laputa-range'));
  const easing = packageChange('easing');
  for (const name of ['animation-2d', 'character-laputa-range', 'character-playground'])
    assert(easing.has(name), name);
  for (const name of ['estimate-engineering', 'cad-core', 'bim-core']) {
    const selected = packageChange(name);
    for (const spec of specs.filter((entry) => /^estimate-/.test(entry.name)))
      assert(selected.has(spec.name), `${name} -> ${spec.name}`);
  }
});

test('no package change selects fewer specs than stage 1, except through a cut dependency', () => {
  const stage1 = JSON.parse(readFileSync(join(root, 'scripts/tests/e2e-stage1-selection.json')));
  const current = new Set(names(specs));
  const unexplained = [];
  for (const [name, before] of Object.entries(stage1.packages)) {
    assert(graph.users.has(name), `${name} is gone: update the snapshot on purpose`);
    const now = packageChange(name);
    for (const spec of before.filter((entry) => current.has(entry) && !now.has(entry))) {
      // Allowed only where a listed cut explains it: the package reaches the cut dependency (or
      // is it), the spec stays on the user's side and the moved-to package still selects it.
      const cut = removedDependencies.find(
        (entry) =>
          dependents(graph, [name]).has(entry.from) &&
          packageChange(entry.user).has(spec) &&
          packageChange(entry.to).has(spec),
      );
      if (!cut) unexplained.push(`${name} -> ${spec}`);
    }
  }
  assert.deepEqual(unexplained, []);
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
