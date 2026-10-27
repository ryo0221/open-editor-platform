import { canonicalJson } from '@editor-platform/artifact-core';
import {
  assertJson,
  record,
  identifier,
  textValue,
  assertPin,
  pinKey,
  assertType,
  assertValue,
  expressionType,
  equalType,
  CalculationError,
  type ScalarType,
} from '@editor-platform/calculation-core';
import { LIMITS, type AnalysisDocument, type Basis, type Field, type Table } from './types';
import { projectData } from './sources';
function fail(code: string): never {
  throw new CalculationError(code);
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('collection-limit');
  return value;
}
function ids(value: unknown, max = 50): string[] {
  const a = list(value, max);
  a.forEach(identifier);
  if (new Set(a).size !== a.length) fail('duplicate-id');
  return a as string[];
}
function unique(values: { id: string }[]) {
  if (new Set(values.map((v) => v.id)).size !== values.length) fail('duplicate-id');
}
export function assertField(value: unknown): asserts value is Field {
  const r = record(value, ['id', 'label', 'type']);
  identifier(r.id);
  textValue(r.label);
  assertType(r.type);
}
export function assertTable(value: unknown): asserts value is Table {
  const r = record(value, ['fields', 'rows', 'diagnostics']);
  const fields = list(r.fields, LIMITS.fields);
  fields.forEach(assertField);
  unique(fields as Field[]);
  const rows = list(r.rows, LIMITS.rows);
  if (rows.length * fields.length > LIMITS.cells) fail('cell-limit');
  const rowIds: string[] = [];
  for (const item of rows) {
    const row = record(item, ['id', 'values']);
    identifier(row.id);
    rowIds.push(row.id);
    const cells = record(
      row.values,
      (fields as Field[]).map((f) => f.id),
    );
    for (const f of fields as Field[]) assertValue(cells[f.id], f.type);
  }
  if (new Set(rowIds).size !== rowIds.length) fail('duplicate-row-id');
  for (const item of list(r.diagnostics, 128)) {
    const d = record(item, ['code', 'count']);
    identifier(d.code);
    if (!Number.isSafeInteger(d.count) || Number(d.count) < 0) fail('invalid-diagnostic');
  }
}
function recipeShape(value: unknown, basis: boolean): void {
  const r = value as Record<string, unknown>;
  for (const input of list(r.inputs, LIMITS.inputs)) {
    const v = record(input, ['id', 'name', 'snapshotKey', 'selectedColumnIds'], ['columnMapping']);
    identifier(v.id);
    textValue(v.name);
    identifier(v.snapshotKey);
    ids(v.selectedColumnIds);
    if (v.columnMapping !== undefined) {
      const mapping = record(v.columnMapping, v.selectedColumnIds as string[]);
      ids(Object.values(mapping));
    }
  }
  for (const p of list(r.parameters, LIMITS.parameters)) {
    const v = record(p, ['id', 'label', 'type', 'value']);
    identifier(v.id);
    textValue(v.label);
    assertType(v.type);
    assertValue(v.value, v.type);
  }
  for (const item of list(r.steps, LIMITS.steps)) {
    const s = record(
      item,
      ['id', 'op', 'input'],
      [
        'columns',
        'expression',
        'field',
        'keys',
        'groupBy',
        'metrics',
        'right',
        'leftKey',
        'rightKey',
        'mode',
        'cardinality',
      ],
    );
    identifier(s.id);
    identifier(s.input);
    const allowed: Record<string, string[]> = {
      select: ['columns'],
      filter: ['expression'],
      derive: ['field', 'expression'],
      sort: ['keys'],
      aggregate: ['groupBy', 'metrics'],
      join: ['right', 'leftKey', 'rightKey', 'mode', 'cardinality', 'columns'],
    };
    if (typeof s.op !== 'string' || !Object.hasOwn(allowed, s.op)) fail('unknown-operation');
    record(item, ['id', 'op', 'input', ...allowed[s.op]]);
    if (s.op === 'select' || s.op === 'join')
      for (const c of list(s.columns, 50)) {
        const v = record(c, ['sourceId', 'field']);
        identifier(v.sourceId);
        assertField(v.field);
      }
    if (s.op === 'derive') assertField(s.field);
    if (s.op === 'sort')
      for (const k of list(s.keys, 50)) {
        const v = record(k, ['fieldId', 'direction']);
        identifier(v.fieldId);
        if (v.direction !== 'asc' && v.direction !== 'desc') fail('invalid-sort');
      }
    if (s.op === 'aggregate') {
      ids(s.groupBy);
      for (const m of list(s.metrics, 50)) {
        const v = record(m, ['field', 'operation'], ['fieldId', 'scale', 'rounding']);
        assertField(v.field);
        if (
          !['countRows', 'countNonNull', 'sum', 'min', 'max', 'mean'].includes(String(v.operation))
        )
          fail('unknown-operation');
        if (v.operation !== 'countRows') identifier(v.fieldId);
        else if (v.fieldId !== undefined) fail('unknown-property');
        if (v.operation === 'mean') {
          if (
            !Number.isInteger(v.scale) ||
            Number(v.scale) < 0 ||
            Number(v.scale) > 12 ||
            !['half-even', 'half-up', 'floor', 'ceil'].includes(String(v.rounding))
          )
            fail('invalid-rounding');
        } else if (v.scale !== undefined || v.rounding !== undefined) fail('unknown-property');
      }
    }
    if (s.op === 'join') {
      identifier(s.right);
      identifier(s.leftKey);
      identifier(s.rightKey);
      if (
        !['inner', 'left'].includes(String(s.mode)) ||
        !['1:1', 'many:1'].includes(String(s.cardinality))
      )
        fail('unsupported-join');
    }
  }
  for (const o of list(r.outputs, LIMITS.outputs)) {
    const v = record(o, ['id', 'stepId', 'columns', 'presentation']);
    identifier(v.id);
    identifier(v.stepId);
    ids(v.columns);
    if (v.presentation !== 'table' && v.presentation !== 'chart') fail('unsupported-presentation');
  }
  if (basis) {
    textValue(r.engine);
    ids(r.sources, 8);
    if (r.scenarioId !== null) identifier(r.scenarioId);
  }
}
/** Infer all step fields without evaluating data: even empty tables must reject invalid expressions. */
export function recipeFields(
  recipe: Pick<Basis, 'inputs' | 'steps' | 'parameters' | 'outputs'>,
  document: AnalysisDocument,
): Map<string, Field[]> {
  const fields = new Map<string, Field[]>(),
    visiting = new Set<string>();
  unique([...recipe.inputs, ...recipe.steps]);
  unique(recipe.parameters);
  unique(recipe.outputs);
  const parameters = Object.fromEntries(recipe.parameters.map((p) => [p.id, p.type]));
  for (const input of recipe.inputs) {
    const source = document.retainedSources.find((s) => s.key === input.snapshotKey);
    if (!source) fail('missing-source');
    fields.set(
      input.id,
      input.selectedColumnIds.map((id) =>
        (() => {
          const field = source.table.fields.find((f) => f.id === id) ?? fail('missing-field');
          return { ...field, id: input.columnMapping?.[id] ?? id };
        })(),
      ),
    );
  }
  function get(id: string): Field[] {
    const known = fields.get(id);
    if (known) return known;
    if (visiting.has(id)) fail('cycle');
    visiting.add(id);
    const s = recipe.steps.find((s) => s.id === id);
    if (!s) fail('missing-step');
    const input = get(s.input),
      field = (key: string) => input.find((f) => f.id === key) ?? fail('missing-field');
    const env = { fields: Object.fromEntries(input.map((f) => [f.id, f.type])), parameters };
    let result: Field[] = input;
    if (s.op === 'select')
      result = s.columns.map((c) => {
        if (canonicalJson(field(c.sourceId).type) !== canonicalJson(c.field.type))
          fail('type-mismatch');
        return c.field;
      });
    if (s.op === 'filter' && expressionType(s.expression, env).kind !== 'boolean')
      fail('type-mismatch');
    if (s.op === 'derive') {
      const type = expressionType(s.expression, env);
      if (!equalType(type, s.field.type) || canonicalJson(type) !== canonicalJson(s.field.type))
        fail('type-mismatch');
      result = [...input, s.field];
    }
    if (s.op === 'sort') s.keys.forEach((k) => field(k.fieldId));
    if (s.op === 'aggregate')
      result = [
        ...s.groupBy.map(field),
        ...s.metrics.map((m) => {
          const type: ScalarType =
            m.operation === 'countRows' || m.operation === 'countNonNull'
              ? { kind: 'decimal', unit: 'count' }
              : field(m.fieldId!).type;
          if (m.fieldId) field(m.fieldId);
          if (type.kind !== 'decimal' || canonicalJson(type) !== canonicalJson(m.field.type))
            fail('type-mismatch');
          return m.field;
        }),
      ];
    if (s.op === 'join') {
      const right = get(s.right),
        rf = (key: string) => right.find((f) => f.id === key) ?? fail('missing-field');
      if (canonicalJson(field(s.leftKey).type) !== canonicalJson(rf(s.rightKey).type))
        fail('join-key-type-mismatch');
      result = [
        ...input,
        ...s.columns.map((c) => {
          if (canonicalJson(rf(c.sourceId).type) !== canonicalJson(c.field.type))
            fail('type-mismatch');
          return c.field;
        }),
      ];
    }
    unique(result);
    if (result.length > 50) fail('field-limit');
    fields.set(id, result);
    visiting.delete(id);
    return result;
  }
  recipe.steps.forEach((s) => get(s.id));
  for (const output of recipe.outputs) {
    const fs = get(output.stepId);
    if (output.columns.some((id) => !fs.some((f) => f.id === id))) fail('missing-output-field');
  }
  return fields;
}
export function assertAnalysis(value: unknown): asserts value is AnalysisDocument {
  assertJson(value, LIMITS.bytes);
  const r = record(value, [
    'schemaVersion',
    'domain',
    'title',
    'blocks',
    'inputs',
    'parameters',
    'steps',
    'scenarios',
    'outputs',
    'runs',
    'retainedSources',
  ]);
  if (r.schemaVersion !== 1 || r.domain !== 'analysis') fail('unsupported-schema');
  textValue(r.title);
  recipeShape(r, false);
  const identities = new Map<string, string>();
  let cells = 0;
  for (const item of list(r.retainedSources, 48)) {
    const s = record(item, ['key', 'pin', 'nativeContent', 'dependencies', 'table']);
    identifier(s.key);
    assertPin(s.pin);
    assertTable(s.table);
    if (s.pin.domain !== 'data' || list(s.dependencies, 0).length || s.key !== pinKey(s.pin))
      fail('invalid-source-closure');
    const identity = canonicalJson([s.pin.domain, s.pin.artifactId, s.pin.versionId]),
      old = identities.get(identity);
    if (old) fail(old === s.pin.contentHash ? 'duplicate-source' : 'conflicting-source-pin');
    identities.set(identity, s.pin.contentHash);
    if (
      canonicalJson(
        projectData(
          s.nativeContent,
          s.table.fields.map((f) => f.id),
        ),
      ) !== canonicalJson(s.table)
    )
      fail('source-projection-mismatch');
    cells += s.table.rows.length * s.table.fields.length;
  }
  if (cells > LIMITS.cells) fail('source-cell-limit');
  const doc = value as AnalysisDocument;
  recipeFields(doc, doc);
  for (const item of list(r.scenarios, LIMITS.scenarios)) {
    const s = record(item, ['id', 'name', 'parameterValues']);
    identifier(s.id);
    textValue(s.name);
    const values = record(
      s.parameterValues,
      doc.parameters.map((p) => p.id),
    );
    for (const p of doc.parameters) assertValue(values[p.id], p.type);
  }
  unique(doc.scenarios);
  for (const item of list(r.blocks, LIMITS.blocks)) {
    const b = record(item, ['id', 'kind', 'text', 'targetId']);
    identifier(b.id);
    textValue(b.text);
    if (!['note', 'step', 'result'].includes(String(b.kind))) fail('unknown-block');
    if (b.kind === 'note') {
      if (b.targetId !== null) fail('invalid-note');
    } else if (!(b.kind === 'step' ? doc.steps : doc.outputs).some((v) => v.id === b.targetId))
      fail('missing-block-target');
  }
  unique(doc.blocks);
  for (const item of list(r.runs, LIMITS.runs)) {
    const run = record(item, ['id', 'basisHash', 'basis', 'results', 'resultHash']);
    identifier(run.id);
    for (const h of [run.basisHash, run.resultHash])
      if (typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h)) fail('invalid-hash');
    const b = record(run.basis, [
      'engine',
      'inputs',
      'sources',
      'parameters',
      'steps',
      'outputs',
      'scenarioId',
    ]);
    recipeShape(b, true);
    const basis = b as unknown as Basis;
    recipeFields(basis, doc);
    if (
      canonicalJson([...new Set(basis.inputs.map((i) => i.snapshotKey))].sort()) !==
      canonicalJson(basis.sources)
    )
      fail('missing-source-closure');
    const results = record(
      run.results,
      basis.outputs.map((o) => o.id),
    );
    Object.values(results).forEach(assertTable);
  }
  unique(doc.runs);
}
export function isAnalysis(value: unknown): value is AnalysisDocument {
  try {
    assertAnalysis(value);
    return true;
  } catch {
    return false;
  }
}
