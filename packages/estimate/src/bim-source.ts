import { canonicalJson } from '@editor-platform/artifact-core';
import { assertBim, deriveBim, type BimDocument } from '@editor-platform/bim-core';
import {
  CalculationError,
  inspectSavedSource,
  numberDecimal,
  convert,
  decimal,
  formatDecimal,
  assertPersistable,
  pinKey,
  type SourcePin,
} from '@editor-platform/calculation-core';
import type {
  Quantity,
  RetainedSource,
  QuantityVerification,
} from '@editor-platform/estimate-core';
import { cadQuantityVerification } from './cad-source';
export interface BimQuantityEvaluation {
  contentHash: string;
  engine: string;
  status: 'ok' | 'superseded';
  elements: Map<string, { status: 'ok' | 'error' }>;
  quantities: Map<string, Record<string, number>>;
}
/** The Host reruns the actual kernel for this exact native content. Imported proofs are never sufficient. */
export type EstimateBimEvaluator = (
  document: BimDocument,
  pin: SourcePin,
  signal?: AbortSignal,
) => Promise<BimQuantityEvaluation>;
const fail = (code: string): never => {
  throw new CalculationError(code);
};
const metricUnits = {
  length: ['mm', 'm'],
  grossArea: ['mm2', 'm2'],
  netArea: ['mm2', 'm2'],
  grossVolume: ['mm3', 'm3'],
  netVolume: ['mm3', 'm3'],
} as const;
export type EstimateBimMetric = keyof typeof metricUnits;
function bim(value: unknown): BimDocument {
  assertBim(value);
  return value;
}
export async function retainBimSource(
  pin: SourcePin,
  native: unknown,
  sources: RetainedSource[] = [],
): Promise<RetainedSource> {
  if (pin.domain !== 'bim') fail('unsupported-quantity-source');
  const doc = bim(native);
  await inspectSavedSource(pin, doc, (v) => {
    try {
      bim(v);
      return true;
    } catch {
      return false;
    }
  });
  const dependencies = [
    ...new Set(
      doc.types.filter((t) => t.kind === 'part').map((t) => pinKey({ domain: 'cad', ...t.source })),
    ),
  ].sort();
  if (dependencies.some((key) => !sources.some((s) => s.key === key)))
    fail('missing-bim-cad-closure');
  return {
    key: pinKey(pin),
    pin: structuredClone(pin),
    nativeContent: structuredClone(doc),
    dependencies,
  };
}
export async function bimQuantity(
  source: RetainedSource,
  elementId: string,
  metric: EstimateBimMetric,
  id: string,
  evaluate?: EstimateBimEvaluator,
  signal?: AbortSignal,
): Promise<Quantity> {
  if (signal?.aborted) fail('cancelled');
  if (source.pin.domain !== 'bim') fail('unsupported-quantity-source');
  const doc = bim(source.nativeContent),
    derived = deriveBim(doc),
    element = doc.elements.find((e) => e.id === elementId);
  await inspectSavedSource(source.pin, doc, (v) => {
    try {
      bim(v);
      return true;
    } catch {
      return false;
    }
  });
  if (
    !element ||
    derived.diagnostics.some((d) => d.severity === 'error' && (!d.id || d.id === elementId))
  )
    fail('bim-element-diagnostic');
  const quantity = derived.quantities.get(elementId);
  if (!quantity || quantity.source === 'none') return fail('bim-quantity-unavailable');
  if (!Object.hasOwn(metricUnits, metric)) return fail('unsupported-bim-metric');
  let values = quantity.values,
    engine = 'bim-analytic-1';
  if (quantity.source === 'kernel') {
    if (!evaluate) return fail('bim-kernel-verifier-required');
    const result = await evaluate(doc, source.pin, signal);
    if (signal?.aborted) fail('cancelled');
    if (result.contentHash !== source.pin.contentHash || result.status !== 'ok')
      return fail('stale-bim-evaluation');
    if (result.elements.get(elementId)?.status !== 'ok')
      return fail('bim-element-evaluation-failed');
    const measured = result.quantities.get(elementId);
    if (!measured) return fail('missing-bim-metric');
    values = measured;
    engine = `bim-kernel-1:${result.engine}`;
  }
  if (!Object.hasOwn(values, metric) || !Number.isFinite(values[metric]) || values[metric] < 0)
    return fail('missing-bim-metric');
  if (signal?.aborted) fail('cancelled');
  const [from, unit] = metricUnits[metric],
    value = convert(decimal(numberDecimal(values[metric])), from, unit);
  assertPersistable(value);
  return {
    id,
    name: element!.name ?? elementId,
    unit,
    value: formatDecimal(value),
    quality: quantity.source,
    evidence: `BIM ${quantity.source} · ${elementId} · ${metric} (${from}→${unit})。幾何計測の数値精度は元評価に依存します。`,
    inclusion: 'include',
    exclusionReason: '',
    source: {
      snapshotKey: source.key,
      identity: elementId,
      metric,
      scope: 'whole',
      coverage: [canonicalJson(['bim', source.pin.artifactId, elementId])],
      extractionBasis: `${engine}:${source.pin.contentHash}`,
    },
  };
}
export function bimQuantityVerification(evaluate?: EstimateBimEvaluator): QuantityVerification {
  return {
    async verifySource(source, sources) {
      if (source.pin.domain === 'cad') return cadQuantityVerification.verifySource(source, sources);
      const expected = await retainBimSource(source.pin, source.nativeContent, sources);
      if (canonicalJson(expected.dependencies) !== canonicalJson(source.dependencies))
        fail('source-closure-mismatch');
    },
    async verifyQuantities(quantities, sources) {
      await cadQuantityVerification.verifyQuantities(
        quantities.filter((q) => q.quality === 'cad'),
        sources,
      );
      for (const q of quantities)
        if (q.source && q.quality !== 'cad') {
          const source = sources.find((s) => s.key === q.source!.snapshotKey);
          if (!source) return fail('missing-quantity-source');
          const expected = await bimQuantity(
            source,
            q.source.identity,
            q.source.metric as EstimateBimMetric,
            q.id,
            evaluate,
          );
          if (
            q.value !== expected.value ||
            q.unit !== expected.unit ||
            q.quality !== expected.quality ||
            canonicalJson(q.source) !== canonicalJson(expected.source)
          )
            fail('quantity-source-mismatch');
        }
    },
  };
}
