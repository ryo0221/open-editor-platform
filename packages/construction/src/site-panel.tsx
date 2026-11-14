import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  earthworkKinds,
  readTerrainCsv,
  temporaryKinds,
  type ConstructionDiagnostic,
  type ConstructionDocument,
  type ConstructionOperation,
  type Earthwork,
  type EarthworkKind,
  type EarthworkVolume,
  type SiteWorksDay,
  type TemporaryKind,
  type TemporaryWork,
} from '@editor-platform/construction-core';
import { formatPlanList, formatVolume, parsePlanList } from './display';

export type SiteItem = { type: 'earthwork' | 'temporary'; id: string };

const kindLabels: Record<EarthworkKind | TemporaryKind, string> = {
  cut: 'Cut',
  fill: 'Fill',
  scaffold: 'Scaffolding',
  hoarding: 'Hoarding',
  gate: 'Gate',
  yard: 'Materials yard',
  office: 'Site office',
};

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="construction-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Reports a form's unsaved state while it is mounted (as the task form does). */
export type Report = (dirty: boolean) => void;

/**
 * CS2b: the site beside the schedule: the boundary and the survey, the earthworks and temporary
 * works with their forms, the day's cut and fill, and what does not fit the site.
 */
export function SitePanel({
  doc,
  volumes,
  works,
  day,
  problems,
  readOnly,
  run,
  setError,
  selected,
  onSelect,
  reportBoundary,
  reportItem,
  boundaryEpoch,
  itemEpoch,
  discardBoundary,
  discardItem,
  held,
}: {
  doc: ConstructionDocument;
  volumes: readonly EarthworkVolume[];
  works: SiteWorksDay | undefined;
  day: string | undefined;
  problems: readonly ConstructionDiagnostic[];
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  setError(e: string): void;
  selected: SiteItem | undefined;
  onSelect(item: SiteItem | undefined): void;
  reportBoundary: Report;
  reportItem: Report;
  boundaryEpoch: number;
  itemEpoch: number;
  discardBoundary(): void;
  discardItem(): void;
  /** True (and says so) while the open site item form has unsaved changes. */
  held(): boolean;
}) {
  const site = doc.site;
  const earthworks = site?.earthworks ?? [];
  const temporaries = site?.temporaries ?? [];
  const terrainInput = useRef<HTMLInputElement>(null);
  const latestSite = useRef(site);
  useEffect(() => {
    latestSite.current = site;
  }, [site]);
  const taskName = (id: string | undefined) =>
    id === undefined ? '—' : (doc.tasks.find((t) => t.id === id)?.name ?? id);
  const total = volumes.reduce((a, v) => ({ cut: a.cut + v.cut, fill: a.fill + v.fill }), {
    cut: 0,
    fill: 0,
  });
  const fresh = (prefix: string) => {
    const taken = new Set([...earthworks, ...temporaries].map((x) => x.id));
    let n = 1;
    while (taken.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  };
  /** A starting outline: a square in the middle of the boundary (or at the origin). */
  const startOutline = (size: number): [number, number][] => {
    const b = site?.boundary ?? [];
    const cx = b.length ? b.reduce((s, p) => s + p[0], 0) / b.length : 0;
    const cy = b.length ? b.reduce((s, p) => s + p[1], 0) / b.length : 0;
    const h = size / 2;
    return [
      [cx - h, cy - h],
      [cx + h, cy - h],
      [cx + h, cy + h],
      [cx - h, cy + h],
    ].map(([x, y]) => [Math.round(x!), Math.round(y!)]);
  };
  const add = (type: SiteItem['type']) => {
    if (held()) return;
    const task = doc.tasks[0];
    if (!task) return setError('Add a task first: an earthwork or temporary work needs one.');
    if (type === 'earthwork') {
      const id = fresh('earthwork');
      const earthwork: Earthwork = {
        id,
        name: `Earthwork ${earthworks.length + 1}`,
        kind: 'cut',
        outline: startOutline(10000),
        levelZ: -1000,
        slope: 0.5,
        taskId: task.id,
      };
      if (run({ type: 'putEarthwork', earthwork })) onSelect({ type, id });
    } else {
      const id = fresh('temporary');
      const temporary: TemporaryWork = {
        id,
        name: `Temporary ${temporaries.length + 1}`,
        kind: 'office',
        outline: startOutline(4000),
        height: 3000,
        fromTaskId: task.id,
      };
      if (run({ type: 'putTemporary', temporary })) onSelect({ type, id });
    }
  };
  const earthwork =
    selected?.type === 'earthwork' ? earthworks.find((w) => w.id === selected.id) : undefined;
  const temporary =
    selected?.type === 'temporary' ? temporaries.find((t) => t.id === selected.id) : undefined;
  return (
    <details className="construction-site" open>
      <summary>Site</summary>
      <p className="construction-note" aria-label="Earthworks on the day">
        {earthworks.length
          ? `By ${day ?? 'the end'}: cut ${formatVolume(works?.cut ?? 0)} of ${formatVolume(total.cut)} m³ · fill ${formatVolume(works?.fill ?? 0)} of ${formatVolume(total.fill)} m³`
          : 'No earthworks'}
      </p>
      {problems.length > 0 && (
        <ul className="construction-problems" aria-label="Site problems">
          {problems.slice(0, 20).map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
      <div className="construction-actions">
        <span className="construction-note">{site?.terrain.length ?? 0} survey points</span>
        {!readOnly && (
          <>
            <button type="button" onClick={() => terrainInput.current?.click()}>
              Import terrain CSV
            </button>
            <input
              ref={terrainInput}
              hidden
              type="file"
              accept=".csv,text/csv"
              aria-label="Terrain CSV"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const r = readTerrainCsv(await file.text());
                if (r.diagnostics.length)
                  return setError(
                    `The terrain was not imported: ${r.diagnostics
                      .slice(0, 5)
                      .map((d) => `${d.path}: ${d.message}`)
                      .join('; ')}`,
                  );
                // The boundary as it stands now: it may have been saved or undone while the file read.
                run({
                  type: 'setSiteGround',
                  boundary: latestSite.current?.boundary ?? [],
                  terrain: r.points,
                });
              }}
            />
          </>
        )}
      </div>
      <BoundaryForm
        key={`${boundaryEpoch}|${JSON.stringify(site?.boundary ?? [])}`}
        doc={doc}
        readOnly={readOnly}
        run={run}
        report={reportBoundary}
        discard={discardBoundary}
      />
      <SiteTable
        label="Earthworks"
        head={['Earthwork', 'Kind', 'Task', 'Cut m³', 'Fill m³']}
        rows={earthworks.map((w) => {
          const v = volumes.find((x) => x.id === w.id);
          return {
            id: w.id,
            cells: [
              w.name || w.id,
              kindLabels[w.kind],
              taskName(w.taskId),
              formatVolume(v?.cut ?? 0),
              formatVolume(v?.fill ?? 0),
            ],
          };
        })}
        selected={selected?.type === 'earthwork' ? selected.id : undefined}
        onSelect={(id) => onSelect({ type: 'earthwork', id })}
      />
      <SiteTable
        label="Temporary works"
        head={['Temporary work', 'Kind', 'From', 'Until', 'Today']}
        rows={temporaries.map((t) => ({
          id: t.id,
          cells: [
            t.name || t.id,
            kindLabels[t.kind],
            taskName(t.fromTaskId),
            t.untilTaskId ? taskName(t.untilTaskId) : 'the end',
            works?.standing.includes(t.id) ? 'standing' : '—',
          ],
        }))}
        selected={selected?.type === 'temporary' ? selected.id : undefined}
        onSelect={(id) => onSelect({ type: 'temporary', id })}
      />
      {!readOnly && (
        <div className="construction-actions">
          <button type="button" onClick={() => add('earthwork')}>
            Add earthwork
          </button>
          <button type="button" onClick={() => add('temporary')}>
            Add temporary work
          </button>
          <button
            type="button"
            disabled={!earthwork && !temporary}
            onClick={() => {
              if (!selected) return;
              const ok = run(
                selected.type === 'earthwork'
                  ? { type: 'removeEarthwork', id: selected.id }
                  : { type: 'removeTemporary', id: selected.id },
              );
              if (ok) onSelect(undefined);
            }}
          >
            Remove site item
          </button>
        </div>
      )}
      {(earthwork ?? temporary) && (
        <SiteItemForm
          key={`${itemEpoch}|${JSON.stringify(earthwork ?? temporary)}`}
          doc={doc}
          earthwork={earthwork}
          temporary={temporary}
          readOnly={readOnly}
          run={run}
          report={reportItem}
          discard={discardItem}
        />
      )}
    </details>
  );
}

export function SiteTable({
  label,
  head,
  rows,
  selected,
  onSelect,
}: {
  label: string;
  head: string[];
  rows: { id: string; cells: string[] }[];
  selected: string | undefined;
  onSelect(id: string): void;
}) {
  if (!rows.length) return null;
  return (
    <div className="construction-table-wrap">
      <table className="construction-table" aria-label={label}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={r.id === selected ? 'selected' : ''}
              aria-selected={r.id === selected}
              onClick={() => onSelect(r.id)}
            >
              <td>
                <button type="button" className="construction-link">
                  {r.cells[0]}
                </button>
              </td>
              {r.cells.slice(1).map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function useDirty(report: Report, dirty: boolean) {
  useEffect(() => report(dirty), [report, dirty]);
  useEffect(() => () => report(false), [report]);
}

function BoundaryForm({
  doc,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const saved = formatPlanList(doc.site?.boundary ?? []);
  const [text, setText] = useState(saved);
  const [problem, setProblem] = useState('');
  const dirty = text !== saved;
  useDirty(report, dirty);
  return (
    <form
      className="construction-form"
      aria-label="Site boundary"
      onSubmit={(e) => {
        e.preventDefault();
        const boundary = parsePlanList(text);
        if (typeof boundary === 'string') return setProblem(boundary);
        setProblem('');
        if (run({ type: 'setSiteGround', boundary, terrain: doc.site?.terrain ?? [] }))
          setText(formatPlanList(boundary));
      }}
    >
      <fieldset disabled={readOnly}>
        <Field label="Boundary">
          <textarea
            aria-label="Boundary points"
            rows={4}
            placeholder={'0, 0\n60000, 0\n60000, 45000\n0, 45000'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit">Set boundary</button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}

function SiteItemForm({
  doc,
  earthwork,
  temporary,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  earthwork: Earthwork | undefined;
  temporary: TemporaryWork | undefined;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const item = (earthwork ?? temporary)!;
  const [name, setName] = useState(item.name);
  const [kind, setKind] = useState<string>(item.kind);
  const [outline, setOutline] = useState(formatPlanList(item.outline));
  const [level, setLevel] = useState(earthwork ? String(earthwork.levelZ) : '');
  const [slope, setSlope] = useState(earthwork ? String(earthwork.slope) : '');
  const [taskId, setTaskId] = useState(earthwork?.taskId ?? '');
  const [height, setHeight] = useState(temporary ? String(temporary.height) : '');
  const [base, setBase] = useState(temporary?.baseZ?.toString() ?? '');
  const [from, setFrom] = useState(temporary?.fromTaskId ?? '');
  const [until, setUntil] = useState(temporary?.untilTaskId ?? '');
  const [problem, setProblem] = useState('');
  const dirty =
    name !== item.name ||
    kind !== item.kind ||
    outline !== formatPlanList(item.outline) ||
    (earthwork
      ? level !== String(earthwork.levelZ) ||
        slope !== String(earthwork.slope) ||
        taskId !== earthwork.taskId
      : height !== String(temporary!.height) ||
        base !== (temporary!.baseZ?.toString() ?? '') ||
        from !== temporary!.fromTaskId ||
        until !== (temporary!.untilTaskId ?? ''));
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
      aria-label={earthwork ? 'Earthwork' : 'Temporary work'}
      onSubmit={(e) => {
        e.preventDefault();
        const points = parsePlanList(outline);
        if (typeof points === 'string') return setProblem(points);
        try {
          if (earthwork) {
            const next: Earthwork = {
              id: item.id,
              name,
              kind: kind as EarthworkKind,
              outline: points,
              levelZ: number(level, 'Level'),
              slope: number(slope, 'Slope'),
              taskId,
            };
            if (!run({ type: 'putEarthwork', earthwork: next })) return;
            // Saved as typed or in another spelling of the same values: the form shows them as
            // stored, so it is no longer pending when nothing changed.
            setOutline(formatPlanList(next.outline));
            setLevel(String(next.levelZ));
            setSlope(String(next.slope));
          } else {
            const next: TemporaryWork = {
              id: item.id,
              name,
              kind: kind as TemporaryKind,
              outline: points,
              height: number(height, 'Height'),
              ...(base.trim() ? { baseZ: number(base, 'Base') } : {}),
              fromTaskId: from,
              ...(until ? { untilTaskId: until } : {}),
            };
            if (!run({ type: 'putTemporary', temporary: next })) return;
            setOutline(formatPlanList(next.outline));
            setHeight(String(next.height));
            setBase(next.baseZ?.toString() ?? '');
          }
          setProblem('');
        } catch (err) {
          setProblem((err as Error).message);
        }
      }}
    >
      <h3>{item.id}</h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input
            aria-label="Site item name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <select
            aria-label="Site item kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {(earthwork ? earthworkKinds : temporaryKinds).map((k) => (
              <option key={k} value={k}>
                {kindLabels[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Outline">
          <textarea
            aria-label="Outline points"
            rows={4}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
          />
        </Field>
        {earthwork ? (
          <>
            <Field label="Level (mm)">
              <input aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)} />
            </Field>
            <Field label="Slope (run per rise, 0 = vertical)">
              <input aria-label="Slope" value={slope} onChange={(e) => setSlope(e.target.value)} />
            </Field>
            <Field label="Task">
              <select
                aria-label="Earthwork task"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              >
                {taskOptions}
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Height (mm)">
              <input
                aria-label="Height"
                value={height}
                onChange={(e) => setHeight(e.target.value)}
              />
            </Field>
            <Field label="Base (mm, empty = on the ground)">
              <input aria-label="Base" value={base} onChange={(e) => setBase(e.target.value)} />
            </Field>
            <Field label="Put up by">
              <select aria-label="Put up by" value={from} onChange={(e) => setFrom(e.target.value)}>
                {taskOptions}
              </select>
            </Field>
            <Field label="Taken down after">
              <select
                aria-label="Taken down after"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              >
                <option value="">Stays to the end</option>
                {taskOptions}
              </select>
            </Field>
          </>
        )}
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save site item
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}
