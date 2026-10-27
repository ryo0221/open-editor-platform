import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Download,
  FileDown,
  FileImage,
  Maximize,
  Package,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  bimDrawingScales,
  bimDrawingSvg,
  bimLimits,
  type BimDocument,
  type BimDrawingScale,
  type BimView,
  type BimElement,
  type BimElementKind,
  type BimLevelHeight,
  type BimPropertyValue,
  type BimType,
} from '@editor-platform/bim-core';
import {
  CommitInput,
  EditorExportGuardContext,
  EditorHistoryContext,
  EditorInputsContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
} from '@editor-platform/editor-ui';
import { bimDrawingKey, type BimController, type BimState } from './controller';
import type { BimPartCandidate, BimPartStatus } from './parts';
import {
  bimArcHint,
  bimArcTools,
  bimToolInfo,
  DraftToolbar,
  drawingRefusal,
  useDraft,
  useNarrow,
} from './draft-tools';
import { draftLevel, draftPlanView, type BimDraftTool } from './drafting';
import type { BimDrawingResult } from './drawing';
import { bimDownload, bimDrawingFileName, bimFileName, bimSvgToPng } from './drawing-export';
import { bimElementLevel, bimViewBounds, bimViewSolids } from './view';
import { BimViewport, type BimDraftMarks, type BimPlanView } from './viewport';
import './style.css';

const kindLabels: Record<BimElementKind, string> = {
  wall: 'Walls',
  slab: 'Slabs',
  column: 'Columns',
  beam: 'Beams',
  opening: 'Openings',
  door: 'Doors',
  window: 'Windows',
  roof: 'Roofs',
  space: 'Spaces',
  part: 'Parts',
};
const kinds = Object.keys(kindLabels) as BimElementKind[];
const typeKindLabels: Record<BimType['kind'], string> = {
  wall: 'Wall types',
  slab: 'Slab types',
  roof: 'Roof types',
  column: 'Column types',
  beam: 'Beam types',
  door: 'Door types',
  window: 'Window types',
  part: 'Part types',
};
const quantityLabels: Record<string, string> = {
  length: 'Length (mm)',
  height: 'Height (mm)',
  width: 'Thickness (mm)',
  grossArea: 'Gross area (mm²)',
  netArea: 'Net area (mm²)',
  grossVolume: 'Gross volume (mm³)',
  netVolume: 'Net volume (mm³)',
  footprintArea: 'Footprint area (mm²)',
  area: 'Area (mm²)',
  perimeter: 'Perimeter (mm)',
  volume: 'Volume (mm³)',
  crossSectionArea: 'Section area (mm²)',
  projectedArea: 'Projected area (mm²)',
  depth: 'Thickness (mm)',
  netFloorArea: 'Net floor area (mm²)',
  netPerimeter: 'Net perimeter (mm)',
  grossSideArea: 'Gross side area (mm²)',
  netSideArea: 'Net side area (mm²)',
  slope: 'Slope (rad)',
};
const coordinate = bimLimits.coordinateMm;

function useBimState(controller: BimController): BimState {
  return useSyncExternalStore(
    (fn) => controller.subscribe(fn),
    () => controller.state,
  );
}

/**
 * The building Surface (docs/cad/r2c-architecture.md, Surface): the 3D view, the elements of a
 * level, and the selected element's attributes and type. `hostHistory`: the Host owns Undo and
 * Redo; otherwise `onUndo`/`onRedo` are shown.
 */
