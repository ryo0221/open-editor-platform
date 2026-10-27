import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import {
  CalculationError,
  assertValue,
  decimal,
  add,
  divide,
  compare,
  compareText,
  formatDecimal,
  evaluateScalar,
  expressionType,
  equalType,
  type ScalarEnvironment,
  type ScalarValue,
} from '@editor-platform/calculation-core';
import {
  ENGINE,
  LIMITS,
  type AnalysisDocument,
  type Basis,
  type Run,
  type Table,
  type Step,
  type Field,
} from './types';
import { verifyRetainedSource } from './sources';
import { assertAnalysis, recipeFields } from './validate';
function fail(code: string, path = ''): never {
  throw new CalculationError(code, path);
}
const field = (table: Table, id: string) =>
  table.fields.find((f) => f.id === id) ?? fail('missing-field', id);
const order = (a: ScalarValue, b: ScalarValue, f: Field): number =>
  a === b
    ? 0
    : a === null
      ? 1
      : b === null
        ? -1
        : f.type.kind === 'decimal'
          ? compare(decimal(String(a)), decimal(String(b)))
          : compareText(String(a), String(b));
function checkTable(table: Table): Table {
  if (
    table.rows.length > LIMITS.rows ||
    table.fields.length > LIMITS.fields ||
    table.rows.length * table.fields.length > LIMITS.cells
  )
    fail('result-limit');
  if (
    new Set(table.fields.map((f) => f.id)).size !== table.fields.length ||
    new Set(table.rows.map((r) => r.id)).size !== table.rows.length
  )
    fail('duplicate-result-id');
  for (const row of table.rows)
    for (const f of table.fields) {
      if (!Object.hasOwn(row.values, f.id)) fail('missing-value', row.id + '/' + f.id);
      assertValue(row.values[f.id], f.type);
    }
  return table;
}
export function makeBasis(document: AnalysisDocument, scenarioId: string | null = null): Basis {
  const scenario =
    scenarioId === null
      ? null
      : (document.scenarios.find((s) => s.id === scenarioId) ?? fail('missing-scenario'));
  if (
    scenario &&
    Object.keys(scenario.parameterValues).some(
      (id) => !document.parameters.some((p) => p.id === id),
    )
  )
    fail('unknown-parameter');
  const parameters = document.parameters.map((p) => {
    if (scenario && !Object.hasOwn(scenario.parameterValues, p.id)) fail('missing-parameter', p.id);
    const value = scenario ? scenario.parameterValues[p.id] : p.value;
    assertValue(value, p.type);
    return { ...p, value };
  });
  return structuredClone({
    engine: ENGINE,
    inputs: document.inputs,
    sources: [...new Set(document.inputs.map((i) => i.snapshotKey))].sort(),
    parameters,
    steps: document.steps,
    outputs: document.outputs,
    scenarioId,
  });
}
export function evaluateBasis(basis: Basis, document: AnalysisDocument): Record<string, Table> {
  return evaluate(basis, document);
}
function evaluate(
  basis: Basis,
  document: AnalysisDocument,
  inspect?: (step: Extract<Step, { op: 'join' }>, left: Table, right: Table) => void,
): Record<string, Table> {
  if (basis.engine !== ENGINE) fail('unsupported-engine');
  recipeFields(basis, document);
  const tables = new Map<string, Table>(),
    visiting = new Set<string>();
  const parameters = Object.fromEntries(basis.parameters.map((p) => [p.id, p.value]));
  for (const input of basis.inputs) {
    const source =
      document.retainedSources.find((s) => s.key === input.snapshotKey) ?? fail('missing-source');
    const fields = input.selectedColumnIds.map((id) => ({
      ...field(source.table, id),
      id: input.columnMapping?.[id] ?? id,
    }));
    if (tables.has(input.id)) fail('duplicate-id');
    tables.set(
      input.id,
      checkTable({
        fields,
        rows: source.table.rows.map((r) => ({
          id: r.id,
          values: Object.fromEntries(
            fields.map((f, index) => [f.id, r.values[input.selectedColumnIds[index]]]),
          ),
        })),
        diagnostics: [],
      }),
    );
  }
  const steps = new Map(basis.steps.map((s) => [s.id, s]));
  if (steps.size !== basis.steps.length || basis.steps.some((s) => tables.has(s.id)))
    fail('duplicate-id');
  function resolve(id: string): Table {
    const cached = tables.get(id);
    if (cached) return cached;
    if (visiting.has(id)) fail('cycle', id);
    const step = steps.get(id) ?? fail('missing-step', id);
    visiting.add(id);
    const result = checkTable(apply(step, resolve(step.input)));
    visiting.delete(id);
    tables.set(id, result);
    return result;
  }
  function apply(step: Step, input: Table): Table {
    const env: ScalarEnvironment = {
      fields: Object.fromEntries(input.fields.map((f) => [f.id, f.type])),
      parameters: Object.fromEntries(basis.parameters.map((p) => [p.id, p.type])),
    };
    const rowValue = (
      expression: Parameters<typeof evaluateScalar>[0],
      row: Table['rows'][number],
    ) => {
      try {
        return evaluateScalar(expression, env, row.values, parameters);
      } catch (error) {
        if (error instanceof CalculationError)
          throw new CalculationError(
            error.code,
            `${step.id}/${row.id}/${step.op === 'derive' ? step.field.id : 'predicate'}${error.path ? '/' + error.path : ''}`,
          );
        throw error;
      }
    };
    switch (step.op) {
      case 'select':
        for (const c of step.columns)
          if (!equalType(field(input, c.sourceId).type, c.field.type)) fail('type-mismatch');
        return {
          fields: step.columns.map((c) => c.field),
          rows: input.rows.map((r) => ({
            id: r.id,
            values: Object.fromEntries(step.columns.map((c) => [c.field.id, r.values[c.sourceId]])),
          })),
          diagnostics: input.diagnostics,
        };
      case 'filter': {
        if (expressionType(step.expression, env).kind !== 'boolean') fail('type-mismatch');
        const rows = input.rows.filter((r) => rowValue(step.expression, r) === true);
        return {
          ...input,
          rows,
          diagnostics: [
            ...input.diagnostics,
            { code: 'filtered', count: input.rows.length - rows.length },
          ],
        };
      }
      case 'derive': {
        if (
          input.fields.some((f) => f.id === step.field.id) ||
          !equalType(step.field.type, expressionType(step.expression, env))
        )
          fail('invalid-derived-field');
        return {
          ...input,
          fields: [...input.fields, step.field],
          rows: input.rows.map((r) => ({
            ...r,
            values: {
              ...r.values,
              [step.field.id]: rowValue(step.expression, r),
            },
          })),
        };
      }
      case 'sort':
        for (const key of step.keys) field(input, key.fieldId);
        return {
          ...input,
          rows: [...input.rows].sort((a, b) => {
            for (const key of step.keys) {
              const x = a.values[key.fieldId],
                y = b.values[key.fieldId];
              const n = order(x, y, field(input, key.fieldId));
              if (n) return x === null || y === null ? n : n * (key.direction === 'desc' ? -1 : 1);
            }
            return compareText(a.id, b.id);
          }),
        };
      case 'aggregate': {
        const groups = new Map<string, typeof input.rows>();
        const groupFields = step.groupBy.map((id) => field(input, id));
        for (const row of input.rows) {
          const key = canonicalJson(groupFields.map((f) => [f.type, row.values[f.id]]));
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        if (!step.groupBy.length && !groups.size) groups.set('[]', []);
        const rows = [...groups.entries()]
          .sort(([a], [b]) => compareText(a, b))
          .map(([key, records]) => {
            const values: Record<string, ScalarValue> = Object.fromEntries(
              groupFields.map((f) => [f.id, records[0].values[f.id]]),
            );
            for (const metric of step.metrics) {
              const sourceField = metric.fieldId ? field(input, metric.fieldId) : undefined;
              const valid = sourceField
                ? records.map((r) => r.values[sourceField.id]).filter((v) => v !== null)
                : [];
              let value: ScalarValue;
              if (metric.operation === 'countRows') value = String(records.length);
              else if (metric.operation === 'countNonNull') value = String(valid.length);
              else {
                if (
                  !sourceField ||
                  sourceField.type.kind !== 'decimal' ||
                  metric.field.type.kind !== 'decimal' ||
                  sourceField.type.unit !== metric.field.type.unit
                )
                  fail('type-mismatch');
                if (!valid.length) value = null;
                else if (metric.operation === 'min' || metric.operation === 'max')
                  value = [...valid].sort((a, b) => order(a, b, sourceField))[
                    metric.operation === 'min' ? 0 : valid.length - 1
                  ];
                else {
                  const sum = valid.reduce(
                    (total, v) => add(total, decimal(String(v))),
                    decimal('0'),
                  );
                  if (metric.operation === 'mean') {
                    if (metric.scale === undefined || metric.rounding === undefined)
                      fail('explicit-rounding-required');
                    value = formatDecimal(
                      divide(sum, decimal(String(valid.length)), metric.scale, metric.rounding),
                    );
                  } else if (metric.operation === 'sum') value = formatDecimal(sum);
                  else fail('unknown-operation');
                }
              }
              values[metric.field.id] = value;
            }
            return { id: 'group:' + key, values };
          });
        return {
          fields: [...groupFields, ...step.metrics.map((m) => m.field)],
          rows,
          diagnostics: [],
        };
      }
      case 'join': {
        const right = resolve(step.right),
          leftField = field(input, step.leftKey),
          rightField = field(right, step.rightKey);
        if (canonicalJson(leftField.type) !== canonicalJson(rightField.type))
          fail('join-key-type-mismatch');
        inspect?.(step, input, right);
        const index = new Map<string, (typeof right.rows)[number]>();
        for (const row of right.rows) {
          const value = row.values[step.rightKey];
          if (value === null) continue;
          const key = canonicalJson(value);
          if (index.has(key)) fail('duplicate-right-key');
          index.set(key, row);
        }
        const seen = new Set<string>();
        let unmatched = 0;
        for (const c of step.columns)
          if (canonicalJson(field(right, c.sourceId).type) !== canonicalJson(c.field.type))
            fail('type-mismatch');
        const rows = input.rows.flatMap((row) => {
          const value = row.values[step.leftKey],
            key = canonicalJson(value);
          if (value !== null && step.cardinality === '1:1' && seen.has(key))
            fail('duplicate-left-key');
          seen.add(key);
          const other = value === null ? undefined : index.get(key);
          if (!other) {
            unmatched++;
            if (step.mode === 'inner') return [];
          }
          return [
            {
              id: 'join:' + canonicalJson([row.id, other?.id ?? null]),
              values: {
                ...row.values,
                ...Object.fromEntries(
                  step.columns.map((c) => [c.field.id, other ? other.values[c.sourceId] : null]),
                ),
              },
            },
          ];
        });
        return {
          fields: [...input.fields, ...step.columns.map((c) => c.field)],
          rows,
          diagnostics: [{ code: 'unmatched', count: unmatched }],
        };
      }
      default:
        return fail('unknown-operation');
    }
  }
  for (const step of basis.steps) resolve(step.id);
  const results = Object.fromEntries(
    basis.outputs.map((output) => {
      const table = resolve(output.stepId),
        fields = output.columns.map((id) => field(table, id));
      return [
        output.id,
        {
          ...table,
          fields,
          rows: table.rows.map((r) => ({
            id: r.id,
            values: Object.fromEntries(fields.map((f) => [f.id, r.values[f.id]])),
          })),
        },
      ];
    }),
  );
  if (
    Object.values(results).reduce((n, t) => n + t.rows.length * t.fields.length, 0) > LIMITS.cells
  )
    fail('result-limit');
  return results;
}
export async function calculateRun(
  document: AnalysisDocument,
  id: string,
  scenarioId: string | null = null,
): Promise<Run> {
  assertAnalysis(document);
  document = structuredClone(document);
  for (const source of document.retainedSources) await verifyRetainedSource(source);
  const basis = makeBasis(document, scenarioId),
    results = evaluateBasis(basis, document);
  return {
    id,
    basis,
    basisHash: await contentHash(basis),
    results,
    resultHash: await contentHash(results),
  };
}

/** Read-only, bounded diagnostics. Findings are not successful results and are never persisted. */
export interface JoinFinding {
  stepId: string;
  inputId: string;
  side: 'left' | 'right';
  code: 'duplicate-key' | 'null-key' | 'unmatched-key';
  key: ScalarValue;
  rowIds: string[];
}
export interface JoinInspectionOptions {
  offset?: number;
  code?: JoinFinding['code'];
}
export function inspectAnalysisJoins(
  document: AnalysisDocument,
  scenarioId: string | null = null,
  options: JoinInspectionOptions = {},
) {
  assertAnalysis(document);
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (options.code !== undefined &&
      !['duplicate-key', 'null-key', 'unmatched-key'].includes(options.code))
  )
    throw new CalculationError('invalid-inspection-options');
  const findings: JoinFinding[] = [];
  let total = 0;
  const add = (finding: JoinFinding) => {
    if (options.code && finding.code !== options.code) return;
    total++;
    if (total > offset && findings.length < 200)
      findings.push({ ...finding, rowIds: finding.rowIds.slice(0, 100) });
  };
  let error: string | null = null;
  try {
    evaluate(makeBasis(document, scenarioId), document, (step, left, right) => {
      const groups = (table: Table, column: string) => {
        const groups = new Map<string, { value: ScalarValue; ids: string[] }>();
        for (const row of table.rows) {
          const value = row.values[column],
            key = canonicalJson(value);
          const group = groups.get(key) ?? { value, ids: [] };
          group.ids.push(row.id);
          groups.set(key, group);
        }
        return groups;
      };
      const a = groups(left, step.leftKey),
        b = groups(right, step.rightKey);
      for (const [side, inputId, groups] of [
        ['left', step.input, a],
        ['right', step.right, b],
      ] as const)
        for (const group of groups.values()) {
          if (group.value === null)
            add({ stepId: step.id, inputId, side, code: 'null-key', key: null, rowIds: group.ids });
          else if (group.ids.length > 1 && (side === 'right' || step.cardinality === '1:1'))
            add({
              stepId: step.id,
              inputId,
              side,
              code: 'duplicate-key',
              key: group.value,
              rowIds: group.ids,
            });
        }
      for (const [key, group] of a)
        if (group.value !== null && !b.has(key))
          add({
            stepId: step.id,
            inputId: step.input,
            side: 'left',
            code: 'unmatched-key',
            key: group.value,
            rowIds: group.ids,
          });
    });
  } catch (e) {
    if (!(e instanceof CalculationError)) throw e;
    error = e.message;
  }
  return { findings, total, error };
}
