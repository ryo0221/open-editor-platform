/**
 * R3e-5c: recording a study's run with the analysis (docs/cad/r3-analysis.md, 評価記録 and 代表操作4).
 * A run that left a result (verified or reference) is kept as one Undo step, replacing the study's
 * earlier record; a record whose inputs no longer match the analysis is shown as out of date and is
 * never used as verified.
 */
import {
  freshSimulationId,
  simulationInputHash,
  simulationLimits,
  studyStatus,
  type SimulationDocument,
  type SimulationOperation,
  type SimulationRunRecord,
} from '@editor-platform/simulation-core';
import type { StudyRun } from './run';

const clip = (s: string) => {
  const cps = [...s];
  return cps.length <= simulationLimits.runTextCodePoints
    ? s
    : `${cps.slice(0, simulationLimits.runTextCodePoints - 1).join('')}…`;
};

/** The edit that records `run` of the current `doc` (the document it solved), or why not. */
export function recordRunOp(
  doc: SimulationDocument,
  run: StudyRun,
): { op: SimulationOperation } | { reason: string } {
  const status = run.status.status;
  if (status === 'failed' || !run.levels.length) return { reason: 'A failed run has no result.' };
  const last = run.levels.at(-1)!;
  const record: SimulationRunRecord = {
    id: freshSimulationId(doc, 'run'),
    studyId: run.studyId,
    inputs: {
      simulationHash: simulationInputHash(doc),
      cadContentHash: doc.source.contentHash,
      kernelBuild: run.builds.kernel,
      mesherBuild: run.builds.mesher,
      solverBuild: run.builds.solver,
    },
    levels: run.levels.map((l) => ({
      size: l.settings.size,
      nodes: l.nodes,
      elements: l.elements,
      metrics: { ...l.metrics },
    })),
    checks: last.checks
      .slice(0, simulationLimits.runChecks)
      .map((c) => ({ name: c.name, pass: c.pass, detail: clip(c.detail) })),
    status,
    reasons:
      status === 'verified'
        ? []
        : run.status.reasons.slice(0, simulationLimits.runReasons).map(clip),
  };
  return { op: { type: 'recordRun', run: record } };
}

/**
 * Whether a record still describes the analysis as it is now: the same inputs, CAD version and
 * kernel, mesher and solver builds. Unknown builds (nothing can run here) are not current.
 */
export const runRecordCurrent = (
  doc: SimulationDocument,
  r: SimulationRunRecord,
  /** The builds a run would use now; several when the study can also run on a compute Host. */
  builds: StudyRun['builds'] | (StudyRun['builds'] | undefined)[] | undefined,
) =>
  r.inputs.simulationHash === simulationInputHash(doc) &&
  r.inputs.cadContentHash === doc.source.contentHash &&
  (Array.isArray(builds) ? builds : [builds]).some(
    (b) =>
      !!b &&
      r.inputs.kernelBuild === b.kernel &&
      r.inputs.mesherBuild === b.mesher &&
      r.inputs.solverBuild === b.solver,
  );

/**
 * The status the record supports under its study (状態の決め方), never more than it claims: a
 * record says `verified` only when its checks and levels make it so.
 */
export function recordedStatus(doc: SimulationDocument, r: SimulationRunRecord) {
  const study = doc.studies.find((s) => s.id === r.studyId);
  if (!study || r.status !== 'verified') return r.status;
  return studyStatus({ study, checks: r.checks, levels: r.levels.map((l) => l.metrics) }).status ===
    'verified'
    ? 'verified'
    : 'reference';
}

const statusText = { verified: 'Verified', reference: 'Reference only' } as const;
const fmt = (v: number | undefined) =>
  v === undefined
    ? '–'
    : Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3
      ? v.toExponential(3)
      : v.toPrecision(4);

export function RecordPanel({
  doc,
  studyId,
  run,
  runCurrent,
  readOnly,
  builds,
  apply,
}: {
  doc: SimulationDocument;
  /** The builds a run would use now, if known (one per place a run can go). */
  builds: Parameters<typeof runRecordCurrent>[2];
  studyId: string | undefined;
  /** The shown run, if any. */
  run: StudyRun | undefined;
  /** The shown run solved the analysis as it is now. */
  runCurrent: boolean;
  readOnly: boolean;
  apply(op: SimulationOperation): string | undefined;
}) {
  const recorded = doc.runs?.find((r) => r.studyId === studyId);
  const prepared = run && runCurrent ? recordRunOp(doc, run) : undefined;
  if (!recorded && !prepared) return null;
  const finest = recorded?.levels.at(-1);
  const current = recorded ? runRecordCurrent(doc, recorded, builds) : false;
  const status = recorded ? recordedStatus(doc, recorded) : undefined;
  return (
    <fieldset className="simulation-group" aria-label="Recorded result">
      <legend>Recorded result</legend>
      <p className="simulation-note" aria-label="Recorded run">
        {recorded && finest
          ? `${statusText[status!]}, ${recorded.levels.length} level${recorded.levels.length === 1 ? '' : 's'}: ${finest.metrics['first-frequency'] !== undefined ? `first frequency ${fmt(finest.metrics['first-frequency'])} Hz` : finest.metrics['max-temperature'] !== undefined ? `max T ${fmt(finest.metrics['max-temperature'])} K, max |q| ${fmt(finest.metrics['max-heat-flux'])} kW/m²` : `max |u| ${fmt(finest.metrics['max-displacement'])} mm, max σvM ${fmt(finest.metrics['max-von-mises'])} MPa`}${current ? '' : ' (out of date: the analysis, its CAD version or a build changed since it was recorded)'}`
          : 'No run is recorded for this study.'}
      </p>
      {prepared && (
        <div className="simulation-actions">
          <button
            type="button"
            disabled={readOnly || 'reason' in prepared}
            title={'reason' in prepared ? prepared.reason : undefined}
            onClick={() => 'op' in prepared && apply(prepared.op)}
          >
            Record result
          </button>
        </div>
      )}
    </fieldset>
  );
}
