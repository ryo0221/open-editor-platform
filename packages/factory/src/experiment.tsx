import { useMemo } from 'react';
import { Download, FlaskConical, Square, Trash2 } from 'lucide-react';
import {
  factoryExperimentCombinations,
  factoryExperimentOf,
  factoryExperimentSize,
  factoryFactorKinds,
  factoryLimits,
  summarizeFactoryExperiment,
  writeFactoryExperimentCsv,
  writeFactoryExperimentRunsCsv,
  type FactoryDocument,
  type FactoryExperiment,
  type FactoryExperimentStat,
  type FactoryFactor,
  type FactoryFactorKind,
} from '@editor-platform/factory-core';
import type { FactoryController, FactorySurfaceState } from './controller';
import { Choice, Field, useSettle } from './fields';

export const factoryFactorLabels: Record<FactoryFactorKind, string> = {
  'buffer-capacity': 'Buffer capacity',
  'parallel-count': 'Machines',
  'fleet-count': 'Vehicles',
  'pool-count': 'Workers',
  'time-scale': 'Time %',
};

/** What a factor of a kind can change in the model: `[id, name, current value]`. */
function targets(doc: FactoryDocument, kind: FactoryFactorKind): [string, string, number][] {
  switch (kind) {
    case 'buffer-capacity':
      return doc.objects.flatMap((o) => (o.kind === 'buffer' ? [[o.id, o.name, o.capacity]] : []));
    case 'parallel-count':
      return doc.objects.flatMap((o) => (o.kind === 'parallel' ? [[o.id, o.name, o.count]] : []));
    case 'time-scale':
      return doc.objects.flatMap((o) =>
        o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly'
          ? [[o.id, o.name, 100]]
          : [],
      );
    case 'fleet-count':
      return (doc.fleets ?? []).map((f) => [f.id, f.name, f.count]);
    case 'pool-count':
      return (doc.workerPools ?? []).map((p) => [p.id, p.name, p.count]);
  }
}
const factorMax: Record<FactoryFactorKind, number> = {
  'buffer-capacity': factoryLimits.bufferCapacity,
  'parallel-count': factoryLimits.parallelCount,
  'fleet-count': factoryLimits.vehiclesPerFleet,
  'pool-count': factoryLimits.workersPerPool,
  'time-scale': factoryLimits.timeScalePercent,
};
/** Starting values: around the model's own value. */
function startValues(kind: FactoryFactorKind, v: number): number[] {
  const raw =
    kind === 'time-scale' ? [90, 100, 110] : kind === 'buffer-capacity' ? [v, v * 2] : [v, v + 1];
  return [...new Set(raw.map((x) => Math.min(Math.max(1, x), factorMax[kind])))];
}
/** `1, 5, 10` → whole numbers, or undefined when one is not. */
function readValues(text: string): number[] | undefined {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.some((p) => !/^[0-9]+$/.test(p))) return undefined;
  return parts.map(Number);
}

const plusMinus = (s: FactoryExperimentStat, digits: number, scale = 1) =>
  s.n === 0
    ? '—'
    : `${(s.mean / scale).toFixed(digits)}${s.halfWidth === undefined ? '' : ` ± ${(s.halfWidth / scale).toFixed(digits)}`}`;

function download(text: string, file: string) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * FT5: the experiment of the model (replications and a table of factors), its run in the
 * Worker with a stop button, and the comparison table (means with 95% intervals) with CSV.
 */
