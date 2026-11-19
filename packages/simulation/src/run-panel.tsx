/**
 * R3e-4c/4d: running a study from the Surface and looking at a result (docs/cad/r3-analysis.md,
 * 代表操作3・4): progress and cancel, the state with its reasons and each level's size and
 * metrics; then the result's colour map on the deformed shape, an axis section, a point readout,
 * the VTU export of a run and a VTU opened for display. A run is kept in memory beside the content
 * it was made on and shown as out of date once the content changes.
 */
import { useMemo, useState } from 'react';
import type { SimulationStudy } from '@editor-platform/simulation-core';
import { crashJobLimits } from '@editor-platform/geometry-fem';
import type { RunProgress, StudyRun } from './run';
import type { StiffnessTestResult } from './stiffness-test';
import { sealSummary } from './run-seal';
import { showerSummary } from './run-shower';
import { aeroSection, aeroStreamlines } from './aero-view';
import {
  autoDeformationScale,
  resultBounds,
  resultDisplay,
  resultGradient,
  resultVtu,
  scalarRange,
  type ResultSection,
  type ResultSource,
  type ResultTimeline,
  transientTime,
} from './results';

/** How the Host runs a study (its own Worker); `unavailable` says why it cannot here. */
export interface SimulationRunner {
  unavailable?: string;
  /** The kernel, mesher and solver builds a run would use now, when they are known. */
  builds?: StudyRun['builds'];
  /**
   * R3f-3: a compute Host the study can also be solved on, as the Host describes it; the Surface
   * says what is sent where before the user chooses it.
   */
  host?: {
    label: string;
    destination: string;
    limits: { nodes: number; elements: number };
    builds?: StudyRun['builds'];
    /** VS4b: the Host also runs wind tunnels, with this solver build. */
    aero?: { solverBuild: string };
    /** VS8a: the Host also runs crash studies, with this solver build. */
    crash?: { solverBuild: string };
  };
  run(
    studyId: string,
    onProgress: (progress: RunProgress) => void,
    /**
     * VS4d: `yawDeg` runs a wind-tunnel study at that yaw instead of its own (one run of a yaw
     * sweep; the document is not changed, see `aeroAtYaw`).
     */
    options?: { onHost?: boolean; yawDeg?: number },
  ): { result: Promise<StudyRun>; cancel(): void };
}

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; progress?: RunProgress; cancel(): void }
  | { status: 'done'; run: StudyRun; hash: string }
  | { status: 'error'; message: string };

const stepLabels: Record<RunProgress['step'], string> = {
  surface: 'preparing the shape',
  mesh: 'meshing',
  mapping: 'mapping loads and constraints',
  solve: 'solving',
  checks: 'checking',
};
const statusLabels = {
  verified: 'Verified',
  reference: 'Reference only',
  failed: 'Failed',
} as const;
const axes = ['X', 'Y', 'Z'] as const;

/** VS9b: a seal's runs out of range as their total length per status (over 120 mm, gap 40 mm). */
const outOfRange = (runs: readonly { status: string; lengthMm: number }[]) => {
  const by = new Map<string, number>();
  for (const r of runs) by.set(r.status, (by.get(r.status) ?? 0) + r.lengthMm);
  return [...by].map(([s, l]) => `${s} ${fmt(l)} mm`).join(', ');
};

export const fmt = (v: number | undefined) =>
  v === undefined || !Number.isFinite(v)
    ? '–'
    : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0)
      ? v.toExponential(3)
      : v.toPrecision(4);