export function BimSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  ifc,
}: {
  controller: BimController;
  name: string;
  hostHistory?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** The Artifact's ID and the content's time, for Export IFC; without it there is none. */
  ifc?: () => { artifactId: string; timeStamp: string };
}) {
  const state = useBimState(controller);
  const exportIfc = useIfcExport(controller, name, ifc);
  const [tab, setTab] = useState<'element' | 'types' | 'drawings'>('element');
  // The view chosen in Drawings, and the one whose drawing replaces the 3D view.
  const [viewId, setViewId] = useState<string | undefined>();
  const [openViewId, setOpenViewId] = useState<string | undefined>();
  const openView = state.content.views.find((v) => v.id === openViewId);
  const [hidden, setHidden] = useState<ReadonlySet<BimElementKind>>(new Set());
  const [axesShown, setAxesShown] = useState(true);
  const [typeId, setTypeId] = useState<string | undefined>();
  const [fit, setFit] = useState(0);
  const [plan, setPlan] = useState(false);
  const [tool, setTool] = useState<BimDraftTool>('select');
  const [arc, setArc] = useState(false);
  const narrow = useNarrow();
  const refusal = drawingRefusal(state, narrow);
  // Drawing closes when the screen narrows or editing stops.
  const activeTool: BimDraftTool = plan && !refusal ? tool : 'select';
  const partType = state.content.types.find((t) => t.id === typeId && t.kind === 'part')?.id;
  const draft = useDraft(controller, state, activeTool, partType, arc);
  const level = state.content.levels.find((l) => l.id === state.level);
  const planView = useMemo(
    () => (plan && level ? { elevationMm: level.elevationMm, cutMm: 1200 } : undefined),
    [plan, level],
  );
  // Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z go to the Host's history when it gives one (artifact Host);
  // handled here, the Host's own window shortcut sees it as done.
  const history = useContext(EditorHistoryContext);
  const settle = useSettle();
  const readOnly = state.readOnly;
  useEffect(() => {
    // No history in view mode, like the Host's disabled buttons.
    if (!history || readOnly) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) history!.redo();
      else history!.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, readOnly]);
  const failed = state.evaluation
    ? [...state.evaluation.elements].filter(([, r]) => r.status === 'error')
    : [];
  return (
    <div className="bim-surface" data-testid="bim-surface">
      <EditorLayout
        viewKey="bim"
        leftLabel="Elements"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Building tools">
            {!hostHistory && (
              <>
                <IconButton icon={Undo2} label="Undo" onClick={onUndo} />
                <IconButton icon={Redo2} label="Redo" onClick={onRedo} />
              </>
            )}
            <label className="bim-level-pick">
              Level
              <select
                aria-label="Level"
                value={state.level ?? ''}
                onChange={(e) => {
                  const level = e.target.value;
                  settle(() => controller.setLevel(level));
                }}
              >
                {state.content.levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <IconButton icon={Maximize} label="Fit view" onClick={() => setFit((n) => n + 1)} />
            {exportIfc && (
              <IconButton
                icon={FileDown}
                label="Export IFC"
                disabled={exportIfc.writing}
                onClick={() => void exportIfc.run()}
              />
            )}
            <DraftToolbar
              plan={plan}
              onPlan={setPlan}
              tool={activeTool}
              onTool={setTool}
              refusal={refusal}
              arc={arc}
              onArc={setArc}
            />
          </Toolbar>
        }
        status={
          <span className="bim-status" aria-live="polite">
            {name} · {state.content.elements.length} elements ·{' '}
            <span data-testid="bim-model-state">
              {state.evaluating || state.evaluatedHash !== state.hash
                ? 'Evaluating…'
                : 'Model up to date'}
            </span>
            {failed.length ? ` · ${failed.length} not built` : ''}
            {exportIfc?.writing ? ' · Writing IFC…' : ''}
            {state.readOnly ? ' · Read only' : ''}
          </span>
        }
        left={
          <ElementList
            state={state}
            hidden={hidden}
            onHidden={setHidden}
            axesShown={axesShown}
            onAxesShown={setAxesShown}
            onSelect={(id, add) =>
              settle(() => {
                controller.select(add ? toggle(state.selection, id) : [id]);
                setTab('element');
              })
            }
          />
        }
        inspector={
          <div className="bim-inspector">
            <div className="bim-tabs" role="tablist" aria-label="Inspector">
              {(['element', 'types', 'drawings'] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'bim-tab bim-tab-on' : 'bim-tab'}
                  onClick={() => settle(() => setTab(t))}
                >
                  {t === 'element' ? 'Element' : t === 'types' ? 'Types' : 'Drawings'}
                </button>
              ))}
            </div>
            {state.notice && (
              <p className="bim-notice" role="alert">
                Refused: {state.notice.code}
                {state.notice.ids.length ? ` (${state.notice.ids.join(', ')})` : ''}
                <button onClick={() => controller.dismissNotice()} aria-label="Dismiss">
                  ×
                </button>
              </p>
            )}
            {tab === 'element' ? (
              // Keyed by what it edits: a draft a refusal kept never moves to another element.
              <ElementInspector
                key={
                  state.selection.length ? state.selection.join('\u0000') : `level:${state.level}`
                }
                controller={controller}
                state={state}
              />
            ) : tab === 'types' ? (
              <TypesPanel
                controller={controller}
                state={state}
                selected={typeId}
                onSelect={(id) => settle(() => setTypeId(id))}
              />
            ) : (
              <DrawingsPanel
                controller={controller}
                state={state}
                selected={viewId}
                onSelect={(id) => settle(() => setViewId(id))}
                open={openView?.id}
                onOpen={setOpenViewId}
              />
            )}
          </div>
        }
      >
        {openView ? (
          <DrawingView
            controller={controller}
            state={state}
            view={openView}
            building={name}
            onClose={() => setOpenViewId(undefined)}
          />
        ) : (
          <Viewport
            controller={controller}
            state={state}
            hidden={hidden}
            axesShown={axesShown}
            fit={fit}
            plan={planView}
            drawing={activeTool !== 'select'}
            onPlan={draft.onPlan}
            marks={draft.marks}
            hint={
              activeTool !== 'select'
                ? `${bimToolInfo[activeTool].hint}${arc && bimArcTools.has(activeTool) ? ` ${bimArcHint}` : ''}`
                : plan && refusal && refusal !== 'Read only'
                  ? `Drawing is closed: ${refusal}.`
                  : undefined
            }
          />
        )}
      </EditorLayout>
    </div>
  );
}

const toggle = (list: string[], id: string) =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

