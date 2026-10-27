import { contentHash } from '@editor-platform/artifact-core';
import { createAnalysis, type AnalysisDocument } from './types';
import { retainData } from './sources';
export async function analysisFixture(): Promise<AnalysisDocument> {
  const native = {
    schemaVersion: 2,
    columns: [
      { id: 'qty', name: 'Quantity', type: 'number' },
      { id: 'price', name: 'Price', type: 'number' },
    ],
    rows: [
      { id: 'a', values: { qty: 2, price: 10 } },
      { id: 'b', values: { qty: 3, price: 20 } },
    ],
  };
  const source = await retainData(
    {
      artifactId: 'sales',
      domain: 'data',
      versionId: 'sales-v1',
      contentHash: await contentHash(native),
    },
    native,
    ['qty', 'price'],
  );
  const type = { kind: 'decimal', unit: 'dimensionless' } as const;
  return {
    ...createAnalysis(),
    retainedSources: [source],
    inputs: [
      { id: 'input', name: 'Sales', snapshotKey: source.key, selectedColumnIds: ['qty', 'price'] },
    ],
    parameters: [{ id: 'factor', label: 'Factor', type, value: '1' }],
    steps: [
      {
        id: 'revenue',
        op: 'derive',
        input: 'input',
        field: {
          id: 'revenue',
          label: 'Revenue',
          type: { kind: 'decimal', unit: 'dimensionless' },
        },
        expression: {
          op: 'multiply',
          left: {
            op: 'multiply',
            left: { op: 'field', id: 'qty' },
            right: { op: 'field', id: 'price' },
          },
          right: { op: 'parameter', id: 'factor' },
        },
      },
      {
        id: 'total',
        op: 'aggregate',
        input: 'revenue',
        groupBy: [],
        metrics: [
          {
            operation: 'sum',
            fieldId: 'revenue',
            field: {
              id: 'total',
              label: 'Total',
              type: { kind: 'decimal', unit: 'dimensionless' },
            },
          },
        ],
      },
    ],
    outputs: [{ id: 'total-output', stepId: 'total', columns: ['total'], presentation: 'table' }],
    scenarios: [
      { id: 'base', name: 'Base', parameterValues: { factor: '1' } },
      { id: 'higher', name: 'Higher', parameterValues: { factor: '1.1' } },
    ],
  };
}
/** More findings than one bounded page, with unmatched keys after the duplicates. */
export async function joinInspectionFixture(): Promise<AnalysisDocument> {
  const doc = await analysisFixture();
  const native = {
    schemaVersion: 2,
    columns: [{ id: 'key', name: 'Key', type: 'number' }],
    rows: Array.from({ length: 402 }, (_, i) => ({
      id: `master-${i}`,
      values: { key: 100 + Math.floor(i / 2) },
    })),
  };
  const source = await retainData(
    {
      domain: 'data',
      artifactId: 'master',
      versionId: 'v1',
      contentHash: await contentHash(native),
    },
    native,
    ['key'],
  );
  doc.retainedSources.push(source);
  doc.inputs.push({
    id: 'master',
    name: 'Master',
    snapshotKey: source.key,
    selectedColumnIds: ['key'],
  });
  doc.steps.push({
    id: 'join',
    op: 'join',
    input: 'input',
    right: 'master',
    leftKey: 'qty',
    rightKey: 'key',
    mode: 'left',
    cardinality: 'many:1',
    columns: [],
  });
  return doc;
}
