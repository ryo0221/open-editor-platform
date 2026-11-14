import { useEffect, useRef, useState } from 'react';
import type { BimDerived, BimDocument } from '@editor-platform/bim-core';
import {
  craneReactions,
  frameCompleted,
  frameOnDay,
  type ConstructionDiagnostic,
  type ConstructionDocument,
  type ConstructionOperation,
  type ConstructionSchedule,
  type CraneWorld,
  type SiteLoad,
} from '@editor-platform/construction-core';
import {
  comparisonRows,
  formatKN,
  frameAnalysis,
  frameSize,
  maxDisplacement,
  nextSiteLoadId,
  ratioLooks,
  solvedSummary,
  type FrameAnalysis,
  type FrameSolver,
  solveBoth,
} from './analysis-view';
import { formatTonnes } from './display';
import { Field, SiteTable, useDirty, type Report } from './site-panel';

/**
 * CS4b: the frame of a construction stage: the site loads (shoring, stocked material) and their
 * form, the day's frame solved on the Host against the completed building, its members coloured
 * by how much harder the day works them, and the crane foundations' reactions.
 */
export function AnalysisPanel({
  doc,
  bim,
  derived,
  schedule,
  day,
  solver,
  craneWorld,
  readOnly,
  run,
  setError,
  picked,
  onShow,
  analysis,
  onAnalysis,
  onUnsolved,
  colour,
  onColour,
  report,
  epoch,
  discard,
  held,
}: {
  doc: ConstructionDocument;
  bim: BimDocument | undefined;
  derived: BimDerived | undefined;
  schedule: ConstructionSchedule | undefined;
  day: string | undefined;
  solver: FrameSolver | undefined;
  craneWorld: CraneWorld | undefined;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  setError(e: string): void;
  /** Elements selected in the view: a new site load lies on the slabs among them. */
  picked: readonly string[];
  /** Selects elements in the view. */
  onShow(ids: string[]): void;
  analysis: FrameAnalysis | undefined;
  onAnalysis(a: FrameAnalysis | undefined): void;
  /** A day whose frame could not be built (nothing on a support): what was found on it. */
  onUnsolved(found: { day: string; notes: ConstructionDiagnostic[] } | undefined): void;
  colour: boolean;
  onColour(on: boolean): void;
  report: Report;
  epoch: number;
  discard(): void;
  /** True (and says so) while the site load form has unsaved changes. */
  held(): boolean;
}) {
  const loads = doc.site?.loads ?? [];
  const [selected, setSelected] = useState<string>();
  const load = loads.find((l) => l.id === selected);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);
  // A new plan or building: the results no longer hold, and a run still going is stopped.
  useEffect(() => {
    abort.current?.abort();
    onAnalysis(undefined);
    onUnsolved(undefined);
    setStatus('');
  }, [doc, bim]);
  useEffect(() => () => abort.current?.abort(), []);
  const slabs = (ids: readonly string[]) =>
    ids.filter((id) => derived?.shapes.get(id)?.kind === 'slab');
  const taskName = (id: string) => doc.tasks.find((t) => t.id === id)?.name ?? id;
  const ready = !!(bim && derived && schedule && day);

  const analyse = async () => {
    if (!bim || !derived || !schedule || !day || !solver) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const world = { bim, derived };
    const stage = frameOnDay(doc, schedule, world, day);
    onUnsolved(undefined);
    if (!stage.model) {
      onAnalysis(undefined);
      onUnsolved({ day, notes: stage.notes });
      setStatus(
        `Nothing stands on a support on ${day}. ${stage.notes.map((n) => n.message).join(' ')}`,
      );
      return;
    }
    const completed = frameCompleted(doc, schedule, world);
    const size = frameSize(stage.model);
    const doneSize = completed.model ? frameSize(completed.model) : undefined;
    setBusy(true);
    setStatus(
      `Solving on ${solver.label}: ${size.nodes} nodes and ${size.elements} beam elements (numbers only) go to ${solver.destination}${doneSize ? `, and the completed building's ${doneSize.nodes} nodes` : ''}…`,
    );
    const start = performance.now();
    try {
      const [s, c] = await solveBoth(solver, stage.model, completed.model, controller);
      if (controller.signal.aborted) return;
      onAnalysis(
        frameAnalysis(
          day,
          stage,
          s,
          completed.model ? completed : undefined,
          c,
          (performance.now() - start) / 1000,
        ),
      );
      setStatus('');
    } catch (e) {
      // A Stop pressed by the user says nothing; a failure (which stopped the other solve) does.
      if (controller.signal.aborted && controller.signal.reason !== e) return;
      setStatus(`The frame could not be solved: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  const reactions = (on?: string) =>
    schedule && craneWorld && doc.site?.cranes?.length
      ? craneReactions(doc, schedule, craneWorld, on)
      : [];
  const crane = (id: string) => doc.site?.cranes?.find((c) => c.id === id);
  const reactionRows = [
    ...reactions(day).map((r) => ({ when: 'On the day', r })),
    ...reactions().map((r) => ({ when: 'Whole plan', r })),
  ];
  const notes = analysis
    ? [...analysis.stage.frame.notes, ...(analysis.completed?.frame.notes ?? [])]
    : [];
  const unique = [...new Map(notes.map((n) => [n.message, n])).values()];

  return (
    <details className="construction-site" open={loads.length > 0 || !!analysis || undefined}>
      <summary>Frame analysis</summary>
      <p className="construction-note">
        The columns, beams and members standing on the day, as beam elements with rigid joints, held
        at the foundation: their own weight, the slabs' and the site loads of the tasks running.
        Compared with the completed building.
      </p>
      <SiteTable
        label="Site loads"
        head={['Name', 'While', 'kN/m²', 'Slabs']}
        rows={loads.map((l) => ({
          id: l.id,
          cells: [l.name || l.id, taskName(l.taskId), String(l.kNm2), String(l.elementIds.length)],
        }))}
        selected={selected}
        onSelect={(id) => {
          // Switching rows or closing the open one both leave its form: unsaved edits hold it.
          if (held()) return;
          setSelected(id === selected ? undefined : id);
          const l = loads.find((x) => x.id === id);
          if (l && id !== selected) onShow(l.elementIds);
        }}
      />
      {!readOnly && (
        <div className="construction-actions">
          <button
            type="button"
            onClick={() => {
              if (held()) return;
              const on = slabs(picked);
              if (!on.length) return setError('Select the slabs the load lies on in the view.');
              const task = doc.tasks[0];
              if (!task) return setError('Add a task first: a site load lies while one runs.');
              const taken = new Set([
                ...loads.map((l) => l.id),
                ...(doc.site?.cranes ?? []).map((c) => c.id),
                ...(doc.site?.lifts ?? []).map((l) => l.id),
                ...(doc.site?.earthworks ?? []).map((w) => w.id),
                ...(doc.site?.temporaries ?? []).map((t) => t.id),
              ]);
              const id = nextSiteLoadId(taken);
              const next: SiteLoad = {
                id,
                name: `Site load ${id.slice('load-'.length)}`,
                taskId: task.id,
                elementIds: on,
                kNm2: 1,
              };
              if (run({ type: 'putSiteLoad', load: next })) setSelected(id);
            }}
          >
            Add site load on selection
          </button>
          <button
            type="button"
            disabled={!load}
            onClick={() =>
              load && run({ type: 'removeSiteLoad', id: load.id }) && setSelected(undefined)
            }
          >
            Remove site load
          </button>
        </div>
      )}
      {load && (
        <SiteLoadForm
          key={`${epoch}|${JSON.stringify(load)}`}
          doc={doc}
          load={load}
          slabsPicked={slabs(picked)}
          readOnly={readOnly}
          run={run}
          report={report}
          discard={discard}
        />
      )}
      <div className="construction-actions">
        <button
          type="button"
          className="primary"
          disabled={!ready || !solver || busy}
          onClick={() => void analyse()}
        >
          Analyse the day
        </button>
        {busy && (
          <button type="button" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        )}
        <label className="construction-check">
          <input
            type="checkbox"
            checked={colour}
            disabled={!analysis}
            onChange={(e) => onColour(e.target.checked)}
          />
          Colour by day ÷ completed
        </label>
      </div>
      {!solver && (
        <p className="construction-note">
          No compute Host: the frame is solved on a Host (CalculiX) only.
        </p>
      )}
      {!bim && <p className="construction-note">The scheduled building is not kept.</p>}
      {status && (
        <p className="construction-status-line" role="status" aria-label="Analysis status">
          {status}
        </p>
      )}
      {analysis && (
        <div aria-label="Frame results">
          <p className="construction-note">
            {analysis.day}: {solvedSummary(analysis.stage)}
            {analysis.completed && <> · completed: {solvedSummary(analysis.completed)}</>} (
            {analysis.seconds.toFixed(1)} s)
            {analysis.day !== day && ' — for another day than the one shown'}
          </p>
          {colour && (
            <p className="construction-legend">
              <i style={{ background: ratioLooks.usual.color }} /> ≤ 1.1×
              <i style={{ background: ratioLooks.higher.color }} /> &gt; 1.1×
              <i style={{ background: ratioLooks.high.color }} /> &gt; 1.5×
            </p>
          )}
          <SiteTable
            label="Members against the completed building"
            head={['Member', 'On the day', 'Completed', 'Ratio']}
            rows={comparisonRows(analysis)}
            selected={undefined}
            onSelect={(id) => onShow([id])}
          />
          {!analysis.completed && (
            <p className="construction-note">The completed building has no frame to compare.</p>
          )}
          {analysis.completed &&
            maxDisplacement(analysis.stage) > maxDisplacement(analysis.completed) && (
              <p className="construction-note">
                The frame moves more on the day than when complete.
              </p>
            )}
          {unique.length > 0 && (
            <ul className="construction-problems" aria-label="Frame notes">
              {unique.slice(0, 12).map((n, i) => (
                <li key={i}>{n.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {reactionRows.length > 0 && (
        <>
          <SiteTable
            label="Crane foundation reactions"
            head={['Crane', 'When', 'Vertical', 'Moment', 'From']}
            rows={reactionRows.map(({ when, r }) => ({
              id: `${r.craneId}|${when}`,
              cells: [
                crane(r.craneId)?.name || r.craneId,
                when,
                formatKN(r.verticalKN),
                `${formatKN(r.momentKNm)}·m`,
                r.liftId ? `${r.liftId}${r.day ? ` (${r.day})` : ''}` : 'no lift',
              ],
            }))}
            selected={undefined}
            onSelect={() => {}}
          />
          {reactionRows.some(({ r }) => !r.ownMassKnown || r.unknown > 0) && (
            <ul className="construction-problems" aria-label="Reaction notes">
              {[...new Set(reactionRows.map(({ r }) => r.craneId))].flatMap((id) => {
                const all = reactionRows.find(
                  ({ r, when }) => r.craneId === id && when === 'Whole plan',
                )!.r;
                const name = crane(id)?.name || id;
                return [
                  ...(!all.ownMassKnown
                    ? [`${name}: its own mass is not given; the reaction is the loads' only.`]
                    : []),
                  ...(all.unknown
                    ? [
                        `${name}: ${all.unknown} lift${all.unknown > 1 ? 's' : ''} of unknown mass left out.`,
                      ]
                    : []),
                ].map((m) => <li key={m}>{m}</li>);
              })}
            </ul>
          )}
          {doc.site?.cranes?.some((c) => c.massKg) && (
            <p className="construction-note">
              Own mass:{' '}
              {doc.site.cranes
                .filter((c) => c.massKg)
                .map((c) => `${c.name || c.id} ${formatTonnes(c.massKg!)}`)
                .join(', ')}
            </p>
          )}
        </>
      )}
    </details>
  );
}

