import { canonicalJson } from '@editor-platform/artifact-core';
import {
  CalculationError,
  type GeometryQuantitySources,
  type MeasuredQuantity,
  type RetainedSource,
} from '@editor-platform/calculation-core';
import type { EstimateDocument, Quantity } from '@editor-platform/estimate-core';

// Estimate's side of geometric quantities: it names, includes and updates the quantities that a
// Host's GeometryQuantitySources (from @editor-platform/estimate-engineering) measure.

const fail = (code: string): never => {
  throw new CalculationError(code);
};
/** An Estimate quantity for a measurement; a source-side exclusion stays an exclusion. */
export function measuredQuantity(measurement: MeasuredQuantity, id: string): Quantity {
  const { excluded, ...rest } = measurement;
  return {
    id,
    ...rest,
    inclusion: excluded ? 'exclude' : 'include',
    exclusionReason: excluded ? 'CAD BOMの除外指定' : '',
  };
}
export interface CadUpdateDifference {
  id: string;
  state: 'unchanged' | 'changed' | 'added' | 'removed' | 'ambiguous';
  before: string | null;
  after: string | null;
}
/** Prepare only. Removed/ambiguous rows remain pending and never silently lose their line mapping. */
export async function proposeCadSourceUpdate(
  document: EstimateDocument,
  oldKey: string,
  replacement: RetainedSource,
  closure: RetainedSource[],
  allocateId: () => string,
  geometry: GeometryQuantitySources,
) {
  const next = structuredClone(document),
    old = next.retainedSources.find((s) => s.key === oldKey);
  if (
    !old ||
    old.pin.artifactId !== replacement.pin.artifactId ||
    old.pin.domain !== 'cad' ||
    replacement.pin.domain !== 'cad'
  )
    fail('quantity-update-source-mismatch');
  const merged = new Map(next.retainedSources.map((s) => [s.key, s]));
  for (const s of closure) merged.set(s.key, s);
  merged.set(replacement.key, replacement);
  next.retainedSources = [...merged.values()];
  for (const source of closure)
    await geometry.verification.verifySource(source, next.retainedSources);
  const oldRows = new Map(
    (await geometry.cadRows(old!, next.retainedSources)).map((r) => [r.identity, r]),
  );
  const newRows = new Map(
    (await geometry.cadRows(replacement, next.retainedSources)).map((r) => [r.identity, r]),
  );
  const differences: CadUpdateDifference[] = [];
  const identities = new Set<string>();
  for (const q of next.quantities)
    if (q.source?.snapshotKey === oldKey) {
      identities.add(q.source.identity);
      const before = oldRows.get(q.source.identity),
        after = newRows.get(q.source.identity);
      if (!before) fail('missing-old-quantity-identity');
      if (!after) {
        q.inclusion = 'pending';
        differences.push({ id: q.id, state: 'removed', before: q.value, after: null });
        continue;
      }
      if (before!.reference?.artifactId !== after.reference?.artifactId) {
        q.inclusion = 'pending';
        differences.push({
          id: q.id,
          state: 'ambiguous',
          before: q.value,
          after: String(after.count),
        });
        continue;
      }
      const updated = await geometry.measureCad(replacement, next.retainedSources, after.identity);
      differences.push({
        id: q.id,
        state: canonicalJson(before) === canonicalJson(after) ? 'unchanged' : 'changed',
        before: q.value,
        after: updated.value,
      });
      q.value = updated.value;
      q.unit = updated.unit;
      q.source = updated.source;
      if (after.excluded) {
        q.inclusion = 'exclude';
        q.exclusionReason = 'CAD BOMの除外指定';
      }
      // Names, notes, price bindings, allocation, user override and explicit exclusion remain owned by Estimate.
    }
  for (const row of newRows.values())
    if (!identities.has(row.identity)) {
      const q = measuredQuantity(
        await geometry.measureCad(replacement, next.retainedSources, row.identity),
        allocateId(),
      );
      if (!row.excluded) q.inclusion = 'pending';
      next.quantities.push(q);
      differences.push({ id: q.id, state: 'added', before: null, after: q.value });
    }
  return { document: next, differences };
}
