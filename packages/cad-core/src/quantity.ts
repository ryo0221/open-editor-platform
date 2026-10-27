import { cadAssemblyLimits, componentCopies, type CadPartLookup } from './assembly';
import { parameterValues } from './graph';
import { validateCad } from './validation';
import type { CadDocument } from './model';

/** Shared seed/pattern counting for BOM and quantity projection. Exclusion stays explicit. */
export function cadComponentSteps(owner: CadDocument) {
  const copies = componentCopies(
    owner,
    owner.componentPatterns.length ? parameterValues(owner) : new Map(),
  );
  return owner.components.map((component) => ({
    component,
    steps: [component.id, ...(copies.get(component.id) ?? []).map((copy) => copy.step)],
  }));
}
export interface CadQuantityRow {
  /** Version-independent occurrence/body identity; names and display order are never keys. */
  identity: string;
  name: string;
  kind: 'body' | 'part' | 'assembly';
  count: number;
  path: string[];
  bodyId?: string;
  reference?: { artifactId: string; versionId: string; contentHash: string };
  coverage: string[];
  excluded: boolean;
}
export interface CadQuantityProjection {
  rows: CadQuantityRow[];
  diagnostics: { code: string; identity: string }[];
}
/** Every assembly keeps its own row and child rows: the consumer must choose buy/make.
 * No partial quantity projection is returned on missing content, access or traversal limits.
 * The caller admits hashes/retained closure before calling this pure projection.
 */
export function cadQuantityRows(
  rootArtifactId: string,
  document: CadDocument,
  lookup: CadPartLookup,
  access: (artifactId: string) => boolean = () => true,
): CadQuantityProjection {
  if (!access(rootArtifactId)) throw Error('quantity-source-access-denied');
  const rows: CadQuantityRow[] = [];
  let occurrences = 0,
    coverageCount = 0;
  const checked = new Set<CadDocument>();
  const inspect = (doc: CadDocument) => {
    if (checked.has(doc)) return;
    if (validateCad(doc).length) throw Error('quantity-invalid-cad');
    checked.add(doc);
    if (checked.size > cadAssemblyLimits.closureVersions + 1) throw Error('quantity-closure-limit');
  };
  const identity = (path: string[], body?: string) =>
    JSON.stringify([rootArtifactId, path, body ?? null]);
  const walk = (
    doc: CadDocument,
    path: string[],
    depth: number,
    excluded: boolean,
    ancestors: Set<string>,
  ): string[] => {
    inspect(doc);
    if (depth > cadAssemblyLimits.depth) throw Error('quantity-depth-limit');
    const coverage: string[] = [];
    for (const body of doc.bodies.filter((b) => b.state === 'active')) {
      if (++coverageCount > 10000) throw Error('quantity-coverage-limit');
      const key = identity(path, body.id);
      rows.push({
        identity: key,
        name: body.name,
        kind: 'body',
        count: 1,
        path,
        bodyId: body.id,
        coverage: [key],
        excluded,
      });
      coverage.push(key);
    }
    const parts = new Map(doc.parts.map((p) => [p.id, p]));
    for (const { component, steps } of cadComponentSteps(doc)) {
      const part = parts.get(component.partId);
      if (!part) throw Error('quantity-missing-part');
      if (part.source.kind !== 'version') throw Error('quantity-imported-part-unsupported');
      if (!access(part.source.artifactId)) throw Error('quantity-source-access-denied');
      const content = lookup(part.source.contentHash);
      if (!content) throw Error('quantity-missing-closure');
      if (ancestors.has(part.source.contentHash)) throw Error('quantity-source-cycle');
      const nextAncestors = new Set(ancestors).add(part.source.contentHash);
      for (const step of steps) {
        if (++occurrences > cadAssemblyLimits.instances) throw Error('quantity-instance-limit');
        const at = [...path, step],
          isExcluded = excluded || component.bom === 'exclude';
        const row: CadQuantityRow = {
          identity: identity(at),
          name: part.name,
          kind: content.components.length ? 'assembly' : 'part',
          count: 1,
          path: at,
          reference: { ...part.source },
          coverage: [],
          excluded: isExcluded,
        };
        rows.push(row);
        const childCoverage = walk(content, at, depth + 1, isExcluded, nextAncestors);
        // A readable but empty part is not a manufactured countable solid.
        if (!childCoverage.length) throw Error('quantity-empty-part');
        for (const bodyRow of rows) {
          if (
            bodyRow.kind === 'body' &&
            bodyRow.path.length === at.length &&
            bodyRow.path.every((step, i) => step === at[i])
          )
            bodyRow.reference = {
              artifactId: part.source.artifactId,
              versionId: part.source.versionId,
              contentHash: part.source.contentHash,
            };
        }
        row.coverage = [...childCoverage].sort();
        coverage.push(...childCoverage);
      }
    }
    return coverage;
  };
  walk(document, [], 0, false, new Set());
  return { rows, diagnostics: [] };
}
