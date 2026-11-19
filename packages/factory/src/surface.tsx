import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowRightLeft,
  Box,
  Boxes,
  Combine,
  Download,
  Inbox,
  LogIn,
  LogOut,
  MoveRight,
  Play,
  Redo2,
  Square,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  EditorHistoryContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  checkFactoryBuilding,
  distributionMean,
  factoryDistributionTypes,
  factoryFootprint,
  factoryObjectSize,
  factoryObstacles,
  type FactoryDiagnostic,
  type FactoryObstacle,
  factoryExitStrategies,
  factoryHistogramBins,
  factoryStates,
  factoryWarnings,
  freshFactoryId,
  writeFactoryTimesCsv,
  type FactoryDistribution,
  type FactoryDistributionType,
  type FactoryDocument,
  type FactoryLookRef,
  type FactoryLink,
  type FactoryObject,
  type FactoryObjectKind,
  type FactoryCalendar,
  type FactoryFleet,
  type FactoryPaths,
  factoryVehicleStates,
  type FactoryRunResult,
} from '@editor-platform/factory-core';
import type { BimKernel } from '@editor-platform/bim';
import type { FactoryController, FactoryNotice, FactorySurfaceState } from './controller';
import { ExperimentPanel } from './experiment';
import { Choice, Field, useSelect, useSettle } from './fields';
import { ControlResults, ControlSection } from './control';
import { factoryAutoLayout, factoryBox, factoryPlanBounds } from './layout';
import { factoryStateColors as stateColors } from './scene';
import { FactoryView3D, type FactoryLookView } from './view3d';

export function useFactoryState(controller: FactoryController): FactorySurfaceState {
  return useSyncExternalStore(
    useCallback((fn) => controller.subscribe(fn), [controller]),
    () => controller.state,
  );
}

export const factoryKindLabels: Record<FactoryObjectKind, string> = {
  source: 'Source',
  station: 'Station',
  parallel: 'Parallel station',
  assembly: 'Assembly',
  buffer: 'Buffer',
  conveyor: 'Conveyor',
  drain: 'Drain',
};
const kindIcons = {
  source: LogIn,
  station: Box,
  parallel: Boxes,
  assembly: Combine,
  buffer: Inbox,
  conveyor: MoveRight,
  drain: LogOut,
} as const;
const noticeWords: Record<string, string> = {
  'permission-denied': 'This model is read only.',
  'select-object': 'Select an object to link from first.',
  'select-something': 'Select an object or a link first.',
  'not-found': 'It is gone.',
  stopped: 'The run was stopped.',
  running: 'A run is going on.',
  'event-limit': 'The run took more than 10 million events.',
  'duplicate-link': 'These two objects are linked already.',
  'link-from-drain': 'A drain has no exit.',
  'link-to-source': 'A source has no entry.',
  'self-link': 'An object cannot link to itself.',
  'product-in-use': 'An object or link still uses this product.',
  'object-in-use': 'Its links do not fit the new kind.',
  'calendar-in-use': 'An object still works to this calendar.',
  'worker-missing': 'An object still needs workers from this pool.',
  'skill-missing': 'No worker pool has that skill.',
  'buffer-loop': 'Buffers linked in a loop would pass parts round forever.',
  'fleet-in-use': 'A link is still carried by this fleet.',
  'fleet-missing': 'There is no such fleet.',
  'no-path-node': 'Both ends of a carried link need a path node.',
  'path-node-missing': 'There is no such path node.',
  'duplicate-segment': 'These two points are joined already.',
  paths: 'The path text was not understood.',
  csv: 'The CSV was refused.',
  'program-unreadable': 'The file is neither PLCopen XML nor ladder JSON.',
  'program-invalid': 'The ladder program was refused.',
  'no-variable': 'Declare a free BOOL variable of that role in the program first.',
  'no-signal': 'Every signal of every object is wired already.',
  'signal-kind': 'That object has no such signal.',
  'variable-type': 'Sensors need BOOL inputs, actuators BOOL outputs.',
  'variable-missing': 'The program has no such variable.',
  'duplicate-variable': 'Two sensors cannot write one input.',
  'duplicate-signal': 'That signal of the object is wired already.',
  'limit-scans': 'The run needs too many PLC scans: a longer scan period or a shorter run.',
  replications: 'An experiment repeats 1 to 100 times.',
  'factor-target': 'That factor does not fit its target.',
  'factor-values': 'Factor values are whole numbers in range, at most 20.',
};
export const factoryNoticeText = (n: FactoryNotice) =>
  `${noticeWords[n.code] ?? 'The edit was refused.'}${n.message && !noticeWords[n.code] ? ` ${n.message}` : n.code === 'csv' && n.message ? ` ${n.message}` : ''} (${n.code}${n.path ? ` at ${n.path}` : ''})`;

/** Names longer than the box are cut with an ellipsis (the full name is the tooltip). */
const clip = (s: string) => ([...s].length > 16 ? `${[...s].slice(0, 15).join('')}…` : s);
/** Shifts as `6-14, 14-22` in hours from the start of the cycle. */
const writeShifts = (shifts: FactoryCalendar['shifts']) =>
  shifts.map((s) => `${hours(s.startMs)}-${hours(s.endMs)}`).join(', ');
function readShifts(
  text: string,
  old: FactoryCalendar['shifts'] = [],
): FactoryCalendar['shifts'] | undefined {
  const parts = text.split(',').map((p) => p.trim());
  const out: FactoryCalendar['shifts'] = [];
  for (const [i, p] of parts.entries()) {
    const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(p);
    if (!m) return undefined;
    out.push({
      name: old[i]?.name ?? `Shift ${i + 1}`,
      startMs: Math.round(Number(m[1]) * 3_600_000),
      endMs: Math.round(Number(m[2]) * 3_600_000),
    });
  }
  return out.length ? out : undefined;
}
/** Path points as `p-a 0 0; p-b 20 0` (ID, x and y in metres). */
const writePathNodes = (paths?: FactoryPaths) =>
  (paths?.nodes ?? []).map((n) => `${n.id} ${n.x / 1000} ${n.y / 1000}`).join('; ');
/** Segments as `p-a > p-b, p-b <> p-c` (`<>` both ways). */
const writePathSegments = (paths?: FactoryPaths) =>
  (paths?.segments ?? []).map((g) => `${g.from} ${g.twoWay ? '<>' : '>'} ${g.to}`).join(', ');
