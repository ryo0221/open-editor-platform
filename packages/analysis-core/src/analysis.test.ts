import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { analysisFixture } from './fixtures';
import { calculateRun } from './evaluate';
import { assertAnalysis } from './validate';
import { replaceAnalysis, verifyAnalysis } from './commands';
import { runDiff } from './diff';
it('AN01/14 computes AF1 exactly and compares scenarios on identical source pins', async () => {
  const document = await analysisFixture();
  assertAnalysis(document);
  const a = await calculateRun(document, 'a', 'base'),
    b = await calculateRun(document, 'b', 'higher');
  expect(a.results['total-output'].rows[0].values.total).toBe('80');
  expect(b.results['total-output'].rows[0].values.total).toBe('88');
  expect(runDiff(a, b).find((d) => d.kind === 'value')?.delta).toBe('8');
  expect(a.basis.sources).toEqual(b.basis.sources);
});
it('AN12 rejects a forged result even if the attacker updates its hash', async () => {
  const document = await analysisFixture(),
    run = await calculateRun(document, 'run');
  run.results['total-output'].rows[0].values.total = '999';
  run.resultHash = await contentHash(run.results);
  await expect(verifyAnalysis({ ...document, runs: [run] })).rejects.toThrow('unverified-result');
});
it('AN03 rejects unknown properties and a cycle before evaluating rows', async () => {
  const document = await analysisFixture();
  expect(() => assertAnalysis({ ...document, verified: true })).toThrow(
    'unknown-or-missing-property',
  );
  document.steps[0].input = 'total';
  expect(() => assertAnalysis(document)).toThrow('cycle');
});
it('AN04/08 uses native Undo and rechecks permission at command execution', async () => {
  const doc = await analysisFixture(),
    next = { ...doc, title: 'Edited' };
  let editable = true;
  const guard = { canEdit: () => editable, canRead: () => true, inputsReady: () => true };
  const session = new EditorSession(doc),
    command = replaceAnalysis(doc, next, guard);
  editable = false;
  expect(() => session.execute(command)).toThrow('read-only');
  editable = true;
  session.execute(command);
  expect(session.content.title).toBe('Edited');
  session.undo();
  expect(session.content.title).toBe(doc.title);
});
it('AN13 rejects right duplicate keys and leaves unmatched/null rows in a left join', async () => {
  const document = await analysisFixture();
  const input = document.inputs[0];
  document.steps = [
    {
      id: 'join',
      op: 'join',
      input: input.id,
      right: input.id,
      leftKey: 'qty',
      rightKey: 'qty',
      mode: 'left',
      cardinality: 'many:1',
      columns: [
        {
          sourceId: 'price',
          field: {
            id: 'right-price',
            label: 'Right price',
            type: { kind: 'decimal', unit: 'dimensionless' },
          },
        },
      ],
    },
  ];
  document.outputs = [
    { id: 'joined', stepId: 'join', columns: ['qty', 'right-price'], presentation: 'table' },
  ];
  expect((await calculateRun(document, 'ok')).results.joined.rows).toHaveLength(2);
  const source = document.retainedSources[0];
  const native = source.nativeContent as { rows: { values: { qty: number } }[] };
  native.rows[1].values.qty = 2;
  const { retainData } = await import('./sources');
  const replacement = await retainData(
    { ...source.pin, contentHash: await contentHash(native) },
    native,
    ['qty', 'price'],
  );
  document.retainedSources = [replacement];
  document.inputs[0].snapshotKey = replacement.key;
  await expect(calculateRun(document, 'bad')).rejects.toThrow('duplicate-right-key');
});
it('AN03/06 validates every historical basis and rejects missing closure', async () => {
  const document = await analysisFixture();
  document.runs = [await calculateRun(document, 'past')];
  const bytes = JSON.stringify(document.runs[0]);
  await verifyAnalysis(JSON.parse(JSON.stringify(document)));
  expect(JSON.stringify(document.runs[0])).toBe(bytes);
  document.retainedSources = [];
  await expect(verifyAnalysis(document)).rejects.toThrow('missing-source');
});
it('AN15 explicit source mapping preserves analysis field identity and old run bytes', async () => {
  const document = await analysisFixture();
  document.runs = [await calculateRun(document, 'old')];
  const old = JSON.stringify(document.runs[0]),
    source = document.retainedSources[0];
  const native = {
    schemaVersion: 2,
    columns: [
      { id: 'quantity-v2', name: 'Renamed quantity', type: 'number' },
      { id: 'price', name: 'Price', type: 'number' },
    ],
    rows: [
      { id: 'a', values: { 'quantity-v2': 4, price: 10 } },
      { id: 'b', values: { 'quantity-v2': 3, price: 20 } },
    ],
  };
  const { retainData } = await import('./sources');
  const retained = await retainData(
    { ...source.pin, versionId: 'v2', contentHash: await contentHash(native) },
    native,
    ['quantity-v2', 'price'],
  );
  const next = {
    ...document,
    retainedSources: [...document.retainedSources, retained],
    inputs: [
      {
        ...document.inputs[0],
        snapshotKey: retained.key,
        selectedColumnIds: ['quantity-v2', 'price'],
        columnMapping: { 'quantity-v2': 'qty', price: 'price' },
      },
    ],
  };
  assertAnalysis(next);
  expect((await calculateRun(next, 'new')).results['total-output'].rows[0].values.total).toBe(
    '100',
  );
  await verifyAnalysis(next);
  expect(JSON.stringify(next.runs[0])).toBe(old);
});
it('AN03/07 enforces the five-run bound without pruning', async () => {
  const document = await analysisFixture(),
    run = await calculateRun(document, 'first');
  document.runs = Array.from({ length: 5 }, (_, i) => ({ ...run, id: `run-${i}` }));
  assertAnalysis(document);
  expect(() =>
    assertAnalysis({ ...document, runs: [...document.runs, { ...run, id: 'sixth' }] }),
  ).toThrow('collection-limit');
  expect(document.runs).toHaveLength(5);
});

