import { newId } from '@editor-platform/artifact-core';
import { CalculationError } from '@editor-platform/calculation-core';
import { assertAnalysis } from './validate';
import type { AnalysisDocument } from './types';
/** Duplicate one step and its declared outputs; remap every field owned by that step. */
export function duplicateAnalysisStep(
  document: AnalysisDocument,
  stepId: string,
): AnalysisDocument {
  const original = document.steps.find((s) => s.id === stepId);
  if (!original) throw new CalculationError('missing-step', stepId);
  const step = structuredClone(original);
  step.id = newId('step');
  const fields = new Map<string, string>();
  const remap = (id: string) => {
    if (!fields.has(id)) fields.set(id, newId('field'));
    return fields.get(id)!;
  };
  if (step.op === 'derive') step.field.id = remap(step.field.id);
  if (step.op === 'select' || step.op === 'join')
    for (const column of step.columns) column.field.id = remap(column.field.id);
  if (step.op === 'aggregate')
    for (const metric of step.metrics) metric.field.id = remap(metric.field.id);
  const next = {
    ...document,
    steps: [...document.steps, step],
    outputs: [
      ...document.outputs,
      ...document.outputs
        .filter((o) => o.stepId === stepId)
        .map((o) => ({
          ...o,
          id: newId('output'),
          stepId: step.id,
          columns: o.columns.map((id) => fields.get(id) ?? id),
        })),
    ],
  };
  assertAnalysis(next);
  return next;
}
export function moveAnalysisStep(
  document: AnalysisDocument,
  id: string,
  direction: -1 | 1,
): AnalysisDocument {
  const index = document.steps.findIndex((s) => s.id === id),
    other = index + direction;
  if (index < 0 || other < 0 || other >= document.steps.length)
    throw new CalculationError('invalid-step-order');
  const steps = [...document.steps];
  [steps[index], steps[other]] = [steps[other], steps[index]];
  return { ...document, steps };
}

/** Restore only input pins/mappings; preserve the current recipe, notes and every past run. */
export function restoreAnalysisInputs(document: AnalysisDocument, runId: string): AnalysisDocument {
  const run = document.runs.find((r) => r.id === runId);
  if (!run) throw new CalculationError('missing-run');
  const next = {
    ...document,
    inputs: document.inputs.map((input) => {
      const previous = run.basis.inputs.find((i) => i.id === input.id);
      if (!previous) throw new CalculationError('missing-historical-input', input.id);
      return {
        ...input,
        snapshotKey: previous.snapshotKey,
        selectedColumnIds: [...previous.selectedColumnIds],
        ...(previous.columnMapping
          ? { columnMapping: { ...previous.columnMapping } }
          : { columnMapping: undefined }),
      };
    }),
  };
  // Optional keys must remain absent in native JSON.
  for (const input of next.inputs)
    if (input.columnMapping === undefined) delete input.columnMapping;
  assertAnalysis(next);
  return next;
}