/** The display of a result with the user's choices: field, deformation scale and section. */
export function useResultDisplay(source: ResultSource | undefined) {
  const [chosen, setField] = useState<string>('von-mises');
  const [scaleText, setScaleText] = useState<string>('auto');
  const [chosenSection, setSection] = useState<{ axis: 0 | 1 | 2; at: number } | undefined>();
  // R3i-5: a shell's midsurface (no tetrahedra) has no inside to cut: a section chosen on a solid
  // result is not applied to it (and comes back for the next solid one).
  const section = source && source.tets.length > 0 ? chosenSection : undefined;
  const field = source?.scalars.some((s) => s.id === chosen)
    ? chosen
    : (source?.scalars[0]?.id ?? chosen);
  const scalar = source?.scalars.find((s) => s.id === field);
  const auto = useMemo(() => (source ? autoDeformationScale(source) : 0), [source]);
  const bounds = useMemo(() => (source ? resultBounds(source) : undefined), [source]);
  const parsed = Number(scaleText);
  const scale = scaleText === 'auto' || !Number.isFinite(parsed) || parsed < 0 ? auto : parsed;
  const autoRange = useMemo(
    () =>
      source?.crash
        ? source.crash.range
        : source && scalar
          ? (scalar.range ?? scalarRange(source, scalar.values, !!section))
          : ([0, 0] as [number, number]),
    [source, scalar, !!section],
  );
  // CR5d (86T1): the colour range the user gives a field (a load point's peak otherwise sets it);
  // each end is 'auto' or a number, and a range whose low end is not below its high one is not
  // applied.
  const [limits, setLimits] = useState<{ field: string; low: string; high: string }>();
  const ends = limits?.field === field ? limits : { field, low: 'auto', high: 'auto' };
  const end = (text: string, fallback: number) => {
    const v = Number(text);
    return text === 'auto' || text === '' || !Number.isFinite(v) ? fallback : v;
  };
  const given: [number, number] = [end(ends.low, autoRange[0]), end(ends.high, autoRange[1])];
  const rangeRefused = given[0] >= given[1] && (ends.low !== 'auto' || ends.high !== 'auto');
  const range = useMemo<[number, number]>(
    () => (rangeRefused ? autoRange : given),
    // `given` is derived from `limits` and `autoRange`.
    [autoRange, rangeRefused, given[0], given[1]],
  );
  const setRangeEnd = (which: 'low' | 'high', text: string) =>
    setLimits({ ...ends, field, [which]: text.trim() || 'auto' });
  /** The section's plane in mm, from its place between the bounds (0–1). */
  const cut: ResultSection | undefined =
    section && bounds
      ? {
          axis: section.axis,
          offset:
            bounds.lo[section.axis]! +
            (bounds.hi[section.axis]! - bounds.lo[section.axis]!) * section.at,
        }
      : undefined;
  const shown = useMemo(
    () => (source ? resultDisplay(source, field, scale, range, cut) : undefined),
    // `cut` is derived from `section` and `bounds`.
    [source, field, scale, range, cut?.axis, cut?.offset],
  );
  // VS4c: a browser wind tunnel's streamlines and a section of its flow speed.
  const [streamlinesOn, setStreamlines] = useState(true);
  const [flowSection, setFlowSection] = useState<{ axis: 0 | 1 | 2; at: number } | undefined>({
    axis: 1,
    at: 0.5,
  });
  const flow = source?.aero?.flow;
  const streamlines = useMemo(
    () => (flow && streamlinesOn ? aeroStreamlines(flow) : undefined),
    [flow, streamlinesOn],
  );
  const flowCut =
    flow && flowSection && bounds
      ? {
          axis: flowSection.axis,
          offset:
            bounds.lo[flowSection.axis]! +
            (bounds.hi[flowSection.axis]! - bounds.lo[flowSection.axis]!) * flowSection.at,
        }
      : undefined;
  const flowPlane = useMemo(
    () =>
      flow && flowCut && bounds
        ? aeroSection(flow, flowCut.axis, flowCut.offset, bounds.lo, bounds.hi)
        : undefined,
    // `flowCut` is derived from `flowSection` and `bounds`.
    [flow, flowCut?.axis, flowCut?.offset, bounds],
  );
  return {
    field,
    setField,
    scalar,
    scaleText,
    setScaleText,
    scale,
    auto,
    range,
    autoRange,
    rangeEnds: ends,
    rangeRefused,
    setRangeEnd,
    section,
    setSection,
    cut,
    shown,
    streamlinesOn,
    setStreamlines,
    streamlines,
    flowSection,
    setFlowSection,
    flowCut,
    flowPlane,
  };
}

