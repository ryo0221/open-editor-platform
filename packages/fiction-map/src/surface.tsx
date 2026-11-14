import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { CanvasStage, initialCanvasView, type CanvasView } from '@editor-platform/canvas-ui';
import { PathHandles } from '@editor-platform/canvas-ui/path-handles';
import { EditorHistoryContext, isTextInput, useEditorInput } from '@editor-platform/editor-ui';
import {
  createFeature,
  deleteFeatures,
  prepareFictionMapChange,
  replaceGeometry,
  translateFeatures,
  type FictionMapBase,
  type FictionMapChange,
  type FictionMapFeature,
  type FictionMapGeometry,
  type FictionMapPoint,
  type FictionMapResult,
  type PreparedFictionMapChange,
} from './model';
import { isOwnedContent } from './admission';
import {
  documentFrame,
  frame,
  geometryPoints,
  hitCandidates,
  nativePoint,
  projectTargets,
  queryAt,
  stagePoint,
  translationPreview,
} from './surface-projection';
import { layoutMapLabels } from './label-layout';
import { FeatureShape } from './surface-render';
import { FeatureInspector } from './surface-inspector';
import { FeatureArtifactRefs, type FictionMapArtifactRefHost } from './artifact-refs';
export interface FictionMapSurfaceProps {
  base: FictionMapBase;
  /** Synchronous trusted Host commit against its current Session and live permission. */
  onCommit(
    prepared: PreparedFictionMapChange,
  ): FictionMapResult<FictionMapBase & { changed: boolean }>;
  onUndo?(): FictionMapResult<FictionMapBase & { changed: boolean }>;
  onRedo?(): FictionMapResult<FictionMapBase & { changed: boolean }>;
  canUndo?: boolean;
  canRedo?: boolean;
  readOnly?: boolean;
  lockedFeatureIds?: readonly string[];
  selected?: readonly string[];
  onSelectionChange?(ids: string[]): void;
  view?: CanvasView;
  onViewChange?(view: CanvasView): void;
  createId?(): string;
  /** GV2a: pin and open fixed CAD/BIM versions from the selected feature. */
  artifactRefs?: FictionMapArtifactRefHost;
}
type Mode = 'select' | 'place' | 'path' | 'region' | 'vertices';
type Drawing = {
  base: FictionMapBase;
  mode: 'path' | 'region';
  layerId: string;
  points: FictionMapPoint[];
};
const sameBase = (a: FictionMapBase, b: FictionMapBase) =>
  a.revision.sessionId === b.revision.sessionId && a.revision.sequence === b.revision.sequence;
