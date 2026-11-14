import { useState } from 'react';
import {
  craneKinds,
  craneReach,
  type ConstructionDiagnostic,
  type ConstructionDocument,
  type ConstructionOperation,
  type Crane,
  type CraneKind,
  type Lift,
} from '@editor-platform/construction-core';
import {
  formatLoadChart,
  formatPlanList,
  nextLiftId,
  parseLoadChart,
  parsePlanList,
  parsePoint3,
} from './display';
import { Field, SiteTable, useDirty, type Report } from './site-panel';

const craneKindLabels: Record<CraneKind, string> = { tower: 'Tower crane', mobile: 'Mobile crane' };

export interface LiftOfDay {
  lift: Lift;
  /** "3.5 t", or why the mass is not known. */
  mass: string;
}

/**
 * CS3b: the cranes beside the site: their table and form, adding a task's lifts, the lifts of the
 * day with their playback, and what the crane checks find.
 */
export function CranePanel({
  doc,
  day,
  standing,
  liftsToday,
  problems,
  checking,
  readOnly,
  run,
  setError,
  selected,
  onSelect,
  report,
  epoch,
  discard,
  held,
  liftable,
  playing,
  onPlay,
  playStatus,
}: {
  doc: ConstructionDocument;
  day: string | undefined;
  /** Cranes standing on the day. */
  standing: ReadonlySet<string>;
  liftsToday: readonly LiftOfDay[];
  problems: readonly ConstructionDiagnostic[];
  /** The crane checks are still running. */
  checking: boolean;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  setError(e: string): void;
  selected: string | undefined;
  onSelect(id: string | undefined): void;
  report: Report;
  epoch: number;
  discard(): void;
  /** True (and says so) while the crane form has unsaved changes. */
  held(): boolean;
  /** Elements a lift can carry (built things with a body, not rooms or openings). */
  liftable(elementId: string): boolean;
  playing: boolean;
  onPlay(): void;
  playStatus: string;
}) {
  const site = doc.site;
  const cranes = site?.cranes ?? [];
  const lifts = site?.lifts ?? [];
  const crane = cranes.find((c) => c.id === selected);
  const taskName = (id: string | undefined) =>
    id === undefined ? '—' : (doc.tasks.find((t) => t.id === id)?.name ?? id);
  const buildTasks = doc.tasks.filter((t) => t.action === 'construct' && t.elementIds.length);
  const [liftCrane, setLiftCrane] = useState('');
  const [liftTask, setLiftTask] = useState('');
  // A choice whose crane or task has since gone falls back to the first one left.
  const liftCraneId = cranes.some((c) => c.id === liftCrane) ? liftCrane : cranes[0]?.id;
  const liftTaskId = buildTasks.some((t) => t.id === liftTask) ? liftTask : buildTasks[0]?.id;
  const [pick, setPick] = useState('');
  const add = () => {
    if (held()) return;
    const from = doc.tasks[0];
    if (!from) return setError('Add a task first: a crane is put up by one.');
    const taken = new Set([
      ...cranes.map((c) => c.id),
      ...(site?.earthworks ?? []).map((w) => w.id),
      ...(site?.temporaries ?? []).map((t) => t.id),
      ...(site?.loads ?? []).map((l) => l.id),
      ...lifts.map((l) => l.id),
    ]);
    let n = 1;
    while (taken.has(`crane-${n}`)) n++;
    const b = site?.boundary ?? [];
    const cx = b.length ? Math.round(b.reduce((s, p) => s + p[0], 0) / b.length) : 0;
    const cy = b.length ? Math.round(b.reduce((s, p) => s + p[1], 0) / b.length) : 0;
    const next: Crane = {
      id: `crane-${n}`,
      name: `Crane ${n}`,
      kind: 'tower',
      base: [cx, cy],
      height: 30000,
      jibLength: 50000,
      minRadius: 3000,
      loadChart: [
        { radius: 20000, capacityKg: 8000 },
        { radius: 50000, capacityKg: 3000 },
      ],
      fromTaskId: from.id,
    };
    if (run({ type: 'putCrane', crane: next })) onSelect(next.id);
  };
  const addLifts = () => {
    const c = liftCraneId;
    const t = doc.tasks.find((x) => x.id === liftTaskId);
    if (!c || !t) return setError('Choose a crane and a task that builds elements.');
    const p = parsePoint3(pick);
    if (typeof p === 'string') return setError(`Pick point: ${p}`);
    const lifted = new Set(lifts.map((l) => l.elementId));
    // Every site object's ID is taken: the site checks them as one set.
    const ids = new Set([
      ...cranes.map((x) => x.id),
      ...(site?.earthworks ?? []).map((w) => w.id),
      ...(site?.temporaries ?? []).map((w) => w.id),
      ...(site?.loads ?? []).map((l) => l.id),
      ...lifts.map((l) => l.id),
    ]);
    const ops: ConstructionOperation[] = [];
    for (const e of t.elementIds) {
      if (lifted.has(e) || !liftable(e)) continue;
      const id = nextLiftId(e, ids);
      ops.push({ type: 'putLift', lift: { id, craneId: c, taskId: t.id, elementId: e, pick: p } });
    }
    if (!ops.length) return setError(`${t.name || t.id} has no element left to lift.`);
    run(ops);
  };
  const removeLifts = () => {
    const t = liftTaskId;
    const ops: ConstructionOperation[] = lifts
      .filter((l) => l.taskId === t)
      .map((l) => ({ type: 'removeLift', id: l.id }));
    if (ops.length) run(ops);
  };
  return (
    <details className="construction-site" open={cranes.length > 0 || undefined}>
      <summary>Cranes</summary>
      {(problems.length > 0 || checking) && (
        <ul className="construction-problems" aria-label="Crane problems">
          {checking && <li>Checking the lifts…</li>}
          {problems.slice(0, 20).map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
          {problems.length > 20 && <li>… and {problems.length - 20} more</li>}
        </ul>
      )}
      <SiteTable
        label="Cranes"
        head={['Crane', 'Kind', 'Reach', 'Up from', 'Until', 'Today']}
        rows={cranes.map((c) => ({
          id: c.id,
          cells: [
            c.name || c.id,
            craneKindLabels[c.kind],
            `${(craneReach(c) / 1000).toFixed(0)} m`,
            taskName(c.fromTaskId),
            c.untilTaskId ? taskName(c.untilTaskId) : 'the end',
            standing.has(c.id) ? 'standing' : '—',
          ],
        }))}
        selected={selected}
        onSelect={(id) => onSelect(id === selected ? undefined : id)}
      />
      {!readOnly && (
        <div className="construction-actions">
          <button type="button" onClick={add}>
            Add crane
          </button>
          <button
            type="button"
            disabled={!crane}
            onClick={() =>
              crane && run({ type: 'removeCrane', id: crane.id }) && onSelect(undefined)
            }
          >
            Remove crane
          </button>
        </div>
      )}
      {crane && (
        <CraneForm
          key={`${epoch}|${JSON.stringify(crane)}`}
          doc={doc}
          crane={crane}
          readOnly={readOnly}
          run={run}
          report={report}
          discard={discard}
        />
      )}
      <p className="construction-note">{lifts.length} lifts planned</p>
      {!readOnly && cranes.length > 0 && (
        <div className="construction-form" aria-label="Add lifts" role="group">
          <Field label="Crane">
            <select
              aria-label="Lift crane"
              value={liftCraneId}
              onChange={(e) => setLiftCrane(e.target.value)}
            >
              {cranes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Task">
            <select
              aria-label="Lift task"
              value={liftTaskId}
              onChange={(e) => setLiftTask(e.target.value)}
            >
              {buildTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name || t.id} ({lifts.filter((l) => l.taskId === t.id).length} lifts)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pick point (x, y, z mm)">
            <input
              aria-label="Pick point"
              placeholder="52000, 11000, 1000"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            />
          </Field>
          <button type="button" onClick={addLifts}>
            Add lifts for task
          </button>
          <button type="button" onClick={removeLifts}>
            Remove lifts of task
          </button>
        </div>
      )}
      {day && (
        <>
          <div className="construction-actions">
            <button type="button" disabled={!liftsToday.length} onClick={onPlay}>
              {playing ? 'Stop lifts' : 'Play lifts'}
            </button>
            <span className="construction-note" aria-label="Lift playback">
              {playStatus || `${liftsToday.length} lifts on ${day}`}
            </span>
          </div>
          <SiteTable
            label="Lifts on the day"
            head={['Element', 'Crane', 'Mass']}
            rows={liftsToday.map(({ lift, mass }) => ({
              id: lift.id,
              cells: [
                lift.elementId,
                cranes.find((c) => c.id === lift.craneId)?.name ?? lift.craneId,
                mass,
              ],
            }))}
            selected={undefined}
            onSelect={() => undefined}
          />
        </>
      )}
    </details>
  );
}

function CraneForm({
  doc,
  crane,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  crane: Crane;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const [name, setName] = useState(crane.name);
  const [kind, setKind] = useState<CraneKind>(crane.kind);
  const [base, setBase] = useState(formatPlanList([crane.base]));
  const [baseZ, setBaseZ] = useState(crane.baseZ?.toString() ?? '');
  const [height, setHeight] = useState(String(crane.height));
  const [jib, setJib] = useState(String(crane.jibLength));
  const [minRadius, setMinRadius] = useState(String(crane.minRadius));
  const [chart, setChart] = useState(formatLoadChart(crane.loadChart));
  const [from, setFrom] = useState(crane.fromTaskId);
  const [until, setUntil] = useState(crane.untilTaskId ?? '');
  const [mass, setMass] = useState(crane.massKg?.toString() ?? '');
  const [problem, setProblem] = useState('');
  const dirty =
    name !== crane.name ||
    kind !== crane.kind ||
    base !== formatPlanList([crane.base]) ||
    baseZ !== (crane.baseZ?.toString() ?? '') ||
    height !== String(crane.height) ||
    jib !== String(crane.jibLength) ||
    minRadius !== String(crane.minRadius) ||
    chart !== formatLoadChart(crane.loadChart) ||
    from !== crane.fromTaskId ||
    until !== (crane.untilTaskId ?? '') ||
    mass !== (crane.massKg?.toString() ?? '');
  useDirty(report, dirty);
  const number = (v: string, what: string) => {
    if (!/^[+-]?\d+(\.\d+)?$/.test(v.trim())) throw new Error(`${what} must be a number`);
    return Number(v);
  };
  const taskOptions = doc.tasks.map((t) => (
    <option key={t.id} value={t.id}>
      {t.name || t.id}
    </option>
  ));
  return (
    <form
      className="construction-form"
      aria-label="Crane"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const at = parsePlanList(base);
          if (typeof at === 'string' || at.length !== 1)
            throw new Error(typeof at === 'string' ? at : 'The base is one "x, y" point');
          const rows = parseLoadChart(chart);
          if (typeof rows === 'string') throw new Error(rows);
          const next: Crane = {
            id: crane.id,
            name,
            kind,
            base: at[0]!,
            ...(baseZ.trim() ? { baseZ: number(baseZ, 'Base height') } : {}),
            height: number(height, 'Height'),
            jibLength: number(jib, 'Jib length'),
            minRadius: number(minRadius, 'Smallest radius'),
            loadChart: rows,
            fromTaskId: from,
            ...(until ? { untilTaskId: until } : {}),
            ...(mass.trim() ? { massKg: number(mass, 'Own mass') } : {}),
          };
          setProblem('');
          // Saved, also as another spelling of the stored values: start again from the stored.
          if (run({ type: 'putCrane', crane: next })) discard();
        } catch (err) {
          setProblem((err as Error).message);
        }
      }}
    >
      <h3>{crane.id}</h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input aria-label="Crane name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Kind">
          <select
            aria-label="Crane kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CraneKind)}
          >
            {craneKinds.map((k) => (
              <option key={k} value={k}>
                {craneKindLabels[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Slewing centre (x, y mm)">
          <input aria-label="Crane base" value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
        <Field label="Base height (mm, empty = on the ground)">
          <input
            aria-label="Crane base height"
            value={baseZ}
            onChange={(e) => setBaseZ(e.target.value)}
          />
        </Field>
        <Field label={kind === 'tower' ? 'Jib height (mm)' : 'Boom pivot height (mm)'}>
          <input
            aria-label="Crane height"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
          />
        </Field>
        <Field label={kind === 'tower' ? 'Jib length (mm)' : 'Boom length (mm)'}>
          <input aria-label="Jib length" value={jib} onChange={(e) => setJib(e.target.value)} />
        </Field>
        <Field label="Smallest radius (mm)">
          <input
            aria-label="Smallest radius"
            value={minRadius}
            onChange={(e) => setMinRadius(e.target.value)}
          />
        </Field>
        <Field label="Load chart (radius mm, capacity kg)">
          <textarea
            aria-label="Load chart"
            rows={4}
            value={chart}
            onChange={(e) => setChart(e.target.value)}
          />
        </Field>
        <Field label="Put up by">
          <select
            aria-label="Crane put up by"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {taskOptions}
          </select>
        </Field>
        <Field label="Taken down after">
          <select
            aria-label="Crane taken down after"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          >
            <option value="">Stays to the end</option>
            {taskOptions}
          </select>
        </Field>
        <Field label="Own mass with counterweight (kg, empty = not known)">
          <input aria-label="Crane mass" value={mass} onChange={(e) => setMass(e.target.value)} />
        </Field>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save crane
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}
