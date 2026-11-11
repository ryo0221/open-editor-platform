/**
 * R3e-4c/4d: running a study from the Surface and looking at a result (docs/cad/r3-analysis.md,
 * 代表操作3・4): progress and cancel, the state with its reasons and each level's size and
 * metrics; then the result's colour map on the deformed shape, an axis section, a point readout,
 * the VTU export of a run and a VTU opened for display. A run is kept in memory beside the content
 * it was made on and shown as out of date once the content changes.
 */
import { useMemo, useState } from 'react';
import type { SimulationStudy } from '@editor-platform/simulation-core';
import type { RunProgress, StudyRun } from './run';
import type { StiffnessTestResult } from './stiffness-test';
import {
  autoDeformationScale,
  resultBounds,
  resultDisplay,
  resultGradient,
  resultVtu,
  scalarRange,
  type ResultSection,
  type ResultSource,
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
  };
  run(
    studyId: string,
    onProgress: (progress: RunProgress) => void,
    options?: { onHost?: boolean },
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
      source && scalar
        ? scalarRange(source, scalar.values, !!section)
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
  return (
    <fieldset className="simulation-group" aria-label="Run">
      <legend>Run</legend>
      {unavailable ? (
        <p className="simulation-note">Studies cannot run here: {unavailable}</p>
      ) : !study ? (
        <p className="simulation-note">Add a load and a constraint to make a study first.</p>
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
          “Run on {host.label}” meshes here, then sends {host.destination} the mesh (node
          coordinates and elements),{' '}
          {study?.kind === 'modal'
            ? 'E, ν and the density, the held nodes and the number of modes'
            : 'E and ν, the held nodes and the nodal forces'}
          , nothing else: no CAD document, names or sign-in. It takes up to{' '}
          {host.limits.nodes.toLocaleString('en')} nodes and{' '}
          {host.limits.elements.toLocaleString('en')} elements.
          {study?.kind !== 'thermal' &&
            study?.idealisation === 'shell' &&
            ' A shell goes as 15-node wedges over its wall, about nine nodes for each shell node.'}
        </p>
      )}
      <p className="simulation-note" role="status" aria-live="polite">
        {state.status === 'running'
          ? state.progress
            ? `Level ${state.progress.level + 1} of ${state.progress.levels}: ${stepLabels[state.progress.step]}${state.progress.on ? ` on ${state.progress.on}` : ''}…`
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
              <th>Size mm</th>
              <th>Nodes</th>
              {modalRun ? (
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
                {modalRun ? (
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
      {(run?.fields?.kind === 'shell-static' || run?.fields?.kind === 'shell-modal') && (
        <p className="simulation-note" aria-label="Shell midsurface">
          Solved as a shell on the midsurface: {fmt(run.fields.mesh.thickness[0] ?? 0)} mm thick,{' '}
          {(run.fields.mesh.triangles.length / 3).toLocaleString('en')} triangles. Stresses are on
          the top (the side the midsurface normal points to), the middle and the bottom.
        </p>
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
          {scalar && (
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
          {scalar && (
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
