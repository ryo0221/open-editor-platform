import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { analysisFixture } from './fixtures';
import { calculateRun } from './evaluate';
import { retainData } from './sources';
import { assertAnalysis } from './validate';
import { runDiff } from './diff';
it('AN13 null keys never match; left preserves unmatched rows and 1:1 rejects repeated left keys', async () => {
  const doc = await analysisFixture();
  const left = {
    schemaVersion: 2,
    columns: [{ id: 'key', name: 'Key', type: 'text' }],
    rows: [
      { id: 'a', values: { key: 'x' } },
      { id: 'b', values: { key: 'x' } },
      { id: 'c', values: { key: null } },
      { id: 'd', values: { key: 'missing' } },
    ],
  };
  const right = {
    ...left,
    rows: [
      { id: 'r', values: { key: 'x' } },
      { id: 'null-right', values: { key: null } },
    ],
  };
  const inputs = await Promise.all(
    [left, right].map(async (native, i) =>
      retainData(
        {
          domain: 'data',
          artifactId: `data-${i}`,
          versionId: 'v1',
          contentHash: await contentHash(native),
        },
        native,
        ['key'],
      ),
    ),
  );
  doc.retainedSources = inputs;
  doc.inputs = inputs.map((source, i) => ({
    id: `input-${i}`,
    name: `Input ${i}`,
    snapshotKey: source.key,
    selectedColumnIds: ['key'],
  }));
  doc.steps = [
    {
      id: 'join',
      op: 'join',
      input: 'input-0',
      right: 'input-1',
      leftKey: 'key',
      rightKey: 'key',
      mode: 'left',
      cardinality: 'many:1',
      columns: [
        { sourceId: 'key', field: { id: 'right-key', label: 'Right', type: { kind: 'text' } } },
      ],
    },
  ];
  doc.outputs = [
    { id: 'joined', stepId: 'join', columns: ['key', 'right-key'], presentation: 'table' },
  ];
  const run = await calculateRun(doc, 'many');
  expect(run.results.joined.rows).toHaveLength(4);
  expect(run.results.joined.rows.map((r) => r.values['right-key'])).toEqual(['x', 'x', null, null]);
  expect(new Set(run.results.joined.rows.map((r) => r.id)).size).toBe(4);
  if (doc.steps[0].op !== 'join') throw Error('fixture');
  doc.steps[0].cardinality = '1:1';
  await expect(calculateRun(doc, 'one')).rejects.toThrow('duplicate-left-key');
});
it('AN14 scenario parameter omissions fail atomically; regrouped diffs do not pair by row position', async () => {
  const doc = await analysisFixture();
  const a = await calculateRun(doc, 'base');
  doc.scenarios[0].parameterValues = {};
  expect(() => assertAnalysis(doc)).toThrow();
  doc.scenarios[0].parameterValues = { factor: '1' };
  const group = doc.steps[1];
  if (group.op !== 'aggregate') throw Error('fixture');
  group.groupBy = ['qty'];
  const b = await calculateRun(doc, 'grouped');
  const changes = runDiff(a, b);
  expect(changes.some((c) => c.kind === 'regrouped')).toBe(true);
  expect(changes.some((c) => c.kind === 'value')).toBe(false);
});
it('AN02 derive errors identify step, stable row and field without producing a partial run', async () => {
  const doc = await analysisFixture(),
    step = doc.steps[0];
  if (step.op !== 'derive') throw Error('fixture');
  step.expression = {
    op: 'divide',
    left: { op: 'field', id: 'qty' },
    right: { op: 'literal', type: { kind: 'decimal', unit: 'dimensionless' }, value: '0' },
    scale: 2,
    rounding: 'half-even',
  };
  await expect(calculateRun(doc, 'bad')).rejects.toThrow('division-by-zero (revenue/a/revenue)');
  expect(doc.runs).toHaveLength(0);
});
