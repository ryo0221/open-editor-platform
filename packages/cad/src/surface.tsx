import {
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Box,
  Circle,
  Copy,
  Cylinder,
  Disc,
  FileDown,
  FileUp,
  ImageDown,
  Move,
  Pentagon,
  Redo2,
  RectangleHorizontal,
  RefreshCw,
  Replace,
  Ruler,
  Scan,
  SplinePointer,
  SquareDashed,
  SquareMousePointer,
  Torus,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  CommitInput,
  Dialog,
  EditorLayout,
  IconButton,
  Section,
  Toolbar,
  EditorExportGuardContext,
  EditorInputsContext,
  EditorHistoryContext,
  isTextInput,
  modKey,
} from '@editor-platform/editor-ui';
import { readCadInput } from './expression-input';
import {
  cadBoundaryCurves,
  cadLimits,
  formatExpression,
  formatTopoName,
  mm,
  position,
  parameterValues,
  resolveLength,
  resolvePosition,
  sketchDefaultPath,
  sketchElement,
  type CadBody,
  type CadBodyEvaluation,
  type CadCurveSource,
  type CadDocument,
  type CadDerivedSection,
  type CadRatio,
  type Position3,
  type CadFeature,
  type CadPatternLayout,
  type CadCurveLayout,
  type CadParameterType,
  type CadProfileShape,
  type Length,
  type Vec3,
  cadContinuity,
  cadCurvature,
  curvatureColors,
  curvatureRange,
  type CadContinuityLevel,
} from '@editor-platform/cad-core';
import {
  describeCode,
  referenceRows,
  type CadCollectedEdge,
  type CadController,
  type CadMigrationPreview,
  type CadMeshExport,
  type CadSnapshot,
  type CadStepImportPreview,
} from './controller';
import { displayDeflectionMm, type CadExportReport } from '@editor-platform/cad-kernel-occt';
import { CadViewport, type CadMeasurePoint, type CadShading } from './viewport';
import type { CadAssembly, CadStepAssemblyImportPreview } from './assembly';
import { AssemblyLayer, AssemblyPanel } from './assembly-panel';
import { PartPropertiesSection } from './bom-panel';
import { modelTree, type CadTreeNode } from './model-tree';
import { initialView } from './view-math';
import { SketchCanvas, SketchPanel, SketchTools, type SketchTool } from './sketch-mode';
import {
  AngleField,
  CountField,
  fmt,
  fmtGrouped,
  fmtQuantity,
  LengthField,
  parameterName,
} from './dimension-fields';
import './style.css';

const parameterUnit = (type: CadDocument['parameters'][number]['type']) =>
  type === 'length' ? ' mm' : type === 'angle' ? ' rad' : '';
const placementOf = (doc: CadDocument, body: CadBody) =>
  doc.features.find((f) => f.id === body.resultFeatureId);
const noParts = () => () => {};
/** A body's measurement: from an ok result, or from a failed one's bodies outside it (U4). */
const bodyMetrics = (
  evaluation: CadSnapshot['evaluation'],
  id: string,
): CadBodyEvaluation | undefined =>
  evaluation?.status === 'ok' ? evaluation.bodies[id] : evaluation?.partial?.[id];
const stateText: Record<CadSnapshot['geometryState'], string> = {
  ready: 'Shape up to date',
  reevaluating: 'Recalculating shape…',
  'geometry-error': 'Shape could not be calculated',
};

/** Active bodies shown for a named view, or all of them for the whole model. */
const shownBodies = (doc: CadDocument, viewId: string | null) => {
  const active = doc.bodies.filter((b) => b.state === 'active').map((b) => b.id);
  const view = doc.namedViews.find((v) => v.id === viewId);
  return view ? active.filter((id) => view.bodyIds.includes(id)) : active;
};

/** Root width at or under which sketching is off (docs/cad/r1-modeling.md: desktop only). */
const narrowSketchPx = 800;

