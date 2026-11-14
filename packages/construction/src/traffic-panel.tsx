import { useState } from 'react';
import {
  clockMinutes,
  clockText,
  routeKinds,
  type Approach,
  type ConstructionDocument,
  type ConstructionOperation,
  type GateCount,
  type RouteKind,
  type SiteRoute,
  type SiteZone,
} from '@editor-platform/construction-core';
import { formatPlanList, parsePlanList } from './display';
import { hazardLooks, newRoutePath } from './traffic-view';
import { Field, SiteTable, useDirty, type Report } from './site-panel';

const kindLabels: Record<RouteKind, string> = { worker: 'Workers', truck: 'Trucks' };
const hazardLabels = {
  zone: 'Zone',
  load: 'Under a load',
  slew: 'Slewing circle',
  edge: 'Pit edge',
} as const;

export type TrafficItem = { type: 'route' | 'zone'; id: string };

/**
 * CS5b: people and trucks: the working hours, the routes and danger zones with their forms, a time
 * of day with Play (workers walk, trucks drive), the day's approaches to danger and the gates.
 */
export function TrafficPanel({
  doc,
  day,
  active,
  clock,
  onClock,
  playing,
  onPlay,
  approaches,
  gates,
  notes,
  readOnly,
  run,
  setError,
  selected,
  onSelect,
  report,
  epoch,
  discard,
  held,
  reportHours,
  hoursEpoch,
  discardHours,
}: {
  doc: ConstructionDocument;
  day: string | undefined;
  /**
   * Whether the day has traffic to show: routes or zones, or only the dangers the site makes
   * itself (cut edges, lifts).
   */
  active: boolean;
  /** Minutes of the day shown. */
  clock: number;
  onClock(minutes: number): void;
  playing: boolean;
  onPlay(): void;
  approaches: readonly Approach[];
  gates: readonly GateCount[];
  notes: readonly string[];
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  setError(e: string): void;
  selected: TrafficItem | undefined;
  onSelect(item: TrafficItem | undefined): void;
  report: Report;
  epoch: number;
  discard(): void;
  held(): boolean;
  /** The working hours' own form: its unsaved edits, and its Discard. */
  reportHours: Report;
  hoursEpoch: number;
  discardHours(): void;
}) {
  const site = doc.site;
  const routes = site?.routes ?? [];
  const zones = site?.zones ?? [];
  const hours = site?.hours ?? { start: '08:00', end: '17:00' };
  const [from, to] = [clockMinutes(hours.start) ?? 480, clockMinutes(hours.end) ?? 1020];
  const taskName = (id: string) => doc.tasks.find((t) => t.id === id)?.name ?? id;
  const route = selected?.type === 'route' ? routes.find((r) => r.id === selected.id) : undefined;
  const zone = selected?.type === 'zone' ? zones.find((z) => z.id === selected.id) : undefined;
  const taken = () =>
    new Set([
      ...routes.map((r) => r.id),
      ...zones.map((z) => z.id),
      ...(site?.cranes ?? []).map((c) => c.id),
      ...(site?.lifts ?? []).map((l) => l.id),
      ...(site?.loads ?? []).map((l) => l.id),
      ...(site?.earthworks ?? []).map((w) => w.id),
      ...(site?.temporaries ?? []).map((t) => t.id),
    ]);
  const fresh = (stem: string) => {
    const ids = taken();
    let n = 1;
    while (ids.has(`${stem}-${n}`)) n++;
    return `${stem}-${n}`;
  };
  const centre = (): [number, number] => {
    const b = site?.boundary ?? [];
    return b.length
      ? [
          Math.round(b.reduce((s, p) => s + p[0], 0) / b.length),
          Math.round(b.reduce((s, p) => s + p[1], 0) / b.length),
        ]
      : [0, 0];
  };
  const gate = site?.temporaries.find((t) => t.kind === 'gate');
  const select = onSelect;
  return (
    <details className="construction-site" open={routes.length + zones.length > 0 || undefined}>
      <summary>People and trucks</summary>
      <HoursForm
        key={`${hoursEpoch}|${JSON.stringify(site?.hours ?? null)}`}
        hours={hours}
        readOnly={readOnly}
        run={run}
        report={reportHours}
        discard={discardHours}
      />
      <SiteTable
        label="Routes"
        head={['Name', 'Who', 'km/h', 'While', 'Trips']}
        rows={routes.map((r) => ({
          id: r.id,
          cells: [
            r.name || r.id,
            kindLabels[r.kind],
            String(r.speedKmh),
            taskName(r.taskId),
            `${r.departures.length}${r.returns ? ' (out and back)' : ''}`,
          ],
        }))}
        selected={route?.id}
        onSelect={(id) => select(route?.id === id ? undefined : { type: 'route', id })}
      />
      <SiteTable
        label="Danger zones"
        head={['Name', 'While', 'Hours']}
        rows={zones.map((z) => ({
          id: z.id,
          cells: [z.name || z.id, taskName(z.taskId), z.hours ? z.hours.join('–') : 'all day'],
        }))}
        selected={zone?.id}
        onSelect={(id) => select(zone?.id === id ? undefined : { type: 'zone', id })}
      />
      {!readOnly && (
        <div className="construction-actions">
          <button
            type="button"
            onClick={() => {
              if (held()) return;
              const task = doc.tasks[0];
              if (!task) return setError('Add a task first: a route is taken while one runs.');
              const id = fresh('route');
              const start: [number, number] = gate
                ? [
                    Math.round(gate.outline.reduce((s, p) => s + p[0], 0) / gate.outline.length),
                    Math.round(gate.outline.reduce((s, p) => s + p[1], 0) / gate.outline.length),
                  ]
                : [0, 0];
              const next: SiteRoute = {
                id,
                name: `Route ${id.slice('route-'.length)}`,
                kind: 'worker',
                path: newRoutePath(start, centre()),
                speedKmh: 4,
                taskId: task.id,
                departures: [hours.start],
              };
              if (run({ type: 'putRoute', route: next })) onSelect({ type: 'route', id });
            }}
          >
            Add route
          </button>
          <button
            type="button"
            onClick={() => {
              if (held()) return;
              const task = doc.tasks[0];
              if (!task) return setError('Add a task first: a zone is in force while one runs.');
              const id = fresh('zone');
              const [x, y] = centre();
              const next: SiteZone = {
                id,
                name: `Zone ${id.slice('zone-'.length)}`,
                outline: [
                  [x - 2000, y - 2000],
                  [x + 2000, y - 2000],
                  [x + 2000, y + 2000],
                  [x - 2000, y + 2000],
                ],
                taskId: task.id,
              };
              if (run({ type: 'putZone', zone: next })) onSelect({ type: 'zone', id });
            }}
          >
            Add danger zone
          </button>
          <button
            type="button"
            disabled={!route && !zone}
            onClick={() => {
              const ok = route
                ? run({ type: 'removeRoute', id: route.id })
                : zone && run({ type: 'removeZone', id: zone.id });
              if (ok) onSelect(undefined);
            }}
          >
            Remove
          </button>
        </div>
      )}
      {route && (
        <RouteForm
          key={`${epoch}|${JSON.stringify(route)}`}
          doc={doc}
          route={route}
          readOnly={readOnly}
          run={run}
          report={report}
          discard={discard}
        />
      )}
      {zone && (
        <ZoneForm
          key={`${epoch}|${JSON.stringify(zone)}`}
          doc={doc}
          zone={zone}
          readOnly={readOnly}
          run={run}
          report={report}
          discard={discard}
        />
      )}
      {day && active && (
        <>
          <div className="construction-actions" aria-label="Time of day">
            <button type="button" onClick={onPlay} aria-label={playing ? 'Stop time' : 'Play time'}>
              {playing ? 'Stop' : 'Play'}
            </button>
            <input
              type="range"
              aria-label="Time"
              min={from}
              max={to}
              value={Math.min(to, Math.max(from, Math.round(clock)))}
              onChange={(e) => onClock(Number(e.target.value))}
            />
            <span aria-label="Clock">{clockText(clock)}</span>
          </div>
          <p className="construction-legend">
            {(Object.keys(hazardLabels) as (keyof typeof hazardLabels)[]).map((k) => (
              <span key={k}>
                <i style={{ background: hazardLooks[k] }} /> {hazardLabels[k]}
              </span>
            ))}
          </p>
          {approaches.length ? (
            <SiteTable
              label="Approaches to danger"
              head={['Time', 'Who', 'Danger', 'Closest']}
              rows={approaches.map((a, i) => ({
                id: String(i),
                cells: [
                  `${a.from}–${a.to}`,
                  `${routes.find((r) => r.id === a.routeId)?.name || a.routeId} (${a.departure})`,
                  `${hazardLabels[a.hazardKind]}: ${a.hazardName}`,
                  a.closest ? `${(a.closest / 1000).toFixed(1)} m` : 'inside',
                ],
              }))}
              selected={undefined}
              onSelect={(i) => {
                const a = approaches[Number(i)];
                if (a) onClock(clockMinutes(a.from.slice(0, 5))! + Number(a.from.slice(6)) / 60);
              }}
            />
          ) : (
            <p className="construction-note">No one comes near a danger on {day}.</p>
          )}
          <p className="construction-note" aria-label="Gate counts">
            {gates.length
              ? gates
                  .map(
                    (g) =>
                      `${site?.temporaries.find((t) => t.id === g.gateId)?.name || g.gateId}: ${g.trucks} truck${g.trucks === 1 ? '' : 's'}, ${g.workers} walking`,
                  )
                  .join(' · ')
              : 'No gate stands on the day.'}
          </p>
          {notes.length > 0 && (
            <ul className="construction-problems" aria-label="Traffic notes">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}

function HoursForm({
  hours,
  readOnly,
  run,
  report,
  discard,
}: {
  hours: { start: string; end: string };
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const [start, setStart] = useState(hours.start);
  const [end, setEnd] = useState(hours.end);
  const dirty = start !== hours.start || end !== hours.end;
  useDirty(report, dirty);
  return (
    <form
      className="construction-form"
      aria-label="Working hours"
      onSubmit={(e) => {
        e.preventDefault();
        run({ type: 'setSiteHours', hours: { start, end } });
      }}
    >
      <fieldset disabled={readOnly}>
        <Field label="Working hours">
          <span className="construction-actions">
            <input
              aria-label="Day starts"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <input
              aria-label="Day ends"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <button type="submit" disabled={!dirty}>
              Set hours
            </button>
            <button type="button" disabled={!dirty} onClick={discard}>
              Discard hours
            </button>
          </span>
        </Field>
      </fieldset>
    </form>
  );
}

function RouteForm({
  doc,
  route,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  route: SiteRoute;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const [name, setName] = useState(route.name);
  const [kind, setKind] = useState(route.kind);
  const [path, setPath] = useState(formatPlanList(route.path));
  const [speed, setSpeed] = useState(String(route.speedKmh));
  const [task, setTask] = useState(route.taskId);
  const [departures, setDepartures] = useState(route.departures.join(', '));
  const [returns, setReturns] = useState(!!route.returns);
  const [problem, setProblem] = useState('');
  const dirty =
    name !== route.name ||
    kind !== route.kind ||
    path !== formatPlanList(route.path) ||
    speed !== String(route.speedKmh) ||
    task !== route.taskId ||
    departures !== route.departures.join(', ') ||
    returns !== !!route.returns;
  useDirty(report, dirty);
  return (
    <form
      className="construction-form"
      aria-label="Route"
      onSubmit={(e) => {
        e.preventDefault();
        const points = parsePlanList(path);
        if (typeof points === 'string') return setProblem(points);
        if (!/^\d+(\.\d+)?$/.test(speed.trim())) return setProblem('The speed is km/h.');
        setProblem('');
        const next: SiteRoute = {
          id: route.id,
          name,
          kind,
          path: points,
          speedKmh: Number(speed),
          taskId: task,
          departures: departures
            .split(/[,\s]+/)
            .map((d) => d.trim())
            .filter(Boolean),
          ...(returns ? { returns: true } : {}),
        };
        if (run({ type: 'putRoute', route: next })) discard();
      }}
    >
      <h3>{route.id}</h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input aria-label="Route name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Who">
          <select
            aria-label="Route kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as RouteKind)}
          >
            {routeKinds.map((k) => (
              <option key={k} value={k}>
                {kindLabels[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Way (one x, y in mm a line)">
          <textarea
            aria-label="Route path"
            rows={4}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        <Field label="Speed (km/h)">
          <input
            aria-label="Route speed"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          />
        </Field>
        <Field label="While">
          <select aria-label="Route task" value={task} onChange={(e) => setTask(e.target.value)}>
            {doc.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || t.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sets off at (HH:MM, …)">
          <input
            aria-label="Route departures"
            value={departures}
            onChange={(e) => setDepartures(e.target.value)}
          />
        </Field>
        <label className="construction-check">
          <input type="checkbox" checked={returns} onChange={(e) => setReturns(e.target.checked)} />
          Comes back the same way
        </label>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save route
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}

function ZoneForm({
  doc,
  zone,
  readOnly,
  run,
  report,
  discard,
}: {
  doc: ConstructionDocument;
  zone: SiteZone;
  readOnly: boolean;
  run(ops: ConstructionOperation | ConstructionOperation[]): boolean;
  report: Report;
  discard(): void;
}) {
  const [name, setName] = useState(zone.name);
  const [outline, setOutline] = useState(formatPlanList(zone.outline));
  const [task, setTask] = useState(zone.taskId);
  const [hours, setHours] = useState(zone.hours ? zone.hours.join('–') : '');
  const [problem, setProblem] = useState('');
  const dirty =
    name !== zone.name ||
    outline !== formatPlanList(zone.outline) ||
    task !== zone.taskId ||
    hours !== (zone.hours ? zone.hours.join('–') : '');
  useDirty(report, dirty);
  return (
    <form
      className="construction-form"
      aria-label="Danger zone"
      onSubmit={(e) => {
        e.preventDefault();
        const points = parsePlanList(outline);
        if (typeof points === 'string') return setProblem(points);
        const span = hours.trim() ? hours.split(/\s*[–-]\s*/) : undefined;
        if (span && span.length !== 2) return setProblem('Hours are "HH:MM–HH:MM", or empty.');
        setProblem('');
        const next: SiteZone = {
          id: zone.id,
          name,
          outline: points,
          taskId: task,
          ...(span ? { hours: [span[0]!, span[1]!] as [string, string] } : {}),
        };
        if (run({ type: 'putZone', zone: next })) discard();
      }}
    >
      <h3>{zone.id}</h3>
      <fieldset disabled={readOnly}>
        <Field label="Name">
          <input aria-label="Zone name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Outline (one x, y in mm a line)">
          <textarea
            aria-label="Zone outline"
            rows={4}
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
          />
        </Field>
        <Field label="While">
          <select aria-label="Zone task" value={task} onChange={(e) => setTask(e.target.value)}>
            {doc.tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || t.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hours (HH:MM–HH:MM, empty = all day)">
          <input aria-label="Zone hours" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" className="primary">
          Save zone
        </button>
        <button type="button" disabled={!dirty} onClick={discard}>
          Discard
        </button>
      </fieldset>
    </form>
  );
}
