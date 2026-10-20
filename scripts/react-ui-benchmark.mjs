import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { loadReactScaleApi } from './react-ui-scale-fixture.mjs';

const [
  mode = 'run',
  output = 'work/complete24/native',
  fixturePath = 'work/complete24/fixture.json',
] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const api = await loadReactScaleApi(output);
if (mode === 'prepare') {
  const document = api.createScaleDocument();
  assert.equal(document.nodes.length, 500);
  assert.equal(document.components.length, 21);
  assert.deepEqual(api.inspectReactUiDocument(document).diagnostics, []);
  await writeFile(fixturePath, api.serializeReactUiDocument(document));
  console.log(
    JSON.stringify({
      fixturePath,
      nodes: document.nodes.length,
      components: document.components.length,
    }),
  );
  process.exit(0);
}
if (mode !== 'run') throw Error('Expected prepare or run');
const bytes = await readFile(fixturePath);
const document = api.parseReactUiDocument(bytes.toString());
const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
const depth = (id) => 1 + Math.max(0, ...Object.values(nodeMap.get(id).slots).flat().map(depth));
assert.equal(document.nodes.length, 500);
assert.equal(document.components.length, 21);
assert.equal(Math.max(...document.roots.map(depth)), 4);
assert.equal(new Set(document.nodes.map((node) => node.component.componentId)).size, 21);
assert.deepEqual(api.inspectReactUiDocument(document).diagnostics, []);
const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
const metrics = [];
function measure(name, budgetMs, targetMs, setup, action, verify) {
  const samples = [];
  for (let index = 0; index < 25; index++) {
    const value = setup(index);
    const start = performance.now();
    const result = action(value, index);
    const ms = performance.now() - start;
    verify(result, index);
    samples.push(ms);
  }
  const sorted = samples.slice(5).sort((a, b) => a - b);
  metrics.push({
    name,
    budgetMs,
    targetMs,
    warmups: 5,
    samples,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: Math.max(...sorted),
  });
}
const session = () => new api.EditorSession(document);
const edit = (value) =>
  api.reactUiCommand([{ type: 'set-prop', nodeId: 'leaf-000', prop: 'text', value }]);
measure(
  'prop',
  100,
  50,
  session,
  (session, i) => session.executeView(edit(`Native ${i}`)),
  (value, i) =>
    assert.equal(value.nodes.find((n) => n.id === 'leaf-000').props.text, `Native ${i}`),
);
measure(
  'insert',
  100,
  50,
  session,
  (session) =>
    session.executeView(
      api.reactUiCommand([
        {
          type: 'insert',
          node: api.scaleNode('bench-new', api.scaleComponents[3]),
          parent: { nodeId: 'card-0', slotId: 'body' },
          beforeId: null,
        },
      ]),
    ),
  (value) => assert.equal(value.nodes.length, 501),
);
measure(
  'move',
  100,
  50,
  session,
  (session) =>
    session.executeView(
      api.reactUiCommand([
        {
          type: 'move',
          nodeId: 'leaf-001',
          parent: { nodeId: 'card-0', slotId: 'body' },
          beforeId: 'leaf-000',
        },
      ]),
    ),
  (value) => assert.equal(value.nodes.find((n) => n.id === 'card-0').slots.body[0], 'leaf-001'),
);
measure(
  'undo',
  100,
  50,
  () => {
    const current = session();
    current.executeView(edit('Undo me'));
    return current;
  },
  (current) => current.undo(),
  (value) => assert.deepEqual(value, document),
);
measure(
  'native-roundtrip',
  500,
  250,
  () => document,
  (value) => api.parseReactUiDocument(api.serializeReactUiDocument(value)),
  (value) => assert.deepEqual(value, document),
);
measure(
  'tsx-export',
  500,
  250,
  () => document,
  (value) => api.exportReactUi(value, api.scaleResolution),
  (bundle) => {
    assert.equal(Object.keys(bundle.files).length, 5);
    assert.match(bundle.files['Screen.tsx'], /@scale\/ui/);
  },
);
measure(
  'host-resolution',
  100,
  50,
  () => null,
  () => {
    const implementation = readFileSync('tests/fixtures/react-ui-scale/components.tsx', 'utf8');
    const css = readFileSync('tests/fixtures/react-ui-scale/styles.css', 'utf8');
    const image =
      'data:image/png;base64,' +
      readFileSync('tests/fixtures/office/images/quadrants.png').toString('base64');
    assert.equal(implementation, api.scaleSource.implementation);
    assert.equal(css, api.scaleSource.css);
    assert.equal(image, api.scaleSource.image);
    const expected = api.scaleEnvironment.dependencies.filter(
      (dependency) => dependency.kind !== 'provider',
    );
    for (const [index, source] of [implementation, css, image].entries())
      assert.equal(api.reuseHash(source), expected[index].hash);
    return api.prepareReactUiExport(document, api.scaleResolution);
  },
  (value) => assert.ok(value),
);
const report = {
  kind: 'native',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  measuredAt: new Date().toISOString(),
  fixtureSha256,
  shape: { nodes: 500, components: 21, depth: 4 },
  environment: {
    node: process.version,
    cpu: cpus()[0]?.model,
    visibleCpus: cpus().length,
    memoryBytes: totalmem(),
  },
  metrics,
};
await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exitCode = Number(metrics.some((metric) => metric.p95Ms > metric.budgetMs));
