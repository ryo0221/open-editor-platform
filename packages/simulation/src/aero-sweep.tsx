/**
 * VS4d (docs/cad/vehicle-simulation.md, VS4): a yaw sweep of a wind-tunnel study. Each angle is
 * one run of the study at that yaw (`aeroAtYaw`, the document is not changed), one after another,
 * in the browser or on the compute Host; the table gives each angle's finest-level coefficients.
 * Display only: a sweep is not recorded (each run can be run and recorded on its own). A sweep
 * belongs to its study and inputs (`inputKey`): another study or an edit stops it and clears the
 * table, so one table never mixes settings.
 */
import { useEffect, useRef, useState } from 'react';
import { simulationLimits, type SimulationAeroStudy } from '@editor-platform/simulation-core';
import { parseYawSweep } from './run-aero';
import { fmt, type SimulationRunner } from './run-panel';

export interface SweepRow {
  yawDeg: number;
  cd?: number;
  cl?: number;
  cs?: number;
  /** The run's status (`reference` for every V1 wind tunnel) and its reasons. */
  status?: string;
  reasons?: string[];
  /** Why the run gave no coefficients (its failure, or the error that stopped it). */
  failure?: string;
}

export function YawSweep({
  study,
  runner,
  readOnly,
  inputKey,
}: {
  study: SimulationAeroStudy;
  /** The study's inputs (its settings, the source version and bodies): a change ends the sweep. */
  inputKey: string;
  runner: SimulationRunner;
  readOnly: boolean;
}) {
  const [text, setText] = useState('0, 5, 10, 15');
  const [rows, setRows] = useState<SweepRow[]>([]);
  const [running, setRunning] = useState<{ at: number; of: number; cancel(): void }>();
  const [error, setError] = useState('');
  const stop = useRef<() => void>(undefined);
  // A sweep stops with the Surface (another Artifact opened).
  useEffect(() => () => stop.current?.(), []);
  // Another study or an edit: the running sweep stops and the table (of other inputs) goes.
  useEffect(() => {
    stop.current?.();
    setRows([]);
  }, [study.id, inputKey]);
  const start = (onHost: boolean) => {
    const angles = parseYawSweep(text, simulationLimits.aeroYawDeg);
    if (typeof angles === 'string') return setError(angles);
    setError('');
    setRows([]);
    let live = true;
    let job: ReturnType<SimulationRunner['run']> | undefined;
    const cancel = () => {
      live = false;
      job?.cancel();
      stop.current = undefined;
      setRunning(undefined);
    };
    stop.current = cancel;
    void (async () => {
      const done: SweepRow[] = [];
      for (let i = 0; i < angles.length && live; i++) {
        const yawDeg = angles[i]!;
        setRunning({ at: i, of: angles.length, cancel });
        job = runner.run(study.id, () => undefined, { onHost, yawDeg });
        let row: SweepRow;
        try {
          const run = await job.result;
          const m = run.levels.at(-1)?.metrics;
          row = run.failure
            ? { yawDeg, failure: `${run.failure.code}: ${run.failure.detail}` }
            : {
                yawDeg,
                cd: m?.['drag-coefficient'],
                cl: m?.['lift-coefficient'],
                cs: m?.['side-force-coefficient'],
                status: run.status.status,
                reasons: run.status.reasons,
              };
        } catch (e) {
          row = { yawDeg, failure: e instanceof Error ? e.message : String(e) };
        }
        if (!live) return;
        done.push(row);
        setRows([...done]);
      }
      if (live) cancel();
    })();
  };
  const hostAero = !!runner.host?.aero;
  return (
    <fieldset className="simulation-group" aria-label="Yaw sweep">
      <legend>Yaw sweep</legend>
      <label className="simulation-field">
        <span>
          Yaw angles <small>° (air from the left when positive)</small>
        </span>
        <input
          aria-label="Yaw angles"
          value={text}
          disabled={!!running}
          onChange={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <div className="simulation-actions">
        {running ? (
          <button type="button" onClick={running.cancel}>
            Cancel sweep
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={readOnly || !!runner.unavailable}
              onClick={() => start(false)}
            >
              Run yaw sweep
            </button>
            {hostAero && (
              <button
                type="button"
                disabled={readOnly || !!runner.unavailable}
                onClick={() => start(true)}
              >
                Sweep on {runner.host!.label}
              </button>
            )}
          </>
        )}
      </div>
      <p className="simulation-note" role="status" aria-live="polite">
        {running
          ? `Yaw ${running.at + 1} of ${running.of}…`
          : error ||
            'Each angle is one run of this study at that yaw; the study keeps its own yaw and the sweep is not recorded.'}
      </p>
      {rows.length > 0 && (
        <table className="simulation-levels" aria-label="Yaw sweep coefficients">
          <thead>
            <tr>
              <th>Yaw °</th>
              <th>Cd</th>
              <th>Cl</th>
              <th>Cs</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.yawDeg}>
                <td>{fmt(r.yawDeg)}</td>
                {r.failure ? (
                  <td colSpan={4}>{r.failure}</td>
                ) : (
                  <>
                    <td>{fmt(r.cd)}</td>
                    <td>{fmt(r.cl)}</td>
                    <td>{fmt(r.cs)}</td>
                    <td>
                      {r.status}
                      {r.reasons?.length ? <small> ({r.reasons.join('; ')})</small> : null}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </fieldset>
  );
}