function SiteLoadForm({
  doc,
  load,
  slabsPicked,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  load: SiteLoad;
  slabsPicked: string[];
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const [name, setName] = useState(load.name);
  const [task, setTask] = useState(load.taskId);
  const [kNm2, setKNm2] = useState(String(load.kNm2));
  const [elementIds, setElementIds] = useState(load.elementIds);
  const [problem, setProblem] = useState('');
  const dirty =
    name !== load.name ||
    task !== load.taskId ||
    kNm2 !== String(load.kNm2) ||
    elementIds.join() !== load.elementIds.join();
  useDirty(report, dirty);
  return (
    <form
      className="construction-form"
      aria-label="Site load"
      onSubmit={(e) => {
        e.preventDefault();
        if (!/^\d+(\.\d+)?$/.test(kNm2.trim()))
          return setProblem('The load must be a number of kN/m².');
        setProblem('');
        if (
          run({
            type: 'putSiteLoad',
            load: { ...load, name, taskId: task, kNm2: Number(kNm2), elementIds },
          })
        )
          discard();
      }}
    >
      <h3>{load.id}</h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input aria-label="Load name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Lies while">
          <select aria-label="Load task" value={task} onChange={(e) => setTask(e.target.value)}>
            {doc.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || t.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Load (kN/m², over each slab)">
          <input
            aria-label="Load per area"
            value={kNm2}
            onChange={(e) => setKNm2(e.target.value)}
          />
        </Field>
        <p className="construction-note">
          On {elementIds.length} slab{elementIds.length === 1 ? '' : 's'}.{' '}
          <button
            type="button"
            disabled={!slabsPicked.length}
            onClick={() => setElementIds(slabsPicked)}
          >
            Use the {slabsPicked.length} selected slab{slabsPicked.length === 1 ? '' : 's'}
          </button>
        </p>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save site load
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}