function Viewport({
  controller,
  state,
  hidden,
  axesShown,
  fit,
  plan,
  drawing,
  onPlan,
  marks,
  hint,
}: {
  controller: BimController;
  state: BimState;
  hidden: ReadonlySet<BimElementKind>;
  axesShown: boolean;
  fit: number;
  plan: BimPlanView | undefined;
  drawing: boolean;
  onPlan(xy: [number, number], kind: 'move' | 'click' | 'double', mmPerPx: number): void;
  marks: BimDraftMarks | undefined;
  hint: string | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<BimViewport | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>();
  const latest = useRef(state);
  latest.current = state;
  const planRef = useRef(onPlan);
  planRef.current = onPlan;
  const settleNow = useSettle();
  const settle = useRef(settleNow);
  settle.current = settleNow;
  useEffect(() => {
    if (!host.current) return;
    try {
      view.current = new BimViewport(host.current, {
        onPick: (id, add) =>
          settle.current(() =>
            controller.select(
              id === undefined ? [] : add ? toggle(latest.current.selection, id) : [id],
            ),
          ),
        onPlan: (xy, kind, mmPerPx) => planRef.current(xy, kind, mmPerPx),
        onContextLost: () =>
          setFailure('The 3D view lost its graphics context. Reload to draw it again.'),
      });
    } catch {
      setFailure('This browser cannot draw the 3D view (WebGL is unavailable).');
    }
    return () => {
      view.current?.dispose();
      view.current = undefined;
    };
  }, [controller]);
  const solids = useMemo(
    () =>
      bimViewSolids(state.content, state.evaluation, {
        selection: new Set(state.selection),
        hiddenKinds: hidden,
        parts: state.parts,
      }),
    [state.content, state.evaluation, state.selection, hidden, state.parts],
  );
  const bounds = useMemo(
    () => bimViewBounds(state.evaluation, state.content),
    [state.evaluation, state.content],
  );
  useEffect(() => view.current?.show(solids, bounds), [solids, bounds]);
  // Only a press of Fit view refits; new bounds after an edit keep the camera.
  const fitBounds = useRef(bounds);
  fitBounds.current = bounds;
  useEffect(() => {
    if (fit && fitBounds.current) view.current?.fit(fitBounds.current);
  }, [fit]);
  useEffect(() => view.current?.setPlan(plan, fitBounds.current), [plan]);
  useEffect(() => {
    if (view.current) view.current.drawing = drawing;
  }, [drawing]);
  useEffect(() => view.current?.setMarks(marks), [marks]);
  const { grids, levels } = state.content;
  useEffect(
    () =>
      view.current?.setAxes(
        axesShown ? grids : [],
        levels.length ? Math.min(...levels.map((l) => l.elevationMm)) : 0,
      ),
    [controller, grids, levels, axesShown],
  );
  return (
    <div
      className="bim-viewport"
      data-testid="bim-viewport"
      data-axes={axesShown ? grids.length : 0}
    >
      <div ref={host} className="bim-canvas-host" />
      {failure ? (
        <p className="bim-viewport-note bim-viewport-failure" role="alert">
          {failure}
        </p>
      ) : !state.evaluation && state.evaluating ? (
        <p className="bim-viewport-note">Building the model…</p>
      ) : hint ? (
        <p className="bim-viewport-note" data-testid="bim-draft-hint">
          {hint}
        </p>
      ) : !state.content.elements.length ? (
        <p className="bim-viewport-note">This building has no elements yet.</p>
      ) : null}
    </div>
  );
}

function ElementList({
  state,
  hidden,
  onHidden,
  axesShown,
  onAxesShown,
  onSelect,
}: {
  state: BimState;
  hidden: ReadonlySet<BimElementKind>;
  onHidden(next: ReadonlySet<BimElementKind>): void;
  axesShown: boolean;
  onAxesShown(shown: boolean): void;
  onSelect(id: string, add: boolean): void;
}) {
  const { content: doc } = state;
  const onLevel = doc.elements.filter((e) => bimElementLevel(doc, e.id) === state.level);
  const selected = new Set(state.selection);
  return (
    <nav className="bim-elements" aria-label="Elements">
      {doc.grids.length > 0 && (
        <section className="bim-kind">
          <h3>
            <label>
              <input
                type="checkbox"
                checked={axesShown}
                aria-label="Show grid axes"
                onChange={(e) => onAxesShown(e.target.checked)}
              />
              Grid axes ({doc.grids.length})
            </label>
          </h3>
        </section>
      )}
      {kinds.map((kind) => {
        const list = onLevel.filter((e) => e.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} className="bim-kind">
            <h3>
              <label>
                <input
                  type="checkbox"
                  checked={!hidden.has(kind)}
                  aria-label={`Show ${kindLabels[kind]}`}
                  onChange={(e) => {
                    const next = new Set(hidden);
                    if (e.target.checked) next.delete(kind);
                    else next.add(kind);
                    onHidden(next);
                  }}
                />
                {kindLabels[kind]} ({list.length})
              </label>
            </h3>
            <ul>
              {list.map((el) => {
                const r = state.evaluation?.elements.get(el.id);
                return (
                  <li key={el.id}>
                    <button
                      className={selected.has(el.id) ? 'bim-item bim-item-on' : 'bim-item'}
                      aria-pressed={selected.has(el.id)}
                      onClick={(e) => onSelect(el.id, e.shiftKey || e.ctrlKey || e.metaKey)}
                    >
                      {el.name ?? el.id}
                      {r?.status === 'error' && (
                        <span className="bim-badge" title={r.code}>
                          {r.code}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {!onLevel.length && <p className="bim-empty">No elements on this level.</p>}
    </nav>
  );
}

/** A value field: an input while editable, the value as text when read only. */
/**
 * Runs a switch that unmounts fields (another element, axis, type, level or tab) after their
 * drafts are committed through the Host's input boundary. A draft that cannot be committed keeps
 * the panel: the Host focuses the field, and the draft is never dropped unseen.
 */
function useSettle() {
  const inputs = useContext(EditorInputsContext);
  return (run: () => void) => {
    try {
      inputs?.flush();
    } catch {
      return;
    }
    run();
  };
}

function Field({
  label,
  value,
  readOnly,
  type = 'text',
  min,
  max,
  onCommit,
}: {
  label: string;
  value: string | number;
  readOnly: boolean;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  onCommit(value: string): string | undefined;
}) {
  if (readOnly)
    return (
      <p className="bim-readonly-field">
        <span>{label}</span> <strong>{String(value)}</strong>
      </p>
    );
  return (
    <CommitInput
      label={label}
      value={value}
      type={type}
      min={min}
      max={max}
      onCommit={(v) => onCommit(v) === undefined}
    />
  );
}
function Check({
  label,
  checked,
  readOnly,
  onChange,
}: {
  label: string;
  checked: boolean;
  readOnly: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="bim-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * A column's or a part's place in plan, by its numbers. On a grid crossing it follows the axes;
 * a typed value places it at that point instead.
 */
function PointFields({
  el,
  state,
  readOnly,
  onCommit,
}: {
  el: Extract<BimElement, { kind: 'column' | 'part' }>;
  state: BimState;
  readOnly: boolean;
  onCommit(at: { xy: [number, number] }): string | undefined;
}) {
  const shape = state.derived.shapes.get(el.id);
  const xy = shape && 'at' in shape ? (shape.at as [number, number]) : undefined;
  if (!xy) return null;
  const grid = 'grid' in el.at ? el.at.grid : undefined;
  const label = (id: string) => state.content.grids.find((g) => g.id === id)?.label ?? id;
  return (
    <>
      {grid && (
        <p className="bim-hint" data-testid="bim-on-grid">
          On the crossing of {label(grid[0])} and {label(grid[1])}: it moves with the axes. A typed
          X or Y places it by coordinates instead.
        </p>
      )}
      {(['X', 'Y'] as const).map((axis, i) => (
        <Field
          key={axis}
          label={`${axis} (mm)`}
          type="number"
          min={-coordinate}
          max={coordinate}
          value={round(xy[i]!)}
          readOnly={readOnly}
          onCommit={(v) => {
            const next: [number, number] = [xy[0], xy[1]];
            next[i] = Number(v);
            return onCommit({ xy: next });
          }}
        />
      ))}
    </>
  );
}

const heightLabel = (doc: BimDocument, h: BimLevelHeight) =>
  doc.levels.find((l) => l.id === h.level)?.name ?? h.level;

function ElementInspector({ controller, state }: { controller: BimController; state: BimState }) {
  const { content: doc, readOnly } = state;
  if (state.selection.length > 1)
    return (
      <div className="bim-panel">
        <p>{state.selection.length} elements selected.</p>
        {!readOnly && <DeleteButton controller={controller} state={state} ids={state.selection} />}
      </div>
    );
  const el = doc.elements.find((e) => e.id === state.selection[0]);
  if (!el) return <LevelPanel controller={controller} state={state} />;
  const update = (patch: Partial<BimElement>) =>
    controller.updateElement({ ...el, ...patch } as BimElement);
  const num = (v: string) => Number(v);
  const r = state.evaluation?.elements.get(el.id);
  const q = state.derived.quantities.get(el.id);
  const kq = state.evaluation?.kernelQuantities.get(el.id);
  const types = doc.types.filter((t) => t.kind === el.kind);
  return (
    <div className="bim-panel" data-testid="bim-element">
      <p className="bim-kind-line">
        {el.kind} · <code>{el.id}</code>
      </p>
      {r?.status === 'error' && (
        <p className="bim-element-error">
          Not built: {r.code}
          {r.role ? ` (${r.role})` : ''}
        </p>
      )}
      <Field
        label="Name"
        value={el.name ?? ''}
        readOnly={readOnly}
        onCommit={(v) => update({ name: v || undefined } as Partial<BimElement>)}
      />
      {'typeId' in el && (
        <label className="ep-field">
          Type
          <select
            aria-label="Type"
            value={el.typeId}
            disabled={readOnly}
            onChange={(e) => update({ typeId: e.target.value } as Partial<BimElement>)}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {(el.kind === 'column' || el.kind === 'part') && (
        <PointFields el={el} state={state} readOnly={readOnly} onCommit={(at) => update({ at })} />
      )}
      {'base' in el && (
        <Field
          label={`Base offset from ${heightLabel(doc, el.base)} (mm)`}
          type="number"
          min={-coordinate}
          max={coordinate}
          value={el.base.offsetMm}
          readOnly={readOnly}
          onCommit={(v) =>
            update({ base: { ...el.base, offsetMm: num(v) } } as Partial<BimElement>)
          }
        />
      )}
      {(el.kind === 'wall' || el.kind === 'column' || (el.kind === 'space' && el.top)) &&
        el.top &&
        ('heightMm' in el.top ? (
          <Field
            label="Height (mm)"
            type="number"
            min={1}
            max={coordinate}
            value={el.top.heightMm}
            readOnly={readOnly}
            onCommit={(v) => update({ top: { heightMm: num(v) } } as Partial<BimElement>)}
          />
        ) : (
          <Field
            label={`Top offset from ${heightLabel(doc, el.top)} (mm)`}
            type="number"
            min={-coordinate}
            max={coordinate}
            value={el.top.offsetMm}
            readOnly={readOnly}
            onCommit={(v) =>
              update({
                top: { ...(el.top as BimLevelHeight), offsetMm: num(v) },
              } as Partial<BimElement>)
            }
          />
        ))}
      {(el.kind === 'slab' || el.kind === 'beam') && (
        <Field
          label={`Top offset from ${heightLabel(doc, el.top)} (mm)`}
          type="number"
          min={-coordinate}
          max={coordinate}
          value={el.top.offsetMm}
          readOnly={readOnly}
          onCommit={(v) => update({ top: { ...el.top, offsetMm: num(v) } } as Partial<BimElement>)}
        />
      )}
      {el.kind === 'wall' && (
        <label className="ep-field">
          Axis location
          <select
            aria-label="Axis location"
            value={el.location}
            disabled={readOnly}
            onChange={(e) => update({ location: e.target.value as typeof el.location })}
          >
            <option value="center">Center</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      )}
      {(el.kind === 'column' || el.kind === 'part') && (
        <Field
          label="Rotation (°)"
          type="number"
          min={-360}
          max={360}
          value={round((el.rotationRad * 180) / Math.PI)}
          readOnly={readOnly}
          onCommit={(v) => update({ rotationRad: (num(v) * Math.PI) / 180 })}
        />
      )}
      {(el.kind === 'door' || el.kind === 'window') && (
        <>
          <Field
            label="Position along wall (mm)"
            type="number"
            min={0}
            max={coordinate}
            value={el.alongMm}
            readOnly={readOnly}
            onCommit={(v) => update({ alongMm: num(v) })}
          />
          {el.kind === 'window' && (
            <Field
              label="Sill height (mm)"
              type="number"
              min={0}
              max={coordinate}
              value={el.sillMm}
              readOnly={readOnly}
              onCommit={(v) => update({ sillMm: num(v) })}
            />
          )}
          <Check
            label="Flip facing"
            checked={el.flipFacing}
            readOnly={readOnly}
            onChange={(flipFacing) => update({ flipFacing })}
          />
          {el.kind === 'door' && (
            <Check
              label="Flip hand"
              checked={el.flipHand}
              readOnly={readOnly}
              onChange={(flipHand) => update({ flipHand })}
            />
          )}
        </>
      )}
      {el.kind === 'opening' && 'wall' in el && (
        <>
          {(['alongMm', 'sillMm', 'widthMm', 'heightMm'] as const).map((k) => (
            <Field
              key={k}
              label={
                {
                  alongMm: 'Position along wall (mm)',
                  sillMm: 'Sill height (mm)',
                  widthMm: 'Width (mm)',
                  heightMm: 'Height (mm)',
                }[k]
              }
              type="number"
              min={k === 'widthMm' || k === 'heightMm' ? 1 : 0}
              max={coordinate}
              value={el.wall[k]}
              readOnly={readOnly}
              onCommit={(v) => update({ wall: { ...el.wall, [k]: num(v) } } as Partial<BimElement>)}
            />
          ))}
        </>
      )}
      {el.kind === 'space' && (
        <Field
          label="Number"
          value={el.number}
          readOnly={readOnly}
          onCommit={(v) => update({ number: v })}
        />
      )}
      <Described
        doc={doc}
        target={el}
        readOnly={readOnly}
        onChange={(patch) => update(patch as Partial<BimElement>)}
      />
      {q && q.source !== 'none' && (
        <Section title={q.source === 'kernel' ? 'Quantities (kernel)' : 'Quantities'}>
          <dl className="bim-quantities">
            {Object.entries({ ...q.values, ...(kq ?? {}) }).map(([k, v]) => (
              <QuantityRow key={k} name={k} value={v} />
            ))}
          </dl>
        </Section>
      )}
      {!readOnly && <DeleteButton controller={controller} state={state} ids={[el.id]} />}
    </div>
  );
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;
function QuantityRow({ name, value }: { name: string; value: number }) {
  return (
    <>
      <dt>{quantityLabels[name] ?? name}</dt>
      <dd>{value.toLocaleString('en-US', { maximumFractionDigits: 1 })}</dd>
    </>
  );
}

function DeleteButton({
  controller,
  state,
  ids,
}: {
  controller: BimController;
  state: BimState;
  ids: string[];
}) {
  // Only the refusal of this very delete, on the content it was refused on, offers the cascade.
  const refused = state.notice?.delete;
  const inUse =
    state.notice?.code === 'in-use' &&
    refused?.hash === state.hash &&
    refused.ids.join('\u0000') === ids.join('\u0000');
  return (
    <div className="bim-delete">
      <button
        className="bim-button"
        onClick={() => controller.apply({ type: 'delete', ids, cascade: false })}
      >
        <Trash2 size={15} aria-hidden="true" /> Delete
      </button>
      {inUse && (
        <button
          className="bim-button bim-danger"
          onClick={() => controller.apply({ type: 'delete', ids, cascade: true })}
        >
          Delete with {state.notice!.ids.length} dependent
          {state.notice!.ids.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

/** Common properties and user-defined property set values of an element or a type. */
function Described({
  doc,
  target,
  readOnly,
  onChange,
}: {
  doc: BimDocument;
  target: BimElement | BimType;
  readOnly: boolean;
  onChange(patch: Pick<BimType, 'common' | 'properties'>): string | undefined;
}) {
  const common = target.common ?? {};
  const setCommon = (patch: Partial<typeof common>) => {
    const next = { ...common, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[])
      if (next[k] === undefined || next[k] === '') delete next[k];
    return onChange({ common: Object.keys(next).length ? next : undefined });
  };
  const setValue = (set: string, name: string, value: BimPropertyValue | undefined) => {
    const properties = structuredClone(target.properties ?? {});
    const values = (properties[set] ??= {});
    if (value === undefined) delete values[name];
    else values[name] = value;
    if (!Object.keys(values).length) delete properties[set];
    return onChange({ properties: Object.keys(properties).length ? properties : undefined });
  };
  return (
    <>
      <Section title="Common properties">
        <Check
          label="External"
          checked={!!common.isExternal}
          readOnly={readOnly}
          onChange={(v) => setCommon({ isExternal: v })}
        />
        <Check
          label="Load bearing"
          checked={!!common.loadBearing}
          readOnly={readOnly}
          onChange={(v) => setCommon({ loadBearing: v })}
        />
        <Field
          label="Fire rating"
          value={common.fireRating ?? ''}
          readOnly={readOnly}
          onCommit={(v) => setCommon({ fireRating: v || undefined })}
        />
        <Field
          label="Reference"
          value={common.reference ?? ''}
          readOnly={readOnly}
          onCommit={(v) => setCommon({ reference: v || undefined })}
        />
      </Section>
      {doc.propertySets.map((set) => (
        <Section key={set.id} title={set.name}>
          {set.properties.map((p) => {
            const value = target.properties?.[set.id]?.[p.name];
            const label = p.type === 'length' ? `${p.name} (mm)` : p.name;
            return p.type === 'boolean' ? (
              <Check
                key={p.name}
                label={label}
                checked={value === true}
                readOnly={readOnly}
                onChange={(v) => setValue(set.id, p.name, v)}
              />
            ) : (
              <Field
                key={p.name}
                label={label}
                type={p.type === 'string' ? 'text' : 'number'}
                value={value === undefined ? '' : String(value)}
                readOnly={readOnly}
                onCommit={(v) =>
                  setValue(
                    set.id,
                    p.name,
                    v === '' ? undefined : p.type === 'string' ? v : Number(v),
                  )
                }
              />
            );
          })}
        </Section>
      ))}
    </>
  );
}

/** With nothing selected: the active level's name and elevation. */
function LevelPanel({ controller, state }: { controller: BimController; state: BimState }) {
  const level = state.content.levels.find((l) => l.id === state.level);
  const add = !state.readOnly && (
    <button className="bim-button" onClick={() => controller.apply(draftLevel(state.content))}>
      <Plus size={15} aria-hidden="true" /> Add level above
    </button>
  );
  if (!level)
    return (
      <div className="bim-panel" data-testid="bim-level">
        <p className="bim-empty">This building has no levels.</p>
        {add}
      </div>
    );
  const update = (patch: Partial<typeof level>) =>
    controller.apply({ type: 'update', collection: 'levels', entity: { ...level, ...patch } });
  return (
    <div className="bim-panel" data-testid="bim-level">
      <p className="bim-kind-line">
        level · <code>{level.id}</code>
      </p>
      <Field
        label="Level name"
        value={level.name}
        readOnly={state.readOnly}
        onCommit={(v) => update({ name: v })}
      />
      <Field
        label="Elevation (mm)"
        type="number"
        min={-coordinate}
        max={coordinate}
        value={level.elevationMm}
        readOnly={state.readOnly}
        onCommit={(v) => update({ elevationMm: Number(v) })}
      />
      {!state.readOnly && (
        <div className="bim-row">
          {add}
          <DeleteButton controller={controller} state={state} ids={[level.id]} />
        </div>
      )}
      <GridPanel controller={controller} state={state} />
      <p className="bim-hint">Select an element in the view or the list to edit it.</p>
    </div>
  );
}

/** The grid axes: their labels and ends. Moving an axis moves what stands on its crossings. */
function GridPanel({ controller, state }: { controller: BimController; state: BimState }) {
  const [open, setOpen] = useState<string | undefined>();
  const settle = useSettle();
  const axis = state.content.grids.find((g) => g.id === open);
  const update = (patch: Partial<NonNullable<typeof axis>>) =>
    controller.apply({ type: 'update', collection: 'grids', entity: { ...axis!, ...patch } });
  const end = (key: 'start' | 'end', i: 0 | 1) => (
    <Field
      key={`${key}${i}`}
      label={`${key === 'start' ? 'Start' : 'End'} ${i ? 'y' : 'x'} (mm)`}
      type="number"
      min={-coordinate}
      max={coordinate}
      value={axis![key][i]}
      readOnly={state.readOnly}
      onCommit={(v) => {
        const p: [number, number] = [...axis![key]];
        p[i] = Number(v);
        return update({ [key]: p });
      }}
    />
  );
  return (
    <section className="bim-kind" aria-label="Grid axes">
      <h3>Grid axes ({state.content.grids.length})</h3>
      {state.content.grids.length ? (
        <ul>
          {state.content.grids.map((g) => (
            <li key={g.id}>
              <button
                className={g.id === open ? 'bim-item bim-item-on' : 'bim-item'}
                aria-pressed={g.id === open}
                onClick={() => settle(() => setOpen(g.id === open ? undefined : g.id))}
              >
                {g.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bim-hint">Draw grid axes on the plan with the Grid axis tool.</p>
      )}
      {axis && (
        // Keyed by the axis: a refused draft never moves to another one.
        <div key={axis.id} className="bim-grid-axis" data-testid="bim-grid-axis">
          <p className="bim-kind-line">
            grid axis · <code>{axis.id}</code>
          </p>
          <Field
            label="Axis label"
            value={axis.label}
            readOnly={state.readOnly}
            onCommit={(v) => update({ label: v })}
          />
          {end('start', 0)}
          {end('start', 1)}
          {end('end', 0)}
          {end('end', 1)}
          {!state.readOnly && (
            <DeleteButton controller={controller} state={state} ids={[axis.id]} />
          )}
        </div>
      )}
    </section>
  );
}

function TypesPanel({
  controller,
  state,
  selected,
  onSelect,
}: {
  controller: BimController;
  state: BimState;
  selected: string | undefined;
  onSelect(id: string | undefined): void;
}) {
  const { content: doc, readOnly } = state;
  const count = new Map<string, number>();
  for (const e of doc.elements)
    if ('typeId' in e) count.set(e.typeId, (count.get(e.typeId) ?? 0) + 1);
  const type = doc.types.find((t) => t.id === selected);
  const groups = (Object.keys(typeKindLabels) as BimType['kind'][])
    .map((k) => [k, doc.types.filter((t) => t.kind === k)] as const)
    .filter(([, list]) => list.length);
  return (
    <div className="bim-panel" data-testid="bim-types">
      {groups.map(([kind, list]) => (
        <section key={kind} className="bim-kind">
          <h3>{typeKindLabels[kind]}</h3>
          <ul>
            {list.map((t) => (
              <li key={t.id}>
                <button
                  className={t.id === selected ? 'bim-item bim-item-on' : 'bim-item'}
                  aria-pressed={t.id === selected}
                  onClick={() => onSelect(t.id === selected ? undefined : t.id)}
                >
                  {t.name} <span className="bim-count">{count.get(t.id) ?? 0}</span>
                  {t.kind === 'part' && (
                    <PartState status={state.parts.get(t.source.contentHash)} />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {controller.partsOffered && !readOnly && <AddPart controller={controller} />}
      {type && (
        <TypeEditor
          key={type.id}
          controller={controller}
          doc={doc}
          type={type}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

function PartState({ status }: { status: BimPartStatus | undefined }) {
  if (!status || status.status === 'available') return null;
  return (
    <span className="bim-part-state" data-testid="bim-part-state">
      {status.status === 'loading' ? 'Reading shape…' : `Unavailable: ${status.code}`}
    </span>
  );
}

/** Makes a part type from a saved CAD version the Host offers. */
function AddPart({ controller }: { controller: BimController }) {
  const [candidates, setCandidates] = useState<BimPartCandidate[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  if (!candidates)
    return (
      <button
        className="bim-button"
        onClick={() => void controller.listParts().then(setCandidates)}
      >
        <Package size={15} aria-hidden="true" /> Add part from CAD…
      </button>
    );
  return (
    <section className="bim-kind" aria-label="CAD parts">
      <h3>CAD parts</h3>
      {!candidates.length && (
        <p className="bim-hint">Save a version of a 3D CAD artifact to place it here.</p>
      )}
      {candidates.map((c) => {
        const version =
          c.versions.find((v) => v.versionId === chosen[c.artifactId]) ?? c.versions[0]!;
        return (
          <div key={c.artifactId} className="bim-row">
            <label className="bim-part-pick">
              {c.name}
              <select
                aria-label={`${c.name} version`}
                value={version.versionId}
                onChange={(e) => setChosen({ ...chosen, [c.artifactId]: e.target.value })}
              >
                {c.versions.map((v) => (
                  <option key={v.versionId} value={v.versionId}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="bim-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void controller
                  .addPartType(
                    {
                      artifactId: c.artifactId,
                      versionId: version.versionId,
                      contentHash: version.contentHash,
                    },
                    `${c.name} ${version.label.split(' ')[0]}`,
                  )
                  .then((code) => {
                    setBusy(false);
                    if (code === undefined) setCandidates(undefined);
                  });
              }}
            >
              Add {c.name}
            </button>
          </div>
        );
      })}
      <button className="bim-button" onClick={() => setCandidates(undefined)}>
        Close
      </button>
    </section>
  );
}

function TypeEditor({
  controller,
  doc,
  type,
  readOnly,
}: {
  controller: BimController;
  doc: BimDocument;
  type: BimType;
  readOnly: boolean;
}) {
  const update = (patch: Partial<BimType>) =>
    controller.apply({
      type: 'update',
      collection: 'types',
      entity: { ...type, ...patch } as BimType,
    });
  const num = (v: string) => Number(v);
  const fields: ReactNode[] = [];
  if ('layers' in type)
    type.layers.forEach((layer, i) =>
      fields.push(
        <Field
          key={`layer${i}`}
          label={`Layer ${i + 1}: ${doc.materials.find((m) => m.id === layer.materialId)?.name ?? layer.materialId} (mm)`}
          type="number"
          min={bimLimits.minDimensionMm}
          max={bimLimits.maxSectionMm}
          value={layer.thicknessMm}
          readOnly={readOnly}
          onCommit={(v) =>
            update({
              layers: type.layers.map((l, j) => (j === i ? { ...l, thicknessMm: num(v) } : l)),
            } as Partial<BimType>)
          }
        />,
      ),
    );
  if ('profile' in type)
    for (const [k, value] of Object.entries(type.profile))
      if (k !== 'shape')
        fields.push(
          <Field
            key={k}
            label={`${k.replace(/Mm$/, '')} (mm)`}
            type="number"
            min={bimLimits.minDimensionMm}
            max={bimLimits.maxSectionMm}
            value={value as number}
            readOnly={readOnly}
            onCommit={(v) =>
              update({ profile: { ...type.profile, [k]: num(v) } } as Partial<BimType>)
            }
          />,
        );
  if (type.kind === 'door' || type.kind === 'window')
    for (const k of ['widthMm', 'heightMm'] as const)
      fields.push(
        <Field
          key={k}
          label={k === 'widthMm' ? 'Width (mm)' : 'Height (mm)'}
          type="number"
          min={bimLimits.minDimensionMm}
          max={coordinate}
          value={type[k]}
          readOnly={readOnly}
          onCommit={(v) => update({ [k]: num(v) } as Partial<BimType>)}
        />,
      );
  return (
    <div className="bim-type-editor" data-testid="bim-type">
      <p className="bim-kind-line">
        {type.kind} type · <code>{type.id}</code>
      </p>
      <Field
        label="Type name"
        value={type.name}
        readOnly={readOnly}
        onCommit={(v) => update({ name: v })}
      />
      {fields}
      {type.kind === 'part' && (
        <p className="bim-hint">
          CAD part version {type.source.versionId} of {type.source.artifactId}
        </p>
      )}
      <Described
        doc={doc}
        target={type}
        readOnly={readOnly}
        onChange={(patch) => update(patch as Partial<BimType>)}
      />
    </div>
  );
}

const viewKindLabels: Record<BimView['kind'], string> = { plan: 'Plan', section: 'Section' };

/**
 * The building's views (R2c-5b): plans of a level and sections drawn on the plan. A view is
 * part of the document; its drawing is derived and never saved.
 */
function DrawingsPanel({
  controller,
  state,
  selected,
  onSelect,
  open,
  onOpen,
}: {
  controller: BimController;
  state: BimState;
  selected: string | undefined;
  onSelect(id: string | undefined): void;
  open: string | undefined;
  onOpen(id: string | undefined): void;
}) {
  const { content: doc, readOnly } = state;
  const view = doc.views.find((v) => v.id === selected);
  const level = doc.levels.find((l) => l.id === state.level);
  const update = (patch: Partial<BimView>) =>
    controller.apply({
      type: 'update',
      collection: 'views',
      entity: { ...view!, ...patch } as BimView,
    });
  return (
    <div className="bim-panel" data-testid="bim-drawings">
      <section className="bim-kind" aria-label="Views">
        <h3>Views ({doc.views.length})</h3>
        {doc.views.length ? (
          <ul>
            {doc.views.map((v) => (
              <li key={v.id}>
                <button
                  className={v.id === selected ? 'bim-item bim-item-on' : 'bim-item'}
                  aria-pressed={v.id === selected}
                  onClick={() => onSelect(v.id === selected ? undefined : v.id)}
                >
                  {v.name} <span className="bim-count">{viewKindLabels[v.kind]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bim-hint">No views yet.</p>
        )}
        {!readOnly && level && (
          <button
            className="bim-button"
            onClick={() => controller.apply(draftPlanView(doc, level.id))}
          >
            <Plus size={15} aria-hidden="true" /> Add plan of {level.name}
          </button>
        )}
        <p className="bim-hint">Draw a section on the plan with the Section tool.</p>
      </section>
      {view && (
        // Keyed by the view: a refused draft never moves to another one.
        <div key={view.id} className="bim-view" data-testid="bim-view">
          <p className="bim-kind-line">
            {view.kind} view · <code>{view.id}</code>
          </p>
          <Field
            label="View name"
            value={view.name}
            readOnly={readOnly}
            onCommit={(v) => update({ name: v })}
          />
          {view.kind === 'plan' ? (
            <>
              <label className="ep-field">
                Plan level
                <select
                  aria-label="Plan level"
                  value={view.level}
                  disabled={readOnly}
                  onChange={(e) => update({ level: e.target.value })}
                >
                  {doc.levels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="Cut height (mm)"
                type="number"
                min={1}
                max={coordinate}
                value={view.cutHeightMm}
                readOnly={readOnly}
                onCommit={(v) => update({ cutHeightMm: Number(v) })}
              />
            </>
          ) : (
            <label className="ep-field">
              Looking
              <select
                aria-label="Looking"
                value={view.direction}
                disabled={readOnly}
                onChange={(e) => update({ direction: e.target.value as 'left' | 'right' })}
              >
                <option value="left">Left of the line</option>
                <option value="right">Right of the line</option>
              </select>
            </label>
          )}
          <Field
            label="Depth (mm)"
            type="number"
            min={1}
            max={coordinate}
            value={view.depthMm}
            readOnly={readOnly}
            onCommit={(v) => update({ depthMm: Number(v) })}
          />
          <label className="ep-field">
            Scale
            <select
              aria-label="Scale"
              value={view.scale}
              disabled={readOnly}
              onChange={(e) => update({ scale: Number(e.target.value) as BimDrawingScale })}
            >
              {bimDrawingScales.map((sc) => (
                <option key={sc} value={sc}>
                  1:{sc}
                </option>
              ))}
            </select>
          </label>
          <div className="bim-row">
            <button
              className="bim-button"
              aria-pressed={open === view.id}
              onClick={() => onOpen(open === view.id ? undefined : view.id)}
            >
              <FileImage size={15} aria-hidden="true" />{' '}
              {open === view.id ? 'Close drawing' : 'Open drawing'}
            </button>
            {!readOnly && <DeleteButton controller={controller} state={state} ids={[view.id]} />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Export IFC (R2c-6): the Host's export boundary first, then the file of the content as it is
 * after it, measured in its own kernel job. A refusal is the Surface's notice, naming elements.
 */
function useIfcExport(
  controller: BimController,
  name: string,
  ifc: (() => { artifactId: string; timeStamp: string }) | undefined,
) {
  const guard = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  const [writing, setWriting] = useState(false);
  if (!ifc) return undefined;
  const run = async () => {
    try {
      if (guard) guard({ keepEditor: true });
      else inputs?.flush();
    } catch (error) {
      controller.report({ code: error instanceof Error ? error.message : String(error), ids: [] });
      return;
    }
    setWriting(true);
    try {
      const fileName = bimFileName(name, 'ifc');
      const file = await controller.exportIfc({ ...ifc(), fileName });
      if (file)
        bimDownload(new Blob([file.bytes as BlobPart], { type: 'application/x-step' }), fileName);
    } finally {
      setWriting(false);
    }
  };
  return { writing, run };
}

/**
 * A view's drawing in place of the 3D view: drawn again when the building or the view changes,
 * and written out as SVG or PNG.
 */
function DrawingView({
  controller,
  state,
  view,
  building,
  onClose,
}: {
  controller: BimController;
  state: BimState;
  view: BimView;
  building: string;
  onClose(): void;
}) {
  const [result, setResult] = useState<
    { key: string; view: BimView; outcome: BimDrawingResult; svg?: string } | undefined
  >();
  const [exportError, setExportError] = useState<string | undefined>();
  const guard = useContext(EditorExportGuardContext);
  const inputs = useContext(EditorInputsContext);
  // The content and the part shapes read so far: a shape arriving later draws again.
  const key = bimDrawingKey(state);
  useEffect(() => {
    let live = true;
    void controller.draw(view).then((outcome) => {
      if (!live) return;
      const svg = outcome.status === 'ok' ? bimDrawingSvg(outcome.drawing) : undefined;
      setResult({ key, view, outcome, svg });
    });
    return () => {
      live = false;
    };
  }, [controller, key, view]);
  const current = result && result.key === key && result.view === view ? result : undefined;
  const url = useMemo(
    () =>
      current?.svg
        ? URL.createObjectURL(new Blob([current.svg], { type: 'image/svg+xml' }))
        : undefined,
    [current?.svg],
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const drawing = current?.outcome.status === 'ok' ? current.outcome.drawing : undefined;
  // Export draws the view as it is after the flush, so it does not wait for the shown drawing.
  const save = async (ext: 'svg' | 'png') => {
    setExportError(undefined);
    try {
      // The Host's export boundary first: a field draft it cannot commit refuses the export.
      if (guard) guard({ keepEditor: true });
      else inputs?.flush();
    } catch (error) {
      return setExportError(error instanceof Error ? error.message : String(error));
    }
    try {
      // What the flush committed (a cut height, a depth) is in the file: the view as it is now.
      const now = controller.state.content.views.find((v) => v.id === view.id);
      if (!now) throw new Error('view-missing');
      const outcome = await controller.draw(now);
      if (outcome.status !== 'ok') throw new Error(outcome.code);
      const svg = bimDrawingSvg(outcome.drawing);
      const blob =
        ext === 'svg' ? new Blob([svg], { type: 'image/svg+xml' }) : await bimSvgToPng(svg);
      bimDownload(blob, bimDrawingFileName(building, now.name, ext));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="bim-drawing" data-testid="bim-drawing">
      <div className="bim-drawing-bar">
        <strong>{view.name}</strong> <span>1:{view.scale}</span>
        <span className="bim-drawing-state" data-testid="bim-drawing-state" aria-live="polite">
          {!current
            ? 'Drawing…'
            : current.outcome.status === 'error'
              ? `Drawing failed: ${current.outcome.code}`
              : 'Drawing up to date'}
        </span>
        <button className="bim-button" onClick={() => void save('svg')}>
          <Download size={15} aria-hidden="true" /> Export SVG
        </button>
        <button className="bim-button" onClick={() => void save('png')}>
          <Download size={15} aria-hidden="true" /> Export PNG
        </button>
        <button className="bim-button" onClick={onClose}>
          Close drawing
        </button>
      </div>
      {drawing?.failed.length ? (
        <p className="bim-notice" role="status">
          Not drawn: {drawing.failed.map((f) => `${f.id} (${f.code})`).join(', ')}
        </p>
      ) : null}
      {exportError && (
        <p className="bim-notice" role="alert">
          Export failed: {exportError}
        </p>
      )}
      <div className="bim-drawing-sheet">
        {url && <img src={url} alt={`${view.name} drawing`} data-testid="bim-drawing-image" />}
      </div>
    </div>
  );
}
