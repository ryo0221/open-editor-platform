import type { BimDocument } from '@editor-platform/bim-core';
import type { ConstructionDiagnostic, ConstructionDocument } from './model';

/**
 * What the source BIM version alone tells about a schedule: every element a task names exists in
 * it (`element-missing`). The Host has already checked that `bim` is the stored version with the
 * stored content hash. After a switch to another version, the missing ones are listed here and
 * the schedule is kept as it is.
 */
export function checkConstructionSource(
  doc: ConstructionDocument,
  bim: Pick<BimDocument, 'elements'>,
): ConstructionDiagnostic[] {
  const ids = new Set(bim.elements.map((e) => e.id));
  const out: ConstructionDiagnostic[] = [];
  doc.tasks.forEach((t, i) =>
    t.elementIds.forEach((e, k) => {
      if (!ids.has(e))
        out.push({
          code: 'element-missing',
          path: `$.tasks[${i}].elementIds[${k}]`,
          message: `${t.name || t.id}: no element ${e} in the BIM version`,
        });
    }),
  );
  return out;
}

/** BIM elements that no task holds: they stand throughout. */
export function unscheduledElements(
  doc: ConstructionDocument,
  bim: Pick<BimDocument, 'elements'>,
): string[] {
  const held = new Set(doc.tasks.flatMap((t) => t.elementIds));
  return bim.elements.map((e) => e.id).filter((id) => !held.has(id));
}
