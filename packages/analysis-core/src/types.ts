import type {
  SourcePin,
  ScalarType,
  ScalarValue,
  Expression,
  Rounding,
} from '@editor-platform/calculation-core';
export interface Field {
  id: string;
  label: string;
  type: ScalarType;
}
export interface Row {
  id: string;
  values: Record<string, ScalarValue>;
}
export interface Table {
  fields: Field[];
  rows: Row[];
  diagnostics: { code: string; count: number }[];
}
export interface RetainedSource {
  key: string;
  pin: SourcePin;
  nativeContent: unknown;
  dependencies: string[];
  table: Table;
}
export interface Input {
  id: string;
  name: string;
  snapshotKey: string;
  selectedColumnIds: string[];
  columnMapping?: Record<string, string>;
}
export interface Parameter extends Field {
  value: ScalarValue;
}
export type Step =
  | { id: string; op: 'select'; input: string; columns: { sourceId: string; field: Field }[] }
  | { id: string; op: 'filter'; input: string; expression: Expression }
  | { id: string; op: 'derive'; input: string; field: Field; expression: Expression }
  | {
      id: string;
      op: 'sort';
      input: string;
      keys: { fieldId: string; direction: 'asc' | 'desc' }[];
    }
  | {
      id: string;
      op: 'aggregate';
      input: string;
      groupBy: string[];
      metrics: {
        field: Field;
        operation: 'countRows' | 'countNonNull' | 'sum' | 'min' | 'max' | 'mean';
        fieldId?: string;
        scale?: number;
        rounding?: Rounding;
      }[];
    }
  | {
      id: string;
      op: 'join';
      input: string;
      right: string;
      leftKey: string;
      rightKey: string;
      mode: 'inner' | 'left';
      cardinality: '1:1' | 'many:1';
      columns: { sourceId: string; field: Field }[];
    };
export interface Scenario {
  id: string;
  name: string;
  parameterValues: Record<string, ScalarValue>;
}
export interface Output {
  id: string;
  stepId: string;
  columns: string[];
  presentation: 'table' | 'chart';
}
export interface Basis {
  engine: string;
  inputs: Input[];
  sources: string[];
  parameters: Parameter[];
  steps: Step[];
  outputs: Output[];
  scenarioId: string | null;
}
export interface Run {
  id: string;
  basisHash: string;
  basis: Basis;
  results: Record<string, Table>;
  resultHash: string;
}
export interface AnalysisDocument {
  schemaVersion: 1;
  domain: 'analysis';
  title: string;
  blocks: { id: string; kind: 'note' | 'step' | 'result'; text: string; targetId: string | null }[];
  inputs: Input[];
  parameters: Parameter[];
  steps: Step[];
  scenarios: Scenario[];
  outputs: Output[];
  runs: Run[];
  retainedSources: RetainedSource[];
}
export const ENGINE = 'analysis-1';
export const LIMITS = {
  inputs: 8,
  steps: 64,
  parameters: 64,
  scenarios: 20,
  outputs: 16,
  runs: 5,
  blocks: 128,
  rows: 10000,
  fields: 50,
  cells: 200000,
  bytes: 2097152,
} as const;
export function createAnalysis(title = '計算・分析ノート'): AnalysisDocument {
  return {
    schemaVersion: 1,
    domain: 'analysis',
    title,
    blocks: [],
    inputs: [],
    parameters: [],
    steps: [],
    scenarios: [],
    outputs: [],
    runs: [],
    retainedSources: [],
  };
}
