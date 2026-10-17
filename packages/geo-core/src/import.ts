import { checkedJson } from './json-boundary';
import type { Budgets, Diagnostic, Feature, SourceSnapshot, VectorLayer } from './model';
import type { GeoCommand, Revision } from './commands';
import { validateGeo } from './validation';
/** Adapter supplies explicit mapping and preallocated IDs. No inference or file parsing here. */
export interface ImportCandidate {
  inputRow: number;
  feature: Feature;
  diagnostics: Diagnostic[];
}
export interface ImportPlan {
  layer: VectorLayer;
  source: SourceSnapshot;
  candidates: ImportCandidate[];
  diagnostics: Diagnostic[];
  counts: { read: number; valid: number; problem: number };
}
export function prepareImport(
  layer: Omit<VectorLayer, 'features'>,
  source: SourceSnapshot,
  candidates: ImportCandidate[],
  budgets: Budgets,
): ImportPlan {
  // Check the complete input budget before spread, property reads or candidate cloning.
  // Layer metadata must not include a second feature collection in this boundary.
  checkedJson({ layer, source, candidates }, budgets);
  const rows = new Set<number>();
  const checked = candidates.map((c) => {
    const diagnostics = [
      ...c.diagnostics,
      ...validateGeo(
        { schemaVersion: 1, layers: [{ ...layer, features: [c.feature] }], sources: [source] },
        budgets,
      ),
    ];
    if (!Number.isSafeInteger(c.inputRow) || c.inputRow < 1 || rows.has(c.inputRow))
      diagnostics.push({ code: 'input-row', path: String(c.inputRow), severity: 'error' });
    rows.add(c.inputRow);
    return structuredClone({ ...c, diagnostics });
  });
  const valid = checked.filter((c) => !c.diagnostics.some((d) => d.severity === 'error'));
  const resultLayer = structuredClone({ ...layer, features: valid.map((c) => c.feature) });
  // Global duplicate IDs/budget failures cannot be silently treated as row exclusions.
  const diagnostics = validateGeo(
    { schemaVersion: 1, layers: [resultLayer], sources: [source] },
    budgets,
  );
  return {
    layer: resultLayer,
    source: structuredClone(source),
    candidates: checked,
    diagnostics,
    counts: { read: checked.length, valid: valid.length, problem: checked.length - valid.length },
  };
}
export function confirmImport(
  plan: ImportPlan,
  expectedRevision: Revision,
  allowPartial: boolean,
  budgets: Budgets,
): { command: GeoCommand; excluded: ImportCandidate[]; imported: number } {
  // Rebuild from candidates; a caller-edited plan cannot bypass validation/counts.
  checkedJson(plan, budgets);
  const { features: _features, ...metadata } = plan.layer;
  const checked = prepareImport(metadata, plan.source, plan.candidates, budgets);
  const excluded = checked.candidates.filter((c) =>
    c.diagnostics.some((d) => d.severity === 'error'),
  );
  if (checked.diagnostics.some((d) => d.severity === 'error') || (excluded.length && !allowPartial))
    throw new Error('import-blocked');
  return {
    command: {
      expectedRevision: structuredClone(expectedRevision),
      actions: [{ type: 'importLayer', layer: checked.layer, source: checked.source }],
    },
    excluded,
    imported: checked.layer.features.length,
  };
}
