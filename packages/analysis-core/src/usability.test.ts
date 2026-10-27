import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { analysisFixture } from './fixtures';
import { calculateRun, inspectAnalysisJoins } from './evaluate';
import { restoreAnalysisInputs } from './edit';
import { retainData } from './sources';
import { verifyAnalysis } from './commands';
it('restores input pins by stable ID, preserves current edits/history and rejects incompatible mappings', async () => {
  const doc = await analysisFixture();
  doc.runs = [await calculateRun(doc, 'good')];
  const native = structuredClone(doc.retainedSources[0].nativeContent) as {
    rows: { values: { qty: number } }[];
  };
  native.rows[0].values.qty = 5;
  const newer = await retainData(
    { ...doc.retainedSources[0].pin, versionId: 'v2', contentHash: await contentHash(native) },
    native,
    ['qty', 'price'],
  );
  doc.retainedSources.push(newer);
  doc.inputs[0].snapshotKey = newer.key;
  doc.title = 'Keep my edits';
  doc.parameters[0].value = '2';
  const before = JSON.stringify(doc),
    restored = restoreAnalysisInputs(doc, 'good');
  expect(JSON.stringify(doc)).toBe(before);
  expect(restored.inputs[0].snapshotKey).toBe(doc.runs[0].basis.inputs[0].snapshotKey);
  expect(restored.title).toBe('Keep my edits');
  expect(restored.parameters[0].value).toBe('2');
  expect(restored.runs).toEqual(doc.runs);
  expect(restored.retainedSources).toEqual(doc.retainedSources);
  await verifyAnalysis(restored);
  expect((await calculateRun(restored, 'again')).results['total-output'].rows[0].values.total).toBe(
    '160',
  );
  expect(() => restoreAnalysisInputs(doc, 'missing')).toThrow('missing-run');
  doc.inputs[0].id = 'renamed';
  expect(() => restoreAnalysisInputs(doc, 'good')).toThrow('missing-historical-input');
});
it('diagnoses duplicate, null and unmatched join keys without adopting partial results', async () => {
  const doc = await analysisFixture();
  doc.runs = [await calculateRun(doc, 'prior')];
  const native = {
    schemaVersion: 2,
    columns: [{ id: 'key', name: 'Key', type: 'number' }],
    rows: [
      { id: 'first', values: { key: 2 } },
      { id: 'duplicate', values: { key: 2 } },
      { id: 'empty', values: { key: null } },
    ],
  };
  const source = await retainData(
    {
      domain: 'data',
      artifactId: 'right',
      versionId: 'v1',
      contentHash: await contentHash(native),
    },
    native,
    ['key'],
  );
  doc.retainedSources.push(source);
  doc.inputs.push({
    id: 'right',
    name: 'Master',
    snapshotKey: source.key,
    selectedColumnIds: ['key'],
  });
  doc.steps.push({
    id: 'join',
    op: 'join',
    input: 'input',
    right: 'right',
    leftKey: 'qty',
    rightKey: 'key',
    mode: 'left',
    cardinality: 'many:1',
    columns: [],
  });
  const before = JSON.stringify(doc),
    report = inspectAnalysisJoins(doc);
  expect(report.error).toBe('duplicate-right-key');
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-key', key: '2', rowIds: ['first', 'duplicate'] }),
      expect.objectContaining({ code: 'null-key', key: null, rowIds: ['empty'] }),
      expect.objectContaining({ code: 'unmatched-key', key: '3', rowIds: ['b'] }),
    ]),
  );
  expect(JSON.stringify(doc)).toBe(before);
  expect(doc.runs[0].results['total-output'].rows[0].values.total).toBe('80');
});
it('pages and filters bounded diagnostics without losing later unmatched keys or changing content', async () => {
  const { joinInspectionFixture } = await import('./fixtures');
  const doc = await joinInspectionFixture(),
    before = JSON.stringify(doc);
  const first = inspectAnalysisJoins(doc);
  expect(first.total).toBe(203);
  expect(first.findings).toHaveLength(200);
  const second = inspectAnalysisJoins(doc, null, { offset: 200 });
  expect(second.findings).toHaveLength(3);
  expect(second.findings.slice(1).map((f) => f.code)).toEqual(['unmatched-key', 'unmatched-key']);
  const filtered = inspectAnalysisJoins(doc, null, { code: 'unmatched-key' });
  expect(filtered.total).toBe(2);
  expect(filtered.findings.map((f) => f.key)).toEqual(['2', '3']);
  expect(inspectAnalysisJoins(doc, null, { offset: 400 }).findings).toEqual([]);
  expect(() => inspectAnalysisJoins(doc, null, { offset: -1 })).toThrow(
    'invalid-inspection-options',
  );
  expect(() => inspectAnalysisJoins(doc, null, { offset: 0.5 })).toThrow(
    'invalid-inspection-options',
  );
  expect(JSON.stringify(doc)).toBe(before);
});