/** Controlled native and one Host-owned history. Camera/selection/drafts never enter native. */
export function FictionMapSurface(props: FictionMapSurfaceProps) {
  if (!isOwnedContent(props.base.content))
    throw new TypeError('FictionMapSurface requires an owned native snapshot');
  const { base, readOnly = false } = props,
    content = base.content,
    axis = content.coordinateSpace.yAxis;
  const composing = useRef(false),
    imeKey = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [localSelected, setSelected] = useState<string[]>([]),
    selected = [...(props.selected ?? localSelected)];
  const [localView, setView] = useState<CanvasView>({
      ...initialCanvasView,
      snap: false,
      grid: false,
    }),
    view = { ...(props.view ?? localView), snap: false, grid: false };
  const [declutter, setDeclutter] = useState(true);
  const [visibility, setVisibility] = useState(new Map<string, boolean>()),
    locked = new Set(props.lockedFeatureIds);
  const [mode, setMode] = useState<Mode>('select'),
    [drawing, setDrawing] = useState<Drawing>(),
    drawingRef = useRef<Drawing | undefined>(undefined);
  drawingRef.current = drawing;
  const [error, setError] = useState<{ code: string; message: string }>(),
    [candidates, setCandidates] = useState<string[]>([]);
  const [vertexPreview, setVertexPreview] = useState<FictionMapGeometry>(),
    vertexBase = useRef<FictionMapBase | undefined>(undefined),
    vertexFeature = useRef<string | undefined>(undefined),
    [pointSelection, setPointSelection] = useState<{ featureId: string; id: string }>();
  const [layerName, setLayerName] = useState(''),
    [activeLayer, setActiveLayer] = useState(''),
    [panel, setPanel] = useState(false);
  const world = useRef<SVGGElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const object = useRef<{ pointerId: number; startedAt: number; base: FictionMapBase } | undefined>(
    undefined,
  );
  const tap = useRef<
    | {
        pointerId: number;
        target: SVGRectElement;
        base: FictionMapBase;
        mode: Mode;
        point: FictionMapPoint;
        layerId: string;
      }
    | undefined
  >(undefined);
  const inspectorDirty = useRef(false);
  const inputs = useEditorInput({
    label: 'Fiction Map draft input',
    read: () => ({
      dirty:
        !!drawingRef.current ||
        !!tap.current ||
        !!object.current ||
        !!vertexBase.current ||
        layerName.length > 0,
      composing: composing.current,
    }),
    prepare() {
      throw new Error(
        'Finish or cancel drawing and layer input before saving, exporting or switching.',
      );
    },
    focus() {
      viewport.current?.querySelector<SVGSVGElement>('svg[role=application]')?.focus();
    },
  });
  const revision = `${base.revision.sessionId}:${base.revision.sequence}`;
  const labels = declutter ? layoutMapLabels(content, view.zoom, visibility, selected) : undefined;
  const targets = projectTargets(content, view.zoom, visibility, locked, labels),
    visible = (id: string) => targets.some((t) => t.id === id && !t.hidden);
  const only =
    selected.length === 1 ? content.features.find((f) => f.id === selected[0]) : undefined;
  // A point index only has meaning inside the feature that was explicitly selected.
  const pointId = pointSelection?.featureId === only?.id ? pointSelection?.id : undefined;
  const pointUnavailable = !only || locked.has(only.id) || !visible(only.id);
  const pointDisabled = readOnly || pointUnavailable;
  const visibleLayers = content.layers.filter((l) => visibility.get(l.id) ?? l.visibleByDefault);
  const layer = visibleLayers.find((l) => l.id === activeLayer) ?? visibleLayers[0];
  const pointRevision = JSON.stringify([revision, only?.id ?? null]);
  function choose(ids: string[]) {
    if (inspectorDirty.current || composing.current) {
      setError({
        code: 'input-pending',
        message: 'Apply or cancel the feature input before changing selection.',
      });
      return;
    }
    setSelected(ids);
    latest.current.onSelectionChange?.(ids);
  }
  function camera(v: CanvasView) {
    const next = { ...v, snap: false, grid: false };
    setView(next);
    latest.current.onViewChange?.(next);
  }
  function zoomBy(factor: number) {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const z = Math.min(8, Math.max(1e-9, view.zoom * factor)),
      ratio = z / view.zoom,
      c = { x: box.width / 2, y: box.height / 2 };
    camera({
      ...view,
      zoom: z,
      fit: false,
      snap: false,
      grid: false,
      pan: { x: c.x - (c.x - view.pan.x) * ratio, y: c.y - (c.y - view.pan.y) * ratio },
    });
  }
  function report(result: FictionMapResult<unknown>): boolean {
    if (result.ok) {
      setError(undefined);
      return true;
    }
    setError({
      code: result.diagnostic.code,
      message:
        result.diagnostic.code === 'stale-revision'
          ? 'The map changed while editing. Cancel this edit and try again.'
          : result.diagnostic.code === 'permission-denied'
            ? 'You cannot edit this feature with the current permissions.'
            : result.diagnostic.code === 'coordinate-out-of-range'
              ? 'Keep all coordinates inside the document bounds.'
              : result.diagnostic.code === 'invalid-geometry'
                ? 'The shape is invalid. Check crossing edges, repeated vertices and zero-length edges.'
                : 'The change could not be applied. Check the fields, shape and document limits.',
    });
    return false;
  }
  function apply(from: FictionMapBase, result: FictionMapResult<FictionMapChange>): boolean {
    if (latest.current.readOnly) {
      setError({ code: 'permission-denied', message: 'This map is read only.' });
      return false;
    }
    if (!report(result) || !result.ok) return false;
    const prep = prepareFictionMapChange(from, result.value);
    if (!report(prep) || !prep.ok) return false;
    return report(latest.current.onCommit(prep.value));
  }
  function endVertexEdit() {
    const active = !!vertexBase.current;
    vertexBase.current = undefined;
    setVertexPreview(undefined);
    if (active) inputs?.changed();
  }
  function deleteSelection() {
    if (inspectorDirty.current || composing.current || vertexBase.current) {
      setError({
        code: 'input-pending',
        message: 'Apply or cancel pending input before deleting features.',
      });
      return;
    }
    if (permitted(selected)) apply(base, deleteFeatures(selected));
  }
  function cancelTap() {
    const t = tap.current;
    tap.current = undefined;
    if (t?.target.hasPointerCapture(t.pointerId)) t.target.releasePointerCapture(t.pointerId);
  }
  function cancelDrawing() {
    cancelTap();
    drawingRef.current = undefined;
    setDrawing(undefined);
  }
  function changeMode(next: Mode) {
    if (inspectorDirty.current || composing.current) {
      setError({
        code: 'input-pending',
        message: 'Apply or cancel the feature input before changing tools.',
      });
      return;
    }
    cancelDrawing();
    endVertexEdit();
    setPointSelection(undefined);
    setMode(next);
    setError(undefined);
  }
  // The Canvas finishes object commit before this bubble listener clears its base.
  // Clearing on lostcapture is too early: successful Canvas commit releases first.
  useEffect(() => {
    const clear = (e: PointerEvent) => {
      const o = object.current;
      if (o && o.pointerId === e.pointerId && e.timeStamp >= o.startedAt) {
        object.current = undefined;
        inputs?.changed();
      }
    };
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
    };
  }, []);
  useEffect(() => {
    cancelDrawing();
    endVertexEdit();
  }, [revision]);
  // Revoked editing access disables commits, but must not silently discard pending
  // drawing/vertex input. Its pinned revision and input boundary remain in force.
  useEffect(() => {
    endVertexEdit();
    vertexFeature.current = undefined;
    setPointSelection(undefined);
  }, [pointUnavailable, only?.id]);
  useEffect(
    () => () => {
      const t = tap.current;
      tap.current = undefined;
      if (t?.target.hasPointerCapture(t.pointerId)) t.target.releasePointerCapture(t.pointerId);
    },
    [],
  );
  function query(e: { clientX: number; clientY: number }) {
    const m = world.current?.getScreenCTM();
    return m
      ? queryAt(
          m,
          { x: e.clientX, y: e.clientY },
          latest.current.base.content.coordinateSpace.yAxis,
        )
      : undefined;
  }
  function pointerCapture(e: ReactPointerEvent<HTMLDivElement>) {
    if (
      e.button !== 0 ||
      !(e.target instanceof Element) ||
      !e.target.closest('svg[role="application"]')
    )
      return;
    if (mode === 'select')
      object.current = {
        pointerId: e.pointerId,
        startedAt: e.timeStamp,
        base: latest.current.base,
      };
    const q = query(e);
    if (q)
      setCandidates(
        hitCandidates(
          content,
          q.point,
          q.zoom,
          visibility,
          locked,
          e.target.closest('[data-fiction-label]')?.getAttribute('data-fiction-label') ?? undefined,
        ),
      );
  }
  function permitted(ids: string[]) {
    return (
      ids.length > 0 &&
      !latest.current.readOnly &&
      ids.every((id) => targets.some((t) => t.id === id && !t.locked && !t.hidden))
    );
  }
  function transform(
    ids: string[],
    d: { dx: number; dy: number; dw: number; dh: number; rotation?: number },
  ) {
    const from = object.current?.base ?? latest.current.base;
    object.current = undefined;
    if (!permitted(ids) || d.dw !== 0 || d.dh !== 0 || (d.rotation ?? 0) !== 0) return;
    apply(
      from,
      translateFeatures(
        from.content,
        ids,
        d.dx,
        from.content.coordinateSpace.yAxis === 'up' ? -d.dy : d.dy,
      ),
    );
  }
  function vertexGeometry(id: string, p: { x: number; y: number }): FictionMapGeometry | undefined {
    const from = vertexBase.current;
    if (!from || !only || vertexFeature.current !== only.id) return;
    const feature = from.content.features.find((f) => f.id === only.id);
    if (!feature || feature.geometry.type === 'point') return;
    const n = Number(id),
      ps = geometryPoints(feature.geometry).map((p) => [...p] as [number, number]);
    if (!Number.isInteger(n) || n < 0 || n >= ps.length) return;
    ps[n] = [...nativePoint(p, from.content.coordinateSpace.yAxis)];
    if (feature.geometry.type === 'polygon' && n === 0) ps[ps.length - 1] = [...ps[0]];
    return feature.geometry.type === 'polygon'
      ? { type: 'polygon', outer: ps }
      : { type: 'polyline', coordinates: ps };
  }
  function addFeature(from: FictionMapBase, geometry: FictionMapGeometry, layerId: string) {
    const feature: FictionMapFeature = {
      id: (latest.current.createId ?? newId)(),
      layerId,
      name:
        geometry.type === 'point'
          ? 'New place'
          : geometry.type === 'polyline'
            ? 'New path'
            : 'New region',
      featureKind:
        geometry.type === 'point' ? 'place' : geometry.type === 'polyline' ? 'path' : 'region',
      geometry,
    };
    const ok = apply(from, createFeature(feature));
    if (ok) choose([feature.id]);
    return ok;
  }
  function finish() {
    const d = drawingRef.current;
    if (!d || d.points.length < (d.mode === 'path' ? 2 : 3)) return;
    const g: FictionMapGeometry =
      d.mode === 'path'
        ? { type: 'polyline', coordinates: d.points }
        : { type: 'polygon', outer: [...d.points, d.points[0]] };
    // Clear transient state before a normal Host commit advances its revision.
    cancelDrawing();
    if (addFeature(d.base, g, d.layerId)) setMode('select');
    else if (sameBase(d.base, latest.current.base)) {
      drawingRef.current = d;
      setDrawing(d);
    }
  }
  function drawUp(e: ReactPointerEvent<SVGRectElement>) {
    const t = tap.current;
    if (!t || t.pointerId !== e.pointerId) return;
    e.stopPropagation();
    cancelTap();
    if (
      readOnly ||
      !sameBase(t.base, latest.current.base) ||
      t.mode !== mode ||
      !(
        visibility.get(t.layerId) ??
        content.layers.find((l) => l.id === t.layerId)?.visibleByDefault
      )
    )
      return;
    if (mode === 'place') {
      if (addFeature(t.base, { type: 'point', coordinates: t.point }, t.layerId)) setMode('select');
      return;
    }
    if (mode !== 'path' && mode !== 'region') return;
    const d = drawingRef.current;
    if (d && (!sameBase(d.base, t.base) || d.layerId !== t.layerId)) return;
    const next: Drawing = d
      ? { ...d, points: [...d.points, t.point] }
      : { base: t.base, mode, layerId: t.layerId, points: [t.point] };
    if (next.points.length > 64) {
      setError({
        code: 'geometry-limit',
        message: 'A path or region can have at most 64 vertices.',
      });
      return;
    }
    drawingRef.current = next;
    setDrawing(next);
  }
  const dframe = documentFrame(content),
    currentVertexPreview = vertexFeature.current === only?.id ? vertexPreview : undefined,
    shownGeometry = currentVertexPreview ?? only?.geometry;
  const handles =
    only && shownGeometry && shownGeometry.type !== 'point'
      ? geometryPoints(shownGeometry)
          .slice(0, shownGeometry.type === 'polygon' ? -1 : undefined)
          .map((p, i) => ({
            id: String(i),
            ...stagePoint(p, axis),
            label: `Vertex ${i + 1} of ${only.name}`,
            kind: 'anchor' as const,
          }))
      : [];
  const history = {
    undo: () => {
      if (
        inspectorDirty.current ||
        drawingRef.current ||
        vertexBase.current ||
        composing.current ||
        layerName.length
      ) {
        setError({ code: 'input-pending', message: 'Apply or cancel pending input before Undo.' });
        return;
      }
      cancelDrawing();
      if (latest.current.onUndo) report(latest.current.onUndo());
    },
    redo: () => {
      if (
        inspectorDirty.current ||
        drawingRef.current ||
        vertexBase.current ||
        composing.current ||
        layerName.length
      ) {
        setError({ code: 'input-pending', message: 'Apply or cancel pending input before Redo.' });
        return;
      }
      cancelDrawing();
      if (latest.current.onRedo) report(latest.current.onRedo());
    },
  };
  return (
    <EditorHistoryContext.Provider value={history}>
      <div
        className="fm-surface"
        onPointerDownCapture={(e) => {
          if (!composing.current) imeKey.current = false;
          pointerCapture(e);
        }}
        onCompositionStartCapture={() => {
          composing.current = true;
          inputs?.changed();
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
          inputs?.changed();
        }}
        onSubmitCapture={(e) => {
          if (composing.current || imeKey.current) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onKeyUpCapture={() => {
          imeKey.current = false;
        }}
        onKeyDownCapture={(e) => {
          if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            // Leave the IME's key default intact; block only the form submission.
            imeKey.current = true;
            return;
          }
          imeKey.current = false;
          if (e.nativeEvent.isComposing || isTextInput(e.target)) return;
          if (e.key === 'Escape') {
            cancelDrawing();
            endVertexEdit();
            setMode('select');
          }
        }}
      >
        <header className="fm-toolbar" aria-label="Map tools">
          {(['select', 'place', 'path', 'region'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              disabled={m !== 'select' && (readOnly || !layer)}
              onClick={() => changeMode(m)}
            >
              {m === 'select'
                ? 'Select'
                : m === 'place'
                  ? 'Add place'
                  : m === 'path'
                    ? 'Draw path'
                    : 'Draw region'}
            </button>
          ))}
          <button
            type="button"
            disabled={pointDisabled || only?.geometry.type === 'point'}
            aria-pressed={mode === 'vertices'}
            onClick={() => changeMode(mode === 'vertices' ? 'select' : 'vertices')}
          >
            Edit vertices
          </button>
          <button
            type="button"
            disabled={readOnly || !props.canUndo || !props.onUndo}
            onClick={history.undo}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={readOnly || !props.canRedo || !props.onRedo}
            onClick={history.redo}
          >
            Redo
          </button>
          <button type="button" disabled={!permitted(selected)} onClick={deleteSelection}>
            Delete selected
          </button>
          <button type="button" aria-expanded={panel} onClick={() => setPanel(!panel)}>
            Layers and inspector
          </button>
        </header>
        <nav className="fm-toolbar" aria-label="Map camera">
          <label>
            <input
              type="checkbox"
              checked={declutter}
              onChange={(e) => setDeclutter(e.target.checked)}
            />
            Avoid label overlap
          </label>
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
            −
          </button>
          <output aria-label="Zoom level">{(view.zoom * 100).toFixed(1)}%</output>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => camera({ ...view, fit: true })}>
            Fit map
          </button>
          <button
            type="button"
            aria-label="Pan canvas"
            aria-pressed={view.panMode}
            onClick={() => camera({ ...view, panMode: !view.panMode })}
          >
            Pan
          </button>
        </nav>
        <p className="fm-hint">
          {mode === 'select'
            ? 'Click shapes or labels. Marquee selects bounding boxes; concave empty areas may be selected.'
            : mode === 'vertices'
              ? 'Drag a vertex. Escape cancels.'
              : 'Click to add vertices. Finish validates the whole shape; Escape cancels.'}
        </p>
        {error && (
          <p role="alert" data-diagnostic-code={error.code}>
            {error.message}
          </p>
        )}
        {drawing && (
          <div className="fm-drawing">
            <span>{drawing.points.length} draft vertices</span>
            <button
              onClick={finish}
              disabled={readOnly || drawing.points.length < (drawing.mode === 'path' ? 2 : 3)}
            >
              Finish shape
            </button>
            <button
              onClick={() => {
                const d = drawingRef.current;
                if (d) {
                  const next = { ...d, points: d.points.slice(0, -1) };
                  drawingRef.current = next;
                  setDrawing(next);
                }
              }}
            >
              Remove last vertex
            </button>
            <button onClick={cancelDrawing}>Cancel drawing</button>
          </div>
        )}
        <div className="fm-body">
          <div className="fm-map" ref={viewport}>
            <CanvasStage
              label="Fiction Map canvas"
              hideControls
              targets={targets}
              selected={selected.filter(visible)}
              onSelect={(ids) => choose(ids.filter(visible))}
              onTransform={transform}
              previewTransform={(ids, delta) => translationPreview(targets, ids, delta)}
              onDelete={deleteSelection}
              readOnly={readOnly}
              objectRevision={revision}
              inputOwner={mode === 'select' ? 'object' : 'point'}
              view={view}
              onViewChange={camera}
              space="infinite"
              width={dframe.width}
              height={dframe.height}
              fitBounds={dframe}
              minZoom={1e-9}
              underlay={
                <g ref={world} data-fiction-world="true">
                  <rect
                    {...dframe}
                    fill="#fbfaf4"
                    stroke="#c3d1d8"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                </g>
              }
              render={(t) => {
                const f = content.features.find((f) => f.id === t.id)!;
                const b = frame(f.geometry, axis, view.zoom);
                return (
                  <FeatureShape
                    feature={
                      mode === 'vertices' && only?.id === f.id && currentVertexPreview
                        ? { ...f, geometry: currentVertexPreview }
                        : f
                    }
                    axis={axis}
                    label={labels?.get(f.id)}
                    zoom={view.zoom}
                    offset={{ x: t.bounds.x - b.x, y: t.bounds.y - b.y }}
                  />
                );
              }}
              overlay={
                <>
                  {mode === 'vertices' && only && (
                    <PathHandles
                      key={only.id}
                      points={handles}
                      zoom={view.zoom}
                      revision={pointRevision}
                      disabled={pointDisabled}
                      selected={pointId}
                      keyDown={(e) => {
                        if (
                          pointDisabled ||
                          e.nativeEvent.isComposing ||
                          e.ctrlKey ||
                          e.metaKey ||
                          !e.key.startsWith('Arrow') ||
                          pointId === undefined
                        )
                          return;
                        e.preventDefault();
                        e.stopPropagation();
                        if (vertexBase.current) {
                          setError({
                            code: 'input-pending',
                            message: 'Finish or cancel the active vertex drag before nudging.',
                          });
                          return;
                        }
                        const p = handles.find((p) => p.id === pointId);
                        if (!p || !only) return;
                        const step = e.shiftKey ? 10 : 1;
                        vertexBase.current = latest.current.base;
                        vertexFeature.current = only!.id;
                        const from = vertexBase.current,
                          g = vertexGeometry(pointId, {
                            x:
                              p.x +
                              (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0),
                            y:
                              p.y +
                              (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0),
                          });
                        endVertexEdit();
                        if (g) apply(from, replaceGeometry(from.content, only.id, g));
                      }}
                      select={(id) => {
                        if (pointDisabled || !only) return false;
                        setPointSelection({ featureId: only.id, id });
                        return true;
                      }}
                      begin={() => {
                        if (pointDisabled) return false;
                        vertexBase.current = latest.current.base;
                        vertexFeature.current = only!.id;
                        inputs?.changed();
                        return true;
                      }}
                      preview={(id, p) => {
                        const g = vertexGeometry(id, p);
                        if (g) setVertexPreview(g);
                        inputs?.changed();
                      }}
                      commit={(id, p) => {
                        const from = vertexBase.current,
                          g = vertexGeometry(id, p);
                        endVertexEdit();
                        if (from && g && only && !pointDisabled)
                          apply(from, replaceGeometry(from.content, only.id, g));
                      }}
                      cancel={() => {
                        endVertexEdit();
                      }}
                    />
                  )}
                  {(mode === 'place' || mode === 'path' || mode === 'region') && !readOnly && (
                    <rect
                      {...dframe}
                      fill="transparent"
                      data-fiction-draw="true"
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !layer) return;
                        e.stopPropagation();
                        e.preventDefault();
                        const q = query(e);
                        if (!q) return;
                        cancelTap();
                        tap.current = {
                          pointerId: e.pointerId,
                          target: e.currentTarget,
                          base: latest.current.base,
                          point: q.point,
                          mode,
                          layerId: layer.id,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerUp={drawUp}
                      onPointerCancel={() => {
                        cancelTap();
                      }}
                      onLostPointerCapture={cancelTap}
                    />
                  )}
                  {drawing && (
                    <polyline
                      points={drawing.points
                        .map((p) => {
                          const s = stagePoint(p, axis);
                          return `${s.x},${s.y}`;
                        })
                        .join(' ')}
                      fill="none"
                      stroke="#b44b15"
                      strokeDasharray="4 3"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                </>
              }
            />
          </div>
          <aside className={`fm-panel ${panel ? 'fm-panel-open' : ''}`} aria-label="Map details">
            <section>
              <h3>Layers</h3>
              {content.layers.map((l) => (
                <div key={l.id} className="fm-layer">
                  <label>
                    <input
                      type="checkbox"
                      checked={visibility.get(l.id) ?? l.visibleByDefault}
                      onChange={(e) => {
                        cancelDrawing();
                        setVisibility(new Map(visibility).set(l.id, e.target.checked));
                      }}
                    />{' '}
                    {l.name}
                  </label>
                  <button
                    aria-label={`Draw on ${l.name}`}
                    aria-pressed={layer?.id === l.id}
                    onClick={() => {
                      cancelDrawing();
                      setActiveLayer(l.id);
                    }}
                  >
                    Draw here
                  </button>
                </div>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (readOnly || composing.current) return;
                  const l = {
                    id: (props.createId ?? newId)(),
                    name: layerName,
                    purpose: 'annotation' as const,
                    visibleByDefault: true,
                  };
                  if (apply(base, { ok: true, value: { layers: [...content.layers, l] } })) {
                    setActiveLayer(l.id);
                    setLayerName('');
                  }
                }}
              >
                <label>
                  New layer
                  <input
                    aria-label="New layer name"
                    value={layerName}
                    disabled={readOnly}
                    onChange={(e) => setLayerName(e.target.value)}
                  />
                </label>
                <button disabled={readOnly || !layerName.trim()}>Add layer</button>
                {layerName && (
                  <button type="button" onClick={() => setLayerName('')}>
                    Cancel layer input
                  </button>
                )}
              </form>
            </section>
            <section>
              <h3>Features</h3>
              <ul className="fm-features">
                {content.features.map((f) => (
                  <li key={f.id}>
                    <button
                      aria-pressed={selected.includes(f.id)}
                      disabled={!visible(f.id)}
                      onClick={() => choose([f.id])}
                    >
                      {f.name}
                      {locked.has(f.id) ? ' (locked)' : ''}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {candidates.length > 1 && (
              <section aria-label="Overlapping features">
                <h3>Overlapping features</h3>
                {candidates.map((id) => {
                  const f = content.features.find((f) => f.id === id);
                  return f && visible(id) && !locked.has(id) ? (
                    <button key={id} onClick={() => choose([id])}>
                      {f.name} · {f.category ?? f.featureKind} ·{' '}
                      {content.layers.find((l) => l.id === f.layerId)?.name} · {f.id}
                    </button>
                  ) : null;
                })}
              </section>
            )}
            {only && (mode === 'select' || mode === 'vertices') && (
              <FeatureInspector
                key={only.id}
                base={base}
                feature={only}
                disabled={pointDisabled}
                onPendingChange={(value) => {
                  inspectorDirty.current = value;
                }}
                apply={apply}
              />
            )}
            {only && (mode === 'select' || mode === 'vertices') && (
              <FeatureArtifactRefs
                key={'refs-' + only.id}
                base={base}
                feature={only}
                host={props.artifactRefs}
                disabled={pointDisabled}
                canChange={() => {
                  if (inspectorDirty.current || composing.current || vertexBase.current) {
                    setError({
                      code: 'input-pending',
                      message: 'Apply or cancel pending input before changing pinned versions.',
                    });
                    return false;
                  }
                  return true;
                }}
                apply={apply}
              />
            )}
          </aside>
        </div>
      </div>
    </EditorHistoryContext.Provider>
  );
}
