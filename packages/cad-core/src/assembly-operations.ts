/**
 * R2b-1 assembly edits (docs/cad/r2b-assembly.md): insert placed parts, move a fixed component,
 * set this document's BOM values, and (R2b-3) whether a component counts in the BOM and component
 * patterns. `applyCadOperation` re-solves `solvedPoses` after every edit.
 */
import {
  solveAssemblyPoses,
  type CadComponent,
  type CadComponentPattern,
  type CadComponentPlacement,
  type CadPartDef,
  type CadPartProperties,
  type CadPartSource,
} from './assembly';
import { lengthParameters, parameterValues } from './graph';
import type { CadDocument } from './model';

export type CadAssemblyOperation =
  /**
   * New part definitions (one per version, `parts` may be empty when the version is already
   * defined) and the components placing them, in one edit. The Host keeps the versions' closure
   * before the edit names them.
   */
  | { type: 'insertComponents'; parts: CadPartDef[]; components: CadComponent[] }
  | { type: 'setComponentPlacement'; componentId: string; placement: CadComponentPlacement }
  | ({ type: 'setPartProperties' } & CadPartProperties)
  /** R2b-3: whether a component (and what it places) is counted in the BOM. */
  | { type: 'setComponentBom'; componentId: string; bom: CadComponent['bom'] }
  /** R2b-3: copies of a direct component in a row or a circle. */
  | { type: 'insertComponentPattern'; pattern: CadComponentPattern }
  /**
   * A pattern's layout (and name) replaced, same ID and seed. Lowering the count is refused while
   * a joint hangs from a copy it removes (`connector-copy-missing`).
   */
  | { type: 'updateComponentPattern'; pattern: CadComponentPattern }
  /**
   * R2b-2b: parts take other saved versions of the same Artifacts, all in one edit. A part whose
   * new version another part already names hands its components to that part. The Host keeps
   * the new versions' closure before the edit names them; joints reading them are resolved
   * again when the edit is prepared.
   */
  | {
      type: 'replacePartSources';
      parts: { partId: string; source: CadPartSource; hint: CadPartDef['hint'] }[];
    };

const fail = (code: string): never => {
  throw new Error(code);
};

export function applyAssemblyOperation(next: CadDocument, op: CadAssemblyOperation) {
  switch (op.type) {
    case 'insertComponents':
      if (!op.components.length) fail('insert-components-empty');
      next.parts.push(...op.parts);
      next.components.push(...op.components);
      return next;
    case 'setComponentPlacement': {
      const c = next.components.find((x) => x.id === op.componentId) ?? fail('target-missing');
      c.placement = op.placement;
      return next;
    }
    case 'replacePartSources': {
      if (!Array.isArray(op.parts) || !op.parts.length) fail('replace-parts-empty');
      const seen = new Set<string>();
      for (const r of op.parts) {
        if (seen.has(r.partId)) fail('replace-parts-duplicate');
        seen.add(r.partId);
        const part = next.parts.find((p) => p.id === r.partId) ?? fail('target-missing');
        // Only a saved version is replaced, by another version of its Artifact.
        if (
          part.source.kind !== 'version' ||
          r.source?.kind !== 'version' ||
          r.source.artifactId !== part.source.artifactId
        )
          fail('replace-part-artifact');
        if (r.source.contentHash === part.source.contentHash) fail('replace-part-same');
        part.source = r.source;
        part.hint = r.hint;
      }
      // Two parts naming one version become one (the BOM counts a version once).
      const byVersion = new Map<string, string>();
      for (const p of next.parts) {
        const s = p.source;
        const key = JSON.stringify(
          s.kind === 'version'
            ? [s.artifactId, s.versionId, s.contentHash]
            : ['imported', s.contentHash],
        );
        const first = byVersion.get(key);
        if (first === undefined) byVersion.set(key, p.id);
        else for (const c of next.components) if (c.partId === p.id) c.partId = first;
      }
      return next;
    }
    case 'setPartProperties':
      next.partProperties = { partNumber: op.partNumber, description: op.description };
      return next;
    case 'insertComponentPattern':
      if (!next.components.some((c) => c.id === op.pattern.seedComponentId)) fail('target-missing');
      next.componentPatterns.push(op.pattern);
      return next;
    case 'updateComponentPattern': {
      const i = next.componentPatterns.findIndex((p) => p.id === op.pattern.id);
      if (i < 0) return fail('target-missing');
      if (next.componentPatterns[i]!.seedComponentId !== op.pattern.seedComponentId)
        fail('component-pattern-seed-changed');
      next.componentPatterns[i] = op.pattern;
      return next;
    }
    case 'setComponentBom': {
      const c = next.components.find((x) => x.id === op.componentId) ?? fail('target-missing');
      if (c.bom === op.bom) fail('component-bom-unchanged');
      c.bom = op.bom;
      return next;
    }
  }
}
/** Components whose placement reads one of these parameters (they go with a deleted parameter). */
export function componentsReading(doc: CadDocument, parameters: ReadonlySet<string>) {
  return doc.components
    .filter((c) =>
      c.placement?.translation.some((l) => lengthParameters(l).some((p) => parameters.has(p))),
    )
    .map((c) => c.id);
}
/**
 * Patterns that go with a deletion: named directly, of a removed seed, or laid out by a removed
 * parameter.
 */
export function patternsReading(
  doc: CadDocument,
  roots: ReadonlySet<string>,
  removed: { parameters: ReadonlySet<string>; components: ReadonlySet<string> },
) {
  return doc.componentPatterns
    .filter((p) => {
      if (roots.has(p.id) || removed.components.has(p.seedComponentId)) return true;
      const l = p.layout;
      const values =
        l.type === 'linear' ? [l.count, l.spacing] : [l.count, l.angle, ...l.axisOrigin];
      return values.some((v) => lengthParameters(v).some((x) => removed.parameters.has(x)));
    })
    .map((p) => p.id);
}
/**
 * After an edit: part definitions no component uses are dropped (the closure stays exact), and
 * every fixed component's pose is solved again from the current parameters.
 */
export function settleAssembly(doc: CadDocument) {
  const used = new Set(doc.components.map((c) => c.partId));
  doc.parts = doc.parts.filter((p) => used.has(p.id));
  solveAssemblyPoses(doc, parameterValues(doc));
}
