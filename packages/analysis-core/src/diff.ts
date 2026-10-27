import { canonicalJson } from '@editor-platform/artifact-core';
import { subtract, decimal, formatDecimal } from '@editor-platform/calculation-core';
import type { AnalysisDocument, Run } from './types';
export interface AnalysisDifference {
  kind: string;
  id: string;
  before: unknown;
  after: unknown;
  delta?: string;
}
export function analysisDiff(
  before: AnalysisDocument,
  after: AnalysisDocument,
): AnalysisDifference[] {
  const changes: AnalysisDifference[] = [];
  for (const kind of ['inputs', 'parameters', 'steps', 'outputs'] as const) {
    const a = new Map(before[kind].map((v) => [v.id, v])),
      b = new Map(after[kind].map((v) => [v.id, v]));
    for (const id of new Set([...a.keys(), ...b.keys()]))
      if (canonicalJson(a.get(id) ?? null) !== canonicalJson(b.get(id) ?? null))
        changes.push({ kind, id, before: a.get(id) ?? null, after: b.get(id) ?? null });
  }
  const a = before.runs.at(-1),
    b = after.runs.at(-1);
  if (a && b) changes.push(...runDiff(a, b));
  else if (a || b)
    changes.push({ kind: 'run', id: (a ?? b)!.id, before: a ?? null, after: b ?? null });
  return changes;
}
export function runDiff(a: Run, b: Run): AnalysisDifference[] {
  const changes: AnalysisDifference[] = [];
  for (const key of ['inputs', 'sources', 'parameters', 'steps'] as const)
    if (canonicalJson(a.basis[key]) !== canonicalJson(b.basis[key]))
      changes.push({ kind: `basis-${key}`, id: key, before: a.basis[key], after: b.basis[key] });

  const structure = (run: Run) =>
    run.basis.steps.filter((s) => s.op === 'join' || s.op === 'aggregate');
  const regrouped = canonicalJson(structure(a)) !== canonicalJson(structure(b));
  if (regrouped)
    changes.push({ kind: 'regrouped', id: 'rows', before: structure(a), after: structure(b) });
  for (const id of new Set([...Object.keys(a.results), ...Object.keys(b.results)])) {
    const x = a.results[id],
      y = b.results[id];
    changes.push({
      kind: 'row-count',
      id,
      before: x?.rows.length ?? null,
      after: y?.rows.length ?? null,
    });
    if (!x || !y || regrouped) continue;
    for (const field of x.fields)
      if (!y.fields.some((f) => f.id === field.id))
        changes.push({
          kind: 'field-removed',
          id: `${id}/${field.id}`,
          before: field,
          after: null,
        });

    const rows = new Map(x.rows.map((r) => [r.id, r]));
    for (const row of y.rows) {
      const previous = rows.get(row.id);
      rows.delete(row.id);
      if (!previous) {
        changes.push({ kind: 'row-added', id: row.id, before: null, after: row });
        continue;
      }
      for (const f of y.fields) {
        const oldField = x.fields.find((v) => v.id === f.id),
          before = previous.values[f.id] ?? null,
          after = row.values[f.id];
        if (before !== after || canonicalJson(oldField?.type ?? null) !== canonicalJson(f.type)) {
          const delta =
            oldField &&
            canonicalJson(oldField.type) === canonicalJson(f.type) &&
            f.type.kind === 'decimal' &&
            before !== null &&
            after !== null
              ? formatDecimal(subtract(decimal(String(after)), decimal(String(before))))
              : undefined;
          changes.push({
            kind: 'value',
            id: `${id}/${row.id}/${f.id}`,
            before: { value: before, type: oldField?.type ?? null },
            after: { value: after, type: f.type },
            ...(delta === undefined ? {} : { delta }),
          });
        }
      }
    }
    for (const row of rows.values())
      changes.push({ kind: 'row-removed', id: row.id, before: row, after: null });
  }
  return changes;
}
