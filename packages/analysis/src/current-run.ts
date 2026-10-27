import { canonicalJson } from '@editor-platform/artifact-core';
import { makeBasis, type AnalysisDocument, type Run } from '@editor-platform/analysis-core';

/** Classify an already verified run without requiring its old scenario to remain editable. */
export function isCurrentRun(document: AnalysisDocument, run: Run): boolean {
  return (
    (run.basis.scenarioId === null ||
      document.scenarios.some((scenario) => scenario.id === run.basis.scenarioId)) &&
    canonicalJson(run.basis) === canonicalJson(makeBasis(document, run.basis.scenarioId))
  );
}