export function RunPanel({
  study,
  state,
  stale,
  readOnly,
  unavailable,
  start,
  host,
  startOnHost,
  test,
}: {
  study: SimulationStudy | undefined;
  state: RunState;
  /** CR5c: the summary of a stiffness test's run. */
  test?: StiffnessTestResult;
  /** The content changed since the shown run. */
  stale: boolean;
  readOnly: boolean;
  unavailable?: string;
  start(): void;
  host?: SimulationRunner['host'];
  startOnHost?(): void;
}) {
  const run = state.status === 'done' ? state.run : undefined;
  const modalRun = run?.levels.some((l) => l.metrics['first-frequency'] !== undefined) ?? false;
  const thermalRun = run?.levels.some((l) => l.metrics['max-temperature'] !== undefined) ?? false;
  // VS4b: a wind tunnel's levels by their cell, fluid cells and coefficients.
  const aeroRun = study?.kind === 'aero' && run?.studyId === study.id;
  // VS7c-2: a crash run's level by its peak deceleration, OLC and crush.
  const crashRun =
    run?.levels.some((l) => l.metrics['occupant-load-criterion'] !== undefined) ?? false;
  // VS8b: a head impact's by its HIC15, peak acceleration and deflection.
  const headRun = run?.levels.some((l) => l.metrics.hic15 !== undefined) ?? false;
  // VS9b: a seal run's level by its point spacing, points and compression range.
  const sealRun = run?.fields?.kind === 'seal' || run?.fields?.kind === 'shower';
  const showerRun = run?.fields?.kind === 'shower';
  return (
    <fieldset className="simulation-group" aria-label="Run">
      <legend>Run</legend>
      {unavailable ? (
        <p className="simulation-note">Studies cannot run here: {unavailable}</p>
      ) : !study ? (
        <p className="simulation-note">
          Add a load and a constraint to make a study first, or add a wind tunnel.
        </p>
      ) : null}
      <div className="simulation-actions">
        {state.status === 'running' ? (
          <button type="button" onClick={state.cancel}>
            Cancel run
          </button>
        ) : (
          <>
            <button type="button" disabled={!study || !!unavailable || readOnly} onClick={start}>
              Run study
            </button>
            {host && startOnHost && (
              <button
                type="button"
                disabled={!study || !!unavailable || readOnly}
                onClick={startOnHost}
              >
                Run on {host.label}
              </button>
            )}
          </>
        )}
      </div>
      {host && startOnHost && state.status !== 'running' && (
        <p className="simulation-note" aria-label="What a Host run sends">
          {study?.kind === 'crash' ? (
            <>
              “Run on {host.label}” meshes here, then sends {host.destination} the explicit model as
              numbers (the shells’ nodes, thickness and materials with their plasticity, the weld
              points, the added masses, the barrier and the initial velocity) and the run’s
              settings, nothing else: no CAD document, names or sign-in. The same explicit solver
              runs there in Node; it takes up to {crashJobLimits.shells.toLocaleString('en')}{' '}
              shells.
            </>
          ) : study?.kind === 'aero' ? (
            <>
              “Run on {host.label}” sends {host.destination} the bodies’ closed surface (triangles,
              mm), the wind speed and yaw, the ground, the mesh sizes, the iterations and the
              reference area, nothing else: no CAD document, names or sign-in. OpenFOAM meshes and
              solves it there; a level can take tens of minutes.
            </>
          ) : (
            <>
              “Run on {host.label}” meshes here, then sends {host.destination} the mesh (node
              coordinates and elements),{' '}
              {study?.kind === 'modal'
                ? 'E, ν and the density, the held nodes and the number of modes'
                : study?.kind === 'transient-thermal'
                  ? `the conductivity, density and specific heat, the start temperatures, the time and step, the held nodes and temperatures, the element faces' fluxes, films and radiation with their amplitudes${study.transient.stress ? ', and for the thermal stress E, ν, the expansion, the held nodes and the last temperatures' : ''}`
                  : 'E and ν, the held nodes and the nodal forces'}
              , nothing else: no CAD document, names or sign-in. It takes up to{' '}
              {host.limits.nodes.toLocaleString('en')} nodes and{' '}
              {host.limits.elements.toLocaleString('en')} elements.
            </>
          )}
          {study?.kind !== 'thermal' &&
            study?.kind !== 'aero' &&
            study?.kind !== 'crash' &&
            study?.kind !== 'transient-thermal' &&
            study?.kind !== 'seal' &&
            study?.kind !== 'shower' &&
            study?.idealisation === 'shell' &&
            ' A shell goes as 15-node wedges over its wall, about nine nodes for each shell node.'}
        </p>
      )}
      <p className="simulation-note" role="status" aria-live="polite">
        {state.status === 'running'
          ? state.progress
            ? `Level ${state.progress.level + 1} of ${state.progress.levels}: ${stepLabels[state.progress.step]}${state.progress.on ? ` on ${state.progress.on}` : ''}${state.progress.crash ? ` ${fmt(state.progress.crash.time * 1000)} of ${fmt(state.progress.crash.endTime * 1000)} ms` : ''}${state.progress.flow ? ` step ${state.progress.flow.step.toLocaleString('en')} of ${state.progress.flow.steps.toLocaleString('en')}, Cd ${fmt(state.progress.flow.cd)}` : ''}…`
            : 'Starting the solver…'
          : state.status === 'error'
            ? `The run stopped: ${state.message}`
            : run
              ? `${statusLabels[run.status.status]}${stale ? ' (out of date: the analysis changed since this run)' : ''}`
              : ''}
      </p>
      {run?.failure && (
        <p className="simulation-error">
          {run.failure.code}: {run.failure.detail}
          {run.failure.code === 'mesh-too-large' && host && startOnHost
            ? ` The browser solves up to its own limits; ${host.label} takes larger meshes.`
            : ''}
        </p>
      )}
      {run && run.status.reasons.length > 0 && run.status.status !== 'failed' && (
        <ul className="simulation-reasons" aria-label="Why the result is not verified">
          {run.status.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {run && run.levels.length > 0 && (
        <table className="simulation-levels">
          <thead>
            <tr>
              <th>Level</th>
              <th>{aeroRun ? 'Cell mm' : sealRun ? 'Spacing mm' : 'Size mm'}</th>
              <th>{aeroRun ? 'Cells' : sealRun ? 'Points' : 'Nodes'}</th>
              {sealRun ? (
                <>
                  <th>Least compression %</th>
                  <th>Most compression %</th>
                  <th>Leaks mm</th>
                  {showerRun && (
                    <>
                      <th>Went in mm³</th>
                      <th>Ponding mm³</th>
                    </>
                  )}
                </>
              ) : aeroRun ? (
                <>
                  <th>Cd</th>
                  <th>Cl</th>
                  <th>Cs</th>
                </>
              ) : headRun ? (
                <>
                  <th>HIC15</th>
                  <th>Peak g</th>
                  <th>Deflection mm</th>
                </>
              ) : crashRun ? (
                <>
                  <th>Peak g</th>
                  <th>OLC g</th>
                  <th>Crush mm</th>
                </>
              ) : modalRun ? (
                <th>First frequency Hz</th>
              ) : thermalRun ? (
                <>
                  <th>Max T K</th>
                  <th>Max |q| kW/m²</th>
                </>
              ) : (
                <>
                  <th>Max |u| mm</th>
                  <th>Max σvM MPa</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {run.levels.map((l, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{fmt(l.settings.size)}</td>
                <td>{l.nodes.toLocaleString('en')}</td>
                {sealRun ? (
                  <>
                    <td>{fmt(100 * (l.metrics['min-compression'] ?? 0))}</td>
                    <td>{fmt(100 * (l.metrics['max-compression'] ?? 0))}</td>
                    <td>{fmt(l.metrics['leak-length'])}</td>
                    {showerRun && (
                      <>
                        <td>{fmt(l.metrics['entered-volume'])}</td>
                        <td>{fmt(l.metrics['pond-volume'])}</td>
                      </>
                    )}
                  </>
                ) : aeroRun ? (
                  <>
                    <td>{fmt(l.metrics['drag-coefficient'])}</td>
                    <td>{fmt(l.metrics['lift-coefficient'])}</td>
                    <td>{fmt(l.metrics['side-force-coefficient'])}</td>
                  </>
                ) : headRun ? (
                  <>
                    <td>{fmt(l.metrics.hic15)}</td>
                    <td>{fmt(l.metrics['head-peak-acceleration'])}</td>
                    <td>{fmt(l.metrics['head-deflection'])}</td>
                  </>
                ) : crashRun ? (
                  <>
                    <td>{fmt(l.metrics['peak-deceleration'])}</td>
                    <td>{fmt(l.metrics['occupant-load-criterion'])}</td>
                    <td>{fmt(l.metrics.crush)}</td>
                  </>
                ) : modalRun ? (
                  <td>{fmt(l.metrics['first-frequency'])}</td>
                ) : thermalRun ? (
                  <>
                    <td>{fmt(l.metrics['max-temperature'])}</td>
                    <td>{fmt(l.metrics['max-heat-flux'])}</td>
                  </>
                ) : (
                  <>
                    <td>{fmt(l.metrics['max-displacement'])}</td>
                    <td>{fmt(l.metrics['max-von-mises'])}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {test && (
        <p className="simulation-note" aria-label="Stiffness test result">
          {test.kind === 'torsion'
            ? `Torsion stiffness ${fmt(test.stiffness)} N·m/deg: a moment of ${fmt(test.momentNm)} N·m about the axis for a twist of ${fmt(test.angleDeg)}° (mounts ${fmt(test.trackMm)} mm apart).`
            : test.kind === 'bending'
              ? `Bending stiffness ${fmt(test.stiffness)} N/mm: ${fmt(test.forceN)} N for a mean deflection of ${fmt(test.deflectionMm)} mm of the loaded faces.`
              : `No stiffness: ${test.reason}.`}
        </p>
      )}
      {run?.fields && run.fields.kind === undefined && run.fields.fatigue && (
        <FatigueSummary fatigue={run.fields.fatigue} />
      )}
      {(run?.fields?.kind === 'shell-static' || run?.fields?.kind === 'shell-modal') && (
        <p className="simulation-note" aria-label="Shell midsurface">
          Solved as a shell on the midsurface: {fmt(run.fields.mesh.thickness[0] ?? 0)} mm thick,{' '}
          {(run.fields.mesh.triangles.length / 3).toLocaleString('en')} triangles. Stresses are on
          the top (the side the midsurface normal points to), the middle and the bottom.
        </p>
      )}
      {run?.fields?.kind === 'shower' && (
        <p className="simulation-note" aria-label="Water">
          {showerSummary(run.fields)}.{' '}
          {run.fields.entries.length
            ? `In through ${[...new Set(run.fields.entries.map((e) => e.sealId))]
                .map((id) => {
                  const r = (
                    run.fields as { seals: { sealId: string; name: string }[] }
                  ).seals.find((x) => x.sealId === id);
                  return r?.name ?? id;
                })
                .join(', ')}.`
            : 'Nothing went in.'}
        </p>
      )}
      {(run?.fields?.kind === 'seal' || run?.fields?.kind === 'shower') && (
        <table className="simulation-levels" aria-label="Seals">
          <thead>
            <tr>
              <th>Seal</th>
              <th>Length mm</th>
              <th>Pressed %</th>
              <th>Leaks mm</th>
              <th>Out of range</th>
            </tr>
          </thead>
          <tbody>
            {run.fields.seals.map((r) => {
              const m = r.measurement;
              return (
                <tr key={r.sealId} title={sealSummary(r)}>
                  <td>
                    {r.name}
                    {r.angleDeg ? ` (opened ${r.angleDeg}°)` : ''}
                  </td>
                  <td>{fmt(m.lengthMm)}</td>
                  <td>
                    {m.compression
                      ? `${fmt(100 * m.compression[0])}–${fmt(100 * m.compression[1])}`
                      : 'no contact'}
                  </td>
                  <td>{fmt(m.leakLengthMm)}</td>
                  <td>
                    {m.runs.length ? outOfRange(m.runs) : 'none'}
                    {m.bends.length ? `; ${m.bends.length} tight bends` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(run?.fields?.kind === 'modal' || run?.fields?.kind === 'shell-modal') && (
        <table className="simulation-levels" aria-label="Natural frequencies">
          <thead>
            <tr>
              <th>Mode</th>
              <th>Frequency Hz</th>
              <th>Mass X %</th>
              <th>Mass Y %</th>
              <th>Mass Z %</th>
            </tr>
          </thead>
          <tbody>
            {run.fields.modes.map((m, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{fmt(m.frequency)}</td>
                {m.effectiveMass.map((e, k) => (
                  <td key={k}>{(e * 100).toFixed(1)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </fieldset>
  );
}

export function ResultPanel({
  source,
  display,
  showing,
  setShowing,
  readout,
  exportVtu,
  openVtu,
  closeImported,
  error,
  body,
}: {
  source: ResultSource | undefined;
  display: ReturnType<typeof useResultDisplay>;
  showing: boolean;
  setShowing(v: boolean): void;
  /** The value last read by a click on the result, and where. */
  readout?: { value: number; at: [number, number, number] };
  /** The run's VTU, when the shown result is a run. */
  exportVtu?: () => void;
  openVtu(file: File): void;
  /** Shown when the result is an opened VTU: back to the run (or to nothing). */
  closeImported?: () => void;
  error?: string;
  /** R3j-6c: the body of a bonded run shown (undefined: every body together). */
  body?: {
    value: string | undefined;
    options: { id: string; label: string }[];
    choose(id: string | undefined): void;
  };
}) {
  const scalar = display.scalar;
  return (
    <fieldset className="simulation-group" aria-label="Result">
      <legend>Result</legend>
      {!source ? (
        <p className="simulation-note">Run the study, or open a VTU to look at it.</p>
      ) : (
        <>
          <p className="simulation-note">
            {source.origin === 'Run'
              ? 'The finest level of the run.'
              : `Opened ${source.origin} (display only).`}
          </p>
          <label className="simulation-field">
            <span>Show</span>
            <select
              aria-label="Shown view"
              value={showing ? 'result' : 'setup'}
              onChange={(e) => setShowing(e.target.value === 'result')}
            >
              <option value="result">Result</option>
              <option value="setup">Loads and constraints</option>
            </select>
          </label>
          {body && (
            <label className="simulation-field">
              <span>Body</span>
              <select
                aria-label="Result body"
                value={body.value === undefined ? '' : `body:${body.value}`}
                onChange={(e) => body.choose(e.target.value ? e.target.value.slice(5) : undefined)}
              >
                <option value="">All bodies</option>
                {body.options.map((o) => (
                  <option key={o.id} value={`body:${o.id}`}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="simulation-field">
            <span>Field</span>
            <select
              aria-label="Result field"
              value={display.field}
              onChange={(e) => display.setField(e.target.value)}
            >
              {source.scalars.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.unit ? ` (${s.unit})` : ''}
                </option>
              ))}
            </select>
          </label>
          {source.transient && (
            <TransientTimeline
              timeline={source.transient}
              field={display.field}
              setField={display.setField}
            />
          )}
          {/* VS4c: nothing moves a wind tunnel's bodies. */}
          {!source.aero && (
            <label className="simulation-field">
              <span>
                Deformation scale <small>× (auto {fmt(display.auto)})</small>
              </span>
              <input
                aria-label="Deformation scale"
                value={display.scaleText}
                onChange={(e) => display.setScaleText(e.target.value.trim() || 'auto')}
              />
            </label>
          )}
          {/* A shell's midsurface has no inside to cut. */}
          {source.tets.length > 0 && (
            <label className="simulation-field">
              <span>Section</span>
              <select
                aria-label="Section axis"
                value={display.section ? String(display.section.axis) : 'none'}
                onChange={(e) =>
                  display.setSection(
                    e.target.value === 'none'
                      ? undefined
                      : {
                          axis: Number(e.target.value) as 0 | 1 | 2,
                          at: display.section?.at ?? 0.5,
                        },
                  )
                }
              >
                <option value="none">None</option>
                {axes.map((a, i) => (
                  <option key={a} value={i}>
                    Cut along {a}
                  </option>
                ))}
              </select>
            </label>
          )}
          {display.section && source.tets.length > 0 && (
            <label className="simulation-field">
              <span>
                Section place <small>{fmt(display.cut?.offset ?? 0)} mm</small>
              </span>
              <input
                aria-label="Section place"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={display.section.at}
                onChange={(e) =>
                  display.setSection({ axis: display.section!.axis, at: Number(e.target.value) })
                }
              />
            </label>
          )}
          {source.aero?.flow && (
            <>
              <label className="simulation-field">
                <span>Streamlines</span>
                <input
                  type="checkbox"
                  aria-label="Streamlines"
                  checked={display.streamlinesOn}
                  onChange={(e) => display.setStreamlines(e.target.checked)}
                />
              </label>
              <label className="simulation-field">
                <span>Flow section</span>
                <select
                  aria-label="Flow section axis"
                  value={display.flowSection ? String(display.flowSection.axis) : 'none'}
                  onChange={(e) =>
                    display.setFlowSection(
                      e.target.value === 'none'
                        ? undefined
                        : {
                            axis: Number(e.target.value) as 0 | 1 | 2,
                            at: display.flowSection?.at ?? 0.5,
                          },
                    )
                  }
                >
                  <option value="none">None</option>
                  {axes.map((a, i) => (
                    <option key={a} value={i}>
                      Plane across {a}
                    </option>
                  ))}
                </select>
              </label>
              {display.flowSection && (
                <label className="simulation-field">
                  <span>
                    Flow section place <small>{fmt(display.flowCut?.offset ?? 0)} mm</small>
                  </span>
                  <input
                    aria-label="Flow section place"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={display.flowSection.at}
                    onChange={(e) =>
                      display.setFlowSection({
                        axis: display.flowSection!.axis,
                        at: Number(e.target.value),
                      })
                    }
                  />
                </label>
              )}
              <p className="simulation-note" aria-label="Flow colours">
                Streamlines and the section are coloured by the air speed, from 0 (blue) to 1.5 ×
                the wind (red)
                {display.streamlines
                  ? `; ${display.streamlines.lines} streamlines from a rake ahead of the bodies`
                  : ''}
                .
              </p>
            </>
          )}
          {scalar && !scalar.classes && (
            <>
              <label className="simulation-field">
                <span>
                  Colours from <small>(auto {fmt(display.autoRange[0])})</small>
                </span>
                <input
                  aria-label="Colour range low"
                  value={display.rangeEnds.low}
                  onChange={(e) => display.setRangeEnd('low', e.target.value)}
                />
              </label>
              <label className="simulation-field">
                <span>
                  Colours to <small>(auto {fmt(display.autoRange[1])})</small>
                </span>
                <input
                  aria-label="Colour range high"
                  value={display.rangeEnds.high}
                  onChange={(e) => display.setRangeEnd('high', e.target.value)}
                />
              </label>
              <p className="simulation-note">
                {display.rangeRefused
                  ? 'The low end must be below the high end: the colours span the whole result.'
                  : 'Values beyond the range take the end colours.'}
              </p>
            </>
          )}
          {scalar?.classes && (
            <ul className="simulation-legend-classes" aria-label={`${scalar.label} legend`}>
              {scalar.classes.map((c, k) => (
                <li key={k}>
                  <span
                    className="simulation-swatch"
                    style={{
                      background: `rgb(${c.color.map((v) => Math.round(v * 255)).join(' ')})`,
                    }}
                  />
                  {k} {c.label}
                </li>
              ))}
            </ul>
          )}
          {scalar && !scalar.classes && (
            <div className="simulation-legend-bar" aria-label={`${scalar.label} legend`}>
              <span className="simulation-gradient" style={{ background: resultGradient }} />
              <span className="simulation-range">
                <span>{fmt(display.range[0])}</span>
                <span>
                  {scalar.label}
                  {scalar.unit ? ` (${scalar.unit})` : ''}
                </span>
                <span>{fmt(display.range[1])}</span>
              </span>
            </div>
          )}
          <p className="simulation-note" aria-label="Point value" aria-live="polite">
            {readout && scalar
              ? `${scalar.label}: ${fmt(readout.value)}${scalar.unit ? ` ${scalar.unit}` : ''} at (${readout.at.map(fmt).join(', ')}) mm`
              : 'Click the result to read a value.'}
          </p>
        </>
      )}
      <div className="simulation-actions">
        {exportVtu && (
          <button type="button" onClick={exportVtu}>
            Export VTU
          </button>
        )}
        <label className="simulation-file">
          Open VTU
          <input
            aria-label="Open VTU"
            type="file"
            accept=".vtu,application/xml"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) openVtu(file);
            }}
          />
        </label>
        {closeImported && (
          <button type="button" onClick={closeImported}>
            Close VTU
          </button>
        )}
      </div>
      {error && (
        <p className="simulation-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Saves a run's VTU in the browser. */
/** The run's VTU; R3j-6c: of one body of a bonded run (`<study>-<body>.vtu`). */
export function downloadVtu(run: StudyRun, bodyId?: string) {
  if (!run.fields) return;
  const blob = new Blob([resultVtu(run.fields, bodyId)], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = bodyId ? `${run.studyId}-${bodyId}.vtu` : `${run.studyId}.vtu`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * VS11d-2: a transient run's time: a slider over the kept fields (shown with one colour range) and
 * the highest and lowest temperature of every step, the shown time marked.
 */
export function TransientTimeline({
  timeline,
  field,
  setField,
}: {
  timeline: ResultTimeline;
  field: string;
  setField(id: string): void;
}) {
  const at = timeline.fields.indexOf(field);
  const index = at < 0 ? timeline.fields.length - 1 : at;
  const { time, max, min } = timeline.history;
  const t1 = time[time.length - 1] ?? 0;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < time.length; i++) {
    lo = Math.min(lo, min[i]!);
    hi = Math.max(hi, max[i]!);
  }
  if (!(hi > lo)) [lo, hi] = [lo - 0.5, hi + 0.5];
  const W = 240,
    H = 96,
    pad = 4;
  const x = (t: number) => pad + ((W - 2 * pad) * t) / Math.max(t1, 1e-300);
  const y = (v: number) => H - pad - ((H - 2 * pad) * (v - lo)) / (hi - lo);
  const line = (v: ArrayLike<number>) =>
    Array.from(
      { length: time.length },
      (_, i) => `${x(time[i]!).toFixed(1)},${y(v[i]!).toFixed(1)}`,
    ).join(' ');
  const shown = timeline.times[index] ?? 0;
  return (
    <div className="simulation-timeline">
      <label className="simulation-field">
        <span>
          Time <small>{transientTime(shown)}</small>
        </span>
        <input
          type="range"
          aria-label="Result time"
          min={0}
          max={timeline.fields.length - 1}
          step={1}
          value={index}
          onChange={(e) => setField(timeline.fields[Number(e.currentTarget.value)]!)}
        />
      </label>
      <figure className="simulation-history">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Highest and lowest temperature over ${transientTime(t1)}: ${fmt(lo)} K to ${fmt(hi)} K`}
        >
          <rect x={0} y={0} width={W} height={H} className="simulation-history-frame" />
          <polyline points={line(max)} className="simulation-history-max" />
          <polyline points={line(min)} className="simulation-history-min" />
          <line
            x1={x(shown)}
            x2={x(shown)}
            y1={pad}
            y2={H - pad}
            className="simulation-history-now"
          />
        </svg>
        <figcaption>
          Highest (solid) and lowest (dashed) temperature of every step, {fmt(lo)}–{fmt(hi)} K over{' '}
          {transientTime(t1)}.
        </figcaption>
      </figure>
    </div>
  );
}

/** VS13b: a fatigue run's shortest life, in passes of its load history, and where it is. */
function FatigueSummary({ fatigue }: { fatigue: { damage: Float64Array; life: Float64Array } }) {
  let worst = 0;
  for (let n = 1; n < fatigue.damage.length; n++)
    if (fatigue.damage[n]! > fatigue.damage[worst]!) worst = n;
  const life = fatigue.life[worst]!;
  return (
    <p className="simulation-note" aria-label="Fatigue summary">
      {Number.isFinite(life)
        ? `Shortest fatigue life ${life.toPrecision(3)} passes of the load history (damage ${fatigue.damage[worst]!.toPrecision(3)} per pass), at node ${worst}.`
        : 'No fatigue damage: every stress amplitude is below the endurance limit.'}
    </p>
  );
}
