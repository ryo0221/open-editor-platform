import { canonicalJson } from '@editor-platform/artifact-core';
import {
  cadQuantityRows,
  cadContentHash,
  assertCad,
  type CadDocument,
} from '@editor-platform/cad-core';
import {
  CalculationError,
  inspectSavedSource,
  pinKey,
  type SourcePin,
} from '@editor-platform/calculation-core';
import type {
  RetainedSource,
  Quantity,
  QuantityVerification,
} from '@editor-platform/estimate-core';

const fail = (code: string): never => {
  throw new CalculationError(code);
};
function cad(value: unknown): CadDocument {
  assertCad(value);
  return value;
}
/** Retain exactly the native count inputs, recursively including part versions. No kernel needed. */
export async function retainCadSource(
  pin: SourcePin,
  native: unknown,
  lookup: (hash: string) => unknown,
): Promise<RetainedSource[]> {
  const retained = new Map<string, RetainedSource>(),
    visiting = new Set<string>();
  const walk = async (sourcePin: SourcePin, value: unknown) => {
    if (sourcePin.domain !== 'cad') fail('unsupported-quantity-source');
    const key = pinKey(sourcePin);
    if (visiting.has(key)) fail('source-cycle');
    if (retained.has(key)) return key;
    if (retained.size + visiting.size >= 8) fail('source-limit');
    visiting.add(key);
    const content = cad(value);
    await inspectSavedSource(sourcePin, content, (v) => {
      try {
        cad(v);
        return true;
      } catch {
        return false;
      }
    });
    const dependencies: string[] = [];
    for (const part of content.parts) {
      if (part.source.kind !== 'version') return fail('imported-part-unsupported');
      const child = lookup(part.source.contentHash);
      if (!child) fail('missing-source-closure');
      dependencies.push(
        await walk(
          {
            domain: 'cad',
            artifactId: part.source.artifactId,
            versionId: part.source.versionId,
            contentHash: part.source.contentHash,
          },
          child,
        ),
      );
    }
    retained.set(key, {
      key,
      pin: structuredClone(sourcePin),
      nativeContent: structuredClone(content),
      dependencies: [...new Set(dependencies)].sort(),
    });
    visiting.delete(key);
    return key;
  };
  await walk(pin, native);
  return [...retained.values()];
}
export function cadSourceProjection(source: RetainedSource, sources: RetainedSource[]) {
  const content = cad(source.nativeContent);
  const lookup = new Map(
    sources
      .filter((s) => s.pin.domain === 'cad')
      .map((s) => [s.pin.contentHash, cad(s.nativeContent)]),
  );
  return cadQuantityRows(source.pin.artifactId, content, (hash) => lookup.get(hash));
}
export function cadQuantity(
  source: RetainedSource,
  sources: RetainedSource[],
  identity: string,
  id: string,
): Quantity {
  const row = cadSourceProjection(source, sources).rows.find((r) => r.identity === identity);
  if (!row) return fail('missing-quantity-identity');
  return {
    id,
    name: row.name,
    unit: 'count',
    value: String(row.count),
    quality: 'cad',
    evidence: '保存CADの部品/本体数量。形状から重量・加工時間を推定しません。',
    inclusion: row.excluded ? 'exclude' : 'include',
    exclusionReason: row.excluded ? 'CAD BOMの除外指定' : '',
    source: {
      snapshotKey: source.key,
      identity: row.identity,
      metric: 'count',
      scope: 'whole',
      coverage: row.coverage,
      extractionBasis: `cad-count-1:${source.pin.contentHash}`,
    },
  };
}
export const cadQuantityVerification: QuantityVerification = {
  async verifySource(source, sources) {
    if (source.pin.domain !== 'cad') fail('unsupported-quantity-source');
    const content = cad(source.nativeContent);
    if (cadContentHash(content) !== source.pin.contentHash) fail('source-hash-mismatch');
    const expected = [
      ...new Set(
        content.parts.map((part) => {
          if (part.source.kind !== 'version') return fail('imported-part-unsupported');
          return pinKey({
            domain: 'cad',
            artifactId: part.source.artifactId,
            versionId: part.source.versionId,
            contentHash: part.source.contentHash,
          });
        }),
      ),
    ].sort();
    if (canonicalJson(expected) !== canonicalJson([...source.dependencies].sort()))
      fail('source-closure-mismatch');
    if (expected.some((key) => !sources.some((s) => s.key === key))) fail('missing-source-closure');
    cadSourceProjection(source, sources);
  },
  async verifyQuantities(quantities, sources) {
    for (const quantity of quantities)
      if (quantity.source) {
        if (quantity.quality !== 'cad') fail('unsupported-quantity-source');
        const source = sources.find((s) => s.key === quantity.source!.snapshotKey);
        if (!source || source.pin.domain !== 'cad') return fail('missing-quantity-source');
        const expected = cadQuantity(source, sources, quantity.source.identity, quantity.id);
        if (
          canonicalJson(quantity.source) !== canonicalJson(expected.source) ||
          quantity.value !== expected.value ||
          quantity.unit !== expected.unit
        )
          fail('quantity-source-mismatch');
        if (expected.inclusion === 'exclude' && quantity.inclusion !== 'exclude')
          fail('source-exclusion-mismatch');
      }
  },
};
export interface CadUpdateDifference {
  id: string;
  state: 'unchanged' | 'changed' | 'added' | 'removed' | 'ambiguous';
  before: string | null;
  after: string | null;
}
/** Prepare only. Removed/ambiguous rows remain pending and never silently lose their line mapping. */
export async function proposeCadSourceUpdate(
  document: import('@editor-platform/estimate-core').EstimateDocument,
  oldKey: string,
  replacement: RetainedSource,
  closure: RetainedSource[],
  allocateId: () => string,
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
    await cadQuantityVerification.verifySource(source, next.retainedSources);
  const oldRows = new Map(
    cadSourceProjection(old!, next.retainedSources).rows.map((r) => [r.identity, r]),
  );
  const newRows = new Map(
    cadSourceProjection(replacement, next.retainedSources).rows.map((r) => [r.identity, r]),
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
      const updated = cadQuantity(replacement, next.retainedSources, after.identity, q.id);
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
      const q = cadQuantity(replacement, next.retainedSources, row.identity, allocateId());
      if (!row.excluded) q.inclusion = 'pending';
      next.quantities.push(q);
      differences.push({ id: q.id, state: 'added', before: null, after: q.value });
    }
  return { document: next, differences };
}