function Viewport({
  controller,
  snapshot,
  view,
  viewId,
  onViewId,
  moving,
  measuring,
  picking,
  gpuBytes,
  onDrawn,
  overlay,
  assembly,
}: {
  controller: CadController;
  /** R2b: placed parts drawn beside the bodies. */
  assembly?: CadAssembly;
  gpuBytes?: number;
  /** Drawn over the view (Sketch mode), which stays mounted under it. */
  overlay?: ReactNode;
  /** Face or edge picking is on: clicks pick from the pick table instead of bodies. */
  picking: 'face' | 'edge' | undefined;
  /** The measure tool is on: clicks on bodies pick points for a distance. */
  measuring: boolean;
  /** Whether the shape is on screen: false while the context is lost or the GPU budget refuses it. */
  onDrawn(drawn: boolean): void;
  snapshot: CadSnapshot;
  view: RefObject<CadViewport | null>;
  viewId: string | null;
  onViewId(id: string | null): void;
  /** The Move tool is on: primary drag moves bodies instead of orbiting. */
  moving: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [lost, setLost] = useState(false);
  /** Bytes the GPU budget refused for the shown shape (CAD26). */
  const [overGpu, setOverGpu] = useState<number>();
  /** Bumped when the WebGL context comes back, so the meshes are uploaded again. */
  const [restored, setRestored] = useState(0);
  // The named view to open with, read once when the viewport is created.
  const opening = useRef(snapshot.content.namedViews.find((v) => v.id === viewId));
  // Set by choosing Whole model: fit after the show effect has put every body back.
  const refit = useRef(false);
  /** Measured points, on the shape of the content they were picked on. */
  const [measure, setMeasure] = useState<{ hash: string; points: CadMeasurePoint[] }>({
    hash: '',
    points: [],
  });
  const valid = measuring && measure.hash === snapshot.contentHash && !!snapshot.meshes?.current;
  const points = useMemo(() => (valid ? measure.points : []), [valid, measure]);
  const onMeasure = useRef((_: CadMeasurePoint) => {});
  onMeasure.current = (point) =>
    setMeasure((m) => ({
      hash: snapshot.contentHash,
      // A third point starts a new measurement.
      points:
        m.hash === snapshot.contentHash && m.points.length === 1 ? [m.points[0]!, point] : [point],
    }));
  // The budget the viewport is created with; later changes apply in place.
  const gpuBudget = useRef(gpuBytes);
  gpuBudget.current = gpuBytes;
  useEffect(() => {
    if (!host.current) return;
    try {
      view.current = new CadViewport(host.current, {
        onPick: (bodyId) => controller.select(bodyId ? { kind: 'body', id: bodyId } : null),
        onContextLost: () => setLost(true),
        onContextRestored: () => {
          setLost(false);
          setRestored((n) => n + 1);
        },
        gpuBytes: gpuBudget.current,
        onGpuBudget: setOverGpu,
        onMeasure: (point) => onMeasure.current(point),
        onPickComponent: (path) => assembly?.select(path[0]),
        onPickTopology: (pick) => {
          // Pick ids belong to the meshes on screen, which are the current content's.
          const { contentHash, meshes } = controller.getSnapshot();
          controller.select(
            pick && meshes?.current
              ? { kind: pick.kind, id: pick.bodyId, pick: pick.id, contentHash }
              : null,
          );
        },
      });
      if (opening.current) view.current.setView(opening.current);
    } catch {
      setLost(true);
    }
    return () => {
      view.current?.dispose();
      view.current = null;
    };
  }, [controller, view]);
  useEffect(() => onDrawn(!lost && overGpu === undefined), [onDrawn, lost, overGpu]);
  // A new budget applies to the viewport in place: its shape, tools and camera stay.
  useEffect(() => view.current?.setGpuBudget(gpuBytes), [view, gpuBytes]);
  // Shading (R2a-4): display only, never part of the content.
  const [shading, setShading] = useState<'shaded' | 'zebra' | 'mean' | 'gauss'>('shaded');
  const [zebraAxis, setZebraAxis] = useState<'x' | 'y' | 'z'>('z');
  /** Zebra on the selected body only; the others keep their colour. */
  const [zebraSelected, setZebraSelected] = useState(false);
  /** The ground grid at z = 0 (display only): off for models that sit on their own ground. */
  const [grid, setGrid] = useState(true);
  useEffect(() => view.current?.setGrid(grid), [view, grid, restored]);
  const [stripes, setStripes] = useState(12);
  /** The colour range is the automatic one times 2 to this power. */
  const [rangeStep, setRangeStep] = useState(0);
  /** The comb scale is the automatic one times 2 to this power. */
  const [combStep, setCombStep] = useState(0);
  const curving = shading === 'mean' || shading === 'gauss';
  const curvature = snapshot.curvature;
  const shownIds = useMemo(
    () => new Set(shownBodies(snapshot.content, viewId)),
    [snapshot.content, viewId],
  );
  // The values on the current meshes only: computed for this content, and these are its meshes.
  const values = useMemo(() => {
    if (!curving || curvature?.status !== 'done' || !snapshot.meshes?.current) return undefined;
    if (snapshot.meshes.contentHash !== snapshot.contentHash) return undefined;
    return new Map(
      curvature.bodies.map((b) => [b.bodyId, shading === 'gauss' ? b.gauss : b.mean] as const),
    );
  }, [curving, curvature, shading, snapshot.meshes, snapshot.contentHash]);
  const autoRange = useMemo(
    () =>
      values &&
      curvatureRange([...values].flatMap(([id, v]) => (shownIds.has(id) ? Array.from(v) : []))),
    [values, shownIds],
  );
  const range = autoRange && autoRange * 2 ** rangeStep;
  // Asks for the curvature once per content while a curvature shading is chosen.
  const asked = useRef('');
  useEffect(() => {
    if (!curving) {
      asked.current = '';
      return;
    }
    const { evaluation, reference, meshes, contentHash } = snapshot;
    if (curvature || reference || !meshes?.current || evaluation?.status !== 'ok') return;
    if (evaluation.contentHash !== contentHash || asked.current === contentHash) return;
    asked.current = contentHash;
    void controller.showCurvature();
  }, [controller, curving, curvature, snapshot]);
  const comb = snapshot.comb?.status === 'done' ? snapshot.comb : undefined;
  const combScale = comb && comb.scale * 2 ** combStep;
  useEffect(() => {
    view.current?.showComb(
      comb && combScale ? { samples: comb.samples, scale: combScale } : undefined,
    );
  }, [view, comb, combScale, restored]);
  useEffect(() => {
    const meshes = snapshot.meshes;
    const bodies = new Map(snapshot.content.bodies.map((b) => [b.id, b]));
    const shown = shownIds;
    const mode: CadShading =
      shading === 'zebra'
        ? { mode: 'zebra', axis: zebraAxis, stripes, selectedOnly: zebraSelected }
        : values && range
          ? { mode: 'curvature', range }
          : { mode: 'shaded' };
    view.current?.setShading(mode);
    const selection = snapshot.selection;
    const picked = selection?.kind === 'face' || selection?.kind === 'edge' ? selection : undefined;
    view.current?.show(
      (meshes?.meshes ?? []).flatMap((mesh) => {
        const body = bodies.get(mesh.bodyId);
        if (!body && meshes?.current) return [];
        if (body && !shown.has(body.id)) return [];
        return [
          {
            mesh,
            color: body?.appearance.color ?? '#9aa4b1',
            opacity: body?.appearance.opacity ?? 1,
            selected: snapshot.selection?.kind === 'body' && snapshot.selection.id === mesh.bodyId,
            sheet: body?.kind === 'sheet',
            ...(values?.has(mesh.bodyId) ? { curvature: values.get(mesh.bodyId)! } : {}),
            ...(picked?.id === mesh.bodyId && picked.contentHash === meshes?.contentHash
              ? { highlight: { bodyId: mesh.bodyId, kind: picked.kind, id: picked.pick } }
              : {}),
          },
        ];
      }),
      !!meshes?.current,
      !meshes?.current && !meshes?.preview,
    );
    // Whole model fits only once all bodies are shown again.
    if (refit.current) {
      refit.current = false;
      view.current?.fit({ reset: true });
    }
  }, [
    snapshot.meshes,
    snapshot.selection,
    snapshot.content,
    view,
    restored,
    shownIds,
    shading,
    zebraAxis,
    zebraSelected,
    stripes,
    values,
    range,
  ]);
  useEffect(() => {
    view.current?.setMoveTool(
      moving
        ? {
            canMove: (id) => {
              const body = controller.getSnapshot().content.bodies.find((b) => b.id === id);
              return !!body && controller.isMovable(body);
            },
            onMove: (id, delta) => {
              const { content } = controller.getSnapshot();
              // History or a Host sync may have removed or bound the body during the gesture:
              // cancel it like Escape instead of moving what is no longer there.
              const body = content.bodies.find((b) => b.id === id);
              if (!body || !controller.isMovable(body)) return Promise.resolve(false);
              const placement = placementOf(content, body);
              const at =
                placement?.type === 'transform'
                  ? resolvePosition(placement.args.translation, parameterValues(content))
                  : [0, 0, 0];
              controller.select({ kind: 'body', id });
              return controller.moveBody(body, at.map((v, i) => v + delta[i]) as Vec3);
            },
            onRefused: (_, reason) =>
              controller.report(
                describeCode(reason === 'bound' ? 'placement-bound' : 'move-edge-on'),
              ),
          }
        : undefined,
    );
  }, [controller, view, moving]);
  useEffect(() => view.current?.setTopologyTool(picking), [view, picking]);
  useEffect(() => {
    view.current?.setMeasureTool(measuring);
    if (!measuring) setMeasure({ hash: '', points: [] });
  }, [view, measuring]);
  // While broken references are chosen again, the chosen candidate is marked on the preview.
  const rebind = snapshot.rebind;
  const marked = useMemo(() => {
    const p = rebind?.problems[rebind.active];
    return p && p.choice >= 0 ? [p.candidates[p.choice]!.hint.centroid] : [];
  }, [rebind]);
  useEffect(() => {
    view.current?.showMeasure(rebind ? marked : points.map((p) => p.point));
  }, [view, points, restored, rebind, marked]);
  const views = snapshot.content.namedViews;
  const hasBodies =
    snapshot.content.bodies.some((b) => b.state === 'active') ||
    snapshot.content.components.length > 0;
  function choose(id: string) {
    const named = views.find((v) => v.id === id);
    if (named) view.current?.setView(named);
    else refit.current = true;
    onViewId(named ? named.id : null);
  }
  return (
    <div className="cad-viewport" data-testid="cad-viewport">
      <div ref={host} className="cad-canvas-host" />
      {assembly && (
        <AssemblyLayer assembly={assembly} view={view} snapshot={snapshot} restored={restored} />
      )}
      {lost && (
        <p className="cad-viewport-note" role="status">
          3D表示を利用できません。一覧とInspectorから編集・保存できます。
        </p>
      )}
      {!lost && overGpu !== undefined && (
        <p className="cad-viewport-note" role="status">
          形状が3D表示に使えるメモリーの上限を超えるため、表示していません（
          {(overGpu / 1024 / 1024).toFixed(1)} MiB）。一覧とInspectorから編集・保存できます。
        </p>
      )}
      {!hasBodies && <p className="cad-viewport-note">Add a body from the toolbar to start.</p>}
      {hasBodies && !lost && !snapshot.meshes && snapshot.geometryState !== 'geometry-error' && (
        <p className="cad-viewport-note" role="status">
          Preparing the 3D shape…
        </p>
      )}
      {/* In place of the shape, where it is read on any width; the status line only names the state. */}
      {!lost && !snapshot.busy && !snapshot.rebind && snapshot.geometryFailure && (
        <div
          className="cad-viewport-note cad-viewport-failure"
          role="status"
          data-testid="cad-geometry-failure"
        >
          {snapshot.geometryFailure}
          {snapshot.partialFailure && (
            <span className="cad-partial-failure">
              {snapshot.partialFailure.shown > 0 &&
                `計算できたbody（${snapshot.partialFailure.shown}個）はそのまま表示し、計測できます。`}
              {snapshot.partialFailure.before.map(
                ({ body, feature }) =>
                  `「${body}」はfeature「${feature}」の手前の形を薄く表示しています（参考表示。選択・計測・書き出しには使いません）。`,
              )}
            </span>
          )}
          {snapshot.canRebindCurrent && (
            <button type="button" onClick={() => controller.rebindCurrent()}>
              Choose references again
            </button>
          )}
        </div>
      )}
      {/* Over the preview it chooses for, on any width (the narrow Inspector covers the view). */}
      <RebindPanel controller={controller} snapshot={snapshot} />
      {overlay}
      {measuring && (
        <Measurement
          points={points}
          snapshot={snapshot}
          onClear={() => setMeasure({ hash: '', points: [] })}
        />
      )}
      {(shading !== 'shaded' || comb) && (
        <div className="cad-analysis">
          {shading === 'zebra' && (
            <section aria-label="Zebra" data-testid="cad-zebra">
              <details className="cad-muted">
                <summary>Around the world {zebraAxis.toUpperCase()} axis</summary>
                <p>
                  Stripes reflected around the world {zebraAxis.toUpperCase()} axis, from the
                  display mesh&apos;s normals (approximate). A kink in the stripes is a crease (G1
                  break); a jump in their bending is a curvature (G2) break.
                </p>
              </details>
              <label>
                Direction{' '}
                <select
                  value={zebraAxis}
                  onChange={(e) => setZebraAxis(e.target.value as 'x' | 'y' | 'z')}
                >
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </label>{' '}
              <label>
                Stripes{' '}
                <input
                  type="range"
                  min={4}
                  max={32}
                  step={2}
                  value={stripes}
                  onChange={(e) => setStripes(Number(e.target.value))}
                />{' '}
                <output>{stripes}</output>
              </label>{' '}
              <label>
                <input
                  type="checkbox"
                  checked={zebraSelected}
                  onChange={(e) => setZebraSelected(e.target.checked)}
                />{' '}
                Selected body only
              </label>
              {zebraSelected && snapshot.selection?.kind !== 'body' && (
                <p className="cad-muted">bodyを選ぶと、そのbodyだけに縞を表示します。</p>
              )}
            </section>
          )}
          {curving && (
            <CurvatureLegend
              measure={shading as 'mean' | 'gauss'}
              range={range}
              rangeStep={rangeStep}
              onRangeStep={setRangeStep}
              status={
                snapshot.reference
                  ? 'reference'
                  : curvature?.status === 'running'
                    ? 'running'
                    : values
                      ? 'done'
                      : snapshot.meshes?.current &&
                          snapshot.evaluation?.status === 'ok' &&
                          snapshot.evaluation.contentHash === snapshot.contentHash
                        ? 'idle'
                        : 'waiting'
              }
              onCompute={() => void controller.showCurvature()}
            />
          )}
          {comb && combScale !== undefined && (
            <section aria-label="Curvature comb" data-testid="cad-comb">
              <p>
                Curvature comb of the picked edge: {comb.samples.length} samples
                {comb.scale > 0
                  ? `, longest tooth ${fmt(
                      Math.max(...comb.samples.map((x) => x.curvature)) * combScale,
                    )} mm at radius ${fmt(1 / Math.max(...comb.samples.map((x) => x.curvature)))} mm.`
                  : '; the edge is straight.'}
              </p>
              <label>
                Scale{' '}
                <input
                  type="range"
                  min={-3}
                  max={3}
                  step={1}
                  value={combStep}
                  onChange={(e) => setCombStep(Number(e.target.value))}
                />{' '}
                <output>×{2 ** combStep}</output>
              </label>{' '}
              <button type="button" onClick={() => controller.hideComb()}>
                Hide
              </button>
            </section>
          )}
        </div>
      )}
      <div className="cad-view-tools">
        <label className="cad-views">
          <span>Shading</span>
          <select
            value={shading}
            onChange={(e) => setShading(e.target.value as typeof shading)}
            data-testid="cad-shading"
          >
            <option value="shaded">Shaded</option>
            <option value="zebra">Zebra</option>
            <option value="mean">Mean curvature</option>
            <option value="gauss">Gauss curvature</option>
          </select>
        </label>
        {views.length > 0 && (
          <label className="cad-views">
            <span>Views</span>
            <select value={viewId ?? ''} onChange={(e) => choose(e.target.value)}>
              <option value="">Whole model</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="cad-views">
          <input
            type="checkbox"
            checked={grid}
            onChange={(e) => setGrid(e.target.checked)}
            data-testid="cad-grid"
          />
          <span>Grid</span>
        </label>
        <IconButton icon={Scan} label="Fit view" onClick={() => view.current?.fit()} />
      </div>
    </div>
  );
}

/** A linear 0–1 colour as CSS: the canvas writes vertex colours to sRGB the same way. */
const cssColor = (c: readonly number[]) =>
  `rgb(${c
    .map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)))
    .join(' ')})`;

/**
 * The curvature colours' legend and range (docs/cad/r2a-freeform.md, 連続性の判定と表示): the
 * kernel's values at the mesh nodes, from the exact surfaces; display only.
 */
function CurvatureLegend({
  measure,
  range,
  rangeStep,
  onRangeStep,
  status,
  onCompute,
}: {
  measure: 'mean' | 'gauss';
  range: number | undefined;
  rangeStep: number;
  onRangeStep(step: number): void;
  /** `idle`: the shape is evaluated but has no curvature (a request was refused or superseded). */
  status: 'reference' | 'running' | 'waiting' | 'idle' | 'done';
  onCompute(): void;
}) {
  const unit = measure === 'mean' ? '/mm' : '/mm²';
  const c = curvatureColors;
  return (
    <section aria-label="Curvature" data-testid="cad-curvature">
      {status === 'reference' && (
        <p>Curvature needs the document&apos;s own kernel build; this is a reference display.</p>
      )}
      {status === 'running' && <p>Computing curvature…</p>}
      {status === 'waiting' && (
        <p className="cad-muted">Curvature is shown once the shape is evaluated.</p>
      )}
      {status === 'idle' && (
        <p>
          <button type="button" onClick={onCompute}>
            Compute curvature
          </button>
        </p>
      )}
      {status === 'done' && range !== undefined && (
        <>
          <p className="cad-muted">
            {measure === 'mean'
              ? 'Mean curvature at the mesh nodes, from the exact surfaces: red convex, blue concave.'
              : 'Gauss curvature at the mesh nodes, from the exact surfaces: red bowl-shaped, blue saddle-shaped.'}{' '}
            Grey: none there (a pole).
          </p>
          <div
            className="cad-legend"
            style={{
              background: `linear-gradient(to right, ${cssColor(c.negative)}, ${cssColor(c.zero)}, ${cssColor(c.positive)})`,
            }}
          />
          <p className="cad-legend-labels">
            <span>−{range.toExponential(2)}</span>
            <span>0</span>
            <span data-testid="cad-curvature-range">
              +{range.toExponential(2)} {unit}
            </span>
          </p>
          {measure === 'mean' && (
            <p className="cad-muted">Full colour at radius {fmt(1 / range)} mm or less.</p>
          )}
          <label>
            Range{' '}
            <input
              type="range"
              min={-3}
              max={3}
              step={1}
              value={rangeStep}
              onChange={(e) => onRangeStep(Number(e.target.value))}
            />{' '}
            <output>×{2 ** rangeStep}</output>
          </label>
          <p className="cad-muted">
            At ×1, {cadCurvature.rangePercentile * 100}% of the shown nodes are within the range.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The distance between two picked points, with how exact each is and the shape it was measured
 * on (docs/cad/README.md, 計測: the evaluated hash and the unit; a mesh measurement says so).
 */
function Measurement({
  points,
  snapshot,
  onClear,
}: {
  points: CadMeasurePoint[];
  snapshot: CadSnapshot;
  onClear(): void;
}) {
  const names = new Map(snapshot.content.bodies.map((b) => [b.id, b.name]));
  const { evaluation } = snapshot;
  const [a, b] = points;
  let result = null;
  if (a && b) {
    const delta = a.point.map((v, i) => b.point[i]! - v);
    const mesh = points.filter((p) => !p.vertex);
    // Points lie on bodies of the shown result: an ok one, or those outside a failure (U4).
    const deflection = Math.max(
      0,
      ...mesh.flatMap((p) => {
        const body = bodyMetrics(evaluation, p.bodyId);
        return body ? [displayDeflectionMm(body.bounds)] : [];
      }),
    );
    result = (
      <>
        <p>
          Distance <output data-testid="cad-distance">{fmt(Math.hypot(...delta))}</output> mm
          {Math.hypot(...delta) >= 10_000 && (
            <span className="cad-muted"> ({fmtGrouped(Math.hypot(...delta) / 1000)} m)</span>
          )}
        </p>
        <p className="cad-muted">
          ΔX {fmt(delta[0]!)} · ΔY {fmt(delta[1]!)} · ΔZ {fmt(delta[2]!)} mm
        </p>
        <p className="cad-muted">
          {mesh.length
            ? `Approximate: ${mesh.length === 2 ? 'both points are' : 'one point is'} on the display mesh, within ${fmt(deflection)} mm of the surface.`
            : 'Exact: both points are corners (B-rep vertices) from the kernel.'}
        </p>
      </>
    );
  }
  return (
    <section className="cad-measure" aria-label="Distance" role="status">
      {points.length === 0 && (
        <p>Click a point on a body. A click near a corner snaps to that vertex.</p>
      )}
      {points.length === 1 && (
        <p>
          From {a!.vertex ? 'a corner' : 'a point'} of {names.get(a!.bodyId)}: click a second point.
        </p>
      )}
      {result}
      <p className="cad-muted">
        Shape {snapshot.contentHash.slice(0, 15)}…, millimetres.{' '}
        {points.length > 0 && (
          <button type="button" onClick={onClear}>
            Clear
          </button>
        )}
      </p>
    </section>
  );
}

/** The profile a feature reads: its dimensions, or a polyline's vertices (each change one edit). */
function ProfileFields({
  profileId,
  doc,
  controller,
}: {
  profileId: string;
  doc: CadDocument;
  controller: CadController;
}) {
  const profile = doc.profiles.find((p) => p.id === profileId)!;
  const { shape } = profile;
  const reshape = (next: CadProfileShape) =>
    void controller.run({
      type: 'updateProfile',
      profileId,
      plane: profile.plane,
      shape: next,
    });
  const mm = (literalMm: number): Length => ({ literalMm });
  return (
    <Section title={`Profile: ${profile.name}`}>
      {shape.type === 'rectangle' ? (
        <>
          <LengthField
            label="Width"
            length={shape.width}
            doc={doc}
            onCommit={(v) => reshape({ ...shape, width: v })}
          />
          <LengthField
            label="Height"
            length={shape.height}
            doc={doc}
            onCommit={(v) => reshape({ ...shape, height: v })}
          />
        </>
      ) : shape.type === 'circle' ? (
        <LengthField
          label="Radius"
          length={shape.radius}
          doc={doc}
          onCommit={(v) => reshape({ ...shape, radius: v })}
        />
      ) : (
        <>
          {shape.vertices.map((vertex, i) => (
            <div className="cad-row" key={vertex.id}>
              {(['u', 'v'] as const).map((axis) => (
                <LengthField
                  key={axis}
                  label={`${i + 1} ${axis.toUpperCase()}`}
                  length={vertex[axis]}
                  doc={doc}
                  onCommit={(value) =>
                    reshape({
                      ...shape,
                      vertices: shape.vertices.map((x, j) =>
                        j === i ? { ...x, [axis]: value } : x,
                      ),
                    })
                  }
                />
              ))}
            </div>
          ))}
          <div className="cad-row">
            <button
              type="button"
              disabled={shape.vertices.length >= cadLimits.verticesPerProfile}
              onClick={() => {
                // Halfway along the closing edge: the outline keeps its shape until moved.
                const values = parameterValues(doc);
                const [a, b] = [shape.vertices.at(-1)!, shape.vertices[0]!];
                const half = (axis: 'u' | 'v') =>
                  mm((resolveLength(a[axis], values) + resolveLength(b[axis], values)) / 2);
                reshape({
                  ...shape,
                  vertices: [
                    ...shape.vertices,
                    { id: controller.newId('vertex'), u: half('u'), v: half('v') },
                  ],
                });
              }}
            >
              Add vertex
            </button>
            <button
              type="button"
              disabled={shape.vertices.length <= 3}
              onClick={() => reshape({ ...shape, vertices: shape.vertices.slice(0, -1) })}
            >
              Remove last vertex
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

const stateLabel = {
  resolved: 'Resolved',
  ambiguous: 'Ambiguous',
  missing: 'Missing',
  unknown: 'Not checked',
} as const;
/** List keys whose entries may be taken out, with how many must remain. */
const removable: Partial<Record<CadFeature['type'], Record<string, number>>> = {
  fillet: { edges: 1 },
  chamfer: { edges: 1 },
  shell: { openFaces: 0 },
  draft: { faces: 1 },
};

/**
 * The stored references of a feature with their states (r1-modeling.md, Pickと表示). An entry
 * of a list may be taken out as one edit.
 */
function ReferenceList({
  feature,
  snapshot,
  controller,
}: {
  feature: CadFeature;
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const rows = referenceRows(feature, snapshot.contentHash, snapshot.evaluation);
  if (!rows.length) return null;
  const args = feature.args as Record<string, unknown>;
  const remove = (key: string, i: number) => {
    const list = args[key] as unknown[];
    void controller.run({
      type: 'updateFeature',
      featureId: feature.id,
      args: { ...args, [key]: list.filter((_, j) => j !== i) } as CadFeature['args'],
    });
  };
  return (
    <Section title="References">
      <ul className="cad-references" aria-label="References" data-testid="cad-references">
        {rows.map(({ path, ref, state, candidates }) => {
          const [key, i] = path;
          const min = typeof i === 'number' ? removable[feature.type]?.[key as string] : undefined;
          const canRemove =
            !snapshot.readOnly &&
            min !== undefined &&
            (args[key as string] as unknown[]).length > min;
          return (
            <li key={JSON.stringify(path)} data-state={state}>
              <span className="cad-reference-name">
                {ref.kind === 'face' ? 'Face' : 'Edge'} {formatTopoName(ref.name)}
                {ref.select && (
                  <span className="cad-muted">
                    {' '}
                    next to {ref.select.adjacent.map(formatTopoName).join(', ')}
                  </span>
                )}
              </span>
              <span className={`cad-reference-state cad-reference-${state}`}>
                {stateLabel[state]}
                {state === 'ambiguous' ? ` (${candidates} candidates)` : ''}
              </span>
              {canRemove && (
                <button
                  type="button"
                  disabled={snapshot.busy}
                  aria-label={`Remove ${formatTopoName(ref.name)}`}
                  onClick={() => remove(key as string, i as number)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * The tools of a Boolean in order: each moves up or down, or is taken out and becomes a body
 * again (r1-modeling.md, Booleanのtoolの名前). Each change is one edit.
 */
function BooleanTools({
  feature,
  snapshot,
  controller,
}: {
  feature: CadFeature;
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const doc = snapshot.content;
  const tools = feature.inputFeatureIds
    .slice(1)
    .map((id) =>
      doc.bodies.find(
        (b) =>
          b.state === 'consumed' &&
          b.consumedByFeatureId === feature.id &&
          b.resultFeatureId === id,
      ),
    )
    .filter((b) => !!b);
  const set = (ids: string[]) =>
    void controller.run({ type: 'setBooleanTools', featureId: feature.id, toolIds: ids });
  const ids = tools.map((t) => t.id);
  const move = (i: number, by: number) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    set(next);
  };
  return (
    <Section title="Tools">
      <ol className="cad-tools" aria-label="Boolean tools">
        {tools.map((t, i) => (
          <li key={t.id}>
            <span>{t.name}</span>
            {!snapshot.readOnly && (
              <span className="cad-row">
                <button
                  type="button"
                  disabled={snapshot.busy || i === 0}
                  aria-label={`Move ${t.name} up`}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={snapshot.busy || i === tools.length - 1}
                  aria-label={`Move ${t.name} down`}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={snapshot.busy || tools.length === 1}
                  aria-label={`Take out ${t.name}`}
                  onClick={() => set(ids.filter((id) => id !== t.id))}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function FeatureArgs({
  feature,
  doc,
  controller,
}: {
  feature: CadFeature;
  doc: CadDocument;
  controller: CadController;
}) {
  const update = (args: CadFeature['args']) =>
    controller.run({ type: 'updateFeature', featureId: feature.id, args });
  switch (feature.type) {
    case 'box': {
      const a = feature.args;
      return (
        <>
          {(['Width', 'Depth', 'Height'] as const).map((label, i) => (
            <LengthField
              key={label}
              label={label}
              length={a.size[i]}
              doc={doc}
              onCommit={(v) =>
                update({ ...a, size: a.size.map((l, j) => (j === i ? v : l)) as typeof a.size })
              }
            />
          ))}
        </>
      );
    }
    case 'cylinder':
      return (
        <>
          <LengthField
            label="Radius"
            length={feature.args.radius}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, radius: v })}
          />
          <LengthField
            label="Height"
            length={feature.args.height}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, height: v })}
          />
        </>
      );
    case 'sphere':
      return (
        <LengthField
          label="Radius"
          length={feature.args.radius}
          doc={doc}
          onCommit={(v) => update({ ...feature.args, radius: v })}
        />
      );
    case 'extrude':
      return (
        <>
          <LengthField
            label="Distance"
            length={feature.args.distance}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, distance: v })}
          />
          {'profileId' in feature.args && (
            <ProfileFields profileId={feature.args.profileId} doc={doc} controller={controller} />
          )}
        </>
      );
    case 'revolve':
      return (
        <>
          <AngleField
            label="Angle"
            angle={feature.args.angle}
            doc={doc}
            onCommit={(angle) => void update({ ...feature.args, angle })}
          />
          {'profileId' in feature.args && (
            <ProfileFields profileId={feature.args.profileId} doc={doc} controller={controller} />
          )}
        </>
      );
    case 'extrudeSurface':
      return (
        <LengthField
          label="Distance"
          length={feature.args.distance}
          doc={doc}
          onCommit={(v) => update({ ...feature.args, distance: v })}
        />
      );
    case 'revolveSurface':
      return (
        <AngleField
          label="Angle"
          angle={feature.args.angle}
          doc={doc}
          onCommit={(angle) => void update({ ...feature.args, angle })}
        />
      );
    case 'loft':
    case 'surfaceLoft': {
      const sketchName = (id: string) => doc.sketches.find((s) => s.id === id)?.name ?? id;
      const names = feature.args.sections.map((x) =>
        'edges' in x
          ? `${x.edges.length} edges`
          : 'derivedFrom' in x
            ? `derived from ${x.derivedFrom + 1}`
            : sketchName(x.sketchId),
      );
      // K6: a derived section's offset, scale and angle, each a value or an expression.
      const derived = feature.type === 'loft' ? feature.args.sections : [];
      const setDerived = (i: number, change: Partial<CadDerivedSection>) =>
        feature.type === 'loft' &&
        void update({
          ...feature.args,
          sections: feature.args.sections.map((x, j) => (j === i ? { ...x, ...change } : x)),
        });
      return (
        <>
          <div className="cad-readonly-field">
            <span>Sections</span>
            <output data-testid="cad-loft-sections">{names.join(' → ')}</output>
          </div>
          {derived.map((x, i) =>
            'derivedFrom' in x ? (
              <fieldset className="cad-derived-section" key={i}>
                <legend>Section {i + 1}</legend>
                {(['U', 'V', 'Normal'] as const).map((axis, k) => (
                  <LengthField
                    key={axis}
                    label={`Offset ${axis}`}
                    length={x.offset[k]!}
                    doc={doc}
                    onCommit={(l) =>
                      setDerived(i, {
                        offset: x.offset.map((o, m) => (m === k ? l : o)) as Position3,
                      })
                    }
                  />
                ))}
                <CountField
                  label="Scale"
                  count={x.scale}
                  doc={doc}
                  onCommit={(scale) => setDerived(i, { scale: scale as CadRatio })}
                />
                <AngleField
                  label="Twist"
                  angle={x.angle}
                  doc={doc}
                  onCommit={(angle) => setDerived(i, { angle })}
                />
              </fieldset>
            ) : null,
          )}
          <label className="cad-check">
            <input
              type="checkbox"
              checked={feature.args.ruled}
              onChange={(e) => void update({ ...feature.args, ruled: e.target.checked })}
            />
            Ruled (straight between sections)
          </label>
        </>
      );
    }
    case 'sweep':
    case 'surfaceSweep': {
      const name = (id: string) => doc.sketches.find((s) => s.id === id)?.name ?? id;
      return (
        <>
          <div className="cad-readonly-field">
            <span>Profile</span>
            <output>{name(feature.args.profile.sketchId)}</output>
          </div>
          <div className="cad-readonly-field">
            <span>Path</span>
            <output>
              {name(feature.args.path.sketchId)} ({feature.args.path.elements.length} elements)
            </output>
          </div>
          <label className="ep-field">
            Orientation
            <select
              value={feature.args.orientation}
              onChange={(e) =>
                void update({
                  ...feature.args,
                  orientation: e.target.value as 'frenet' | 'fixed',
                })
              }
            >
              <option value="frenet">Follow the path (Frenet)</option>
              <option value="fixed">Fixed</option>
            </select>
          </label>
        </>
      );
    }
    case 'boundarySurface':
      return (
        <div className="cad-readonly-field">
          <span>Curves</span>
          <output data-testid="cad-boundary-curves">
            {feature.args.curves.map((c) => curveLabel(doc, c)).join(' → ')}
          </output>
        </div>
      );
    case 'fill':
      return (
        <div data-testid="cad-fill-boundary">
          <p className="cad-muted">Boundary, in loop order</p>
          {feature.args.boundary.map((b, i) => (
            <label key={i} className="ep-field">
              {curveLabel(doc, b.curve)}
              <select
                value={b.continuity}
                disabled={!('edge' in b.curve)}
                onChange={(e) =>
                  void update({
                    boundary: feature.args.boundary.map((x, j) =>
                      j === i ? { ...x, continuity: e.target.value as 'G0' | 'G1' } : x,
                    ),
                  })
                }
              >
                <option value="G0">G0 (meets the curve)</option>
                <option value="G1">G1 (tangent to the face beside)</option>
              </select>
            </label>
          ))}
        </div>
      );
    case 'trim': {
      const sides =
        'sketchId' in feature.args.tool
          ? (['inside', 'outside'] as const)
          : (['front', 'back'] as const);
      return (
        <label className="ep-field">
          Keep
          <select
            value={feature.args.keep}
            onChange={(e) =>
              void update({ ...feature.args, keep: e.target.value as (typeof sides)[number] })
            }
          >
            {sides.map((x) => (
              <option key={x} value={x}>
                {trimSideLabels[x]}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case 'sew':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Joining distance</span>
            <output>{feature.args.toleranceMm} mm</output>
          </div>
          <label className="cad-check">
            <input
              type="checkbox"
              checked={feature.args.solid}
              onChange={(e) => void update({ ...feature.args, solid: e.target.checked })}
            />
            Close into a solid
          </label>
        </>
      );
    case 'thicken':
      return (
        <>
          <LengthField
            label="Thickness"
            length={feature.args.thickness}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, thickness: v })}
          />
          <label className="ep-field">
            Towards
            <select
              value={feature.args.side}
              onChange={(e) =>
                void update({
                  ...feature.args,
                  side: e.target.value as 'front' | 'back' | 'both',
                })
              }
            >
              <option value="front">The front (its normal)</option>
              <option value="back">The back</option>
              <option value="both">Both sides, half each</option>
            </select>
          </label>
        </>
      );
    case 'fillet':
      return (
        <LengthField
          label="Radius"
          length={feature.args.radius}
          doc={doc}
          onCommit={(v) => update({ ...feature.args, radius: v })}
        />
      );
    case 'chamfer': {
      const a = feature.args;
      return (
        <>
          <LengthField
            label="Distance"
            length={a.distance}
            doc={doc}
            onCommit={(v) => update({ ...a, distance: v })}
          />
          {'distance2' in a && (
            <LengthField
              label="Distance 2"
              length={a.distance2}
              doc={doc}
              onCommit={(v) => update({ ...a, distance2: v })}
            />
          )}
        </>
      );
    }
    case 'shell':
      return (
        <>
          <LengthField
            label="Thickness"
            length={feature.args.thickness}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, thickness: v })}
          />
          <label className="ep-field">
            Wall
            <select
              value={feature.args.side}
              onChange={(e) =>
                void update({ ...feature.args, side: e.target.value as 'inside' | 'outside' })
              }
            >
              <option value="inside">Inside the faces</option>
              <option value="outside">Outside the faces</option>
            </select>
          </label>
        </>
      );
    case 'draft':
      return (
        <AngleField
          label="Angle"
          angle={feature.args.angle}
          doc={doc}
          onCommit={(angle) => void update({ ...feature.args, angle })}
        />
      );
    case 'mirror':
      return (
        <label className="cad-check">
          <input
            type="checkbox"
            checked={feature.args.union}
            onChange={(e) => void update({ ...feature.args, union: e.target.checked })}
          />
          Keep the original (join it to the reflection)
        </label>
      );
    case 'pattern': {
      const a = feature.args;
      const layout = a.layout;
      const set = (l: CadPatternLayout | CadCurveLayout) => void update({ ...a, layout: l });
      return (
        <>
          <p className="cad-muted">
            {a.mode === 'cut' ? 'Cuts' : 'Joins'}{' '}
            {layout.type === 'linear'
              ? `copies in a row along (${layout.direction.map((c) => fmt(c)).join(', ')})`
              : layout.type === 'circular'
                ? `copies round the axis (${layout.axisDirection.map((c) => fmt(c)).join(', ')})`
                : `copies along the path of ${doc.sketches.find((x) => x.id === layout.path.sketchId)?.name ?? layout.path.sketchId}, start to end`}
            .
          </p>
          <CountField
            count={layout.count}
            doc={doc}
            onCommit={(count) => set({ ...layout, count })}
          />
          {layout.type === 'curve' ? (
            <label className="cad-check">
              <input
                type="checkbox"
                checked={layout.align}
                onChange={(e) => set({ ...layout, align: e.target.checked })}
              />
              Turn each copy with the path
            </label>
          ) : layout.type === 'linear' ? (
            <LengthField
              label="Spacing"
              length={layout.spacing}
              doc={doc}
              onCommit={(spacing) => set({ ...layout, spacing })}
            />
          ) : (
            <AngleField
              label="Step angle"
              angle={layout.angle}
              doc={doc}
              onCommit={(angle) => set({ ...layout, angle })}
            />
          )}
        </>
      );
    }
    case 'imported': {
      const source = doc.assets.find((a) => a.id === feature.args.sourceAssetId);
      return (
        <p className="cad-muted">
          Imported from STEP ({feature.args.sourceUnit}
          {feature.args.scaleToMm === 1 ? '' : `, × ${feature.args.scaleToMm} to mm`}
          {source ? `, ${source.byteLength.toLocaleString('en-US')} bytes` : ''}). One solid without
          feature history: it has no editable dimensions.
        </p>
      );
    }
    default:
      return <p className="cad-muted">No editable dimensions.</p>;
  }
}

/**
 * K2 (docs/cad/complex-models.md): the document's tolerance set. Changing it evaluates the whole
 * graph with the new set and shows the difference before it is adopted as one edit.
 */
function DocumentSettings({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const current = snapshot.toleranceSet;
  const other = current === 'large' ? 'standard' : 'large';
  return (
    <Section title="Document">
      <div className="cad-readonly-field">
        <span>Tolerance set</span>
        <output data-testid="cad-tolerance-set">{current ?? 'custom'}</output>
      </div>
      {!snapshot.readOnly && (
        <button
          type="button"
          disabled={!snapshot.canChangeTolerance}
          title="Evaluates the whole model with the other set and shows the difference before you adopt it"
          onClick={() => void controller.prepareToleranceSet(other)}
        >
          Use {other} tolerances…
        </button>
      )}
    </Section>
  );
}

function Inspector({ controller, snapshot }: { controller: CadController; snapshot: CadSnapshot }) {
  const { content: doc, selection, evaluation, readOnly } = snapshot;
  const [tool, setTool] = useState('');
  if (!selection)
    return (
      <>
        <p className="cad-muted">Select a body, feature or parameter.</p>
        <DocumentSettings controller={controller} snapshot={snapshot} />
      </>
    );
  if (selection.kind === 'face' || selection.kind === 'edge')
    return <TopologyInspector snapshot={snapshot} controller={controller} />;
  const key = `${selection.id}:${snapshot.rejections}`;
  if (selection.kind === 'parameter') {
    const p = doc.parameters.find((x) => x.id === selection.id)!;
    return (
      <div className="cad-inspector" key={key}>
        <CommitInput
          label="Name"
          value={p.name}
          onCommit={(name) => void controller.run({ type: 'rename', targetId: p.id, name })}
        />
        <CommitInput
          label={`Value${p.type === 'count' ? '' : ` (${parameterUnit(p.type).trim()})`}`}
          value={p.expression ? formatExpression(p.expression, parameterName(doc)) : p.value!}
          placeholder="number or expression"
          onCommit={(text) => {
            const v = readCadInput(text, doc, p.type === 'count' ? 'scalar' : p.type);
            void controller.run(
              'literal' in v
                ? { type: 'setParameter', parameterId: p.id, value: v.literal }
                : { type: 'setParameter', parameterId: p.id, expression: v.expression },
            );
          }}
        />
      </div>
    );
  }
  if (selection.kind === 'feature') {
    const f = doc.features.find((x) => x.id === selection.id)!;
    return (
      <div className="cad-inspector" key={key}>
        <CommitInput
          label="Name"
          value={f.name}
          onCommit={(name) => void controller.run({ type: 'rename', targetId: f.id, name })}
        />
        <p className="cad-muted">Type: {f.type}</p>
        {!readOnly && <FeatureArgs feature={f} doc={doc} controller={controller} />}
        {f.type === 'boolean' && (
          <BooleanTools feature={f} snapshot={snapshot} controller={controller} />
        )}
        <ReferenceList feature={f} snapshot={snapshot} controller={controller} />
      </div>
    );
  }
  const body = doc.bodies.find((b) => b.id === selection.id)!;
  // Measurements need the document's exact build: a reference evaluation shows none.
  const reference = evaluation?.status === 'ok' && evaluation.reference;
  const metrics = reference ? undefined : bodyMetrics(evaluation, body.id);
  const placement = placementOf(doc, body);
  const at =
    placement?.type === 'transform'
      ? resolvePosition(placement.args.translation, parameterValues(doc))
      : [0, 0, 0];
  const movable = !readOnly && controller.isMovable(body);
  const others = doc.bodies.filter((b) => b.state === 'active' && b.id !== body.id);
  return (
    <div className="cad-inspector" key={key}>
      <CommitInput
        label="Name"
        value={body.name}
        onCommit={(name) => void controller.run({ type: 'rename', targetId: body.id, name })}
      />
      <Section title="Placement">
        {(['X', 'Y', 'Z'] as const).map((axis, i) =>
          movable ? (
            <CommitInput
              key={axis}
              label={`${axis} (mm)`}
              type="number"
              step={1}
              value={at[i]}
              onCommit={(v) =>
                void controller.moveBody(
                  body,
                  at.map((x, j) => (j === i ? Number(v) : x)) as [number, number, number],
                )
              }
            />
          ) : (
            <div className="cad-readonly-field" key={axis}>
              <span>{axis}</span>
              <output>{fmt(at[i])} mm</output>
            </div>
          ),
        )}
      </Section>
      <Section title="Measurements">
        {metrics ? (
          <dl className="cad-metrics">
            {metrics.kind === 'solid' ? (
              <>
                <dt>Volume</dt>
                <dd>{fmtQuantity(metrics.volumeMm3, 'mm³')}</dd>
                {metrics.solids ? (
                  <>
                    <dt>Solids</dt>
                    <dd data-testid="cad-body-solids">
                      {fmtGrouped(metrics.solids, 0)} disjoint solids (totals over all)
                    </dd>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <dt>Kind</dt>
                <dd>Surface (no volume)</dd>
                <dt>Open edges</dt>
                <dd>
                  {metrics.freeEdges}, {fmtQuantity(metrics.freeEdgeLengthMm, 'mm')}
                </dd>
              </>
            )}
            <dt>Area</dt>
            <dd>{fmtQuantity(metrics.areaMm2, 'mm²')}</dd>
            <dt>Size</dt>
            <dd>
              {metrics.bounds[1]
                .map((max, i) => fmtGrouped(max - metrics.bounds[0][i], 2))
                .join(' × ')}{' '}
              mm
            </dd>
          </dl>
        ) : reference ? (
          <p className="cad-muted">
            Not available on a reference display: measurements need this document&apos;s own kernel
            build.
          </p>
        ) : (
          <p className="cad-muted">Available after the shape is calculated.</p>
        )}
      </Section>
      {!readOnly && body.state === 'active' && (
        <Section title="Combine">
          <label className="ep-field">
            With body
            <select value={tool} onChange={(e) => setTool(e.target.value)}>
              <option value="">Choose…</option>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <div className="cad-row">
            {(['union', 'cut', 'common'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!tool || snapshot.busy}
                onClick={() => void controller.combine(body.id, tool, mode).then(() => setTool(''))}
              >
                {mode === 'union' ? 'Union' : mode === 'cut' ? 'Cut' : 'Intersect'}
              </button>
            ))}
          </div>
        </Section>
      )}
      {!readOnly && body.state === 'active' && body.kind === 'sheet' && (
        <SheetSection
          body={body}
          others={others}
          doc={doc}
          snapshot={snapshot}
          controller={controller}
        />
      )}
      {!readOnly && body.state === 'active' && others.length > 0 && (
        <PatternSection body={body} others={others} snapshot={snapshot} controller={controller} />
      )}
      {!readOnly && body.state === 'active' && (
        <button
          type="button"
          disabled={snapshot.busy}
          onClick={() => void controller.duplicateBody(body.id)}
        >
          <Copy size={16} aria-hidden="true" /> Duplicate body
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          className="cad-danger"
          onClick={() =>
            void controller.run({ type: 'deleteClosure', ids: [body.id], cascade: false })
          }
        >
          <Trash2 size={16} aria-hidden="true" /> Delete body
        </button>
      )}
    </div>
  );
}

const axes: Record<string, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const trimSideLabels = {
  inside: 'Inside the curve',
  outside: 'Outside the curve',
  front: 'In front (the normal side)',
  back: 'Behind',
} as const;

/**
 * A sheet body's surface operations (R2a-3, docs/cad/r2a-freeform.md): sew other sheets into it
 * (a solid when they close), trim it with a sketch's closed chain, a plane or another sheet, and
 * thicken it into a solid.
 */
function SheetSection({
  body,
  others,
  doc,
  snapshot,
  controller,
}: {
  body: CadBody;
  others: CadBody[];
  doc: CadDocument;
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const sheets = others.filter((b) => b.kind === 'sheet');
  const [sewn, setSewn] = useState<string[]>([]);
  const [solid, setSolid] = useState(false);
  const [tool, setTool] = useState('');
  const [keep, setKeep] = useState<keyof typeof trimSideLabels>('outside');
  const [offset, setOffset] = useState('0');
  const [thickness, setThickness] = useState('1');
  const [side, setSide] = useState<'front' | 'back' | 'both'>('front');
  const byCurve = tool.startsWith('sketch:');
  const sides = byCurve ? (['inside', 'outside'] as const) : (['front', 'back'] as const);
  const kept = (sides as readonly string[]).includes(keep) ? keep : sides[0];
  const trim = () => {
    const [kind, id] = [tool.slice(0, tool.indexOf(':')), tool.slice(tool.indexOf(':') + 1)];
    const at = Number(offset);
    const made =
      kind === 'sketch'
        ? { sketchId: id }
        : kind === 'body'
          ? { bodyId: id }
          : {
              plane: {
                origin: axes[id]!.map((x) => x * at) as Vec3,
                normal: axes[id]!,
              },
            };
    void controller.trimBody(body, made, kept).then((ok) => ok && setTool(''));
  };
  const t = Number(thickness);
  return (
    <>
      <Section title="Sew" open={false}>
        {sheets.length ? (
          <ul aria-label="Sheets to sew">
            {sheets.map((b) => (
              <li key={b.id}>
                <label className="cad-check">
                  <input
                    type="checkbox"
                    checked={sewn.includes(b.id)}
                    onChange={(e) =>
                      setSewn((x) =>
                        e.target.checked ? [...x, b.id] : x.filter((y) => y !== b.id),
                      )
                    }
                  />
                  {b.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="cad-muted">No other surface body to sew.</p>
        )}
        <label className="cad-check">
          <input type="checkbox" checked={solid} onChange={(e) => setSolid(e.target.checked)} />
          Close into a solid
        </label>
        <p className="cad-muted">Edges within 0.0001 mm join.</p>
        <button
          type="button"
          disabled={!sewn.length || snapshot.busy}
          onClick={() =>
            void controller.sewBodies(body.id, sewn, solid).then((ok) => ok && setSewn([]))
          }
        >
          Sew
        </button>
      </Section>
      <Section title="Trim" open={false}>
        <label className="ep-field">
          Cut with
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">Choose…</option>
            {doc.sketches.map((s) => (
              <option key={s.id} value={`sketch:${s.id}`}>
                Sketch {s.name} (along its normal)
              </option>
            ))}
            {(['x', 'y', 'z'] as const).map((a) => (
              <option key={a} value={`plane:${a}`}>
                Plane normal to {a.toUpperCase()}
              </option>
            ))}
            {sheets.map((b) => (
              <option key={b.id} value={`body:${b.id}`}>
                Surface {b.name}
              </option>
            ))}
          </select>
        </label>
        {tool.startsWith('plane:') && (
          <CommitInput
            label={`At ${tool.slice(6).toUpperCase()} (mm)`}
            type="number"
            step={1}
            value={offset}
            onCommit={setOffset}
          />
        )}
        <label className="ep-field">
          Keep
          <select value={kept} onChange={(e) => setKeep(e.target.value as typeof keep)}>
            {sides.map((x) => (
              <option key={x} value={x}>
                {trimSideLabels[x]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!tool || snapshot.busy} onClick={trim}>
          Trim
        </button>
      </Section>
      <Section title="Thicken" open={false}>
        <CommitInput
          label="Thickness (mm)"
          type="number"
          step={0.5}
          value={thickness}
          onCommit={setThickness}
        />
        <label className="ep-field">
          Towards
          <select value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
            <option value="front">The front (its normal)</option>
            <option value="back">The back</option>
            <option value="both">Both sides, half each</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!(t > 0) || snapshot.busy}
          onClick={() => void controller.thickenBody(body, t, side)}
        >
          Thicken
        </button>
      </Section>
    </>
  );
}

/**
 * `count` copies of another body Booleaned into this one at once (r1-modeling.md, 詳細feature):
 * in a row along an axis, or round an axis through this body's centre. Spacing, count and angle
 * are edited on the pattern feature afterwards.
 */
function PatternSection({
  body,
  others,
  snapshot,
  controller,
}: {
  body: CadBody;
  others: CadBody[];
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const [tool, setTool] = useState('');
  const [layout, setLayout] = useState('x');
  const [count, setCount] = useState('3');
  const [step, setStep] = useState('10');
  const [align, setAlign] = useState(true);
  const circular = layout === 'circle';
  // K5a: along the open chain a sketch draws.
  const path = layout.startsWith('path:') ? layout.slice(5) : undefined;
  const paths = snapshot.content.sketches.filter((s) => sketchDefaultPath(s));
  const n = Number(count);
  const by = Number(step);
  const valid =
    Number.isInteger(n) && n >= 1 && n <= 1000 && (!!path || (Number.isFinite(by) && by !== 0));
  const centre = () => {
    const e = snapshot.evaluation;
    const b = e?.status === 'ok' && e.reference ? undefined : bodyMetrics(e, body.id);
    return b ? b.bounds[0].map((min, i) => (min + b.bounds[1][i]!) / 2) : [0, 0, 0];
  };
  const make = (mode: 'union' | 'cut') => {
    if (path) {
      const along = { type: 'curve' as const, sketchId: path, count: { literal: n }, align };
      return void controller.pattern(body.id, tool, mode, along).then((ok) => ok && setTool(''));
    }
    const l: CadPatternLayout = circular
      ? {
          type: 'circular',
          axisOrigin: position(...(centre() as [number, number, number])),
          axisDirection: [0, 0, 1],
          count: { literal: n },
          angle: { literalRad: (by * Math.PI) / 180 },
        }
      : { type: 'linear', direction: axes[layout]!, count: { literal: n }, spacing: mm(by) };
    void controller.pattern(body.id, tool, mode, l).then((ok) => ok && setTool(''));
  };
  return (
    <Section title="Pattern" open={false}>
      <label className="ep-field">
        Copies of
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="">Choose…</option>
          {others.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ep-field">
        Layout
        <select value={layout} onChange={(e) => setLayout(e.target.value)}>
          <option value="x">Row along X</option>
          <option value="y">Row along Y</option>
          <option value="z">Row along Z</option>
          <option value="circle">Circle about Z</option>
          {paths.map((s) => (
            <option key={s.id} value={`path:${s.id}`}>
              Along {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="ep-field">
        Count
        <input
          type="number"
          min={1}
          max={1000}
          step={1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </label>
      {path ? (
        <label className="cad-check">
          <input type="checkbox" checked={align} onChange={(e) => setAlign(e.target.checked)} />
          Turn each copy with the path
        </label>
      ) : (
        <label className="ep-field">
          {circular ? 'Step angle (°)' : 'Spacing (mm)'}
          <input type="number" value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
      )}
      <div className="cad-row">
        <button
          type="button"
          disabled={!tool || !valid || snapshot.busy}
          onClick={() => make('cut')}
        >
          Pattern cut
        </button>
        <button
          type="button"
          disabled={!tool || !valid || snapshot.busy}
          onClick={() => make('union')}
        >
          Pattern union
        </button>
      </div>
    </Section>
  );
}

/** A positive number typed into a local field (not yet an edit). */
function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ep-field">
      {label}
      <input type="number" min={0} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
const positive = (text: string) => Number.isFinite(Number(text)) && Number(text) > 0;

/**
 * A picked face or edge: its persistent name and whether a reference could pick it again
 * (docs/cad/r1-modeling.md, 命名・分かれた要素の選び直し), and the detail features that start
 * from it. Nothing is stored until one of those is added (one edit each).
 */
function TopologyInspector({
  snapshot,
  controller,
}: {
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const [size, setSize] = useState('1');
  const [wall, setWall] = useState('2');
  const [angle, setAngle] = useState('3');
  const info = snapshot.topology;
  if (!info) return <p className="cad-muted">The picked element is no longer shown.</p>;
  const body = snapshot.content.bodies.find((b) => b.id === info.bodyId);
  const noun = info.kind === 'face' ? 'face' : 'edge';
  const plural = info.kind === 'face' ? 'faces' : 'edges';
  const referable = info.select !== 'unnamed' && info.select !== 'symmetric';
  const editable =
    referable &&
    !snapshot.readOnly &&
    body?.state === 'active' &&
    snapshot.meshes?.current === true &&
    !snapshot.busy;
  return (
    <div className="cad-inspector" data-testid="cad-topology">
      <p className="cad-muted">
        {info.kind === 'face' ? 'Face' : 'Edge'} of {body?.name ?? info.bodyId}
      </p>
      <dl className="cad-metrics">
        <dt>Name</dt>
        <dd data-testid="cad-topology-name">{info.name ? formatTopoName(info.name) : '—'}</dd>
        <dt>{info.kind === 'face' ? 'Area' : 'Length'}</dt>
        <dd>{fmtQuantity(info.size, info.kind === 'face' ? 'mm²' : 'mm')}</dd>
      </dl>
      <p className="cad-muted" data-testid="cad-topology-status">
        {info.select === 'unnamed'
          ? `This ${noun} has no persistent name (an imported body's), so it cannot be referenced.`
          : info.select === 'symmetric'
            ? `${info.sameName} ${plural} share this name and their neighbours' names, so this one cannot be referenced on its own.`
            : info.select
              ? `${info.sameName} ${plural} share this name. A reference to this one also records the neighbouring ${info.select.adjacent.map(formatTopoName).join(', ')}.`
              : `This name identifies one ${noun}.`}
      </p>
      {referable && !snapshot.readOnly && body?.state === 'active' && info.kind === 'edge' && (
        <Section title="Round or bevel this edge">
          <NumberField label="Size (mm)" value={size} onChange={setSize} />
          <div className="cad-row">
            <button
              type="button"
              disabled={!editable || !positive(size)}
              onClick={() => void controller.blendPickedEdge('fillet', Number(size))}
            >
              Fillet
            </button>
            <button
              type="button"
              disabled={!editable || !positive(size)}
              onClick={() => void controller.blendPickedEdge('chamfer', Number(size))}
            >
              Chamfer
            </button>
          </div>
        </Section>
      )}
      {referable && !snapshot.readOnly && body?.state === 'active' && info.kind === 'edge' && (
        <Section title="Use this edge for a surface">
          <p className="cad-muted" data-testid="cad-collected-edges">
            {snapshot.collectedEdges.length
              ? `${snapshot.collectedEdges.length} edges collected for Boundary… and Loft….`
              : 'Collect edges in loop order for a boundary surface, a fill or a loft section.'}
          </p>
          <div className="cad-row">
            <button
              type="button"
              disabled={!editable}
              onClick={() => void controller.collectPickedEdge()}
            >
              Collect edge
            </button>
            <button
              type="button"
              disabled={!snapshot.collectedEdges.length}
              onClick={() => controller.clearCollectedEdges()}
            >
              Clear
            </button>
          </div>
        </Section>
      )}
      {info.kind === 'edge' && body?.state === 'active' && !snapshot.reference && (
        <>
          <ContinuitySection controller={controller} snapshot={snapshot} />
          <CombSection controller={controller} snapshot={snapshot} />
        </>
      )}
      {referable && !snapshot.readOnly && body?.state === 'active' && info.kind === 'face' && (
        <>
          <Section title="Shell from this face">
            <NumberField label="Wall (mm)" value={wall} onChange={setWall} />
            <button
              type="button"
              disabled={!editable || !positive(wall)}
              onClick={() => void controller.shellPickedFace(Number(wall))}
            >
              Shell, this face open
            </button>
          </Section>
          {info.normal ? (
            <>
              <Section title="Draft from this face">
                <NumberField label="Angle (°)" value={angle} onChange={setAngle} />
                <button
                  type="button"
                  disabled={!editable || !positive(angle) || Number(angle) > 45}
                  onClick={() => void controller.draftFromPickedFace(Number(angle))}
                >
                  Draft the faces around it
                </button>
              </Section>
              <Section title="Mirror in this face">
                <div className="cad-row">
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() => void controller.mirrorInPickedFace(true)}
                  >
                    Mirror and join
                  </button>
                </div>
              </Section>
            </>
          ) : (
            <p className="cad-muted">
              Draft and mirror start from a planar face: this one is curved.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Choosing broken references again (r1-modeling.md, 分かれた要素の選び直し): each broken
 * reference shows its candidates in turn on a preview of the shape with that choice; Confirm
 * applies the choice (and the edit that broke it) as one edit, Cancel leaves everything as it was.
 */
function RebindPanel({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const rebind = snapshot.rebind;
  if (!rebind) return null;
  return (
    <section className="cad-rebind" aria-label="Choose references again" data-testid="cad-rebind">
      <strong>Choose references again</strong>
      <p className="cad-muted">
        {rebind.withEdit
          ? `This change breaks references of 「${rebind.featureName}」. Choose what each one should point at; the change and the choice are one edit.`
          : `The references of 「${rebind.featureName}」 no longer point at one element. Choose what each one should point at.`}
      </p>
      <ol className="cad-rebind-list">
        {rebind.problems.map((p, i) => {
          const selectable = p.candidates.flatMap((c, j) => (c.selectable ? [j] : []));
          const at = selectable.indexOf(p.choice);
          const step = (by: number) =>
            controller.chooseRebind(
              i,
              selectable[(at + by + selectable.length) % selectable.length]!,
            );
          const hint = p.choice >= 0 ? p.candidates[p.choice]!.hint : undefined;
          return (
            <li key={JSON.stringify(p.path)}>
              <span className="cad-reference-name">
                {p.name ? formatTopoName(p.name) : p.path.join('.')}
              </span>
              <span className={`cad-reference-state cad-reference-${p.status}`}>
                {p.status === 'ambiguous' ? 'Ambiguous' : 'Missing'}
              </span>
              {selectable.length ? (
                <div className="cad-rebind-choice" role="group" aria-label="Candidates">
                  <output data-testid="cad-rebind-candidate">
                    Candidate {at + 1} of {selectable.length}
                    {hint ? ` at (${hint.centroid.map((c) => fmt(c, 1)).join(', ')})` : ''}
                  </output>
                  <div className="cad-row">
                    <button
                      type="button"
                      aria-label="Previous candidate"
                      disabled={selectable.length < 2}
                      onClick={() => step(-1)}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      aria-label="Next candidate"
                      disabled={selectable.length < 2}
                      onClick={() => step(1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              ) : (
                <p className="cad-muted">
                  {p.status === 'missing'
                    ? 'The element it pointed at is gone.'
                    : 'Its candidates cannot be told apart by their neighbours.'}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {rebind.message && (
        <p className="cad-muted" role="status">
          {rebind.message}
        </p>
      )}
      <div className="cad-row">
        <button
          type="button"
          disabled={rebind.status !== 'ready'}
          onClick={() => controller.confirmRebind()}
        >
          {rebind.status === 'evaluating' ? 'Calculating…' : 'Confirm'}
        </button>
        {rebind.canGoBack && (
          <button type="button" onClick={() => controller.backRebind()}>
            Back
          </button>
        )}
        <button type="button" onClick={() => controller.cancelRebind()}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** A boundary curve as the editor reads it: the sketch and element, or the edge's name. */
function curveLabel(doc: CadDocument, c: CadCurveSource) {
  if ('edge' in c) return formatTopoName(c.edge.name);
  return `${doc.sketches.find((s) => s.id === c.sketchId)?.name ?? c.sketchId} ${c.element}`;
}

/** Chooses the sections of a new loft, in order, and whether it is ruled (R1e). */
function LoftDialog({
  controller,
  doc,
  edges,
  onClose,
}: {
  controller: CadController;
  doc: CadDocument;
  edges: CadCollectedEdge[];
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [ruled, setRuled] = useState(false);
  const [surface, setSurface] = useState(false);
  // The collected edges are one more section of a surface loft (R2a-2c).
  const collected = '#edges';
  const sections = [
    ...doc.sketches.map((s) => ({ id: s.id, name: s.name })),
    ...(surface && edges.length
      ? [{ id: collected, name: `Collected edges (${edges.length})` }]
      : []),
  ];
  const picked = chosen.filter((id) => sections.some((x) => x.id === id));
  // K6: sections derived from section 1, after the chosen ones (offset along its normal, scale).
  const [derived, setDerived] = useState<{ offsetMm: number; scale: number }[]>([]);
  const derivable = !surface && picked.length > 0 && picked[0] !== collected;
  const total = picked.length + (derivable ? derived.length : 0);
  return (
    <Dialog title="Loft" onClose={onClose}>
      <div className="cad-export">
        <p>Choose the sections in the order the loft passes through them.</p>
        <SurfaceChoice surface={surface} onChange={setSurface} />
        <ol className="cad-loft-sections" aria-label="Sketches">
          {sections.map((s) => {
            const at = picked.indexOf(s.id);
            return (
              <li key={s.id}>
                <label className="cad-check">
                  <input
                    type="checkbox"
                    checked={at >= 0}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id),
                      )
                    }
                  />
                  {s.name}
                  {at >= 0 && <small> (section {at + 1})</small>}
                </label>
              </li>
            );
          })}
        </ol>
        {derivable && (
          <ol className="cad-loft-sections" aria-label="Derived sections" start={picked.length + 1}>
            {derived.map((d, i) => (
              <li key={i}>
                <span>From section 1:</span>
                <label className="ep-field">
                  <span>Offset (mm)</span>
                  <input
                    type="number"
                    value={d.offsetMm}
                    onChange={(e) =>
                      setDerived((all) =>
                        all.map((x, j) =>
                          j === i ? { ...x, offsetMm: Number(e.target.value) } : x,
                        ),
                      )
                    }
                  />
                </label>
                <label className="ep-field">
                  <span>Scale</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.001}
                    value={d.scale}
                    onChange={(e) =>
                      setDerived((all) =>
                        all.map((x, j) => (j === i ? { ...x, scale: Number(e.target.value) } : x)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setDerived((all) => all.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ol>
        )}
        {derivable && (
          <button
            type="button"
            title="A copy of section 1 moved along its normal and scaled; it follows section 1's sketch"
            onClick={() =>
              setDerived((all) => [...all, { offsetMm: 100 * (all.length + 1), scale: 1 }])
            }
          >
            Add derived section
          </button>
        )}
        <label className="cad-check">
          <input type="checkbox" checked={ruled} onChange={(e) => setRuled(e.target.checked)} />
          Ruled (straight between sections)
        </label>
        <div className="cad-row">
          <button
            type="button"
            disabled={total < 2}
            onClick={async () => {
              const order = [
                ...picked.map((id) => (id === collected ? { edges: edges.map((e) => e.ref) } : id)),
                ...(derivable ? derived.map((d) => ({ derivedFrom: 0, ...d })) : []),
              ];
              if (await controller.addLoft(order, ruled, surface)) onClose();
            }}
          >
            Create loft
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Chooses a boundary surface (3 or 4 curves) or a fill (3 to 16) and its curves in loop order:
 * sketch lines, arcs and open splines, and the edges collected from picks (R2a-2c). A fill
 * meets the face beside a collected free edge G1 when asked.
 */
function BoundaryDialog({
  controller,
  doc,
  edges,
  onClose,
}: {
  controller: CadController;
  doc: CadDocument;
  edges: CadCollectedEdge[];
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'boundarySurface' | 'fill'>('boundarySurface');
  const [chosen, setChosen] = useState<string[]>([]);
  const [tangent, setTangent] = useState<Set<string>>(new Set());
  const options = new Map<string, { label: string; curve: CadCurveSource; free?: boolean }>();
  edges.forEach((e, i) =>
    options.set(`edge:${i}`, { label: e.label, curve: { edge: e.ref }, free: e.free }),
  );
  for (const sketch of doc.sketches)
    for (const x of sketch.entities) {
      const e = sketchElement(sketch, x.id);
      if (!e || e.ends.length !== 2 || ('construction' in x && x.construction)) continue;
      options.set(`${sketch.id}/${x.id}`, {
        label: `${sketch.name} ${x.id}`,
        curve: { sketchId: sketch.id, element: x.id },
      });
    }
  const [min, max] = cadBoundaryCurves[kind === 'fill' ? 'fill' : 'surface'];
  return (
    <Dialog title="Boundary" onClose={onClose}>
      <div className="cad-export">
        <p>
          Choose the curves in the order they go round the loop. Pick an edge of a body and collect
          it in the Inspector to use it here.
        </p>
        <label className="ep-field">
          Result
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as 'boundarySurface' | 'fill')}
          >
            <option value="boundarySurface">Boundary surface (3 or 4 curves)</option>
            <option value="fill">Fill (3 to 16 curves)</option>
          </select>
        </label>
        <ol className="cad-loft-sections" aria-label="Curves">
          {[...options].map(([key, o]) => {
            const at = chosen.indexOf(key);
            return (
              <li key={key}>
                <label className="cad-check">
                  <input
                    type="checkbox"
                    checked={at >= 0}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked ? [...c, key] : c.filter((x) => x !== key),
                      )
                    }
                  />
                  {o.label}
                  {at >= 0 && <small> (curve {at + 1})</small>}
                </label>
                {kind === 'fill' && at >= 0 && o.free && (
                  <label className="cad-check">
                    <input
                      type="checkbox"
                      checked={tangent.has(key)}
                      onChange={(e) =>
                        setTangent((t) => {
                          const next = new Set(t);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    Tangent to its face (G1)
                  </label>
                )}
              </li>
            );
          })}
        </ol>
        <div className="cad-row">
          <button
            type="button"
            disabled={chosen.length < min || chosen.length > max}
            onClick={async () => {
              const curves = chosen.map((key) => ({
                curve: options.get(key)!.curve,
                continuity: kind === 'fill' && tangent.has(key) ? ('G1' as const) : ('G0' as const),
              }));
              if (await controller.addBoundary(kind, curves)) onClose();
            }}
          >
            Create {kind === 'fill' ? 'fill' : 'boundary surface'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** Chooses the profile and path sketches of a new sweep and its orientation (R1e). */
function SweepDialog({
  controller,
  doc,
  onClose,
}: {
  controller: CadController;
  doc: CadDocument;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState(doc.sketches[0]?.id ?? '');
  const [path, setPath] = useState(doc.sketches[1]?.id ?? '');
  const [orientation, setOrientation] = useState<'frenet' | 'fixed'>('frenet');
  const [surface, setSurface] = useState(false);
  const options = doc.sketches.map((s) => (
    <option key={s.id} value={s.id}>
      {s.name}
    </option>
  ));
  return (
    <Dialog title="Sweep" onClose={onClose}>
      <div className="cad-export">
        <p>
          The profile's closed region (or, for a surface, its chain) is carried along the open chain
          the path sketch draws, from where the profile is.
        </p>
        <SurfaceChoice surface={surface} onChange={setSurface} />
        <label className="ep-field">
          Profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {options}
          </select>
        </label>
        <label className="ep-field">
          Path
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            {options}
          </select>
        </label>
        <label className="ep-field">
          Orientation
          <select
            value={orientation}
            onChange={(e) => setOrientation(e.target.value as 'frenet' | 'fixed')}
          >
            <option value="frenet">Follow the path (Frenet)</option>
            <option value="fixed">Fixed</option>
          </select>
        </label>
        <div className="cad-row">
          <button
            type="button"
            disabled={!profile || !path || profile === path}
            onClick={async () => {
              if (await controller.addSweep(profile, path, orientation, surface)) onClose();
            }}
          >
            Create sweep
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Whether a loft or sweep makes a solid from closed regions or a surface without volume from
 * each sketch's chain, open or one loop (R2a-2b).
 */
function SurfaceChoice({
  surface,
  onChange,
}: {
  surface: boolean;
  onChange: (surface: boolean) => void;
}) {
  return (
    <label className="ep-field">
      Result
      <select
        value={surface ? 'surface' : 'solid'}
        onChange={(e) => onChange(e.target.value === 'surface')}
      >
        <option value="solid">Solid (closed regions)</option>
        <option value="surface">Surface (chains, open or closed)</option>
      </select>
    </label>
  );
}

/** A sheet from one sketch's chain of lines and arcs (R2a-1). */
function SurfaceDialog({
  controller,
  doc,
  onClose,
}: {
  controller: CadController;
  doc: CadDocument;
  onClose: () => void;
}) {
  const [sketch, setSketch] = useState(doc.sketches[0]?.id ?? '');
  const [type, setType] = useState<'extrude' | 'revolve'>('extrude');
  const [distance, setDistance] = useState('20');
  const [angle, setAngle] = useState('360');
  const value = Number(type === 'extrude' ? distance : angle);
  return (
    <Dialog title="Surface" onClose={onClose}>
      <div className="cad-export">
        <p>
          A surface without volume from the sketch's open chain (or one loop) of lines and arcs:
          carried along the sketch normal, or turned about the sketch's vertical axis.
        </p>
        <label className="ep-field">
          Sketch
          <select value={sketch} onChange={(e) => setSketch(e.target.value)}>
            {doc.sketches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ep-field">
          Shape
          <select value={type} onChange={(e) => setType(e.target.value as 'extrude' | 'revolve')}>
            <option value="extrude">Extrude</option>
            <option value="revolve">Revolve</option>
          </select>
        </label>
        {type === 'extrude' ? (
          <label className="ep-field">
            Distance (mm)
            <input
              inputMode="decimal"
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
            />
          </label>
        ) : (
          <label className="ep-field">
            Angle (°)
            <input inputMode="decimal" value={angle} onChange={(e) => setAngle(e.target.value)} />
          </label>
        )}
        <div className="cad-row">
          <button
            type="button"
            disabled={!sketch || !(value > 0)}
            onClick={async () => {
              const made = await controller.addSurface(
                sketch,
                type === 'extrude'
                  ? { type, distance: value }
                  : { type, angleRad: (value * Math.PI) / 180 },
              );
              if (made) onClose();
            }}
          >
            Create surface
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Each active body with the features its result reads, in evaluation order; a Boolean shows the
 * tool bodies it consumed, with their features (U5). Selecting an entry selects it as the lists do.
 */
function ModelTree({
  doc,
  item,
}: {
  doc: CadDocument;
  item: (kind: 'body' | 'feature', id: string, label: string, extra?: string) => ReactNode;
}) {
  const nodes = (list: CadTreeNode[]): ReactNode[] =>
    list.map((n) =>
      n.kind === 'body' ? (
        <Fragment key={`body:${n.body.id}`}>
          {n.body.state === 'active' ? (
            item('body', n.body.id, n.body.name, 'body')
          ) : (
            <li className="cad-muted">{n.body.name} (tool)</li>
          )}
          <li>
            <ul aria-label={`${n.body.name} features`}>{nodes(n.children)}</ul>
          </li>
        </Fragment>
      ) : (
        <Fragment key={`feature:${n.feature.id}`}>
          {item('feature', n.feature.id, n.feature.name, n.feature.type)}
          {n.tools.length > 0 && (
            <li>
              <ul aria-label={`${n.feature.name} tools`}>{nodes(n.tools)}</ul>
            </li>
          )}
        </Fragment>
      ),
    );
  return (
    <ul aria-label="Model tree" className="cad-tree">
      {nodes(modelTree(doc))}
    </ul>
  );
}

function Navigator({
  controller,
  snapshot,
  narrow,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  narrow: boolean;
}) {
  const { content: doc, selection } = snapshot;
  // Sketching is desktop work: on a narrow root the entries stay, disabled, with the reason.
  const sketchReason = narrow
    ? 'Sketching needs a wider window (over 800 px). Sketches can still be viewed here.'
    : undefined;
  const canSketch = snapshot.canSketch && !narrow;
  // Sketch mode replaces the Inspector: its buffered fields are committed first, and one that
  // does not commit keeps the Inspector (and its text) in place.
  const inputs = useContext(EditorInputsContext);
  const enterSketch = (start: () => unknown) => {
    try {
      inputs?.flush({ keepEditor: true });
    } catch (error) {
      return controller.report(error instanceof Error ? error.message : String(error));
    }
    start();
  };
  const onFace = snapshot.topology?.kind === 'face' && !!snapshot.topology.normal;
  const [making, setMaking] = useState<'loft' | 'sweep' | 'surface' | 'boundary'>();
  const item = (
    kind: 'body' | 'feature' | 'parameter',
    id: string,
    label: string,
    extra?: string,
  ) => (
    <li key={id}>
      <button
        type="button"
        className="cad-item"
        aria-pressed={selection?.kind === kind && selection.id === id}
        onClick={() => controller.select({ kind, id })}
      >
        {label}
        {extra && <small>{extra}</small>}
      </button>
    </li>
  );
  const active = doc.bodies.filter((b) => b.state === 'active');
  const values = parameterValues(doc);
  return (
    <nav className="cad-navigator" aria-label="CAD elements">
      <Section title={`Bodies (${active.length})`}>
        <ul aria-label="Bodies">{active.map((b) => item('body', b.id, b.name))}</ul>
      </Section>
      <Section title="Model tree" open={false}>
        <ModelTree doc={doc} item={item} />
      </Section>
      <Section title={`Parameters (${doc.parameters.length})`}>
        <ul aria-label="Parameters">
          {doc.parameters.map((p) =>
            item(
              'parameter',
              p.id,
              p.name,
              `${fmt(values.get(p.id)?.value ?? NaN)}${parameterUnit(p.type)}`,
            ),
          )}
        </ul>
        {!snapshot.readOnly && (
          <div className="cad-row" role="group" aria-label="Add parameter">
            {(['length', 'angle', 'count'] as CadParameterType[]).map((type) => (
              <button
                key={type}
                type="button"
                disabled={snapshot.busy || doc.parameters.length >= cadLimits.parameters}
                onClick={() => void controller.addParameter(type)}
              >
                Add {type}
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title={`Sketches (${doc.sketches.length})`}>
        <ul aria-label="Sketches">
          {doc.sketches.map((s) => (
            <li key={s.id} className="cad-row">
              <span>{s.name}</span>
              {!snapshot.readOnly && (
                <button
                  type="button"
                  data-sketch-entry
                  aria-label={`Edit sketch ${s.name}`}
                  title={sketchReason}
                  disabled={!canSketch}
                  onClick={() => enterSketch(() => controller.editSketch(s.id))}
                >
                  Edit
                </button>
              )}
            </li>
          ))}
        </ul>
        {!snapshot.readOnly && (
          <>
            <div className="cad-row" role="group" aria-label="New sketch">
              {(['xy', 'xz', 'yz'] as const).map((plane) => (
                <button
                  key={plane}
                  type="button"
                  data-sketch-entry
                  title={sketchReason}
                  disabled={!canSketch}
                  onClick={() => enterSketch(() => controller.startSketch(plane))}
                >
                  Sketch on {plane.toUpperCase()}
                </button>
              ))}
              <button
                type="button"
                data-sketch-entry
                title={sketchReason ?? (onFace ? undefined : 'Pick a planar face first')}
                disabled={!canSketch || !onFace}
                onClick={() => enterSketch(() => controller.startSketchOnPickedFace())}
              >
                Sketch on face
              </button>
            </div>
            {sketchReason && (
              <p className="cad-muted" data-testid="cad-sketch-narrow">
                {sketchReason}
              </p>
            )}
            <div className="cad-row" role="group" aria-label="From sketches">
              <button
                type="button"
                disabled={snapshot.busy || !!snapshot.sketch || doc.sketches.length < 2}
                onClick={() => setMaking('loft')}
              >
                Loft…
              </button>
              <button
                type="button"
                disabled={snapshot.busy || !!snapshot.sketch || doc.sketches.length < 2}
                onClick={() => setMaking('sweep')}
              >
                Sweep…
              </button>
              <button
                type="button"
                disabled={snapshot.busy || !!snapshot.sketch || !doc.sketches.length}
                onClick={() => setMaking('surface')}
              >
                Surface…
              </button>
              <button
                type="button"
                disabled={
                  snapshot.busy ||
                  !!snapshot.sketch ||
                  (!doc.sketches.length && !snapshot.collectedEdges.length)
                }
                onClick={() => setMaking('boundary')}
              >
                Boundary…
              </button>
            </div>
          </>
        )}
        {making === 'loft' && (
          <LoftDialog
            controller={controller}
            doc={doc}
            edges={snapshot.collectedEdges}
            onClose={() => setMaking(undefined)}
          />
        )}
        {making === 'sweep' && (
          <SweepDialog controller={controller} doc={doc} onClose={() => setMaking(undefined)} />
        )}
        {making === 'surface' && (
          <SurfaceDialog controller={controller} doc={doc} onClose={() => setMaking(undefined)} />
        )}
        {making === 'boundary' && (
          <BoundaryDialog
            controller={controller}
            doc={doc}
            edges={snapshot.collectedEdges}
            onClose={() => setMaking(undefined)}
          />
        )}
      </Section>
      <Section title={`History (${doc.features.length})`} open={false}>
        <ol aria-label="Feature history">
          {doc.features.map((f) => item('feature', f.id, f.name, f.type))}
        </ol>
      </Section>
      <PartPropertiesSection controller={controller} snapshot={snapshot} />
    </nav>
  );
}

/** The Surface that window-level shortcuts belong to when focus is outside every Surface. */
let activeSurface: HTMLElement | null = null;

/** CAD Surface. All edits go through the controller's prepare → apply boundary. */
const stlDeflections = [
  { mm: 0.05, label: 'Standard (0.05 mm)' },
  { mm: 0.01, label: 'Fine (0.01 mm)' },
  // Large models (a 38 m airliner): the standard chord error takes longer than an export may.
  { mm: 1, label: 'Coarse (1 mm, large models)' },
];
/**
 * STL (millimetres, chosen triangulation) or GLB (display mesh, metres, Y-up) of the confirmed
 * shape, or STEP. An assembly is written as STEP AP242 only (R2b-5): its products and instances.
 * The file is prepared first and its report shown; saving is a separate step.
 */
function ExportFileDialog({
  controller,
  assembly,
  name,
  guard,
  onExportFile,
  onClose,
}: {
  controller: CadController;
  assembly: CadAssembly | undefined;
  name: string;
  guard: ((options?: { keepEditor?: boolean }) => void) | undefined;
  onExportFile: CadSurfaceProps['onExportFile'];
  onClose(): void;
}) {
  const components = useSyncExternalStore(
    controller.subscribe,
    () => controller.getSnapshot().content.components.length,
  );
  const placing = components > 0;
  const [format, setFormat] = useState<'stl' | 'glb' | 'step'>(placing ? 'step' : 'stl');
  const [deflectionMm, setDeflectionMm] = useState(stlDeflections[0].mm);
  const [unitsConfirmed, setUnitsConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<CadMeshExport | 'preparing' | undefined>();
  const [error, setError] = useState<string | undefined>();
  async function prepare() {
    setError(undefined);
    try {
      // The confirmed content: an edit already evaluating may apply after the file is prepared,
      // but a field this flush commits is refused (its value would not be in the file).
      guard?.({ keepEditor: true });
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }
    setPrepared('preparing');
    const result =
      format !== 'step'
        ? await controller.exportMesh(format, { deflectionMm })
        : placing && assembly
          ? await assembly.exportStep(name)
          : await controller.exportStep();
    setPrepared(result);
    if (!result) setError(controller.getSnapshot().diagnostic?.message);
  }
  function save(file: CadMeshExport) {
    const fileName = `${name}.${file.report.format}`;
    const type = { stl: 'model/stl', glb: 'model/gltf-binary', step: 'model/step' }[
      file.report.format
    ];
    const blob = new Blob([file.bytes as BlobPart], { type });
    if (onExportFile) onExportFile(blob, { fileName, report: file.report });
    else {
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: fileName }).click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    onClose();
  }
  const reset = () => setPrepared(undefined);
  const ready = prepared && prepared !== 'preparing' ? prepared : undefined;
  return (
    // An export scope: the Host's input guard accepts this open dialog during prepare.
    <Dialog exportScope title="Export 3D file" onClose={onClose}>
      <div className="cad-export">
        <fieldset disabled={prepared === 'preparing'}>
          <legend>Format</legend>
          <label>
            <input
              type="radio"
              name="cad-export-format"
              checked={format === 'stl'}
              disabled={placing}
              onChange={() => (setFormat('stl'), reset())}
            />
            STL (binary, millimetres)
          </label>
          <label>
            <input
              type="radio"
              name="cad-export-format"
              checked={format === 'glb'}
              disabled={placing}
              onChange={() => (setFormat('glb'), reset())}
            />
            GLB (display mesh with colours, metres, Y-up)
          </label>
          <label>
            <input
              type="radio"
              name="cad-export-format"
              checked={format === 'step'}
              onChange={() => (setFormat('step'), reset())}
            />
            {placing
              ? 'STEP (AP242 assembly: each part once as a product, its instances placed, millimetres)'
              : 'STEP (AP214, exact solids or surfaces, one per body, millimetres)'}
          </label>
          {placing && <p className="cad-muted">An assembly is written as STEP only.</p>}
        </fieldset>
        {format === 'stl' && (
          <>
            <label>
              Triangulation
              <select
                value={deflectionMm}
                disabled={prepared === 'preparing'}
                onChange={(e) => (setDeflectionMm(Number(e.target.value)), reset())}
              >
                {stlDeflections.map((d) => (
                  <option key={d.mm} value={d.mm}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={unitsConfirmed}
                onChange={(e) => setUnitsConfirmed(e.target.checked)}
              />
              STL has no unit field. Coordinates are written in millimetres; I will open the file as
              millimetres.
            </label>
          </>
        )}
        {ready && (
          <dl className="cad-export-report" aria-label="Export report">
            <dt>Bodies</dt>
            <dd>{ready.report.bodies}</dd>
            {ready.report.products !== undefined && (
              <>
                <dt>Products</dt>
                <dd>{ready.report.products}</dd>
                <dt>Instances</dt>
                <dd>{ready.report.instances}</dd>
              </>
            )}
            {ready.report.triangles !== undefined && (
              <>
                <dt>Triangles</dt>
                <dd>{ready.report.triangles.toLocaleString('en-US')}</dd>
              </>
            )}
            <dt>Units</dt>
            <dd>{ready.report.units}</dd>
            {ready.report.deflectionMm !== undefined && (
              <>
                <dt>Triangulation</dt>
                <dd>{ready.report.deflectionMm} mm</dd>
              </>
            )}
            {ready.report.transforms.length > 0 && (
              <>
                <dt>Conversion</dt>
                <dd>{ready.report.transforms.join('; ')}</dd>
              </>
            )}
            <dt>Not kept</dt>
            <dd>{ready.report.losses.join(' ')}</dd>
          </dl>
        )}
        {error && (
          <p role="alert" className="cad-diagnostic">
            {error}
          </p>
        )}
        <div className="cad-row">
          {ready ? (
            <button type="button" onClick={() => save(ready)}>
              Save {ready.report.format.toUpperCase()}
            </button>
          ) : (
            <button
              type="button"
              disabled={prepared === 'preparing' || (format === 'stl' && !unitsConfirmed)}
              onClick={() => void prepare()}
            >
              {prepared === 'preparing' ? 'Preparing…' : 'Prepare file'}
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
const lossText: Record<string, string> = {
  'product-names': 'part and product names',
  'source-feature-history': 'feature history of the source CAD',
  appearance: 'colours and styles',
  material: 'material',
  nesting: 'nested sub-assemblies (flattened; each path stays in the component name)',
};
/**
 * Preflight report of a read STEP assembly (docs/cad/r2b-assembly.md, R2b-U7): each distinct
 * shape becomes an imported part and each instance a fixed component of this empty document.
 */
function StepAssemblyImportDialog({
  assembly,
  preview,
}: {
  assembly: CadAssembly;
  preview: CadStepAssemblyImportPreview;
}) {
  const { report } = preview;
  return (
    <Dialog title="Import STEP assembly" onClose={() => assembly.cancelStepImport()}>
      <div className="cad-export">
        <dl className="cad-export-report" aria-label="Import report">
          <dt>File</dt>
          <dd>
            {preview.fileName} ({report.source.byteLength.toLocaleString('en-US')} bytes)
          </dd>
          <dt>Source hash</dt>
          <dd className="cad-hash">{report.source.sha256}</dd>
          <dt>Format</dt>
          <dd>
            STEP {report.source.schema} ({report.source.fileSchema})
          </dd>
          <dt>Reader</dt>
          <dd className="cad-hash">kernel {report.importerBuildHash}</dd>
          <dt>Units</dt>
          <dd>
            {report.sourceUnit === 'mm'
              ? 'mm (no conversion)'
              : `${report.sourceUnit} → mm (× ${report.scaleToMm}, applied once)`}
          </dd>
          <dt>Parts</dt>
          <dd>{preview.parts}</dd>
          <dt>Components</dt>
          <dd>{preview.components}</dd>
          <dt>Depth</dt>
          <dd>{report.depth}</dd>
          {report.split.length > 0 && (
            <>
              <dt>Split</dt>
              <dd>{report.split.map((s) => `${s.name} into ${s.count} parts`).join(', ')}</dd>
            </>
          )}
          {preview.skipped.length > 0 && (
            <>
              <dt>Skipped</dt>
              <dd>{preview.skipped.join(', ')} (no solid or surface)</dd>
            </>
          )}
          <dt>Healing</dt>
          <dd>None (each solid is kept as read)</dd>
          <dt>Not kept</dt>
          <dd>{report.losses.map((l) => lossText[l] ?? l).join(', ')}</dd>
        </dl>
        <p>
          The original file is kept unchanged with the document. Each part has no feature history,
          and each component is fixed where the file placed it.
        </p>
        <div className="cad-row">
          <button type="button" onClick={() => void assembly.adoptStepImport()}>
            Import assembly
          </button>
          <button type="button" onClick={() => assembly.cancelStepImport()}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
/**
 * Preflight report of a read STEP file (docs/cad/integration.md): source, reader, unit
 * conversion, the solid and what is not kept. Inserting stores the file with the Host first.
 */
function StepImportDialog({
  controller,
  preview,
}: {
  controller: CadController;
  preview: CadStepImportPreview;
}) {
  const { report } = preview;
  const b = report.body;
  const size = b.bounds[1].map((max, i) => fmt(max - b.bounds[0][i], 3)).join(' × ');
  return (
    <Dialog title="Import STEP" onClose={() => controller.cancelStepImport()}>
      <div className="cad-export">
        <dl className="cad-export-report" aria-label="Import report">
          <dt>File</dt>
          <dd>
            {preview.fileName} ({report.source.byteLength.toLocaleString('en-US')} bytes)
          </dd>
          <dt>Source hash</dt>
          <dd className="cad-hash">{report.source.sha256}</dd>
          <dt>Format</dt>
          <dd>
            STEP {report.source.schema} ({report.source.fileSchema})
          </dd>
          <dt>Reader</dt>
          <dd className="cad-hash">kernel {report.importerBuildHash}</dd>
          <dt>Units</dt>
          <dd>
            {report.sourceUnit === 'mm'
              ? 'mm (no conversion)'
              : `${report.sourceUnit} → mm (× ${report.scaleToMm}, applied once)`}
          </dd>
          <dt>Bodies</dt>
          <dd>{b.kind === 'solid' ? '1 solid' : '1 surface'}</dd>
          {b.kind === 'solid' ? (
            <>
              <dt>Volume</dt>
              <dd>{fmtQuantity(b.volumeMm3, 'mm³')}</dd>
            </>
          ) : (
            <>
              <dt>Area</dt>
              <dd>{fmtQuantity(b.areaMm2, 'mm²')}</dd>
            </>
          )}
          <dt>Size</dt>
          <dd>{size} mm</dd>
          <dt>Largest tolerance</dt>
          <dd>{report.maxToleranceMm.toExponential(2)} mm</dd>
          <dt>Healing</dt>
          <dd>None (the solid is kept as read)</dd>
          <dt>Not kept</dt>
          <dd>{report.losses.map((l) => lossText[l] ?? l).join(', ')}</dd>
        </dl>
        <p>
          The original file is kept unchanged with the document. The body has no feature history and
          no editable dimensions.
        </p>
        <div className="cad-row">
          <button type="button" onClick={() => void controller.adoptStepImport()}>
            Insert body
          </button>
          <button type="button" onClick={() => controller.cancelStepImport()}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
/**
 * The new build's exact result before the migration is adopted. Earlier versions keep their
 * build; adopting is one edit that Undo reverts.
 */
function MigrationDialog({
  controller,
  preview,
}: {
  controller: CadController;
  preview: CadMigrationPreview;
}) {
  /** A solid's volume, or a sheet's area (it has no volume). */
  const measure = (m: CadBodyEvaluation) =>
    m.kind === 'solid'
      ? fmtQuantity(m.volumeMm3, 'mm³')
      : `${fmtQuantity(m.areaMm2, 'mm²')} surface`;
  const size = (m: CadBodyEvaluation) =>
    `${m.bounds[1].map((max, i) => fmt(max - m.bounds[0][i], 2)).join(' × ')} mm`;
  /** K1: the number of solids, when a body has several. */
  const solids = (m: CadBodyEvaluation) =>
    m.kind === 'solid' && m.solids ? `, ${fmtGrouped(m.solids, 0)} solids` : '';
  const result = (m: CadBodyEvaluation) => `${measure(m)}, ${size(m)}${solids(m)}`;
  const compared = preview.bodies.some((b) => b.shown);
  const tolerance = preview.tolerance;
  return (
    <Dialog
      title={tolerance ? 'Change tolerance set' : 'Migrate to current kernel'}
      onClose={() => controller.cancelMigration()}
    >
      <div className="cad-export">
        {tolerance ? (
          <p>
            The whole model was evaluated with the {tolerance.to} tolerances (every result valid).
            Check the difference before adopting it; it is one edit that Undo reverts.
            {preview.shownCode
              ? ` The shown shape could not be calculated with the ${tolerance.from ?? 'current'} tolerances (${preview.shownCode}).`
              : ''}
          </p>
        ) : (
          <p>
            The current kernel build evaluated this recipe. Check the result before adopting it;
            saved versions keep their build.
            {!compared &&
              ' The earlier build could not be run, so there is nothing to compare with.'}
          </p>
        )}
        <table
          className="cad-migration"
          aria-label={tolerance ? 'Tolerance set result' : 'Migration result'}
        >
          <thead>
            <tr>
              <th scope="col">Body</th>
              {compared && (
                <th scope="col">
                  {tolerance ? `Shown (${tolerance.from ?? 'current'})` : 'Shown (reference)'}
                </th>
              )}
              <th scope="col">{tolerance ? `With ${tolerance.to}` : 'Current kernel'}</th>
            </tr>
          </thead>
          <tbody>
            {preview.bodies.map((b) => (
              <tr key={b.id}>
                <th scope="row">{b.name}</th>
                {compared && <td>{b.shown ? result(b.shown) : 'Not shown'}</td>}
                <td>{result(b.next)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cad-row">
          <button type="button" onClick={() => controller.adoptMigration()}>
            {tolerance ? `Adopt ${tolerance.to} tolerances` : 'Adopt migration'}
          </button>
          <button type="button" onClick={() => controller.cancelMigration()}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
export interface CadSurfaceProps {
  controller: CadController;
  /**
   * The Host owns Undo/Redo and calls `controller.sync()` afterwards. Ctrl/Cmd+Z on this Surface
   * goes to `EditorHistoryContext` when the Host provides one.
   */
  hostHistory?: boolean;
  /** File name stem for PNG export. */
  name?: string;
  /**
   * Receives the exported PNG; without it the Surface offers a download. `background: false`
   * is the PNG without background, grid or axes, for placing as an image elsewhere.
   */
  onExportPng?(png: Blob, options: { background: boolean }): void;
  /** Receives an exported STL/GLB with its report; without it the Surface offers a download. */
  onExportFile?(file: Blob, options: { fileName: string; report: CadExportReport }): void;
  /** Receives an exported BOM (R2b-3); without it the Surface offers a download. */
  onExportCsv?(csv: Blob, options: { fileName: string }): void;
  /** GPU budget for the shown shape; a Host may make it smaller than `cadBudgets.gpuBytes`. */
  gpuBytes?: number;
  /** R2b: placed parts and their edits (`CadBinding.assembly`). */
  assembly?: CadAssembly;
}
export function CadSurface({
  controller,
  hostHistory,
  name = 'cad',
  onExportPng,
  onExportFile,
  onExportCsv,
  gpuBytes,
  assembly,
}: CadSurfaceProps) {
  const [exportingFile, setExportingFile] = useState(false);
  const [moveTool, setMoveTool] = useState(false);
  const [measureTool, setMeasureTool] = useState(false);
  const [pickTool, setPickTool] = useState<'face' | 'edge'>();
  const [sketchTool, setSketchTool] = useState<SketchTool>('line');
  /** Sketch mode's curvature comb (R2a-4): its scale step, undefined when off. */
  const [sketchComb, setSketchComb] = useState<number>();
  const [sketchSelection, setSketchSelection] = useState<string[]>([]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const sketching = snapshot.sketch;
  // A new Sketch mode session starts with the line tool and nothing selected.
  const sketchSession = sketching ? `${sketching.sketch.id}:${sketching.isNew}` : '';
  const [shownSession, setShownSession] = useState(sketchSession);
  if (shownSession !== sketchSession) {
    setShownSession(sketchSession);
    setSketchTool(sketching?.isNew ? 'line' : 'select');
    setSketchSelection([]);
  }
  const view = useRef<CadViewport | null>(null);
  const { readOnly, busy } = snapshot;
  // Private view state: which named view is shown. Opens with the first one that still fits.
  const [viewId, setViewId] = useState<string | null>(
    () =>
      initialView(
        snapshot.content.namedViews,
        new Set(snapshot.content.bodies.filter((b) => b.state === 'active').map((b) => b.id)),
      )?.id ?? null,
  );
  // Undo of Save view, or another edit, removed the view shown: keep the camera, show all bodies.
  const shownView = snapshot.content.namedViews.some((v) => v.id === viewId) ? viewId : null;
  async function saveView() {
    const current = view.current?.currentView();
    const bodyIds = shownBodies(snapshot.content, shownView);
    if (!current || !bodyIds.length) return;
    const id = await controller.saveView(current, bodyIds);
    if (id) setViewId(id);
  }
  const disabled = readOnly || busy || !!sketching;
  // PNG shows exactly the confirmed content: only when its own meshes are displayed and no
  // edit is still evaluating.
  // A reference display is never exported (docs/cad/model.md, kernel update).
  // STEP, STL and GLB export the confirmed content even while an edit evaluates (CAD21): the
  // file is pinned to its hash. PNG waits, since the view may show a dropped move's preview.
  // Stored poses that do not match their joints are a reference display too (R2b-U5).
  const mismatched = (x: CadSnapshot) =>
    x.evaluation?.status === 'ok' && !!x.evaluation.assembly?.poseMismatch?.length;
  const fileExportable =
    !!snapshot.meshes?.current &&
    snapshot.geometryState === 'ready' &&
    !snapshot.reference &&
    !mismatched(snapshot);
  // A PNG captures the screen: without the shape on it (context lost, GPU budget), it would be
  // an image of the background only.
  const [drawn, setDrawn] = useState(true);
  const exportable = fileExportable && !busy && !sketching;
  // U4: a failed document's bodies outside the failure are picked and measured as usual (a
  // shape before the failure never is); nothing of it is exported.
  const partialShown =
    !!snapshot.meshes?.current &&
    snapshot.evaluation?.status === 'error' &&
    !!snapshot.evaluation.partial &&
    !snapshot.reference;
  const inspectable = (fileExportable || partialShown) && !busy && !sketching;
  // Parts still evaluating after the result are boxes: no measurement or picture of them (R2b-4).
  const partsLeft = useSyncExternalStore(
    assembly?.subscribe ?? noParts,
    () => assembly?.getSnapshot().progress,
  );
  const measurable = inspectable && !partsLeft;
  const assemblyImport = useSyncExternalStore(
    assembly?.subscribe ?? noParts,
    () => assembly?.getSnapshot().stepImport,
  );
  const pngExportable = exportable && !partsLeft && drawn;
  const guardExport = useContext(EditorExportGuardContext);
  async function exportPng(background: boolean) {
    // The Host guard flushes pending inputs first; a field it commits starts a new evaluation.
    try {
      guardExport?.();
    } catch (error) {
      return controller.report(error instanceof Error ? error.message : String(error));
    }
    const now = controller.getSnapshot();
    if (now.reference) return controller.report(describeCode('kernel-reference-only'));
    if (mismatched(now)) return controller.report(describeCode('assembly-pose-mismatch'));
    // A joint being made shows poses that are not content (R2b-2c).
    if (assembly?.getSnapshot().creating) return controller.report(describeCode('joint-creating'));
    if (now.busy || !now.meshes?.current || now.geometryState !== 'ready')
      return controller.report('形状を計算中です。計算が終わってから、もう一度操作してください。');
    if (!drawn) return controller.report(describeCode('png-not-drawn'));
    // A drag shows a placement that is not committed (and Escape may still cancel it).
    if (view.current?.dragging || view.current?.draggingJoint)
      return controller.report(
        view.current.dragging
          ? 'bodyを移動している途中です。離すかEscapeで取り消してから、もう一度操作してください。'
          : 'jointを動かしている途中です。離すかEscapeで取り消してから、もう一度操作してください。',
      );
    const png = await view.current?.capture({ background });
    if (!png) return;
    if (onExportPng) return onExportPng(png, { background });
    const url = URL.createObjectURL(png);
    const file = background ? `${name}.png` : `${name}-transparent.png`;
    const link = Object.assign(document.createElement('a'), { href: url, download: file });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  // Import is a Host capability (asset storage): the button stays while an edit evaluates.
  const importAvailable = controller.importAvailable;
  const importInput = useRef<HTMLInputElement>(null);
  async function importStep(file: File) {
    // Refused before reading, so a very large file is never held in memory.
    if (file.size > cadLimits.stepBytes) return controller.report(describeCode('step-too-large'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A file with assembly usages (R2b-5), as the kernel's scan finds them, goes to the assembly.
    await controller.prepareStepImport(
      file.name,
      bytes,
      assembly ? { assembly: () => assembly.prepareStepImport(file.name, bytes) } : {},
    );
  }
  useEffect(() => {
    void controller.refresh();
  }, [controller]);
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = root.current!;
    const measure = () => setNarrow(element.clientWidth <= narrowSketchPx);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Focus goes back to the entry Sketch mode was opened from when it closes. The entry is
  // remembered when pressed: it is disabled (and loses focus) while the mode is open.
  const sketchEntry = useRef<HTMLElement | null>(null);
  const wasSketching = useRef(false);
  useEffect(() => {
    const element = root.current!;
    const remember = (e: Event) => {
      const entry = e.target instanceof Element && e.target.closest('[data-sketch-entry]');
      if (entry instanceof HTMLElement) sketchEntry.current = entry;
    };
    element.addEventListener('click', remember, true);
    return () => element.removeEventListener('click', remember, true);
  }, []);
  useEffect(() => {
    if (!sketching && wasSketching.current) {
      const back = sketchEntry.current;
      if (back?.isConnected) back.focus();
      else root.current?.querySelector<HTMLElement>('[data-sketch-entry]')?.focus();
    }
    wasSketching.current = !!sketching;
  }, [sketching]);
  /** A key event belongs to this Surface: focus is in it, or outside every Surface and it was used last. */
  const ownsKey = (e: KeyboardEvent) => {
    const owner = e.target instanceof Element ? e.target.closest('.cad-surface') : null;
    return owner ? owner === root.current : activeSurface === root.current;
  };
  const hostHistoryContext = useContext(EditorHistoryContext);
  const history = hostHistory
    ? hostHistoryContext
    : { undo: () => void controller.undo(), redo: () => void controller.redo() };
  const historyRef = useRef(history);
  historyRef.current = history;
  // Window-level, like the Playground, so shortcuts still work after focus falls back to <body>.
  // With several Surfaces mounted, only the one last used (or the first mounted) answers.
  useEffect(() => {
    const element = root.current!;
    activeSurface ??= element;
    const activate = () => (activeSurface = element);
    element.addEventListener('pointerdown', activate, true);
    element.addEventListener('focusin', activate);
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      const owner = e.target instanceof Element ? e.target.closest('.cad-surface') : null;
      if (owner ? owner !== element : activeSurface !== element) return;
      const history = historyRef.current;
      // Sketch mode has no history of its own: nothing is an edit until Finish.
      if (controller.getSnapshot().sketch) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') e.preventDefault();
        return;
      }
      if (history && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (e.key === 'Escape' && controller.getSnapshot().selection) controller.select(null);
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', activate, true);
      element.removeEventListener('focusin', activate);
      if (activeSurface === element) activeSurface = null;
    };
  }, [controller]);
  return (
    <div className="cad-surface" ref={root}>
      <EditorLayout
        viewKey="cad"
        leftLabel="Elements"
        toolbar={
          <Toolbar label={sketching ? 'Sketch tools' : 'CAD tools'}>
            {sketching ? (
              <SketchTools tool={sketchTool} onTool={setSketchTool} />
            ) : (
              <>
                {!hostHistory && (
                  <>
                    <IconButton
                      icon={Undo2}
                      label="Undo"
                      shortcut={`${modKey()}+Z`}
                      disabled={!snapshot.canEdit || !snapshot.canUndo}
                      onClick={() => void controller.undo()}
                    />
                    <IconButton
                      icon={Redo2}
                      label="Redo"
                      shortcut={`${modKey()}+Shift+Z`}
                      disabled={!snapshot.canEdit || !snapshot.canRedo}
                      onClick={() => void controller.redo()}
                    />
                  </>
                )}
                <IconButton
                  icon={Box}
                  label="Add box"
                  disabled={disabled}
                  onClick={() => void controller.addPrimitive('box')}
                />
                <IconButton
                  icon={Cylinder}
                  label="Add cylinder"
                  disabled={disabled}
                  onClick={() => void controller.addPrimitive('cylinder')}
                />
                <IconButton
                  icon={Circle}
                  label="Add sphere"
                  disabled={disabled}
                  onClick={() => void controller.addPrimitive('sphere')}
                />
                <IconButton
                  icon={RectangleHorizontal}
                  label="Add plate"
                  reason="Extruded rectangle with a width parameter"
                  disabled={disabled}
                  onClick={() => void controller.addPlate()}
                />
                <IconButton
                  icon={Disc}
                  label="Add disc"
                  reason="Extruded circle"
                  disabled={disabled}
                  onClick={() => void controller.addDisc()}
                />
                <IconButton
                  icon={Pentagon}
                  label="Add prism"
                  reason="Extruded closed polyline; edit its vertices in the Inspector"
                  disabled={disabled}
                  onClick={() => void controller.addPrism()}
                />
                <IconButton
                  icon={Torus}
                  label="Add ring"
                  reason="Rectangle section revolved about an axis"
                  disabled={disabled}
                  onClick={() => void controller.addRing()}
                />
                <IconButton
                  icon={Move}
                  label="Move bodies"
                  reason="Drag a body to move it; Escape cancels"
                  aria-pressed={moveTool && !disabled}
                  disabled={disabled}
                  onClick={() => {
                    setMoveTool((on) => !on);
                    setMeasureTool(false);
                    setPickTool(undefined);
                  }}
                />
                <IconButton
                  icon={Ruler}
                  label="Measure distance"
                  reason="Click two points on bodies; a click near a corner snaps to that vertex"
                  aria-pressed={measureTool && measurable}
                  disabled={!measurable}
                  onClick={() => {
                    setMeasureTool((on) => !on);
                    setMoveTool(false);
                    setPickTool(undefined);
                  }}
                />
                {(['face', 'edge'] as const).map((kind) => (
                  <IconButton
                    key={kind}
                    icon={kind === 'face' ? SquareMousePointer : SplinePointer}
                    label={kind === 'face' ? 'Pick faces' : 'Pick edges'}
                    reason={`Click a ${kind} to see its persistent name; Escape clears the selection`}
                    aria-pressed={pickTool === kind && inspectable}
                    disabled={!inspectable}
                    onClick={() => {
                      setPickTool((on) => (on === kind ? undefined : kind));
                      setMoveTool(false);
                      setMeasureTool(false);
                    }}
                  />
                ))}
                <IconButton
                  icon={BookmarkPlus}
                  label="Save view"
                  reason="Saves the current camera and shown bodies as a named view"
                  disabled={disabled || !shownBodies(snapshot.content, shownView).length}
                  onClick={() => void saveView()}
                />
                <IconButton
                  icon={ImageDown}
                  label="Export PNG"
                  reason="Available when the shape is up to date and drawn"
                  disabled={!pngExportable}
                  onClick={() => void exportPng(true)}
                />
                <IconButton
                  icon={SquareDashed}
                  label="Export PNG without background"
                  reason="Available when the shape is up to date and drawn"
                  disabled={!pngExportable}
                  onClick={() => void exportPng(false)}
                />
                {importAvailable && !readOnly ? (
                  <IconButton
                    icon={FileUp}
                    label="Import STEP"
                    reason="One solid from an AP203/AP214 file; the file is kept with the document"
                    disabled={disabled}
                    onClick={() => importInput.current?.click()}
                  />
                ) : null}
                <IconButton
                  icon={FileDown}
                  label="Export STEP, STL or GLB"
                  reason="Available when the shape is up to date; exports the confirmed shape while an edit is calculated"
                  disabled={!fileExportable}
                  onClick={() => setExportingFile(true)}
                />
                {snapshot.canMigrate && (
                  <IconButton
                    icon={Replace}
                    label="Migrate to current kernel"
                    reason="Creates one edit that evaluates this document with the current kernel build; earlier versions keep theirs"
                    onClick={() => void controller.prepareMigration()}
                  />
                )}
                {snapshot.geometryState === 'geometry-error' && (
                  <IconButton
                    icon={RefreshCw}
                    label="Recalculate"
                    onClick={() => void controller.refresh({ retry: true })}
                  />
                )}
              </>
            )}
          </Toolbar>
        }
        left={
          <>
            {assembly && (
              <AssemblyPanel
                assembly={assembly}
                snapshot={snapshot}
                narrow={narrow}
                name={name}
                onExportCsv={onExportCsv}
              />
            )}
            <Navigator controller={controller} snapshot={snapshot} narrow={narrow} />
          </>
        }
        inspector={
          // Fields stay disabled while an edit evaluates: a second edit built from the still
          // committed values would silently supersede the pending one.
          <fieldset className="cad-inspector-scope" disabled={busy}>
            {sketching ? (
              <SketchPanel
                controller={controller}
                view={sketching}
                doc={snapshot.content}
                selected={sketchSelection}
                onSelect={setSketchSelection}
                comb={sketchComb}
                onComb={setSketchComb}
              />
            ) : (
              <Inspector controller={controller} snapshot={snapshot} />
            )}
          </fieldset>
        }
        status={
          <div className="cad-status" aria-live="polite">
            <span>mm</span>
            <span data-testid="cad-geometry-state">
              {busy ? 'Calculating…' : stateText[snapshot.geometryState]}
              {snapshot.progress &&
                ` (feature ${snapshot.progress.done} / ${snapshot.progress.total})`}
            </span>
            {snapshot.canStop && (
              <button
                type="button"
                data-testid="cad-stop-evaluation"
                onClick={() => controller.stopEvaluation()}
              >
                Stop
              </button>
            )}
            {partsLeft && (
              <span data-testid="cad-parts-progress">
                部品 {partsLeft.done} / {partsLeft.total} を計算中
              </span>
            )}
            {snapshot.reference ? (
              <span className="cad-reference" role="note">
                Reference display by a newer kernel build: not confirmed to match the saved shape.
                Editing and export are off.
              </span>
            ) : (
              readOnly && <span>Read only</span>
            )}
            {snapshot.rebind && (
              <span role="note" className="cad-diagnostic">
                Choose references in the view.
              </span>
            )}
            {sketching && (
              <span role="note">
                Sketch mode: {sketching.dof === 0 ? 'fully constrained' : `${sketching.dof} DOF`}.
                Escape leaves without an edit.
              </span>
            )}
            {snapshot.diagnostic && (
              <span role="alert" className="cad-diagnostic">
                {snapshot.diagnostic.message}
                <button
                  type="button"
                  aria-label="Dismiss message"
                  onClick={() => controller.dismissDiagnostic()}
                >
                  ×
                </button>
              </span>
            )}
          </div>
        }
      >
        <Viewport
          controller={controller}
          snapshot={snapshot}
          view={view}
          viewId={shownView}
          onViewId={setViewId}
          moving={moveTool && !disabled}
          // Not while an edit evaluates: a dropped move still shows its uncommitted placement.
          measuring={measureTool && measurable}
          picking={inspectable ? pickTool : undefined}
          gpuBytes={gpuBytes}
          assembly={assembly}
          onDrawn={setDrawn}
          overlay={
            sketching && (
              <SketchCanvas
                controller={controller}
                view={sketching}
                tool={sketchTool}
                selected={sketchSelection}
                onSelect={setSketchSelection}
                ownsKey={ownsKey}
                comb={sketchComb}
              />
            )
          }
        />
      </EditorLayout>
      {snapshot.migration && (
        <MigrationDialog controller={controller} preview={snapshot.migration} />
      )}
      {snapshot.stepImport && (
        <StepImportDialog controller={controller} preview={snapshot.stepImport} />
      )}
      {assembly && assemblyImport && (
        <StepAssemblyImportDialog assembly={assembly} preview={assemblyImport} />
      )}
      <input
        ref={importInput}
        type="file"
        accept=".step,.stp,model/step"
        hidden
        aria-label="STEP file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importStep(file);
        }}
      />
      {exportingFile && (
        <ExportFileDialog
          controller={controller}
          assembly={assembly}
          name={name}
          guard={guardExport}
          onExportFile={onExportFile}
          onClose={() => setExportingFile(false)}
        />
      )}
    </div>
  );
}

/**
 * The picked edge's continuity check (R2a-4): the largest deviation of each level over the
 * kernel's 65 samples, with the fixed tolerances. A judgement at the samples, not between them;
 * the content does not change.
 */
function ContinuitySection({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const view = snapshot.continuity;
  const report = view?.status === 'done' ? view.report : undefined;
  const t = cadContinuity;
  // The largest deviation, where it is (model mm), and the judgement at the samples.
  const row = (label: string, value: string, level: CadContinuityLevel) => (
    <>
      <dt>{label}</dt>
      <dd>
        {value} at ({level.at.map((x) => fmt(x)).join(', ')}) —{' '}
        {level.pass ? 'within tolerance at the samples' : 'over tolerance'}
      </dd>
    </>
  );
  return (
    <Section title="Continuity">
      <p className="cad-muted">
        Compares the two faces at {t.samples} samples along the edge, both ends included: G0{' '}
        {t.g0Mm} mm, G1 {t.g1Deg}°, G2 {t.g2Relative * 100}% of the larger curvature (both radii
        over {t.flatRadiusMm.toLocaleString('en')} mm count as flat). It says nothing between the
        samples.
      </p>
      <button
        type="button"
        disabled={view?.status === 'running' || snapshot.meshes?.current !== true}
        onClick={() => void controller.checkContinuity()}
      >
        {view?.status === 'running' ? 'Checking…' : 'Check continuity'}
      </button>
      {report && (
        <div data-testid="cad-continuity">
          <p>
            {report.level === 'none'
              ? `Over the G0 tolerance at ${report.samples} samples.`
              : `${report.level} within tolerance at all ${report.samples} samples.`}
          </p>
          <dl className="cad-metrics">
            {row('G0 gap', `${report.g0.max.toExponential(2)} mm`, report.g0)}
            {row('G1 angle', `${report.g1.max.toPrecision(3)}°`, report.g1)}
            {row(
              'G2 curvature',
              `${(report.g2.max * 100).toPrecision(3)}% (${report.g2.difference.toExponential(2)} /mm)`,
              report.g2,
            )}
          </dl>
        </div>
      )}
    </Section>
  );
}

/** The picked edge's curvature comb (R2a-4): the kernel samples its curve, the view draws it. */
function CombSection({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const comb = snapshot.comb;
  return (
    <Section title="Curvature comb">
      <p className="cad-muted">
        Draws the edge curve&apos;s curvature at {cadCurvature.combSamples} samples as teeth away
        from the centre of curvature, from the exact curve. Display only.
      </p>
      <button
        type="button"
        disabled={comb?.status === 'running' || snapshot.meshes?.current !== true}
        onClick={() => void controller.sampleComb()}
      >
        {comb?.status === 'running'
          ? 'Sampling…'
          : comb
            ? 'Sample curvature comb again'
            : 'Show curvature comb'}
      </button>
    </Section>
  );
}
