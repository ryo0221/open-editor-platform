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
  type GeometrySourceInput,
  type MeasuredQuantity,
  type QuantityVerification,
  type RetainedSource,
  type SourcePin,
} from '@editor-platform/calculation-core';

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
/** The count of one CAD row, as the calculation stores it. */
export function cadMeasurement(
  source: RetainedSource,
  sources: RetainedSource[],
  identity: string,
): MeasuredQuantity {
  const row = cadSourceProjection(source, sources).rows.find((r) => r.identity === identity);
  if (!row) return fail('missing-quantity-identity');
  return {
    name: row.name,
    unit: 'count',
    value: String(row.count),
    quality: 'cad',
    evidence: '保存CADの部品/本体数量。形状から重量・加工時間を推定しません。',
    excluded: row.excluded,
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
/** Retain a saved CAD and its saved part closure; `root` is the CAD itself. */
export async function retainCadInput(input: GeometrySourceInput) {
  const sources = await retainCadSource(
    input.pin,
    input.content,
    (hash) => input.closure.find((c) => c.contentHash === hash)?.content,
  );
  return { root: sources.find((s) => s.key === pinKey(input.pin))!, sources };
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
        const expected = cadMeasurement(source, sources, quantity.source.identity);
        if (
          canonicalJson(quantity.source) !== canonicalJson(expected.source) ||
          quantity.value !== expected.value ||
          quantity.unit !== expected.unit
        )
          fail('quantity-source-mismatch');
        if (expected.excluded && quantity.inclusion !== 'exclude')
          fail('source-exclusion-mismatch');
      }
  },
};