it('AN04 duplicates owned field/output IDs and keeps native Undo exact', async () => {
  const { duplicateAnalysisStep, moveAnalysisStep } = await import('./edit');
  const doc = await analysisFixture(),
    next = duplicateAnalysisStep(doc, doc.steps[1].id);
  expect(next.steps.at(-1)?.id).not.toBe(doc.steps[1].id);
  expect(next.outputs.at(-1)?.id).not.toBe(doc.outputs[0].id);
  assertAnalysis(next);
  const moved = moveAnalysisStep(next, next.steps.at(-1)!.id, -1);
  expect(new Set(moved.steps.map((s) => s.id))).toEqual(new Set(next.steps.map((s) => s.id)));
  const session = new EditorSession(doc);
  session.execute(
    replaceAnalysis(doc, moved, {
      canEdit: () => true,
      canRead: () => true,
      inputsReady: () => true,
    }),
  );
  session.undo();
  expect(session.content).toEqual(doc);
  session.redo();
  expect(session.content).toEqual(moved);
});
it('AN11 exact static CSV/Data keeps decimal precision, null and empty text distinct', async () => {
  const { resultCsv, resultData } = await import('./export');
  const table = {
    fields: [
      { id: 'n', label: 'Number', type: { kind: 'decimal' as const, unit: 'dimensionless' } },
      { id: 't', label: 'Text', type: { kind: 'text' as const } },
    ],
    rows: [
      { id: 'a', values: { n: '9007199254740993', t: '=1+1' } },
      { id: 'b', values: { n: null, t: '' } },
    ],
    diagnostics: [],
  };
  const csv = resultCsv(table);
  expect(csv.csv).toContain(`"9007199254740993","'=1+1"`);
  expect(csv.csv).toContain(',""\r\n');
  expect(resultData(table).columns[0].type).toBe('text');
  expect(resultData(table).rows[0].values.n).toBe('9007199254740993');
  expect(table.rows[0].values.t).toBe('=1+1');
});
it('AN12 unknown engine is retained for viewing but never verified for formal output', async () => {
  const doc = await analysisFixture(),
    run = await calculateRun(doc, 'old');
  run.basis.engine = 'unknown-engine';
  run.basisHash = await contentHash(run.basis);
  doc.runs = [run];
  await expect(verifyAnalysis(doc)).rejects.toThrow('unsupported-engine');
  expect((await verifyAnalysis(doc, undefined, true)).runs).toEqual(doc.runs);
});
it('AN09 identical source bytes keep distinct Artifact/version identities and conflicting identities reject', async () => {
  const document = await analysisFixture(),
    first = document.retainedSources[0];
  const { retainData } = await import('./sources');
  const second = await retainData(
    { ...first.pin, artifactId: 'another-sales' },
    first.nativeContent,
    ['qty', 'price'],
  );
  expect(second.pin.contentHash).toBe(first.pin.contentHash);
  expect(second.key).not.toBe(first.key);
  document.retainedSources.push(second);
  assertAnalysis(document);
  const forged = structuredClone(first);
  forged.pin.contentHash = '0'.repeat(64);
  const { pinKey } = await import('@editor-platform/calculation-core');
  forged.key = pinKey(forged.pin);
  document.retainedSources.push(forged);
  expect(() => assertAnalysis(document)).toThrow('conflicting-source-pin');
});
it('AN14 a failed scenario cannot replace or rank the previous successful result', async () => {
  const document = await analysisFixture(),
    step = document.steps[0];
  if (step.op !== 'derive') throw Error('fixture');
  step.expression = {
    op: 'divide',
    left: { op: 'multiply', left: { op: 'field', id: 'qty' }, right: { op: 'field', id: 'price' } },
    right: { op: 'parameter', id: 'factor' },
    scale: 2,
    rounding: 'half-even',
  };
  document.scenarios[1].parameterValues.factor = '0';
  document.runs = [await calculateRun(document, 'good', 'base')];
  const before = JSON.stringify(document.runs);
  await expect(calculateRun(document, 'bad', 'higher')).rejects.toThrow('division-by-zero');
  expect(JSON.stringify(document.runs)).toBe(before);
  expect(document.runs[0].results['total-output'].rows[0].values.total).toBe('80');
});
