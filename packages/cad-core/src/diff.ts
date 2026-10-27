import { canonicalEqual, canonicalJson, type Change } from '@editor-platform/artifact-core';
import type { CadDocument } from './model';

const collections = [
  'parameters',
  'profiles',
  'sketches',
  'features',
  'bodies',
  'namedViews',
  'parts',
  'components',
  'joints',
] as const;

/** Semantic parameter/profile/sketch/feature/body/view differences by stable ID. No geometry comparison. */
export function compareCad(before: CadDocument, after: CadDocument): Change[] {
  const changes: Change[] = [];
  // Document-level values: the kernel build and the assembly's own BOM values (R2b).
  for (const key of ['kernelProfile', 'partProperties'] as const)
    if (!canonicalEqual(before[key], after[key]))
      changes.push({
        elementId: key,
        path: key,
        kind: 'changed',
        before: canonicalJson(before[key]),
        after: canonicalJson(after[key]),
      });
  for (const key of collections) {
    const a = new Map<string, object>(before[key].map((x) => [x.id, x]));
    const b = new Map<string, object>(after[key].map((x) => [x.id, x]));
    for (const [id, x] of a)
      if (!b.has(id))
        changes.push({ elementId: id, path: key, kind: 'removed', before: canonicalJson(x) });
    for (const [id, y] of b) {
      const x = a.get(id) as Record<string, unknown> | undefined;
      if (!x) {
        changes.push({ elementId: id, path: key, kind: 'added', after: canonicalJson(y) });
        continue;
      }
      for (const field of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (!canonicalEqual(x[field], (y as Record<string, unknown>)[field]))
          changes.push({
            elementId: id,
            path: `${key}.${field}`,
            kind: 'changed',
            before: canonicalJson(x[field]),
            after: canonicalJson((y as Record<string, unknown>)[field]),
          });
    }
    const kept = (list: { id: string }[], other: Map<string, object>) =>
      list.filter((x) => other.has(x.id)).map((x) => x.id);
    const order = [kept(before[key], b), kept(after[key], a)];
    order[1].forEach((id, i) => {
      if (order[0][i] !== id)
        changes.push({
          elementId: id,
          path: key,
          kind: 'moved',
          before: String(order[0].indexOf(id)),
          after: String(i),
        });
    });
  }
  return changes;
}