export function ExperimentPanel({
  controller,
  state,
  name,
}: {
  controller: FactoryController;
  state: FactorySurfaceState;
  name: string;
}) {
  const settle = useSettle();
  const doc = state.content;
  const locked = state.readOnly;
  const experiment = factoryExperimentOf(doc);
  const combinations = factoryExperimentCombinations(experiment).length;
  const put = (next: FactoryExperiment) =>
    !controller.apply({ type: 'setExperiment', experiment: next });
  const putFactor = (i: number, f: FactoryFactor) =>
    put({ ...experiment, factors: experiment.factors.map((x, j) => (j === i ? f : x)) });
  const used = new Set(experiment.factors.map((f) => `${f.kind}\u0000${f.targetId}`));
  const freeTarget = (kind: FactoryFactorKind) =>
    targets(doc, kind).find(([id]) => !used.has(`${kind}\u0000${id}`));
  const addable = factoryFactorKinds.find((k) => freeTarget(k));
  const addFactor = () => {
    if (!addable) return;
    const [id, , v] = freeTarget(addable)!;
    put({
      ...experiment,
      factors: [
        ...experiment.factors,
        { kind: addable, targetId: id, values: startValues(addable, v) },
      ],
    });
  };
  const last = state.experiment;
  const rows = useMemo(
    () => (last ? summarizeFactoryExperiment(last.experiment, last.runs) : []),
    [last],
  );
  const names = new Map<string, string>([
    ...doc.objects.map((o) => [o.id, o.name || o.id] as const),
    ...(doc.fleets ?? []).map((f) => [f.id, f.name || f.id] as const),
    ...(doc.workerPools ?? []).map((p) => [p.id, p.name || p.id] as const),
  ]);
  const best = rows.reduce<number | undefined>(
    (b, r) =>
      r.stats.throughputPerHour.n &&
      (b === undefined || r.stats.throughputPerHour.mean > rows[b]!.stats.throughputPerHour.mean)
        ? r.combination
        : b,
    undefined,
  );
  const stale = !!last && last.key !== state.key;
  const file = name || 'factory';
  return (
    <section className="fac-results fac-experiment" data-testid="fac-experiment">
      <h3>Experiment</h3>
      <div className="fac-experiment-setup">
        <Field
          readOnly={locked}
          label="Replications (seeds)"
          value={String(experiment.replications)}
          onCommit={(v) =>
            /^[0-9]+$/.test(v.trim()) && put({ ...experiment, replications: Number(v) })
          }
        />
        <ul className="fac-list" data-testid="fac-factors">
          {experiment.factors.map((f, i) => (
            <li key={`${f.kind}-${f.targetId}`} className="fac-factor">
              <Choice
                label={`Factor ${i + 1}`}
                value={f.kind}
                disabled={locked}
                options={factoryFactorKinds
                  .filter((k) => k === f.kind || freeTarget(k))
                  .map((k) => ({ value: k, label: factoryFactorLabels[k] }))}
                onChange={(k) =>
                  settle(() => {
                    const kind = k as FactoryFactorKind;
                    const [id, , v] = freeTarget(kind)!;
                    putFactor(i, { kind, targetId: id, values: startValues(kind, v) });
                  })
                }
              />
              <Choice
                label={`Target of factor ${i + 1}`}
                value={f.targetId}
                disabled={locked}
                options={targets(doc, f.kind)
                  .filter(([id]) => id === f.targetId || !used.has(`${f.kind}\u0000${id}`))
                  .map(([id, n]) => ({ value: id, label: n || id }))}
                onChange={(id) => settle(() => putFactor(i, { ...f, targetId: id }))}
              />
              <Field
                readOnly={locked}
                label={`Values of factor ${i + 1} (comma)`}
                value={f.values.join(', ')}
                onCommit={(v) => {
                  const values = readValues(v);
                  return !!values && putFactor(i, { ...f, values });
                }}
              />
              <button
                disabled={locked}
                aria-label={`Remove factor ${i + 1}`}
                onClick={() =>
                  settle(() =>
                    put({ ...experiment, factors: experiment.factors.filter((_, j) => j !== i) }),
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <div className="fac-experiment-actions">
          <button
            disabled={
              locked || !addable || experiment.factors.length >= factoryLimits.experimentFactors
            }
            onClick={() => settle(addFactor)}
          >
            Add factor
          </button>
          <span data-testid="fac-experiment-size">
            {combinations} combination{combinations === 1 ? '' : 's'} × {experiment.replications}{' '}
            replication{experiment.replications === 1 ? '' : 's'} ={' '}
            {factoryExperimentSize(experiment)} runs
          </span>
          {state.experimenting ? (
            <button onClick={() => controller.stopExperiment()}>
              <Square size={14} /> Stop experiment
            </button>
          ) : (
            <button
              disabled={!doc.objects.length}
              onClick={() => settle(() => void controller.runExperiment())}
            >
              <FlaskConical size={14} /> Run experiment
            </button>
          )}
        </div>
      </div>
      {last && (
        <div data-stale={stale || undefined}>
          <p className="fac-experiment-progress" data-testid="fac-experiment-progress">
            <progress value={last.runs.length} max={last.total} /> {last.runs.length} / {last.total}{' '}
            runs
            {state.experimenting ? ' · running…' : last.done ? ' · done' : ' · stopped'}
          </p>
          {stale && (
            <p className="fac-stale">
              This experiment ran on an earlier version of the model. Run it again.
            </p>
          )}
          <table className="fac-table" data-testid="fac-experiment-table">
            <thead>
              <tr>
                {last.experiment.factors.map((f, i) => (
                  <th key={i}>
                    {factoryFactorLabels[f.kind]} · {names.get(f.targetId) ?? f.targetId}
                  </th>
                ))}
                <th>Runs</th>
                <th>Per hour</th>
                <th>Lead time (s)</th>
                <th>Work in progress</th>
                <th>Deadlocks</th>
                <th>Bottleneck</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.combination} data-best={r.combination === best || undefined}>
                  {r.values.map((v, i) => (
                    <td key={i}>{v}</td>
                  ))}
                  <td>
                    {r.runs}
                    {r.failed ? ` (${r.failed} failed)` : ''}
                  </td>
                  <td>{plusMinus(r.stats.throughputPerHour, 1)}</td>
                  <td>{plusMinus(r.stats.leadTimeMeanMs, 1, 1000)}</td>
                  <td>{plusMinus(r.stats.wipMean, 1)}</td>
                  <td>
                    {r.stats.deadlock.n
                      ? `${Math.round(r.stats.deadlock.mean * r.stats.deadlock.n)} / ${r.stats.deadlock.n}`
                      : '—'}
                  </td>
                  <td>{r.bottleneck ? (names.get(r.bottleneck) ?? r.bottleneck) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fac-experiment-note">
            Means with 95% confidence intervals (Student t) over the replications that finished.
          </p>
          <div className="fac-experiment-actions">
            <button
              disabled={!last.runs.length}
              onClick={() =>
                download(
                  writeFactoryExperimentCsv(last.experiment, last.runs),
                  `${file}-experiment.csv`,
                )
              }
            >
              <Download size={14} /> Table CSV
            </button>
            <button
              disabled={!last.runs.length}
              onClick={() =>
                download(
                  writeFactoryExperimentRunsCsv(last.experiment, last.runs),
                  `${file}-experiment-runs.csv`,
                )
              }
            >
              <Download size={14} /> Runs CSV
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
