import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { CalculationError, type SourcePin } from '@editor-platform/calculation-core';
import { assertAnalysis } from './validate';
import { evaluateBasis } from './evaluate';
import { verifyRetainedSource } from './sources';
import { ENGINE, type AnalysisDocument } from './types';
export interface AnalysisGuard {
  canEdit(): boolean;
  canRead(pin: SourcePin): boolean;
  inputsReady(): boolean;
}
export function assertAnalysisAccess(
  document: AnalysisDocument,
  guard: Pick<AnalysisGuard, 'canRead'>,
): void {
  for (const source of document.retainedSources)
    if (!guard.canRead(source.pin))
      throw new CalculationError('source-access-denied', source.pin.artifactId);
}
/** One native command. Permission and input guards are rechecked at apply, including headless/proposal. */
export function replaceAnalysis(
  expected: AnalysisDocument,
  next: AnalysisDocument,
  guard: AnalysisGuard,
  label = 'Edit analysis',
): EditorCommand<AnalysisDocument> {
  assertAnalysis(next);
  for (const run of expected.runs) {
    const retained = next.runs.find((r) => r.id === run.id);
    if (retained && canonicalJson(retained) !== canonicalJson(run))
      throw new CalculationError('immutable-run');
  }
  const base = canonicalJson(expected),
    replacement = structuredClone(next);
  return command('analysis.edit', label, (current) => {
    if (!guard.canEdit()) throw new CalculationError('read-only');
    if (!guard.inputsReady()) throw new CalculationError('input-pending');
    if (canonicalJson(current) !== base) throw new CalculationError('stale-analysis');
    assertAnalysisAccess(current, guard);
    assertAnalysisAccess(replacement, guard);
    assertAnalysis(replacement);
    return structuredClone(replacement);
  });
}
/** Never trust stored result hashes alone: replay every retained run against its own input pins. */
export async function verifyAnalysis(
  value: unknown,
  ownArtifactId?: string,
  allowUnknownEngine = false,
): Promise<AnalysisDocument> {
  assertAnalysis(value);
  const document = structuredClone(value);
  const identities = new Set<string>();
  for (const source of document.retainedSources) {
    if (source.pin.artifactId === ownArtifactId) throw new CalculationError('self-reference');
    if (identities.has(source.key)) throw new CalculationError('duplicate-source');
    identities.add(source.key);
    await verifyRetainedSource(source);
  }
  for (const run of document.runs) {
    if (run.basis.engine !== ENGINE) {
      if (
        (await contentHash(run.basis)) !== run.basisHash ||
        (await contentHash(run.results)) !== run.resultHash
      )
        throw new CalculationError('unverified-result');
      if (allowUnknownEngine) continue;
      throw new CalculationError('unsupported-engine');
    }
    const results = evaluateBasis(run.basis, document);
    if (
      (await contentHash(run.basis)) !== run.basisHash ||
      (await contentHash(results)) !== run.resultHash ||
      canonicalJson(results) !== canonicalJson(run.results)
    )
      throw new CalculationError('unverified-result', run.id);
  }
  return document;
}