/** Undefined when the text is not understood; segments keep their IDs by their ends. */
export function readPaths(
  doc: FactoryDocument,
  nodesText: string,
  segmentsText: string,
): FactoryPaths | null | undefined {
  const nodes: FactoryPaths['nodes'] = [];
  for (const part of nodesText
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(\S+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return undefined;
    nodes.push({
      id: m[1]!,
      x: Math.round(Number(m[2]) * 1000),
      y: Math.round(Number(m[3]) * 1000),
    });
  }
  const old = doc.paths?.segments ?? [];
  const taken = new Set<string>();
  const segments: FactoryPaths['segments'] = [];
  for (const part of segmentsText
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(\S+)\s*(<>|>)\s*(\S+)$/.exec(part);
    if (!m) return undefined;
    const [from, to, twoWay] = [m[1]!, m[3]!, m[2] === '<>'];
    const same = old.find((g) => g.from === from && g.to === to && !taken.has(g.id));
    let id = same?.id;
    if (!id) {
      const ids = new Set([...taken, ...old.map((g) => g.id)]);
      for (let n = 1; !id || ids.has(id); n++) id = freshFactoryId(doc, `seg-${n}`);
    }
    taken.add(id);
    segments.push({ id, from, to, ...(twoWay ? { twoWay } : {}) });
  }
  return nodes.length || segments.length ? { nodes, segments } : null;
}
const hours = (ms: number) => +(ms / 3_600_000).toFixed(3);
const secs = (ms: number) => +(ms / 1000).toFixed(3);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The building content a check reads (a saved BIM version). */
export type FactoryBim = Parameters<typeof checkFactoryBuilding>[1];

/**
 * FT4a: the Building version the factory stands in, from the Host: the kept content of the one
 * set (`bim`, undefined when none is set or it was not kept), its label and the versions that
 * can be set instead. `choose` returns a message when it could not set the choice.
 */
export interface FactoryBuildingBinding {
  bim?: FactoryBim;
  /** FT4b: the BIM kernel that draws the building in 3D (none: the 3D view shows no building). */
  kernel?: BimKernel;
  label?: string;
  choices: { key: string; label: string }[];
  choose(key: string | undefined): Promise<string | undefined>;
}

/**
 * FT4c: the CAD versions that give objects their look, from the Host: the saved versions that
 * can be chosen, the label of one set, and each look's evaluation by content hash (`revision`
 * changes as evaluations finish). `choose` keeps the version with the record and sets it on the
 * object (none: back to its box); it returns a message when it could not.
 */
export interface FactoryLooksBinding {
  choices: { key: string; label: string }[];
  label(look: FactoryLookRef): string | undefined;
  choose(objectId: string, key: string | undefined): Promise<string | undefined>;
  view(contentHash: string): FactoryLookView;
  revision: number;
}

export function FactorySurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
  building,
  looks,
}: {
  controller: FactoryController;
  name: string;
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
  building?: FactoryBuildingBinding;
  looks?: FactoryLooksBinding;
}) {
  const state = useFactoryState(controller);
  const settle = useSettle();
  // Result rows select like the plan: a refused inspector draft keeps the selection.
  const selectResult = useSelect(controller);
  const locked = state.readOnly;
  const why = 'Read only';
  const history = useContext(EditorHistoryContext);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const file = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      controller.stop();
      controller.stopExperiment();
    },
    [controller],
  );
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !locked && controller.state.selection) {
        e.preventDefault();
        settleRef.current(() => controller.deleteSelection());
        return;
      }
      if (e.key === 'Escape' && controller.state.connectFrom) controller.toggleConnect();
      if (!history || locked) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, history, locked]);
  const doc = state.content;
  const selected = doc.objects.find((o) => o.id === state.selection);
  const selectedLink = doc.links.find((l) => l.id === state.selection);
  const warnings = useMemo(() => factoryWarnings(doc), [doc]);
  const bim = doc.building ? building?.bim : undefined;
  const obstacles = useMemo(() => (bim ? factoryObstacles(bim) : []), [bim]);
  const clashes = useMemo(
    () => (bim ? checkFactoryBuilding(doc, bim, obstacles) : []),
    [doc, bim, obstacles],
  );
  const result = state.result?.value;
  const fresh = state.result?.key === state.key;
  const [view, setView] = useState<'plan' | '3d'>('plan');
  const places = useMemo(() => factoryAutoLayout(doc), [doc]);
  const exportCsv = () => {
    const blob = new Blob([writeFactoryTimesCsv(doc)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name || 'factory'}-times.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="fac-surface" data-testid="fac-surface">
      <EditorLayout
        viewKey="factory"
        leftLabel="Model"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Factory tools">
            {!hostHistory && (
              <>
                <IconButton
                  icon={Undo2}
                  label="Undo"
                  disabled={locked}
                  reason={why}
                  onClick={() => settle(() => onUndo?.())}
                />
                <IconButton
                  icon={Redo2}
                  label="Redo"
                  disabled={locked}
                  reason={why}
                  onClick={() => settle(() => onRedo?.())}
                />
              </>
            )}
            {state.running ? (
              <IconButton icon={Square} label="Stop" onClick={() => controller.stop()} />
            ) : (
              <IconButton
                icon={Play}
                label="Run"
                disabled={!doc.objects.length}
                reason="Add objects first"
                onClick={() => settle(() => void controller.run())}
              />
            )}
            <span className="fac-sep" />
            {(Object.keys(factoryKindLabels) as FactoryObjectKind[]).map((k) => (
              <IconButton
                key={k}
                icon={kindIcons[k]}
                label={`Add ${factoryKindLabels[k].toLowerCase()}`}
                disabled={locked}
                reason={why}
                onClick={() => settle(() => controller.addObject(k))}
              />
            ))}
            <span className="fac-sep" />
            <IconButton
              icon={ArrowRightLeft}
              label={state.connectFrom ? 'Cancel link' : 'Link to…'}
              aria-pressed={!!state.connectFrom}
              disabled={locked || (!selected && !state.connectFrom)}
              reason={locked ? why : 'Select an object'}
              onClick={() => controller.toggleConnect()}
            />
            <IconButton
              icon={Trash2}
              label="Delete selection"
              disabled={locked || !state.selection}
              reason={locked ? why : 'Select something'}
              onClick={() => settle(() => controller.deleteSelection())}
            />
            <span className="fac-sep" />
            <IconButton
              icon={Upload}
              label="Import times CSV"
              disabled={locked}
              reason={why}
              onClick={() => file.current?.click()}
            />
            <IconButton icon={Download} label="Export times CSV" onClick={exportCsv} />
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              aria-label="Times CSV file"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) {
                  const text = await f.text();
                  settle(() => controller.importTimes(text));
                }
              }}
            />
          </Toolbar>
        }
        left={
          <>
            <ModelSection controller={controller} doc={doc} locked={locked} building={building} />
            <ControlSection controller={controller} doc={doc} locked={locked} />
          </>
        }
        inspector={
          <div className="fac-inspector">
            {selected ? (
              <ObjectInspector
                key={selected.id}
                controller={controller}
                doc={doc}
                object={selected}
                locked={locked}
                result={fresh ? result : undefined}
                looks={looks}
              />
            ) : selectedLink ? (
              <LinkInspector
                key={selectedLink.id}
                controller={controller}
                doc={doc}
                link={selectedLink}
                locked={locked}
                flow={fresh ? result?.flows[selectedLink.id] : undefined}
              />
            ) : (
              <Section title="Selection">
                <p className="fac-empty">Click an object or a link on the plan.</p>
              </Section>
            )}
            {clashes.length > 0 && (
              <Section title="Building">
                <ul className="fac-list" data-testid="fac-clashes">
                  {clashes.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </Section>
            )}
            {warnings.length > 0 && (
              <Section title="Warnings">
                <ul className="fac-list" data-testid="fac-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        }
        status={
          <span className="fac-status" data-testid="fac-status">
            {state.running
              ? 'Running…'
              : result
                ? `${fresh ? 'Result' : 'Result of an earlier model'}: ${result.produced} produced, ${result.throughputPerHour.toFixed(1)}/h`
                : 'Not run'}
            {state.connectFrom && ' · Click the object to link to (Esc cancels)'}
            {state.notice && (
              <span className="fac-notice" role="alert" data-testid="fac-notice">
                {' '}
                · {factoryNoticeText(state.notice)}
              </span>
            )}
          </span>
        }
        {...layout}
      >
        <div className="fac-main">
          <div role="tablist" aria-label="View" className="fac-tabs fac-views">
            {(
              [
                ['plan', 'Plan'],
                ['3d', '3D'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
                {label}
              </button>
            ))}
          </div>
          {view === 'plan' ? (
            <Plan
              controller={controller}
              state={state}
              result={fresh ? result : undefined}
              obstacles={obstacles}
              clashes={clashes}
              showFootprints={!!bim}
            />
          ) : (
            <FactoryView3D
              doc={doc}
              places={places}
              result={fresh ? result : undefined}
              bim={bim}
              kernel={building?.kernel}
              looks={looks}
              selection={state.selection}
              onPick={(id) => void selectResult(id)}
            />
          )}
          {result && (
            <Results
              doc={doc}
              result={result}
              stale={!fresh}
              onSelect={(id) => void selectResult(id)}
            />
          )}
          <ExperimentPanel controller={controller} state={state} name={name} />
        </div>
      </EditorLayout>
    </div>
  );
}

// The plan.

function Plan({
  controller,
  state,
  result,
  obstacles,
  clashes,
  showFootprints,
}: {
  controller: FactoryController;
  state: FactorySurfaceState;
  result?: FactoryRunResult;
  /** FT4a: the building's walls and columns, and what runs into them. */
  obstacles: FactoryObstacle[];
  clashes: FactoryDiagnostic[];
  showFootprints: boolean;
}) {
  const doc = state.content;
  const select = useSelect(controller);
  const [flows, setFlows] = useState(false);
  const layout = useMemo(() => factoryAutoLayout(doc), [doc]);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; moved: boolean }>();
  const svg = useRef<SVGSVGElement>(null);
  const b = factoryPlanBounds(layout, [
    ...(doc.paths?.nodes ?? []),
    ...obstacles.flatMap((o) => o.outline.map(([x, y]) => ({ x, y }))),
    // The footprints drawn, whole: an object larger than its plan box stays in view.
    ...(showFootprints
      ? doc.objects.flatMap((o) => {
          const at = layout.get(o.id);
          return at ? factoryFootprint(o, at).map(([x, y]) => ({ x, y })) : [];
        })
      : []),
  ]);
  const clashing = new Set(
    clashes
      .filter((c) => c.code === 'object-clash')
      .map((c) => doc.objects[Number(c.path.split('.')[2])]?.id),
  );
  const W = factoryBox.w;
  const H = factoryBox.h;
  const pos = (id: string) => {
    const p = layout.get(id)!;
    return drag?.id === id ? { x: p.x + drag.dx, y: p.y + drag.dy } : p;
  };
  const toMm = (e: { clientX: number; clientY: number }) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: -p.y };
  };
  const start = useRef({ x: 0, y: 0 });
  const stats = new Map(result?.objects.map((o) => [o.id, o]));
  const period = result ? result.endMs - result.startMs : 0;
  const top = result?.bottlenecks[0];
  const maxFlow = Math.max(1, ...Object.values(result?.flows ?? {}));
  return (
    <div className="fac-plan-wrap">
      <div className="fac-plan-bar">
        <label>
          <input
            type="checkbox"
            checked={flows}
            disabled={!result}
            onChange={(e) => setFlows(e.target.checked)}
          />{' '}
          Show flows
        </label>
        <span className="fac-legend">
          {factoryStates.map((s) => (
            <span key={s}>
              <i style={{ background: stateColors[s] }} /> {s}
            </span>
          ))}
        </span>
      </div>
      <svg
        ref={svg}
        className="fac-plan"
        data-testid="fac-plan"
        role="group"
        aria-label="Floor plan"
        viewBox={`${b.minX} ${-b.maxY} ${b.maxX - b.minX} ${b.maxY - b.minY}`}
        onPointerDown={(e) => {
          if (e.target === svg.current) select(undefined);
        }}
      >
        <defs>
          <marker
            id="fac-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerUnits="userSpaceOnUse"
            markerWidth="320"
            markerHeight="320"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" fill="#475569" />
          </marker>
        </defs>
        {!doc.objects.length && (
          <text x={0} y={0} className="fac-hint">
            Add a source, stations and a drain, then link them.
          </text>
        )}
        {obstacles.length > 0 && (
          <g className="fac-building" data-testid="fac-building">
            {obstacles.map((o) => (
              <polygon
                key={o.elementId}
                data-kind={o.kind}
                points={o.outline.map(([x, y]) => `${x},${-y}`).join(' ')}
              >
                <title>{o.elementId}</title>
              </polygon>
            ))}
            {obstacles.flatMap((o) =>
              o.passages.map((p, i) => (
                <polygon
                  key={`${o.elementId}-${i}`}
                  className="fac-passage"
                  points={p.outline.map(([x, y]) => `${x},${-y}`).join(' ')}
                />
              )),
            )}
          </g>
        )}
        {showFootprints && (
          <g className="fac-footprints" data-testid="fac-footprints">
            {doc.objects.map((o) => {
              const p = pos(o.id);
              return (
                <polygon
                  key={o.id}
                  data-clash={clashing.has(o.id) || undefined}
                  points={factoryFootprint(o, { ...p, angle: layout.get(o.id)?.angle })
                    .map(([x, y]) => `${x},${-y}`)
                    .join(' ')}
                >
                  <title>{`${o.name || o.id}: ${(() => {
                    const z = factoryObjectSize(o);
                    return `${z.widthMm} × ${z.depthMm} × ${z.heightMm} mm`;
                  })()}`}</title>
                </polygon>
              );
            })}
          </g>
        )}
        {doc.paths && (
          <g className="fac-paths" data-testid="fac-paths">
            {doc.paths.segments.map((g) => {
              const a = doc.paths!.nodes.find((n) => n.id === g.from);
              const c = doc.paths!.nodes.find((n) => n.id === g.to);
              return a && c ? (
                <line key={g.id} x1={a.x} y1={-a.y} x2={c.x} y2={-c.y}>
                  <title>{g.id}</title>
                </line>
              ) : null;
            })}
            {doc.paths.nodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x} ${-n.y})`}>
                <circle r={160} />
                <text y={-240}>{n.id}</text>
              </g>
            ))}
          </g>
        )}
        {doc.links.map((l) => {
          const a = pos(l.from);
          const c = pos(l.to);
          const sel = state.selection === l.id;
          const f = result?.flows[l.id] ?? 0;
          const width = flows && result ? 40 + (200 * f) / maxFlow : 40;
          return (
            <g
              key={l.id}
              className="fac-link"
              data-selected={sel || undefined}
              role="button"
              aria-label={`Link ${l.from} to ${l.to}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                select(l.id);
              }}
            >
              <line
                x1={a.x + W / 2}
                y1={-a.y}
                x2={c.x - W / 2}
                y2={-c.y}
                className="fac-link-hit"
              />
              <line
                x1={a.x + W / 2}
                y1={-a.y}
                x2={c.x - W / 2}
                y2={-c.y}
                strokeDasharray={l.transport ? '160 120' : undefined}
                strokeWidth={width}
                markerEnd="url(#fac-arrow)"
              />
              {flows && result && (
                <text x={(a.x + c.x) / 2} y={-(a.y + c.y) / 2 - 200} className="fac-flow">
                  {f}
                </text>
              )}
            </g>
          );
        })}
        {doc.objects.map((o) => {
          const p = pos(o.id);
          const st = stats.get(o.id);
          const sel = state.selection === o.id;
          return (
            <g
              key={o.id}
              className="fac-obj"
              data-kind={o.kind}
              data-selected={sel || undefined}
              data-connect={state.connectFrom === o.id || undefined}
              transform={`translate(${p.x} ${-p.y})`}
              role="button"
              aria-label={`${factoryKindLabels[o.kind]} ${o.name}`}
              onPointerDown={(e: ReactPointerEvent) => {
                e.stopPropagation();
                if (!select(o.id)) return;
                if (state.readOnly || controller.state.selection !== o.id) return;
                start.current = toMm(e);
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag({ id: o.id, dx: 0, dy: 0, moved: false });
              }}
              onPointerMove={(e) => {
                if (drag?.id !== o.id) return;
                const m = toMm(e);
                const dx = m.x - start.current.x;
                const dy = m.y - start.current.y;
                setDrag({ id: o.id, dx, dy, moved: drag.moved || Math.hypot(dx, dy) > 150 });
              }}
              onPointerUp={() => {
                if (drag?.id !== o.id) return;
                const p0 = layout.get(o.id)!;
                if (drag.moved) controller.moveObject(o.id, p0.x + drag.dx, p0.y + drag.dy);
                setDrag(undefined);
              }}
            >
              <rect x={-W / 2} y={-H / 2} width={W} height={H} rx={120} className="fac-box" />
              <text y={-H / 2 + 330} className="fac-kind">
                {factoryKindLabels[o.kind]}
              </text>
              <text y={-H / 2 + 680} className="fac-name">
                {clip(o.name || o.id)}
              </text>
              <title>{o.name || o.id}</title>
              {st && period > 0 && (
                <g transform={`translate(${-W / 2 + 120} ${H / 2 - 330})`}>
                  {(() => {
                    let x = 0;
                    return factoryStates.map((s) => {
                      const w = ((W - 240) * st.states[s]) / period;
                      const r = <rect key={s} x={x} width={w} height={200} fill={stateColors[s]} />;
                      x += w;
                      return r;
                    });
                  })()}
                </g>
              )}
              {top && top.id === o.id && top.share > 0 && (
                <text y={-H / 2 - 120} className="fac-bottleneck" data-testid="fac-bottleneck-mark">
                  Bottleneck
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Results.

function Results({
  doc,
  result,
  stale,
  onSelect,
}: {
  doc: FactoryDocument;
  result: FactoryRunResult;
  stale: boolean;
  onSelect(id: string): void;
}) {
  const [tab, setTab] = useState<'summary' | 'gantt' | 'lead'>('summary');
  const period = result.endMs - result.startMs;
  const names = new Map(doc.objects.map((o) => [o.id, o.name || o.id]));
  return (
    <section className="fac-results" data-testid="fac-results" data-stale={stale || undefined}>
      {stale && (
        <p className="fac-stale">
          These results are for an earlier version of the model. Run again.
        </p>
      )}
      {result.deadlock && (
        <p className="fac-stale" data-testid="fac-deadlock">
          Deadlock at {hours(result.deadlock.atMs)} h: {result.deadlock.vehicles.join(', ')} wait
          for each other on {result.deadlock.segments.join(', ')}. The run stopped there.
        </p>
      )}
      <ControlResults doc={doc} result={result} stale={stale} />
      <div className="fac-tiles">
        <Tile label="Produced" value={String(result.produced)} />
        <Tile label="Per hour" value={result.throughputPerHour.toFixed(1)} />
        <Tile label="Lead time" value={`${secs(result.leadTime.meanMs)} s`} />
        <Tile label="Work in progress" value={result.wip.mean.toFixed(1)} />
        <Tile label="Period" value={`${hours(period)} h`} />
      </div>
      <div role="tablist" className="fac-tabs">
        {(
          [
            ['summary', 'States'],
            ['gantt', 'Timeline'],
            ['lead', 'Lead time'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'summary' && (
        <div className="fac-summary">
          <table className="fac-table" data-testid="fac-states">
            <thead>
              <tr>
                <th>Object</th>
                {factoryStates.map((s) => (
                  <th key={s}>{s}</th>
                ))}
                <th>Mean content</th>
                <th>Out</th>
              </tr>
            </thead>
            <tbody>
              {result.objects.map((o) => (
                <tr key={o.id} onClick={() => onSelect(o.id)}>
                  <td>{names.get(o.id) ?? o.id}</td>
                  {factoryStates.map((s) => (
                    <td key={s}>
                      <span className="fac-bar">
                        <i
                          style={{ width: pct(o.states[s] / period), background: stateColors[s] }}
                        />
                      </span>
                      {pct(o.states[s] / period)}
                    </td>
                  ))}
                  <td>{o.meanContent.toFixed(2)}</td>
                  <td>{o.exited}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="fac-table" data-testid="fac-bottlenecks">
            <caption>Bottlenecks (active periods)</caption>
            <thead>
              <tr>
                <th>Object</th>
                <th>Share</th>
                <th>Sole</th>
                <th>Shifting</th>
                <th>Mean active</th>
              </tr>
            </thead>
            <tbody>
              {result.bottlenecks.map((b) => (
                <tr key={b.id} onClick={() => onSelect(b.id)}>
                  <td>{names.get(b.id) ?? b.id}</td>
                  <td>{pct(b.share)}</td>
                  <td>{pct(b.soleMs / period)}</td>
                  <td>{pct(b.shiftingMs / period)}</td>
                  <td>{secs(b.meanActiveMs)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'summary' && result.workers.length > 0 && (
        <table className="fac-table" data-testid="fac-workers">
          <caption>Workers</caption>
          <thead>
            <tr>
              <th>Pool</th>
              <th>Workers</th>
              <th>Busy</th>
              <th>Walking</th>
              <th>Mean wait</th>
            </tr>
          </thead>
          <tbody>
            {result.workers.map((w) => (
              <tr key={w.poolId}>
                <td>{doc.workerPools?.find((p) => p.id === w.poolId)?.name ?? w.poolId}</td>
                <td>{w.count}</td>
                <td>{pct(w.busyShare)}</td>
                <td>{pct(w.walkShare)}</td>
                <td>{secs(w.meanWaitMs)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'summary' && result.fleets.length > 0 && (
        <table className="fac-table" data-testid="fac-fleet-stats">
          <caption>Vehicles</caption>
          <thead>
            <tr>
              <th>Fleet</th>
              <th>Vehicles</th>
              <th>Trips</th>
              {factoryVehicleStates.map((k) => (
                <th key={k}>{k}</th>
              ))}
              <th>Mean call wait</th>
            </tr>
          </thead>
          <tbody>
            {result.fleets.map((f) => (
              <tr key={f.fleetId}>
                <td>{doc.fleets?.find((x) => x.id === f.fleetId)?.name ?? f.fleetId}</td>
                <td>{f.count}</td>
                <td>{f.trips}</td>
                {factoryVehicleStates.map((k) => (
                  <td key={k}>{pct(f.shares[k])}</td>
                ))}
                <td>{secs(f.meanCallWaitMs)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'gantt' && <Gantt doc={doc} result={result} />}
      {tab === 'lead' && <LeadTime result={result} />}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="fac-tile">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Gantt({ doc, result }: { doc: FactoryDocument; result: FactoryRunResult }) {
  const [from, setFrom] = useState(result.startMs);
  const [span, setSpan] = useState(Math.min(3_600_000, result.endMs - result.startMs));
  const t = result.timeline;
  if (!t) return <p className="fac-empty">Run with recording to see the timeline.</p>;
  // Rows follow the objects of the run (its recording), not the model as edited since.
  const rows: { id: string; label: string; place: number; index: number }[] = [];
  result.objects.forEach((o, index) => {
    if (o.kind === 'drain') return;
    const now = doc.objects.find((x) => x.id === o.id);
    const s = t.states[index] ?? [];
    let places = now?.kind === 'parallel' && o.kind === 'parallel' ? now.count : 1;
    for (let k = 3; k < s.length; k += 4) places = Math.max(places, s[k]! + 1);
    const name = now?.name || o.id;
    for (let p = 0; p < places; p++)
      rows.push({ id: o.id, label: places > 1 ? `${name} ${p + 1}` : name, place: p, index });
  });
  const W = 1000;
  const RH = 18;
  const LW = 160;
  const to = from + span;
  const x = (ms: number) => LW + ((Math.min(to, Math.max(from, ms)) - from) / span) * (W - LW);
  return (
    <div className="fac-gantt" data-testid="fac-gantt">
      <div className="fac-gantt-bar">
        <label>
          From (h)
          <input
            type="number"
            aria-label="Timeline start in hours"
            min={0}
            step={0.25}
            value={hours(from)}
            onChange={(e) => setFrom(Math.max(0, Number(e.target.value) * 3_600_000))}
          />
        </label>
        <label>
          Span (h)
          <input
            type="number"
            aria-label="Timeline span in hours"
            min={0.05}
            step={0.25}
            value={hours(span)}
            onChange={(e) => setSpan(Math.max(60_000, Number(e.target.value) * 3_600_000))}
          />
        </label>
        {t.truncated && <span className="fac-notice">The recording stopped at its limit.</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${rows.length * RH + 20}`} className="fac-gantt-svg">
        {rows.map((r, i) => {
          const s = t.states[r.index]!;
          const cells = [];
          for (let k = 0; k < s.length; k += 4) {
            if (s[k + 3] !== r.place || s[k + 1]! <= from || s[k]! >= to) continue;
            const state = factoryStates[s[k + 2]!]!;
            if (state === 'waiting') continue;
            cells.push(
              <rect
                key={k}
                x={x(s[k]!)}
                y={i * RH + 2}
                width={Math.max(0.5, x(s[k + 1]!) - x(s[k]!))}
                height={RH - 4}
                fill={stateColors[state]}
              />,
            );
          }
          return (
            <g key={`${r.id}-${r.place}`}>
              <text x={4} y={i * RH + 13} className="fac-gantt-label">
                {r.label}
              </text>
              <line x1={LW} x2={W} y1={i * RH + RH} y2={i * RH + RH} className="fac-gantt-grid" />
              {cells}
            </g>
          );
        })}
        <text x={LW} y={rows.length * RH + 16} className="fac-gantt-label">
          {hours(from)} h
        </text>
        <text x={W - 4} y={rows.length * RH + 16} textAnchor="end" className="fac-gantt-label">
          {hours(to)} h
        </text>
      </svg>
    </div>
  );
}

function LeadTime({ result }: { result: FactoryRunResult }) {
  const lt = result.leadTime;
  const max = Math.max(1, ...lt.histogram);
  const W = 600;
  const H = 160;
  const bw = W / factoryHistogramBins;
  return (
    <div className="fac-lead" data-testid="fac-lead">
      <p>
        Mean {secs(lt.meanMs)} s · median {secs(lt.p50Ms)} s · 90% {secs(lt.p90Ms)} s · 95%{' '}
        {secs(lt.p95Ms)} s · min {secs(lt.minMs)} s · max {secs(lt.maxMs)} s
      </p>
      <svg viewBox={`0 0 ${W} ${H + 20}`} className="fac-hist">
        {lt.histogram.map((c, i) => (
          <rect
            key={i}
            x={i * bw + 1}
            y={H - (H * c) / max}
            width={bw - 2}
            height={(H * c) / max}
          />
        ))}
        <text x={0} y={H + 16}>
          {secs(lt.minMs)} s
        </text>
        <text x={W} y={H + 16} textAnchor="end">
          {secs(lt.maxMs)} s
        </text>
      </svg>
    </div>
  );
}

// Panels.

function ModelSection({
  controller,
  doc,
  locked,
  building,
}: {
  controller: FactoryController;
  doc: FactoryDocument;
  locked: boolean;
  building?: FactoryBuildingBinding;
}) {
  const settle = useSettle();
  const [buildingError, setBuildingError] = useState<string>();
  const run = doc.run;
  const num = (v: string, min: number) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= min ? n : undefined;
  };
  return (
    <div className="fac-model">
      {building && (
        <Section title="Building">
          <Choice
            label="Building version"
            value={doc.building ? 'current' : ''}
            disabled={locked}
            options={[
              { value: '', label: '(none)' },
              ...(doc.building
                ? [{ value: 'current', label: building.label ?? 'A saved Building version' }]
                : []),
              ...building.choices.map((c) => ({ value: c.key, label: c.label })),
            ]}
            onChange={(v) =>
              settle(() => {
                if (v === 'current') return;
                setBuildingError(undefined);
                void building.choose(v || undefined).then(setBuildingError);
              })
            }
          />
          {doc.building && !building.bim && (
            <p className="fac-empty">The version is not kept with this factory: no checks.</p>
          )}
          {buildingError && (
            <p className="fac-error" role="alert">
              {buildingError}
            </p>
          )}
        </Section>
      )}
      <Section title="Run">
        <Field
          readOnly={locked}
          label="Duration (h)"
          value={String(hours(run.durationMs))}
          onCommit={(v) => {
            const n = num(v, 0);
            return (
              !!n &&
              !controller.apply({
                type: 'setRun',
                run: { ...run, durationMs: Math.round(n * 3_600_000) },
              })
            );
          }}
        />
        <Field
          readOnly={locked}
          label="Warm-up (h)"
          value={String(hours(run.warmupMs ?? 0))}
          onCommit={(v) => {
            const n = num(v, 0);
            return (
              n !== undefined &&
              !controller.apply({
                type: 'setRun',
                run: { ...run, warmupMs: Math.round(n * 3_600_000) },
              })
            );
          }}
        />
        <Field
          readOnly={locked}
          label="Seed"
          value={String(run.seed)}
          onCommit={(v) => {
            const n = num(v, 0);
            return (
              n !== undefined &&
              Number.isInteger(n) &&
              !controller.apply({ type: 'setRun', run: { ...run, seed: n } })
            );
          }}
        />
      </Section>
      <Section title="Calendars">
        <ul className="fac-list" data-testid="fac-calendars">
          {(doc.calendars ?? []).map((c) => (
            <li key={c.id} className="fac-calendar">
              <Field
                readOnly={locked}
                label={`Calendar ${c.id}`}
                value={c.name}
                onCommit={(v) =>
                  !controller.apply({ type: 'putCalendar', calendar: { ...c, name: v } })
                }
              />
              <Field
                readOnly={locked}
                label={`Cycle of ${c.id} (h)`}
                value={String(hours(c.cycleMs))}
                onCommit={(v) => {
                  const n = num(v, 0);
                  return (
                    !!n &&
                    !controller.apply({
                      type: 'putCalendar',
                      calendar: { ...c, cycleMs: Math.round(n * 3_600_000) },
                    })
                  );
                }}
              />
              <Field
                readOnly={locked}
                label={`Shifts of ${c.id} (h, start-end)`}
                value={writeShifts(c.shifts)}
                onCommit={(v) => {
                  const shifts = readShifts(v, c.shifts);
                  return (
                    !!shifts &&
                    !controller.apply({ type: 'putCalendar', calendar: { ...c, shifts } })
                  );
                }}
              />
              <button
                disabled={locked}
                aria-label={`Remove calendar ${c.id}`}
                onClick={() => settle(() => controller.apply({ type: 'removeCalendar', id: c.id }))}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <button
          disabled={locked}
          onClick={() =>
            settle(() =>
              controller.apply({
                type: 'putCalendar',
                calendar: {
                  id: freshFactoryId(doc, 'calendar'),
                  name: 'Two shifts',
                  cycleMs: 24 * 3_600_000,
                  shifts: [
                    { name: 'Early', startMs: 6 * 3_600_000, endMs: 14 * 3_600_000 },
                    { name: 'Late', startMs: 14 * 3_600_000, endMs: 22 * 3_600_000 },
                  ],
                },
              }),
            )
          }
        >
          Add calendar
        </button>
      </Section>
      <Section title="Worker pools">
        <ul className="fac-list" data-testid="fac-pools">
          {(doc.workerPools ?? []).map((w) => {
            const putPool = (pool: typeof w) => !controller.apply({ type: 'putWorkerPool', pool });
            return (
              <li key={w.id} className="fac-calendar">
                <Field
                  readOnly={locked}
                  label={`Pool ${w.id}`}
                  value={w.name}
                  onCommit={(v) => putPool({ ...w, name: v })}
                />
                <Field
                  readOnly={locked}
                  label={`Workers in ${w.id}`}
                  value={String(w.count)}
                  onCommit={(v) => {
                    const n = num(v, 1);
                    return !!n && Number.isInteger(n) && putPool({ ...w, count: n });
                  }}
                />
                <Field
                  readOnly={locked}
                  label={`Skills of ${w.id} (comma)`}
                  value={w.skills.join(', ')}
                  onCommit={(v) =>
                    putPool({
                      ...w,
                      skills: v
                        .split(',')
                        .map((k) => k.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <Field
                  readOnly={locked}
                  label={`Walking speed of ${w.id} (m/s)`}
                  value={String(w.walkSpeedMmS / 1000)}
                  onCommit={(v) => {
                    const n = num(v, 0);
                    return !!n && putPool({ ...w, walkSpeedMmS: Math.round(n * 1000) });
                  }}
                />
                <button
                  disabled={locked}
                  aria-label={`Remove pool ${w.id}`}
                  onClick={() =>
                    settle(() => controller.apply({ type: 'removeWorkerPool', id: w.id }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
        <button
          disabled={locked}
          onClick={() =>
            settle(() =>
              controller.apply({
                type: 'putWorkerPool',
                pool: {
                  id: freshFactoryId(doc, 'workers'),
                  name: 'Workers',
                  count: 2,
                  skills: [],
                  walkSpeedMmS: 1000,
                },
              }),
            )
          }
        >
          Add worker pool
        </button>
      </Section>
      <Section title="Vehicles">
        <PathFields controller={controller} doc={doc} locked={locked} />
        <ul className="fac-list" data-testid="fac-fleets">
          {(doc.fleets ?? []).map((f) => {
            const putFleet = (fleet: FactoryFleet) =>
              !controller.apply({ type: 'putFleet', fleet });
            return (
              <li key={f.id} className="fac-calendar">
                <Field
                  readOnly={locked}
                  label={`Fleet ${f.id}`}
                  value={f.name}
                  onCommit={(v) => putFleet({ ...f, name: v })}
                />
                <Field
                  readOnly={locked}
                  label={`Vehicles in ${f.id}`}
                  value={String(f.count)}
                  onCommit={(v) => {
                    const n = num(v, 1);
                    return !!n && Number.isInteger(n) && putFleet({ ...f, count: n });
                  }}
                />
                <Field
                  readOnly={locked}
                  label={`Speed of ${f.id} (m/s)`}
                  value={String(f.speedMmS / 1000)}
                  onCommit={(v) => {
                    const n = num(v, 0);
                    return !!n && putFleet({ ...f, speedMmS: Math.round(n * 1000) });
                  }}
                />
                <Field
                  readOnly={locked}
                  label={`Load and unload of ${f.id} (s)`}
                  value={`${secs(f.loadMs)}, ${secs(f.unloadMs)}`}
                  onCommit={(v) => {
                    const [a, b] = v.split(',').map((x) => num(x, 0));
                    return (
                      a !== undefined &&
                      b !== undefined &&
                      putFleet({
                        ...f,
                        loadMs: Math.round(a * 1000),
                        unloadMs: Math.round(b * 1000),
                      })
                    );
                  }}
                />
                <Choice
                  label={`Home of ${f.id}`}
                  value={f.homeNodeId}
                  disabled={locked}
                  options={(doc.paths?.nodes ?? []).map((n) => n.id)}
                  onChange={(v) => settle(() => putFleet({ ...f, homeNodeId: v }))}
                />
                <button
                  disabled={locked}
                  aria-label={`Remove fleet ${f.id}`}
                  onClick={() => settle(() => controller.apply({ type: 'removeFleet', id: f.id }))}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            );
          })}
        </ul>
        <button
          disabled={locked || !doc.paths?.nodes.length}
          onClick={() =>
            settle(() =>
              controller.apply({
                type: 'putFleet',
                fleet: {
                  id: freshFactoryId(doc, 'agv'),
                  name: 'AGVs',
                  count: 2,
                  speedMmS: 1000,
                  loadMs: 10_000,
                  unloadMs: 10_000,
                  homeNodeId: doc.paths!.nodes[0]!.id,
                },
              }),
            )
          }
        >
          Add fleet
        </button>
      </Section>
      <Section title="Products">
        <ul className="fac-list" data-testid="fac-products">
          {doc.products.map((p) => (
            <li key={p.id}>
              <Field
                readOnly={locked}
                label={`Product ${p.id}`}
                value={p.name}
                onCommit={(v) =>
                  !controller.apply({ type: 'putProduct', product: { ...p, name: v } })
                }
              />
              <button
                disabled={locked}
                aria-label={`Remove product ${p.id}`}
                onClick={() => settle(() => controller.apply({ type: 'removeProduct', id: p.id }))}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <button
          disabled={locked}
          onClick={() =>
            settle(() => {
              // Fresh across the whole document: products, objects, links and the rest share IDs.
              const n = doc.products.length + 1;
              controller.apply({
                type: 'putProduct',
                product: { id: freshFactoryId(doc, `product-${n}`), name: `Product ${n}` },
              });
            })
          }
        >
          Add product
        </button>
      </Section>
    </div>
  );
}

/** The path network as two text fields (points, then segments); applied together. */
function PathFields({
  controller,
  doc,
  locked,
}: {
  controller: FactoryController;
  doc: FactoryDocument;
  locked: boolean;
}) {
  const nodes = writePathNodes(doc.paths);
  const segs = writePathSegments(doc.paths);
  const set = (n: string, g: string) => {
    const paths = readPaths(doc, n, g);
    if (paths === undefined) return (controller.notify({ code: 'paths' }), false);
    return !controller.apply({ type: 'setPaths', paths });
  };
  return (
    <>
      <Field
        readOnly={locked}
        label="Path points (id x y in m; …)"
        value={nodes}
        onCommit={(v) => set(v, segs)}
      />
      <Field
        readOnly={locked}
        label="Path segments (a > b, a <> b)"
        value={segs}
        onCommit={(v) => set(nodes, v)}
      />
    </>
  );
}

/** Distribution fields in seconds. */
function DistributionFields({
  label,
  value,
  locked,
  onChange,
}: {
  label: string;
  value: FactoryDistribution;
  locked: boolean;
  onChange(d: FactoryDistribution): boolean;
}) {
  const settle = useSettle();
  const keys: Record<Exclude<FactoryDistributionType, 'empirical'>, string[]> = {
    const: ['value'],
    uniform: ['min', 'max'],
    triangular: ['min', 'mode', 'max'],
    normal: ['mean', 'sd'],
    lognormal: ['mean', 'sd'],
    exponential: ['mean'],
  };
  const fromMean = (type: FactoryDistributionType, m: number): FactoryDistribution => {
    switch (type) {
      case 'const':
        return { type, value: m };
      case 'uniform':
        return { type, min: Math.round(m * 0.8), max: Math.round(m * 1.2) };
      case 'triangular':
        return { type, min: Math.round(m * 0.8), mode: m, max: Math.round(m * 1.2) };
      case 'normal':
      case 'lognormal':
        return { type, mean: m, sd: Math.round(m * 0.1) };
      case 'exponential':
        return { type, mean: Math.max(1, m) };
      case 'empirical':
        return { type, values: [{ value: m, weight: 1 }] };
    }
  };
  const v = value as unknown as Record<string, number>;
  return (
    <fieldset className="fac-dist" aria-label={label}>
      <legend>{label}</legend>
      <Choice
        label={`${label} type`}
        value={value.type}
        disabled={locked}
        options={factoryDistributionTypes.filter(
          (t) => t !== 'empirical' || value.type === 'empirical',
        )}
        onChange={(t) =>
          settle(() =>
            onChange(fromMean(t as FactoryDistributionType, Math.round(distributionMean(value)))),
          )
        }
      />
      {value.type === 'empirical' ? (
        <p className="fac-empty">{value.values.length} values (edit as JSON or CSV)</p>
      ) : (
        keys[value.type].map((k) => (
          <Field
            key={k}
            readOnly={locked}
            label={`${label} ${k} (s)`}
            value={String(secs(v[k] ?? 0))}
            onCommit={(text) => {
              const n = Number(text);
              if (text.trim() === '' || !Number.isFinite(n) || n < 0) return false;
              return onChange({ ...value, [k]: Math.round(n * 1000) } as FactoryDistribution);
            }}
          />
        ))
      )}
    </fieldset>
  );
}

function ObjectInspector({
  controller,
  doc,
  object: o,
  locked,
  result,
  looks,
}: {
  controller: FactoryController;
  doc: FactoryDocument;
  object: FactoryObject;
  locked: boolean;
  result?: FactoryRunResult;
  looks?: FactoryLooksBinding;
}) {
  const settle = useSettle();
  const [lookError, setLookError] = useState<string>();
  const lookKey = o.look ? `${o.look.artifactId}:${o.look.versionId}` : undefined;
  const lookView = o.look ? looks?.view(o.look.contentHash) : undefined;
  const put = (next: FactoryObject) => !controller.updateObject(next);
  const int = (v: string, min: number) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isInteger(n) && n >= min ? n : undefined;
  };
  const products = doc.products.map((p) => ({ value: p.id, label: p.name || p.id }));
  const st = result?.objects.find((x) => x.id === o.id);
  const period = result ? result.endMs - result.startMs : 0;
  const hasOuts = doc.links.filter((l) => l.from === o.id).length > 1;
  return (
    <>
      <Section title={factoryKindLabels[o.kind]}>
        <p className="fac-id">{o.id}</p>
        <Field
          readOnly={locked}
          label="Name"
          value={o.name}
          onCommit={(v) => put({ ...o, name: v })}
        />
        {o.kind !== 'drain' && hasOuts && (
          <Choice
            label="Exit"
            value={o.exit ?? 'first-free'}
            disabled={locked}
            options={factoryExitStrategies}
            onChange={(v) => settle(() => put({ ...o, exit: v as FactoryObject['exit'] }))}
          />
        )}
        {(doc.paths?.nodes.length ?? 0) > 0 && (
          <Choice
            label="Path node"
            value={o.pathNodeId ?? ''}
            disabled={locked}
            options={[
              { value: '', label: '(none)' },
              ...doc.paths!.nodes.map((n) => ({ value: n.id, label: n.id })),
            ]}
            onChange={(v) =>
              settle(() => {
                const { pathNodeId: _, ...rest } = o;
                put(v ? { ...rest, pathNodeId: v } : rest);
              })
            }
          />
        )}
        {(['widthMm', 'depthMm', 'heightMm'] as const).map((k) => (
          <Field
            key={k}
            readOnly={locked}
            label={`${k === 'widthMm' ? 'Width' : k === 'depthMm' ? 'Depth' : 'Height'} (mm)`}
            value={String(factoryObjectSize(o)[k])}
            onCommit={(v) => {
              const n = int(v, 1);
              return n !== undefined && put({ ...o, size: { ...factoryObjectSize(o), [k]: n } });
            }}
          />
        ))}
        {looks && (
          <>
            <Choice
              label="Look (CAD version)"
              value={o.look ? 'current' : ''}
              disabled={locked}
              options={[
                { value: '', label: '(box)' },
                ...(o.look
                  ? [{ value: 'current', label: looks.label(o.look) ?? 'A saved CAD version' }]
                  : []),
                ...looks.choices
                  .filter((c) => c.key !== lookKey)
                  .map((c) => ({ value: c.key, label: c.label })),
              ]}
              onChange={(v) => {
                if (v === 'current') return;
                settle(() => {
                  setLookError(undefined);
                  void looks.choose(o.id, v || undefined).then(setLookError);
                });
              }}
            />
            {lookError && (
              <p className="fac-error" role="alert">
                {lookError}
              </p>
            )}
            {lookView?.status === 'pending' && (
              <p className="fac-note" data-testid="fac-look-status">
                Evaluating the look…
              </p>
            )}
            {lookView?.status === 'failed' && (
              <p className="fac-error" data-testid="fac-look-status">
                The look could not be drawn ({lookView.message}): the object is a box.
              </p>
            )}
          </>
        )}
        {o.kind === 'source' && (
          <>
            <DistributionFields
              label="Interval"
              value={o.interval}
              locked={locked}
              onChange={(d) => put({ ...o, interval: d })}
            />
            <Choice
              label="Product"
              value={o.mix[0]!.productId}
              disabled={locked || o.mix.length > 1}
              options={products}
              onChange={(v) => settle(() => put({ ...o, mix: [{ productId: v, weight: 1 }] }))}
            />
            <Field
              readOnly={locked}
              label="Limit (parts, empty = none)"
              value={o.limit === undefined ? '' : String(o.limit)}
              onCommit={(v) => {
                if (v.trim() === '') {
                  const { limit: _, ...rest } = o;
                  return put(rest);
                }
                const n = int(v, 1);
                return n !== undefined && put({ ...o, limit: n });
              }}
            />
          </>
        )}
        {(o.kind === 'station' || o.kind === 'parallel' || o.kind === 'assembly') && (
          <DistributionFields
            label="Processing time"
            value={o.processTime}
            locked={locked}
            onChange={(d) => put({ ...o, processTime: d })}
          />
        )}
        {o.kind === 'parallel' && (
          <Field
            readOnly={locked}
            label="Places"
            value={String(o.count)}
            onCommit={(v) => {
              const n = int(v, 1);
              return n !== undefined && put({ ...o, count: n });
            }}
          />
        )}
        {o.kind === 'assembly' && (
          <>
            <Choice
              label="Main product"
              value={o.mainProductId}
              disabled={locked}
              options={products}
              onChange={(v) => settle(() => put({ ...o, mainProductId: v }))}
            />
            {o.components.map((c, i) => (
              <Field
                key={c.productId}
                readOnly={locked}
                label={`Count of ${c.productId}`}
                value={String(c.count)}
                onCommit={(v) => {
                  const n = int(v, 1);
                  return (
                    n !== undefined &&
                    put({
                      ...o,
                      components: o.components.map((x, j) => (j === i ? { ...x, count: n } : x)),
                    })
                  );
                }}
              />
            ))}
            <Choice
              label="Output product"
              value={o.outputProductId ?? ''}
              disabled={locked}
              options={[{ value: '', label: '(same as main)' }, ...products]}
              onChange={(v) =>
                settle(() => {
                  const { outputProductId: _, ...rest } = o;
                  put(v ? { ...rest, outputProductId: v } : rest);
                })
              }
            />
          </>
        )}
        {o.kind === 'buffer' && (
          <>
            <Field
              readOnly={locked}
              label="Capacity"
              value={String(o.capacity)}
              onCommit={(v) => {
                const n = int(v, 1);
                return n !== undefined && put({ ...o, capacity: n });
              }}
            />
            <Choice
              label="Order"
              value={o.order ?? 'fifo'}
              disabled={locked}
              options={['fifo', 'lifo']}
              onChange={(v) => settle(() => put({ ...o, order: v as 'fifo' | 'lifo' }))}
            />
          </>
        )}
        {o.kind === 'conveyor' && (
          <>
            {(['lengthMm', 'partLengthMm', 'speedMmS'] as const).map((k) => (
              <Field
                key={k}
                readOnly={locked}
                label={
                  {
                    lengthMm: 'Length (mm)',
                    partLengthMm: 'Part length (mm)',
                    speedMmS: 'Speed (mm/s)',
                  }[k]
                }
                value={String(o[k])}
                onCommit={(v) => {
                  const n = Number(v);
                  if (v.trim() === '' || !Number.isFinite(n) || n <= 0) return false;
                  return put({ ...o, [k]: k === 'speedMmS' ? n : Math.round(n) });
                }}
              />
            ))}
            <Choice
              label="Accumulating"
              value={o.accumulating ? 'yes' : 'no'}
              disabled={locked}
              options={['yes', 'no']}
              onChange={(v) => settle(() => put({ ...o, accumulating: v === 'yes' }))}
            />
          </>
        )}
      </Section>
      {(o.kind === 'source' ||
        o.kind === 'station' ||
        o.kind === 'parallel' ||
        o.kind === 'assembly') && (
        <Section title="Time and resources">
          <Choice
            label="Calendar"
            value={o.calendarId ?? ''}
            disabled={locked}
            options={[
              { value: '', label: '(around the clock)' },
              ...(doc.calendars ?? []).map((c) => ({ value: c.id, label: c.name || c.id })),
            ]}
            onChange={(v) =>
              settle(() => {
                const { calendarId: _, ...rest } = o;
                put(v ? { ...rest, calendarId: v } : rest);
              })
            }
          />
          {o.kind !== 'source' && (
            <>
              <label className="fac-check">
                <input
                  type="checkbox"
                  checked={!!o.failures}
                  disabled={locked}
                  onChange={() =>
                    settle(() => {
                      const { failures: _, ...rest } = o;
                      put(
                        o.failures
                          ? rest
                          : {
                              ...rest,
                              failures: {
                                uptime: { type: 'exponential', mean: 3_600_000 },
                                repair: { type: 'const', value: 300_000 },
                              },
                            },
                      );
                    })
                  }
                />{' '}
                Breakdowns
              </label>
              {o.failures && (
                <>
                  <DistributionFields
                    label="Time to failure"
                    value={o.failures.uptime}
                    locked={locked}
                    onChange={(d) => put({ ...o, failures: { ...o.failures!, uptime: d } })}
                  />
                  <DistributionFields
                    label="Repair time"
                    value={o.failures.repair}
                    locked={locked}
                    onChange={(d) => put({ ...o, failures: { ...o.failures!, repair: d } })}
                  />
                  <Choice
                    label="Failures count"
                    value={o.failures.basis ?? 'operating'}
                    disabled={locked}
                    options={[
                      { value: 'operating', label: 'operating time' },
                      { value: 'calendar', label: 'calendar time' },
                    ]}
                    onChange={(v) =>
                      settle(() =>
                        put({
                          ...o,
                          failures: { ...o.failures!, basis: v as 'operating' | 'calendar' },
                        }),
                      )
                    }
                  />
                </>
              )}
              <Field
                readOnly={locked}
                label="Workers needed (0 = none)"
                value={String(o.workers?.count ?? 0)}
                onCommit={(v) => {
                  const n = int(v, 0);
                  if (n === undefined) return false;
                  const { workers: _, ...rest } = o;
                  return put(n ? { ...rest, workers: { ...o.workers, count: n } } : rest);
                }}
              />
              {o.workers && (
                <Choice
                  label="Skill"
                  value={o.workers.skill ?? ''}
                  disabled={locked}
                  options={[
                    { value: '', label: '(any worker)' },
                    ...[...new Set((doc.workerPools ?? []).flatMap((w) => w.skills))].map((k) => ({
                      value: k,
                      label: k,
                    })),
                  ]}
                  onChange={(v) =>
                    settle(() => {
                      const { skill: _, ...need } = o.workers!;
                      put({ ...o, workers: v ? { ...need, skill: v } : need });
                    })
                  }
                />
              )}
              <label className="fac-check">
                <input
                  type="checkbox"
                  checked={!!o.setup}
                  disabled={locked}
                  onChange={() =>
                    settle(() => {
                      const { setup: _, ...rest } = o;
                      put(
                        o.setup
                          ? rest
                          : { ...rest, setup: { time: { type: 'const', value: 60_000 } } },
                      );
                    })
                  }
                />{' '}
                Setup on product change
              </label>
              {o.setup && (
                <DistributionFields
                  label="Setup time"
                  value={o.setup.time}
                  locked={locked}
                  onChange={(d) => put({ ...o, setup: { ...o.setup!, time: d } })}
                />
              )}
            </>
          )}
        </Section>
      )}
      {st && period > 0 && (
        <Section title="Result">
          <ul className="fac-list" data-testid="fac-object-result">
            {factoryStates.map((s) => (
              <li key={s}>
                {s}: {pct(st.states[s] / period)}
              </li>
            ))}
            <li>
              in {st.entered} · out {st.exited}
            </li>
            <li>
              mean content {st.meanContent.toFixed(2)} · max {st.maxContent}
            </li>
          </ul>
        </Section>
      )}
    </>
  );
}

function LinkInspector({
  controller,
  doc,
  link,
  locked,
  flow,
}: {
  controller: FactoryController;
  doc: FactoryDocument;
  link: FactoryLink;
  locked: boolean;
  flow?: number;
}) {
  const settle = useSettle();
  const name = (id: string) => doc.objects.find((o) => o.id === id)?.name || id;
  return (
    <Section title="Link">
      <p>
        {name(link.from)} → {name(link.to)}
      </p>
      {flow !== undefined && <p data-testid="fac-link-flow">{flow} parts in the period</p>}
      {(doc.fleets?.length ?? 0) > 0 && (
        <Choice
          label="Carried by"
          value={link.transport?.fleetId ?? ''}
          disabled={locked}
          options={[
            { value: '', label: '(handed on directly)' },
            ...doc.fleets!.map((f) => ({ value: f.id, label: f.name || f.id })),
          ]}
          onChange={(v) =>
            settle(() => {
              const { transport: _, ...rest } = link;
              controller.updateLink(v ? { ...rest, transport: { fleetId: v } } : rest);
            })
          }
        />
      )}
      <fieldset className="fac-filter">
        <legend>Products allowed (none checked = all)</legend>
        {doc.products.map((p) => {
          const on = link.productIds?.includes(p.id) ?? false;
          return (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={on}
                disabled={locked}
                onChange={() =>
                  settle(() => {
                    const ids = new Set(link.productIds ?? []);
                    if (on) ids.delete(p.id);
                    else ids.add(p.id);
                    const { productIds: _, ...rest } = link;
                    controller.updateLink(ids.size ? { ...rest, productIds: [...ids] } : rest);
                  })
                }
              />{' '}
              {p.name || p.id}
            </label>
          );
        })}
      </fieldset>
    </Section>
  );
}
