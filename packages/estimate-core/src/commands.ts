import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { CalculationError, type SourcePin } from '@editor-platform/calculation-core';
import { assertEstimate } from './validate';
import { evaluateEstimate } from './evaluate';
import { assertRateSources, retainPriceData } from './sources';
import { ENGINE, type EstimateDocument, type RetainedSource, type Quantity } from './types';
export interface EstimateGuard {
  canEdit(): boolean;
  canRead(pin: SourcePin): boolean;
  inputsReady(): boolean;
}
export function assertEstimateAccess(
  document: EstimateDocument,
  guard: Pick<EstimateGuard, 'canRead'>,
) {
  for (const source of document.retainedSources)
    if (!guard.canRead(source.pin))
      throw new CalculationError('source-access-denied', source.pin.artifactId);
}
export function replaceEstimate(
  expected: EstimateDocument,
  next: EstimateDocument,
  guard: EstimateGuard,
  label = 'Edit estimate',
): EditorCommand<EstimateDocument> {
  assertEstimate(next);
  assertRateSources(next.rates, next.retainedSources);
  for (const run of expected.calculations) {
    const retained = next.calculations.find((r) => r.id === run.id);
    if (retained && canonicalJson(retained) !== canonicalJson(run))
      throw new CalculationError('immutable-calculation');
  }
  const base = canonicalJson(expected),
    replacement = structuredClone(next);
  return command('estimate.edit', label, (current) => {
    if (!guard.canEdit()) throw new CalculationError('read-only');
    if (!guard.inputsReady()) throw new CalculationError('input-pending');
    if (canonicalJson(current) !== base) throw new CalculationError('stale-estimate');
    assertEstimateAccess(current, guard);
    assertEstimateAccess(replacement, guard);
    assertEstimate(replacement);
    return structuredClone(replacement);
  });
}
export interface QuantityVerification {
  verifySource(source: RetainedSource, sources: RetainedSource[]): Promise<void>;
  verifyQuantities(quantities: Quantity[], sources: RetainedSource[]): Promise<void>;
}
export async function verifyEstimate(
  value: unknown,
  ownArtifactId?: string,
  allowUnknownEngine = false,
  quantities?: QuantityVerification,
): Promise<EstimateDocument> {
  assertEstimate(value);
  const doc = structuredClone(value);
  for (const source of doc.retainedSources) {
    if (source.pin.artifactId === ownArtifactId) throw new CalculationError('self-reference');
    if (source.pin.domain === 'data') await retainPriceData(source.pin, source.nativeContent);
    else {
      if (!quantities) throw new CalculationError('quantity-verifier-required');
      await quantities.verifySource(source, doc.retainedSources);
    }
  }
  if (doc.quantities.some((q) => q.source)) {
    if (!quantities) throw new CalculationError('quantity-verifier-required');
    await quantities.verifyQuantities(doc.quantities, doc.retainedSources);
  }
  assertRateSources(doc.rates, doc.retainedSources);
  for (const run of doc.calculations) {
    if (run.basis.quantities.some((q) => q.source)) {
      if (!quantities) throw new CalculationError('quantity-verifier-required');
      await quantities.verifyQuantities(run.basis.quantities, doc.retainedSources);
    }
    assertRateSources(run.basis.rates, doc.retainedSources);
    const sources = [
      ...new Set(
        [...run.basis.rates, ...run.basis.quantities].flatMap((r) =>
          r.source ? [r.source.snapshotKey] : [],
        ),
      ),
    ].sort();
    if (canonicalJson(sources) !== canonicalJson(run.basis.sources))
      throw new CalculationError('source-closure-mismatch');
    if (
      (await contentHash(run.basis)) !== run.basisHash ||
      (await contentHash(run.result)) !== run.resultHash
    )
      throw new CalculationError('unverified-result');
    if (run.basis.engine !== ENGINE) {
      if (allowUnknownEngine) continue;
      throw new CalculationError('unsupported-engine');
    }
    if (canonicalJson(evaluateEstimate(run.basis)) !== canonicalJson(run.result))
      throw new CalculationError('unverified-result', run.id);
  }
  return doc;
}
