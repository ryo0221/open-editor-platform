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
  Eye,
  EyeOff,
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
  ScanSearch,
  SplinePointer,
  SquareDashed,
  SquareMousePointer,
  Torus,
  Trash2,
  Undo2,
  Aperture,
  Package,
  Cog,
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
  cadCurveNetwork,
  cadLimits,
  cadPanelGapDefaultMm,
  cadPanelGapMm,
  cadGrooveRadiusMm,
  cadBodyPmiPlacements,
  cadPmiTrackedIndex,
  cadPmiViewCamera,
  cadPmiItemText,
  placePmiPoint,
  type CadPmiAsset,
  type CadPmiItem,
  type CadPmiItemState,
  type CadPmiPlacement,
  type CadPmiTracking,
  type CadPmiKind,
  type CadPmiTarget,
  formatExpression,
  formatTopoName,
  mm,
  position,
  parameterValues,
  resolveLength,
  resolveCount,
  type CadSpurGearArgs,
  resolvePosition,
  sketchDefaultPath,
  sketchElement,
  type CadAppearance,
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
  cadGapFlush,
  cadSpotWeldLimits,
  type CadSpotWeld,
  type CadSpotWeldPoints,
  curvatureColors,
  curvatureRange,
  type CadContinuityLevel,
  cadProfileKinds,
  type CadProfileKind,
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
import {
  displayDeflectionMm,
  type CadExportReport,
  type CadMesh,
  type CadStepPmiReport,
} from '@editor-platform/cad-kernel-occt';
import {
  CadViewport,
  type CadMeasurePoint,
  type CadShading,
  type CadTopologyPick,
} from './viewport';
import type { CadAssembly, CadStepAssemblyImportPreview } from './assembly';
import { AssemblyLayer, AssemblyPanel } from './assembly-panel';
import { PartPropertiesSection } from './bom-panel';
import { modelTree, type CadTreeNode } from './model-tree';
import { compareSizes, initialView, standardViews, type CadStandardView } from './view-math';
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
import { Output, StatusRoleContext, useStatusProps, type CadStatusRole } from './status-role';
import {
  draftColor,
  draftSummary,
  finishOf,
  partCheckColors,
  partCheckColorsOf,
  partCheckLimits,
  partDraft,
  partThickness,
  thicknessColor,
  type DraftSummary,
  type ThicknessResult,
  rayDiagramLimits,
  rayDiagramSegments,
  traceRayFan,
  type RayFan,
  type RaySurface,
  type TracedRay,
  PathRenderDialog,
  viewTexturesOf,
  ViewTextureCache,
} from '@editor-platform/geometry-view';
import { TextureSection } from './texture-panel';
import { sheetFront } from './sheet-front';
import { geometryLightLimits, geometryMaterialPresets } from '@editor-platform/geometry-core';
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
/** The disjoint solids of a body of more than one, from its own build's result (K1). */
const solidCount = (snapshot: CadSnapshot, id: string) => {
  const e = snapshot.evaluation;
  const m = e?.status === 'ok' && e.reference ? undefined : bodyMetrics(e, id);
  return m?.kind === 'solid' ? m.solids : undefined;
};
const stateText: Record<CadSnapshot['geometryState'], string> = {
  ready: 'Shape up to date',
  reevaluating: 'Recalculating shape…',
  'geometry-error': 'Shape could not be calculated',
};

/**
 * Active bodies shown for a named view, or all of them for the whole model. `toggled` holds the
 * bodies the eye in the Bodies list flipped from that (private view state, SU3).
 */
const shownBodies = (
  doc: CadDocument,
  viewId: string | null,
  toggled: ReadonlySet<string> = new Set(),
) => {
  const active = doc.bodies.filter((b) => b.state === 'active').map((b) => b.id);
  const view = doc.namedViews.find((v) => v.id === viewId);
  return active.filter((id) => (view ? view.bodyIds.includes(id) : true) !== toggled.has(id));
};

/** Root width at or under which sketching is off (docs/cad/r1-modeling.md: desktop only). */
const narrowSketchPx = 800;

function Viewport({
  controller,
  snapshot,
  view,
  viewId,
  toggled,
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
  /** Bodies shown or hidden against the view by the eye in the Bodies list. */
  toggled: ReadonlySet<string>;
  onViewId(id: string | null): void;
  /** The Move tool is on: primary drag moves bodies instead of orbiting. */
  moving: boolean;
}) {
  const status = useStatusProps();
  // MR3: a shown interference finding with the assembly's own shape (the empty path).
  const ownShown = useSyncExternalStore(
    assembly?.subscribe ?? noParts,
    () => !!assembly?.getSnapshot().highlighted?.some((p) => p.length === 0),
  );
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
  const [shading, setShading] = useState<
    'shaded' | 'realistic' | 'zebra' | 'mean' | 'gauss' | 'thickness' | 'draft'
  >('shaded');
  /** CR6c: the ray diagram's fan, when shown; display only. */
  const [rayFan, setRayFan] = useState<RayFanSettings | undefined>();
  /** CR6b: the wanted wall thickness (mm) and the draft check's settings; display only. */
  const [thickness, setThickness] = useState({ min: 1.5, max: 3 });
  const [draft, setDraft] = useState<{
    minDeg: number;
    axis: 'x' | 'y' | 'z';
    sign: 1 | -1;
    split: boolean;
  }>({ minDeg: 1, axis: 'z', sign: 1, split: true });
  const [zebraAxis, setZebraAxis] = useState<'x' | 'y' | 'z'>('z');
  /** Zebra on the selected body only; the others keep their colour. */
  const [zebraSelected, setZebraSelected] = useState(false);
  /** The ground grid at z = 0 (display only): off for models that sit on their own ground. */
  const [grid, setGrid] = useState(true);
  useEffect(() => view.current?.setGrid(grid), [view, grid, restored]);
  /** PMI-3a: the PMI presentation lines of the bodies (display only), shown by default. */
  const [pmiShown, setPmiShown] = useState(true);
  const pmiLines = useMemo(() => new PmiLineCache(), []);
  const [stripes, setStripes] = useState(12);
  /** The colour range is the automatic one times 2 to this power. */
  const [rangeStep, setRangeStep] = useState(0);
  /** The comb scale is the automatic one times 2 to this power. */
  const [combStep, setCombStep] = useState(0);
  // #662: each texture image decoded once; the bodies are drawn again when one is ready.
  const [texturesLoaded, setTexturesLoaded] = useState(0);
  const textureCache = useMemo(
    () => new ViewTextureCache(() => setTexturesLoaded((n) => n + 1)),
    [],
  );
  // The placed parts' images, swept by their own layer's build.
  const partTextureCache = useMemo(
    () => new ViewTextureCache(() => setTexturesLoaded((n) => n + 1)),
    [],
  );
  useEffect(
    () => () => {
      textureCache.dispose();
      partTextureCache.dispose();
    },
    [textureCache, partTextureCache],
  );
  const curving = shading === 'mean' || shading === 'gauss';
  const curvature = snapshot.curvature;
  const shownIds = useMemo(
    () => new Set(shownBodies(snapshot.content, viewId, toggled)),
    [snapshot.content, viewId, toggled],
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
  // CR6b: the part checks on the current meshes of the shown bodies (sheets have no wall).
  const checkMeshes = useMemo(() => {
    if (shading !== 'thickness' && shading !== 'draft') return undefined;
    if (!snapshot.meshes?.current) return undefined;
    return snapshot.meshes.meshes.filter((m) => shownIds.has(m.bodyId) && !m.lod);
  }, [shading, snapshot.meshes, shownIds]);
  const kinds = useMemo(
    () => new Map(snapshot.content.bodies.map((b) => [b.id, b.kind] as const)),
    [snapshot.content.bodies],
  );
  const thicknesses = useMemo(
    () =>
      shading === 'thickness' && checkMeshes
        ? checkMeshes
            .filter((m) => kinds.get(m.bodyId) === 'solid')
            .map((m) => ({ bodyId: m.bodyId, result: partThickness(m) }))
        : undefined,
    [shading, checkMeshes, kinds],
  );
  const drafts = useMemo(() => {
    if (shading !== 'draft' || !checkMeshes) return undefined;
    const pull: [number, number, number] = [0, 0, 0];
    pull['xyz'.indexOf(draft.axis)] = draft.sign;
    return checkMeshes.map((m) => {
      const values = partDraft(m, pull);
      return {
        bodyId: m.bodyId,
        values,
        summary: draftSummary(m, values, draft.minDeg, draft.split),
      };
    });
  }, [shading, checkMeshes, draft]);
  const checkColors = useMemo(() => {
    if (thicknesses)
      return new Map(
        thicknesses.map((t) => [
          t.bodyId,
          partCheckColorsOf(t.result.values, (v) =>
            thicknessColor(v, thickness.min, thickness.max),
          ),
        ]),
      );
    if (drafts)
      return new Map(
        drafts.map((d) => [
          d.bodyId,
          partCheckColorsOf(d.values, (v) => draftColor(v, draft.minDeg, draft.split)),
        ]),
      );
    return undefined;
  }, [thicknesses, drafts, thickness, draft]);
  // CR6c: the fan traced through the shown bodies' current meshes.
  const rayResult = useMemo(() => {
    if (!rayFan || !snapshot.meshes?.current) return undefined;
    // Placed components are drawn by the assembly layer, not traced: refuse rather than show rays
    // that pass through them.
    if (snapshot.content.components.length > 0)
      return {
        rays: undefined,
        error:
          "The ray diagram traces only this document's bodies; open a placed part on its own to trace it.",
      };
    const bodies = new Map(snapshot.content.bodies.map((b) => [b.id, b]));
    const meshes = snapshot.meshes.meshes.filter((m) => shownIds.has(m.bodyId) && !m.lod);
    try {
      const rays = traceRayFan(
        meshes.map((m) => ({ ...m, surface: raySurfaceOf(bodies.get(m.bodyId)?.appearance) })),
        rayFanOf(rayFan),
      );
      return { rays, kinds: countRaySurfaces(meshes, bodies) };
    } catch (e) {
      return { rays: undefined, error: e instanceof Error ? e.message : String(e) };
    }
  }, [rayFan, snapshot.meshes, snapshot.content.bodies, snapshot.content.components, shownIds]);
  useEffect(() => {
    view.current?.showRays(rayResult?.rays ? rayLines(rayResult.rays) : undefined);
  }, [view, rayResult, restored]);
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
  // CR3d: the measured gap and flush, drawn along the first edge.
  const gapFlush = snapshot.gapFlush?.status === 'done' ? snapshot.gapFlush : undefined;
  useEffect(() => {
    view.current?.showGapFlush(gapFlush?.samples);
  }, [view, gapFlush, restored]);
  // CR4e: the spot weld points of the current content, each red where it is too far.
  const welds = snapshot.spotWelds;
  const weldDoc = snapshot.content.spotWelds;
  useEffect(() => {
    view.current?.showSpotWelds(
      welds?.flatMap((w) => {
        const max = weldDoc?.find((d) => d.id === w.id)?.maxGapMm ?? Infinity;
        return w.status === 'ok' ? [{ points: w.points, far: w.gaps.map((g) => g > max) }] : [];
      }),
    );
  }, [view, welds, weldDoc, restored]);
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
          : shading === 'realistic'
            ? { mode: 'realistic' }
            : { mode: 'shaded' };
    view.current?.setShading(mode);
    const selection = snapshot.selection;
    const picked = selection?.kind === 'face' || selection?.kind === 'edge' ? selection : undefined;
    // PMI-2: the focused item's targets on its body's current mesh.
    const focus = snapshot.pmiFocus;
    const focusAsset = focus && controller.bodyPmi(focus.bodyId).asset;
    const focusItem = focusAsset?.items.find((i) => i.id === focus!.itemId);
    const pmiFocus = focus && focusItem ? { bodyId: focus.bodyId, item: focusItem } : undefined;
    /**
     * PMI-3a: a body's presentation lines where it is now, the focused item's in its colour;
     * with a saved view shown (PMI-3b), only the lines of the items it shows.
     */
    const pmiView = snapshot.pmiView;
    const annotations = (mesh: CadMesh) => {
      if (!pmiShown || !meshes?.current) return undefined;
      if (pmiView && pmiView.bodyId !== mesh.bodyId) return undefined;
      const pmi = controller.bodyPmi(mesh.bodyId);
      const placements = pmi.asset && cadBodyPmiPlacements(snapshot.content, mesh.bodyId);
      if (!pmi.asset || !placements) return undefined;
      const lines = pmiLines.get(
        pmi.asset,
        placements,
        mesh.origin,
        pmiFocus?.bodyId === mesh.bodyId ? pmiFocus.item.id : undefined,
        pmiView?.viewId,
        pmi.items,
      );
      return lines.length ? lines : undefined;
    };
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
            ...finishOf(body?.appearance),
            textures: viewTexturesOf(
              body?.appearance.textures,
              snapshot.content.assets,
              textureCache,
              (sha) => controller.assetBytes(sha),
            ),
            selected:
              ownShown ||
              (snapshot.selection?.kind === 'body' && snapshot.selection.id === mesh.bodyId),
            sheet: body?.kind === 'sheet',
            ...(values?.has(mesh.bodyId) ? { curvature: values.get(mesh.bodyId)! } : {}),
            ...(checkColors?.has(mesh.bodyId) && !mesh.lod
              ? { colors: checkColors.get(mesh.bodyId)! }
              : {}),
            ...(picked?.id === mesh.bodyId && picked.contentHash === meshes?.contentHash
              ? { highlight: { bodyId: mesh.bodyId, kind: picked.kind, id: picked.pick } }
              : {}),
            ...(pmiFocus?.bodyId === mesh.bodyId && meshes?.current && !mesh.lod
              ? { marks: pmiMarks(mesh, pmiFocus.item, controller.bodyPmi(mesh.bodyId).tracking) }
              : {}),
            ...(annotations(mesh) ? { annotations: annotations(mesh) } : {}),
          },
        ];
      }),
      !!meshes?.current,
      !meshes?.current && !meshes?.preview,
    );
    // Every image the bodies draw was asked for: free the others (a replaced texture).
    textureCache.sweep();
    // Whole model fits only once all bodies are shown again.
    if (refit.current) {
      refit.current = false;
      view.current?.fit({ reset: true });
    }
  }, [
    snapshot.meshes,
    snapshot.selection,
    snapshot.pmiFocus,
    snapshot.pmiView,
    snapshot.content,
    ownShown,
    pmiShown,
    pmiLines,
    view,
    restored,
    shownIds,
    shading,
    zebraAxis,
    zebraSelected,
    stripes,
    values,
    range,
    checkColors,
    textureCache,
    texturesLoaded,
    controller,
  ]);
  // PMI-3b: choosing a saved view aims the camera once, after the bodies above are shown;
  // orbiting from there is the user's, until another view is chosen.
  // Each choice aims again, the same view included (after orbiting, or a moved body).
  const pmiViewKey = snapshot.pmiView
    ? `${snapshot.pmiView.bodyId}\u0000${snapshot.pmiView.viewId}\u0000${snapshot.pmiView.chosen}`
    : '';
  const pmiViewAim = useRef({ snapshot, controller });
  pmiViewAim.current = { snapshot, controller };
  useEffect(() => {
    const { snapshot: now, controller: c } = pmiViewAim.current;
    const chosen = now.pmiView;
    if (!chosen) return;
    const saved = c.bodyPmi(chosen.bodyId).asset?.views?.find((v) => v.id === chosen.viewId);
    const placements = saved && cadBodyPmiPlacements(now.content, chosen.bodyId);
    const frame = view.current?.bodyFrame(chosen.bodyId);
    if (!saved || !placements || !frame) return;
    view.current?.setView(cadPmiViewCamera(placements, saved.camera, frame.center, frame.aspect));
  }, [pmiViewKey, view]);
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
  const partTextures = useMemo(
    () => ({
      cache: partTextureCache,
      read: (sha: string) => controller.assetBytes(sha),
      loaded: texturesLoaded,
    }),
    [partTextureCache, controller, texturesLoaded],
  );
  const views = snapshot.content.namedViews;
  // PMI-3a: the PMI switch is offered once a body has presentation lines.
  const presented = snapshot.content.bodies.some(
    (b) =>
      b.state === 'active' && controller.bodyPmi(b.id).asset?.items.some((i) => i.presentation),
  );
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
        <AssemblyLayer
          assembly={assembly}
          view={view}
          snapshot={snapshot}
          restored={restored}
          textures={partTextures}
        />
      )}
      {lost && (
        <p className="cad-viewport-note" {...status}>
          3D表示を利用できません。一覧とInspectorから編集・保存できます。
        </p>
      )}
      {!lost && overGpu !== undefined && (
        <p className="cad-viewport-note" {...status}>
          形状が3D表示に使えるメモリーの上限を超えるため、表示していません（
          {(overGpu / 1024 / 1024).toFixed(1)} MiB）。一覧とInspectorから編集・保存できます。
        </p>
      )}
      {!hasBodies && <p className="cad-viewport-note">Add a body from the toolbar to start.</p>}
      {hasBodies && !lost && !snapshot.meshes && snapshot.geometryState !== 'geometry-error' && (
        <p className="cad-viewport-note" {...status}>
          Preparing the 3D shape…
        </p>
      )}
      {/* In place of the shape, where it is read on any width; the status line only names the state. */}
      {!lost && !snapshot.busy && !snapshot.rebind && snapshot.geometryFailure && (
        <div
          className="cad-viewport-note cad-viewport-failure"
          {...status}
          data-testid="cad-geometry-failure"
        >
          {snapshot.geometryFailure}
          {snapshot.failureReport?.kernelReason && (
            <details className="cad-kernel-reason">
              <summary>Kernel detail</summary>
              <code>{snapshot.failureReport.kernelReason}</code>
            </details>
          )}
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
      {((shading !== 'shaded' && shading !== 'realistic') || comb || gapFlush || rayFan) && (
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
                <Output>{stripes}</Output>
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
          {shading === 'thickness' && (
            <ThicknessLegend
              bounds={thickness}
              onBounds={setThickness}
              results={thicknesses}
              names={snapshot.content.bodies}
              sheets={(checkMeshes ?? []).filter((m) => kinds.get(m.bodyId) === 'sheet').length}
            />
          )}
          {shading === 'draft' && (
            <DraftLegend
              settings={draft}
              onSettings={setDraft}
              results={drafts}
              names={snapshot.content.bodies}
            />
          )}
          {rayFan && (
            <RayDiagramPanel
              settings={rayFan}
              onSettings={setRayFan}
              result={rayResult}
              measured={points[points.length - 1]?.point}
            />
          )}
          {gapFlush && (
            <section aria-label="Gap and flush" data-testid="cad-gap-flush">
              <p>
                Gap and flush from {gapFlush.from.bodyId} to {gapFlush.to.bodyId}:{' '}
                {gapFlush.report.samples} of {cadGapFlush.samples} points face each other.
              </p>
              <dl className="cad-metrics">
                {(['gap', 'flush'] as const).map((k) => (
                  <Fragment key={k}>
                    <dt>{k === 'gap' ? 'Gap' : 'Flush'}</dt>
                    <dd>
                      min {fmt(gapFlush.report[k].min)} mm, max {fmt(gapFlush.report[k].max)} mm,
                      mean {fmt(gapFlush.report[k].mean)} mm
                    </dd>
                  </Fragment>
                ))}
              </dl>
              <p className="cad-muted">
                The line along the edge runs from blue (smallest gap) to red (largest).
              </p>
              <button type="button" onClick={() => controller.clearGapFlush()}>
                Clear
              </button>
            </section>
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
                <Output>×{2 ** combStep}</Output>
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
            <option value="realistic">Realistic</option>
            <option value="zebra">Zebra</option>
            <option value="mean">Mean curvature</option>
            <option value="gauss">Gauss curvature</option>
            <option value="thickness">Wall thickness</option>
            <option value="draft">Draft angle</option>
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
          <span>Look</span>
          {/* Camera only, like Fit view: the document and its named views are not changed. */}
          <select
            value=""
            onChange={(e) => view.current?.fit({ view: e.target.value as CadStandardView })}
            data-testid="cad-standard-view"
          >
            <option value="" disabled>
              From…
            </option>
            {Object.entries(standardViews).map(([id, v]) => (
              <option key={id} value={id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <label className="cad-views">
          <input
            type="checkbox"
            checked={grid}
            onChange={(e) => setGrid(e.target.checked)}
            data-testid="cad-grid"
          />
          <span>Grid</span>
        </label>
        {presented && (
          <label className="cad-views">
            <input
              type="checkbox"
              checked={pmiShown}
              onChange={(e) => setPmiShown(e.target.checked)}
              data-testid="cad-pmi-shown"
            />
            <span>PMI</span>
          </label>
        )}
        <label className="cad-views">
          <input
            type="checkbox"
            checked={!!rayFan}
            onChange={(e) => setRayFan(e.target.checked ? defaultRayFan : undefined)}
            data-testid="cad-rays-shown"
          />
          <span>Rays</span>
        </label>
        <IconButton icon={Scan} label="Fit view" onClick={() => view.current?.fit()} />
        {/* WM3: frame the selected body or part, however small in the model (camera only). */}
        <IconButton
          icon={ScanSearch}
          label="Zoom to selection"
          onClick={() => view.current?.fit({ selection: true })}
        />
      </div>
    </div>
  );
}

/** A linear 0–1 colour as CSS: the canvas writes vertex colours to sRGB the same way. */
const cssColor = (c: readonly number[]) =>
  `rgb(${c
    .map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)))
    .join(' ')})`;

/** CR6b: why the checks are approximate, shown with both. */
const checkNote =
  'Read on the display mesh, not the exact shape: the values change with how fine the mesh is.';
function CheckNumber({
  label,
  value,
  limits,
  step,
  onValue,
}: {
  label: string;
  value: number;
  limits: readonly [number, number];
  step: number;
  onValue(v: number): boolean | void;
}) {
  return (
    <CommitInput
      label={label}
      type="number"
      min={limits[0]}
      max={limits[1]}
      step={step}
      value={value}
      onCommit={(v) => onValue(Number(v))}
    />
  );
}
/**
 * CR6b: the wall thickness shading's range and result: each node's distance through the part
 * along its inward normal, red under the range, green within, blue over it.
 */
function ThicknessLegend({
  bounds,
  onBounds,
  results,
  names,
  sheets,
}: {
  bounds: { min: number; max: number };
  onBounds(b: { min: number; max: number }): void;
  results: { bodyId: string; result: ThicknessResult }[] | undefined;
  names: CadBody[];
  sheets: number;
}) {
  const name = (id: string) => names.find((b) => b.id === id)?.name ?? id;
  const c = partCheckColors;
  const at = (p: [number, number, number]) => `(${p.map((v) => fmt(v)).join(', ')})`;
  return (
    <section aria-label="Wall thickness" data-testid="cad-thickness">
      <p className="cad-muted">
        Wall thickness at each mesh node, through the part along its inward normal. {checkNote}
      </p>
      <p className="cad-legend-labels">
        <span style={{ color: cssColor(c.thin) }}>■ under {fmt(bounds.min)} mm</span>
        <span style={{ color: cssColor(c.ok) }}>■ within</span>
        <span style={{ color: cssColor(c.thick) }}>■ over {fmt(bounds.max)} mm</span>
      </p>
      <CheckNumber
        label="Thinnest wall (mm)"
        value={bounds.min}
        limits={partCheckLimits.thickness}
        step={0.1}
        onValue={(min) => {
          if (min > bounds.max) return false;
          onBounds({ ...bounds, min });
        }}
      />
      <CheckNumber
        label="Thickest wall (mm)"
        value={bounds.max}
        limits={partCheckLimits.thickness}
        step={0.1}
        onValue={(max) => {
          if (max < bounds.min) return false;
          onBounds({ ...bounds, max });
        }}
      />
      {!results && <p className="cad-muted">The thickness is shown once the shape is evaluated.</p>}
      {results && (
        <ul data-testid="cad-thickness-results">
          {results.map(({ bodyId, result }) => (
            <li key={bodyId}>
              {name(bodyId)}:{' '}
              {result.min && result.max
                ? `min ${fmt(result.min.mm)} mm at ${at(result.min.at)}, max ${fmt(result.max.mm)} mm at ${at(result.max.at)}`
                : 'no wall found'}
              {result.missing > 0 && `; ${result.missing} nodes without a wall (grey)`}
            </li>
          ))}
        </ul>
      )}
      {sheets > 0 && (
        <p className="cad-muted">
          {sheets} shown sheet{sheets === 1 ? '' : 's'}: a sheet has no wall to measure.
        </p>
      )}
    </section>
  );
}
/**
 * CR6b: the draft shading's pull direction and result: each node's angle to the pull, green
 * releasing along it, blue into the other half (a mould in two halves), yellow under the smallest
 * draft, red an undercut (a mould in one direction).
 */
function DraftLegend({
  settings,
  onSettings,
  results,
  names,
}: {
  settings: { minDeg: number; axis: 'x' | 'y' | 'z'; sign: 1 | -1; split: boolean };
  onSettings(s: { minDeg: number; axis: 'x' | 'y' | 'z'; sign: 1 | -1; split: boolean }): void;
  results: { bodyId: string; summary: DraftSummary }[] | undefined;
  names: CadBody[];
}) {
  const name = (id: string) => names.find((b) => b.id === id)?.name ?? id;
  const c = partCheckColors;
  const pct = (part: number, all: number) => (all > 0 ? `${fmt((part / all) * 100)}%` : '0%');
  return (
    <section aria-label="Draft angle" data-testid="cad-draft-check">
      <p className="cad-muted">
        Draft of each mesh node to the pull direction, from the display mesh&apos;s normals.{' '}
        {checkNote}
      </p>
      <label>
        Pull direction{' '}
        <select
          value={`${settings.sign > 0 ? '+' : '-'}${settings.axis}`}
          onChange={(e) =>
            onSettings({
              ...settings,
              sign: e.target.value.startsWith('-') ? -1 : 1,
              axis: e.target.value.slice(1) as 'x' | 'y' | 'z',
            })
          }
        >
          {(['+', '-'] as const).flatMap((sign) =>
            (['x', 'y', 'z'] as const).map((axis) => (
              <option key={sign + axis} value={sign + axis}>
                {sign}
                {axis.toUpperCase()}
              </option>
            )),
          )}
        </select>
      </label>{' '}
      <label>
        <input
          type="checkbox"
          checked={settings.split}
          onChange={(e) => onSettings({ ...settings, split: e.target.checked })}
        />{' '}
        Two mould halves (faces against the pull release into the other half)
      </label>
      <CheckNumber
        label="Smallest draft (°)"
        value={settings.minDeg}
        limits={partCheckLimits.draft}
        step={0.5}
        onValue={(minDeg) => onSettings({ ...settings, minDeg })}
      />
      <p className="cad-legend-labels">
        <span style={{ color: cssColor(c.withPull) }}>■ along the pull</span>
        {settings.split && <span style={{ color: cssColor(c.againstPull) }}>■ other half</span>}
        <span style={{ color: cssColor(c.tooSmall) }}>■ under {fmt(settings.minDeg)}°</span>
        {!settings.split && <span style={{ color: cssColor(c.undercut) }}>■ undercut</span>}
      </p>
      {!results && <p className="cad-muted">The draft is shown once the shape is evaluated.</p>}
      {results && (
        <ul data-testid="cad-draft-results">
          {results.map(({ bodyId, summary: s }) => {
            const all = s.withPull + s.againstPull + s.tooSmall + s.undercut;
            return (
              <li key={bodyId}>
                {name(bodyId)}: under {fmt(settings.minDeg)}° {pct(s.tooSmall, all)}
                {settings.split
                  ? `, other half ${pct(s.againstPull, all)}`
                  : `, undercut ${pct(s.undercut, all)}`}{' '}
                of {fmtGrouped(all)} mm²
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

type Axis = 'x' | 'y' | 'z';
/** CR6c: the ray diagram's settings as the panel edits them. */
interface RayFanSettings {
  focus: [number, number, number];
  /** The fan's middle direction, an axis with its sign. */
  direction: `${'+' | '-'}${Axis}`;
  /** The axis normal to the fan's plane. */
  plane: Axis;
  spreadDeg: number;
  count: number;
  maxBounces: number;
  exitLength: number;
}
const defaultRayFan: RayFanSettings = {
  focus: [0, 0, 0],
  direction: '-x',
  plane: 'z',
  spreadDeg: 120,
  count: 15,
  maxBounces: 4,
  exitLength: 500,
};
const axisVector = (axis: Axis, sign = 1): [number, number, number] => {
  const v: [number, number, number] = [0, 0, 0];
  v['xyz'.indexOf(axis)] = sign;
  return v;
};
function rayFanOf(s: RayFanSettings): RayFan {
  return {
    focus: s.focus,
    direction: axisVector(s.direction.slice(1) as Axis, s.direction.startsWith('-') ? -1 : 1),
    planeNormal: axisVector(s.plane),
    spreadDeg: s.spreadDeg,
    count: s.count,
    maxBounces: s.maxBounces,
    exitLength: s.exitLength,
  };
}
/**
 * CR6c: how a body's look treats a ray: a lit body is the source (passed through), a
 * transmitting one refracts, a metal one (metalness 0.9 or more) mirrors, any other stops it.
 */
function raySurfaceOf(a: CadAppearance | undefined): RaySurface {
  if (!a) return { kind: 'opaque' };
  if (a.emission && a.emission.strength > 0) return { kind: 'pass' };
  if (a.transmission) return { kind: 'refract', ior: a.ior ?? geometryLightLimits.defaultIor };
  if ((a.metalness ?? 0) >= 0.9) return { kind: 'mirror' };
  return { kind: 'opaque' };
}
function countRaySurfaces(meshes: CadMesh[], bodies: Map<string, CadBody>) {
  const out = { mirror: 0, refract: 0, opaque: 0, pass: 0 };
  for (const id of new Set(meshes.map((m) => m.bodyId)))
    out[raySurfaceOf(bodies.get(id)?.appearance).kind]++;
  return out;
}
/** CR6c: each ray's colour by how it ended (linear RGB). */
const rayColors = {
  escaped: [1, 0.45, 0] as const,
  absorbed: [0.35, 0.38, 0.42] as const,
  bounces: [0.55, 0.2, 0.85] as const,
};
function rayLines(rays: TracedRay[]) {
  const segments = rayDiagramSegments(rays);
  const colors = new Float32Array(segments.length);
  let k = 0;
  for (const r of rays)
    for (let i = 1; i < r.points.length; i++) {
      colors.set(rayColors[r.end], k);
      colors.set(rayColors[r.end], k + 3);
      k += 6;
    }
  return { segments, colors };
}
/**
 * CR6c: the ray diagram's fan (focus, direction, plane, spread, rays, bounces) and what the rays
 * met. Geometry only: no light distribution and no standard's check.
 */
function RayDiagramPanel({
  settings,
  onSettings,
  result,
  measured,
}: {
  settings: RayFanSettings;
  onSettings(s: RayFanSettings): void;
  result:
    | { rays: TracedRay[]; kinds: Record<RaySurface['kind'], number>; error?: undefined }
    | { rays: undefined; error: string }
    | undefined;
  measured: Vec3 | undefined;
}) {
  const set = (patch: Partial<RayFanSettings>) => onSettings({ ...settings, ...patch });
  const L = rayDiagramLimits;
  const whole = (v: string) => Number.isInteger(Number(v));
  const ends = result?.rays && countBy(result.rays.map((r) => r.end));
  const hits = result?.rays && countBy(result.rays.flatMap((r) => r.events));
  return (
    <section aria-label="Ray diagram" data-testid="cad-rays">
      <p className="cad-muted">
        Rays from the focus in a fan, reflected by metal bodies (metalness 0.9 or more), refracted
        by transmitting ones and stopped by the others; lit bodies are the source and let the rays
        through. Traced on the display mesh: geometry only, no light distribution.
      </p>
      <div className="cad-row">
        {(['x', 'y', 'z'] as const).map((axis, i) => (
          <CheckNumber
            key={axis}
            label={`Focus ${axis.toUpperCase()} (mm)`}
            value={settings.focus[i]!}
            limits={[-1e6, 1e6]}
            step={1}
            onValue={(v) => {
              const focus = [...settings.focus] as [number, number, number];
              focus[i] = v;
              set({ focus });
            }}
          />
        ))}
      </div>
      {measured && (
        <button
          type="button"
          onClick={() => set({ focus: [...measured] as [number, number, number] })}
        >
          Focus at the measured point
        </button>
      )}{' '}
      <label>
        Direction{' '}
        <select
          value={settings.direction}
          onChange={(e) => set({ direction: e.target.value as RayFanSettings['direction'] })}
        >
          {(['+', '-'] as const).flatMap((sign) =>
            (['x', 'y', 'z'] as const).map((axis) => (
              <option key={sign + axis} value={sign + axis}>
                {sign}
                {axis.toUpperCase()}
              </option>
            )),
          )}
        </select>
      </label>{' '}
      <label>
        Fan plane normal{' '}
        <select value={settings.plane} onChange={(e) => set({ plane: e.target.value as Axis })}>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <option key={axis} value={axis} disabled={settings.direction.endsWith(axis)}>
              {axis.toUpperCase()}
            </option>
          ))}
        </select>
      </label>
      <CheckNumber
        label="Spread (°)"
        value={settings.spreadDeg}
        limits={L.spreadDeg}
        step={5}
        onValue={(spreadDeg) => set({ spreadDeg })}
      />
      <CheckNumber
        label="Rays"
        value={settings.count}
        limits={L.count}
        step={1}
        onValue={(count) => (whole(String(count)) ? set({ count }) : false)}
      />
      <CheckNumber
        label="Bounces"
        value={settings.maxBounces}
        limits={L.maxBounces}
        step={1}
        onValue={(maxBounces) => (whole(String(maxBounces)) ? set({ maxBounces }) : false)}
      />
      <CheckNumber
        label="Length out (mm)"
        value={settings.exitLength}
        limits={L.exitLength}
        step={10}
        onValue={(exitLength) => set({ exitLength })}
      />
      {!result && <p className="cad-muted">The rays are traced once the shape is evaluated.</p>}
      {result?.error && <p role="alert">{result.error}</p>}
      {result?.rays && ends && hits && (
        <p data-testid="cad-rays-result">
          {result.rays.length} rays: {ends.escaped ?? 0} leave the model (orange),{' '}
          {ends.absorbed ?? 0} stopped (grey), {ends.bounces ?? 0} at the bounce limit (purple).
          Hits: {hits.mirror ?? 0} reflections, {hits.refract ?? 0} refractions,{' '}
          {hits.internal ?? 0} total internal reflections. Shown bodies: {result.kinds.mirror}{' '}
          mirror, {result.kinds.refract} transmitting, {result.kinds.pass} lit,{' '}
          {result.kinds.opaque} opaque.
        </p>
      )}
    </section>
  );
}
function countBy<T extends string>(items: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

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
            <Output>×{2 ** rangeStep}</Output>
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
  const status = useStatusProps('Distance');
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
          Distance <Output data-testid="cad-distance">{fmt(Math.hypot(...delta))}</Output> mm
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
    <section className="cad-measure" aria-label="Distance" {...status}>
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

/**
 * Compare size (#538): the selected body's overall size along X, Y and Z beside another body's,
 * and the difference. Display only, readOnly too; on the evaluated hash in millimetres, as
 * Distance. The bounds say nothing about turning, height clearance or load.
 */
function CompareSize({
  body,
  others,
  snapshot,
}: {
  body: CadBody;
  others: CadBody[];
  snapshot: CadSnapshot;
}) {
  const [otherId, setOtherId] = useState('');
  const other = others.find((b) => b.id === otherId);
  const a = bodyMetrics(snapshot.evaluation, body.id);
  const b = other && bodyMetrics(snapshot.evaluation, other.id);
  const rows = a && b ? compareSizes(a.bounds, b.bounds) : [];
  // Rounded as shown, so a difference of 0.004 mm reads as the same size.
  const shown = (v: number) => Math.round(v * 100) / 100 || 0;
  return (
    <Section title="Compare size" open={false}>
      <label className="ep-field">
        With body
        <select value={otherId} onChange={(e) => setOtherId(e.target.value)}>
          <option value="">Choose…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      {other && !b && <p className="cad-muted">{other.name} has no calculated shape to compare.</p>}
      {other && b && (
        <>
          <table className="cad-compare" data-testid="cad-compare-size">
            <thead>
              <tr>
                <th scope="col">Axis</th>
                <th scope="col">{body.name}</th>
                <th scope="col">{other.name}</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = shown(r.difference);
                return (
                  <tr key={r.axis}>
                    <th scope="row">{r.axis}</th>
                    <td>{fmtGrouped(r.a, 2)}</td>
                    <td>{fmtGrouped(r.b, 2)}</td>
                    <td data-testid={`cad-compare-${r.axis}`}>
                      {d === 0
                        ? 'Same'
                        : `${fmtGrouped(Math.abs(d), 2)} ${d < 0 ? 'smaller' : 'larger'}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="cad-muted">
            Overall sizes along the world axes (millimetres), and how much {body.name} is smaller or
            larger than {other.name} in total, not per side. They do not check position, turning,
            height clearance or load. Shape {snapshot.contentHash.slice(0, 15)}….
          </p>
        </>
      )}
    </Section>
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
    case 'spurGear':
      return <GearFields args={feature.args} doc={doc} onCommit={update} />;
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
            <Output data-testid="cad-loft-sections">{names.join(' → ')}</Output>
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
            <Output>{name(feature.args.profile.sketchId)}</Output>
          </div>
          <div className="cad-readonly-field">
            <span>Path</span>
            <Output>
              {name(feature.args.path.sketchId)} ({feature.args.path.elements.length} elements)
            </Output>
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
    case 'profileSweep': {
      const a = feature.args;
      const profile = (patch: Partial<typeof a.profile>) =>
        void update({ ...a, profile: { ...a.profile, ...patch } });
      return (
        <>
          <div className="cad-readonly-field">
            <span>Path</span>
            <Output data-testid="cad-member-path">
              {doc.sketches.find((s) => s.id === a.path.sketchId)?.name ?? a.path.sketchId} (
              {a.path.elements.length} elements)
            </Output>
          </div>
          <label className="ep-field">
            Section
            <select
              value={a.profile.kind}
              onChange={(e) => profile({ kind: e.target.value as CadProfileKind })}
            >
              {cadProfileKinds.map((k) => (
                <option key={k} value={k}>
                  {profileKindLabels[k]}
                </option>
              ))}
            </select>
          </label>
          <LengthField
            label="Height"
            length={a.profile.height}
            doc={doc}
            onCommit={(v) => profile({ height: v })}
          />
          <LengthField
            label="Width"
            length={a.profile.width}
            doc={doc}
            onCommit={(v) => profile({ width: v })}
          />
          <LengthField
            label="Flange width"
            length={a.profile.flange}
            doc={doc}
            onCommit={(v) => profile({ flange: v })}
          />
          <LengthField
            label="Bend R"
            length={a.profile.radius}
            doc={doc}
            onCommit={(v) => profile({ radius: v })}
          />
          {typeof a.up === 'string' ? (
            <label className="ep-field">
              Height points
              <select
                value={a.up}
                onChange={(e) => void update({ ...a, up: e.target.value as 'normal' | 'inPlane' })}
              >
                <option value="normal">{profileUpLabels.normal}</option>
                <option value="inPlane">{profileUpLabels.inPlane}</option>
              </select>
            </label>
          ) : (
            <div className="cad-readonly-field">
              <span>Height points</span>
              <Output>along ({a.up.map((x) => fmt(x)).join(', ')})</Output>
            </div>
          )}
          <label className="cad-check">
            <input
              type="checkbox"
              checked={a.flip}
              onChange={(e) => void update({ ...a, flip: e.target.checked })}
            />
            Flip (the other way)
          </label>
        </>
      );
    }
    case 'boundarySurface':
      return (
        <div className="cad-readonly-field">
          <span>Curves</span>
          <Output data-testid="cad-boundary-curves">
            {feature.args.curves.map((c) => curveLabel(doc, c)).join(' → ')}
          </Output>
        </div>
      );
    case 'curveNetwork':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along (u)</span>
            <Output data-testid="cad-network-u">
              {feature.args.u.map((c) => curveLabel(doc, c)).join(' → ')}
            </Output>
          </div>
          <div className="cad-readonly-field">
            <span>Across (v)</span>
            <Output data-testid="cad-network-v">
              {feature.args.v.map((c) => curveLabel(doc, c)).join(' → ')}
            </Output>
          </div>
          <div className="cad-readonly-field">
            <span>Meeting tolerance</span>
            <Output>{feature.args.toleranceMm} mm</Output>
          </div>
        </>
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
                      j === i ? { ...x, continuity: e.target.value as 'G0' | 'G1' | 'G2' } : x,
                    ),
                  })
                }
              >
                <option value="G0">G0 (meets the curve)</option>
                <option value="G1">G1 (tangent to the face beside)</option>
                <option value="G2">G2 (same curvature as the face beside)</option>
              </select>
            </label>
          ))}
        </div>
      );
    case 'split':
      return (
        <div className="cad-readonly-field">
          <span>Along</span>
          <Output data-testid="cad-split-along">
            {doc.sketches.find((s) => s.id === feature.args.tool.sketchId)?.name ??
              feature.args.tool.sketchId}{' '}
            ({feature.args.tool.elements.length} elements)
          </Output>
        </div>
      );
    case 'panel':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along</span>
            <Output>
              {doc.sketches.find((s) => s.id === feature.args.tool.sketchId)?.name ??
                feature.args.tool.sketchId}{' '}
              ({feature.args.tool.elements.length} elements)
            </Output>
          </div>
          <label className="ep-field">
            Panel
            <select
              value={feature.args.keep}
              onChange={(e) =>
                void update({ ...feature.args, keep: e.target.value as 'inside' | 'outside' })
              }
            >
              <option value="inside">Inside the line</option>
              <option value="outside">Outside the line</option>
            </select>
          </label>
          <LengthField
            label="Gap"
            length={feature.args.gap}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, gap: v })}
          />
        </>
      );
    case 'trim': {
      const sides =
        'sketchId' in feature.args.tool
          ? (['inside', 'outside'] as const)
          : (['front', 'back'] as const);
      const gap = feature.args.gap;
      return (
        <>
          {gap && (
            <LengthField
              label="Gap"
              length={gap}
              doc={doc}
              onCommit={(v) => update({ ...feature.args, gap: v })}
            />
          )}
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
          {feature.args.chains && (
            <div className="cad-readonly-field">
              <span>Closed lines</span>
              <Output>{feature.args.chains.length + 1}</Output>
            </div>
          )}
          {'sketchId' in feature.args.tool && (
            <label className="cad-check">
              <input
                type="checkbox"
                data-testid="cad-trim-skip-missed"
                checked={feature.args.ifMissed === 'skip'}
                onChange={(e) => {
                  const { ifMissed: _, ...rest } = feature.args;
                  void update(e.target.checked ? { ...rest, ifMissed: 'skip' } : rest);
                }}
              />
              Leave out lines that miss the surface
            </label>
          )}
        </>
      );
    }
    case 'sew':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Joining distance</span>
            <Output>{feature.args.toleranceMm} mm</Output>
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
    case 'groove':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along</span>
            <Output data-testid="cad-groove-along">
              {doc.sketches.find((s) => s.id === feature.args.tool.sketchId)?.name ??
                feature.args.tool.sketchId}{' '}
              ({feature.args.tool.elements.length} elements, on the nearest faces)
            </Output>
          </div>
          <LengthField
            label="Radius"
            length={feature.args.radius}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, radius: v })}
          />
        </>
      );
    case 'pressLine':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along</span>
            <Output data-testid="cad-press-along">
              {doc.sketches.find((s) => s.id === feature.args.tool.sketchId)?.name ??
                feature.args.tool.sketchId}{' '}
              ({feature.args.tool.elements.length} elements, the {feature.args.side} side moved)
            </Output>
          </div>
          <LengthField
            label="Depth"
            length={feature.args.depth}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, depth: v })}
          />
          <label className="ep-field">
            Towards
            <select
              value={feature.args.toward}
              onChange={(e) =>
                void update({ ...feature.args, toward: e.target.value as 'front' | 'back' })
              }
            >
              <option value="front">The front (its normal)</option>
              <option value="back">The back</option>
            </select>
          </label>
          <LengthField
            label="Step R"
            length={feature.args.radius}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, radius: v })}
          />
        </>
      );
    case 'flange':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along</span>
            <Output data-testid="cad-flange-along">
              {feature.args.edges.length} {feature.args.edges.length === 1 ? 'edge' : 'edges'}
            </Output>
          </div>
          <LengthField
            label="Width"
            length={feature.args.width}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, width: v })}
          />
          <AngleField
            label="Angle from the sheet"
            angle={feature.args.angle}
            doc={doc}
            onCommit={(angle) => void update({ ...feature.args, angle })}
          />
          <label className="ep-field">
            Towards
            <select
              value={feature.args.toward}
              onChange={(e) =>
                void update({ ...feature.args, toward: e.target.value as 'front' | 'back' })
              }
            >
              <option value="front">The front (its normal)</option>
              <option value="back">The back</option>
            </select>
          </label>
        </>
      );
    case 'flare':
      return (
        <>
          <div className="cad-readonly-field">
            <span>Along</span>
            <Output data-testid="cad-flare-along">
              {doc.sketches.find((s) => s.id === feature.args.tool.sketchId)?.name ??
                feature.args.tool.sketchId}{' '}
              ({feature.args.tool.elements.length} elements)
            </Output>
          </div>
          <LengthField
            label="Height"
            length={feature.args.height}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, height: v })}
          />
          <label className="ep-field">
            Joining the sheet
            <select
              value={feature.args.continuity}
              onChange={(e) =>
                void update({ ...feature.args, continuity: e.target.value as 'G1' | 'G2' })
              }
            >
              <option value="G1">G1 (tangent)</option>
              <option value="G2">G2 (curvature too)</option>
            </select>
          </label>
        </>
      );
    case 'offsetSurface':
      return (
        <>
          <LengthField
            label="Distance"
            length={feature.args.distance}
            doc={doc}
            onCommit={(v) => update({ ...feature.args, distance: v })}
          />
          <label className="ep-field">
            Towards
            <select
              data-testid="cad-offset-side"
              value={feature.args.side}
              onChange={(e) =>
                void update({ ...feature.args, side: e.target.value as 'front' | 'back' })
              }
            >
              <option value="front">The front (its normal)</option>
              <option value="back">The back</option>
            </select>
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
            <>
              <LengthField
                label="Spacing"
                length={layout.spacing}
                doc={doc}
                onCommit={(spacing) => set({ ...layout, spacing })}
              />
              {layout.rows && (
                <>
                  <p className="cad-muted" data-testid="cad-pattern-rows">
                    In rows along ({layout.rows.direction.map((c) => fmt(c)).join(', ')}).
                  </p>
                  <CountField
                    count={layout.rows.count}
                    doc={doc}
                    label="Rows"
                    onCommit={(count) => set({ ...layout, rows: { ...layout.rows!, count } })}
                  />
                  <LengthField
                    label="Row spacing"
                    length={layout.rows.spacing}
                    doc={doc}
                    onCommit={(spacing) => set({ ...layout, rows: { ...layout.rows!, spacing } })}
                  />
                </>
              )}
            </>
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
        <Output data-testid="cad-tolerance-set">{current ?? 'custom'}</Output>
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

function Inspector({
  controller,
  snapshot,
  assembly,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  assembly?: CadAssembly;
}) {
  const { content: doc, selection, evaluation, readOnly } = snapshot;
  const [tool, setTool] = useState('');
  const canMakePart = useSyncExternalStore(
    assembly?.subscribe ?? noParts,
    () => !!assembly?.getSnapshot().canMakePart,
  );
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
              <Output>{fmt(at[i])} mm</Output>
            </div>
          ),
        )}
      </Section>
      <AppearanceSection body={body} controller={controller} readOnly={readOnly} />
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
      {metrics && others.length > 0 && (
        <CompareSize body={body} others={others} snapshot={snapshot} />
      )}
      <PmiSection body={body} snapshot={snapshot} controller={controller} />
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
      {!readOnly && body.state === 'active' && body.kind === 'solid' && (
        <GrooveSection body={body} doc={doc} snapshot={snapshot} controller={controller} />
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
      {!readOnly && body.state === 'active' && assembly && (
        <button
          type="button"
          disabled={snapshot.busy || !canMakePart}
          title="このbodyと、その形を作るsketch・featureを新しい部品のArtifactにし、ここではその部品を同じ位置に置きます"
          onClick={() => void assembly.makePart(body.id)}
        >
          <Package size={16} aria-hidden="true" /> Make part
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

/**
 * PMI-2: an item's targets as marks on its body's mesh: the pick table lists the body's faces and
 * edges in the same map order as the asset's indices. A location dimension's second end has its
 * own colour. Vertices are listed, not drawn.
 */
/**
 * The faces and edges an item targets, as pick ids of the body's mesh: by their own index when
 * the body is the import, through the evaluation's tracking after a change (PMI-4a).
 */
function pmiMarks(mesh: CadMesh, item: CadPmiItem, tracking?: CadPmiTracking) {
  const marks: { pick: CadTopologyPick; color: string }[] = [];
  const add = (targets: CadPmiTarget[], color: string) => {
    for (const t of targets) {
      const i = tracking ? cadPmiTrackedIndex(tracking, t) : t.index - 1;
      if (i === undefined || i < 0) continue;
      if (t.shape === 'face' && i < mesh.topology.faces.length)
        marks.push({
          pick: { bodyId: mesh.bodyId, kind: 'face', id: mesh.faceBase + 1 + i },
          color,
        });
      else if (t.shape === 'edge' && i < mesh.topology.edges.length)
        marks.push({
          pick: { bodyId: mesh.bodyId, kind: 'edge', id: mesh.edgeBase + 1 + i },
          color,
        });
    }
  };
  add(item.targets, pmiTargetColour);
  if (item.kind === 'dimension') add(item.targets2 ?? [], pmiSecondColour);
  return marks;
}
const pmiTargetColour = '#e8590c';
/** PMI-3a: presentation lines, and the focused item's (in the targets' colour). */
const pmiLineColour = '#2b8a3e';
/**
 * PMI-3a: the presentation lines of a body's asset as viewport segments, placed where the body is
 * and relative to its mesh origin; the last few results are kept, as a large file's lines are
 * many and the viewport redraws on every selection.
 */
class PmiLineCache {
  private readonly entries = new Map<string, { segments: Float32Array; color: string }[]>();
  private readonly ids = new WeakMap<object, number>();
  private next = 0;
  private idOf(o: object) {
    let id = this.ids.get(o);
    if (id === undefined) this.ids.set(o, (id = this.next++));
    return id;
  }
  get(
    asset: CadPmiAsset,
    placements: CadPmiPlacement[],
    origin: Vec3,
    focusId: string | undefined,
    viewId?: string,
    /** PMI-4a: after a change of the shape, only the current items are drawn. */
    states?: ReadonlyMap<string, CadPmiItemState>,
  ): { segments: Float32Array; color: string }[] {
    const key = JSON.stringify([
      this.idOf(asset),
      states ? this.idOf(states) : null,
      placements,
      origin,
      focusId ?? null,
      viewId ?? null,
    ]);
    const hit = this.entries.get(key);
    if (hit) return hit;
    // With a view shown, only the ranges (callouts) that view lists; otherwise all lines.
    const segmentsOf = (i: CadPmiItem): number[] => {
      const p = i.presentation;
      if (!p) return [];
      if (viewId === undefined || !p.ranges) return p.segments;
      let from = 0;
      return p.ranges.flatMap((range) => {
        const part = range.views.includes(viewId) ? p.segments.slice(from, range.end) : [];
        from = range.end;
        return part;
      });
    };
    const line = (items: CadPmiItem[]) => {
      const parts = items.map(segmentsOf);
      const n = parts.reduce((k, s) => k + s.length, 0);
      const out = new Float32Array(n);
      let at = 0;
      for (const s of parts) {
        for (let k = 0; k < s.length; k += 3) {
          const p = placePmiPoint(placements, [s[k]!, s[k + 1]!, s[k + 2]!]);
          out[at++] = p[0] - origin[0];
          out[at++] = p[1] - origin[1];
          out[at++] = p[2] - origin[2];
        }
      }
      return out;
    };
    const shown = asset.items.filter(
      (i) =>
        i.presentation &&
        (viewId === undefined || i.views?.includes(viewId)) &&
        (!states || states.get(i.id)?.current === true),
    );
    const focused = shown.filter((i) => i.id === focusId);
    const rest = shown.filter((i) => i.id !== focusId);
    const lines = [
      ...(rest.length ? [{ segments: line(rest), color: pmiLineColour }] : []),
      ...(focused.length ? [{ segments: line(focused), color: pmiTargetColour }] : []),
    ];
    if (this.entries.size >= 8) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, lines);
    return lines;
  }
}
const pmiSecondColour = '#1c7ed6';
const pmiKindTitles: Record<CadPmiKind, string> = {
  dimension: 'Dimensions',
  'geometric-tolerance': 'Geometric tolerances',
  datum: 'Datums',
  'datum-target': 'Datum targets',
};
const targetCount = (item: CadPmiItem) => {
  const all = [...item.targets, ...(item.kind === 'dimension' ? (item.targets2 ?? []) : [])];
  const n = (kind: string, one: string, many: string) => {
    const c = all.filter((t) => t.shape === kind).length;
    return c ? [`${c} ${c === 1 ? one : many}`] : [];
  };
  return [
    ...n('face', 'face', 'faces'),
    ...n('edge', 'edge', 'edges'),
    ...n('vertex', 'vertex', 'vertices'),
  ].join(', ');
};
/**
 * PMI-2 (docs/cad/pmi.md, 表示と操作): the semantic PMI an imported body keeps, by kind. Choosing
 * an item highlights its faces and edges (display only). PMI-4a: after a feature that changes the
 * shape, an item whose faces, edges and datums the evaluation found unchanged stays current; the
 * others are listed as stale and cannot be chosen. A body that joins two imports with PMI has all
 * of it stale.
 */
function PmiSection({
  body,
  snapshot,
  controller,
}: {
  body: CadBody;
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const { state, asset, unreadable, items: states } = controller.bodyPmi(body.id);
  if (state.status === 'none') return null;
  const focus = snapshot.pmiFocus?.bodyId === body.id ? snapshot.pmiFocus.itemId : undefined;
  const shownView = snapshot.pmiView?.bodyId === body.id ? snapshot.pmiView.viewId : undefined;
  const stale = state.status === 'stale';
  const changedBy =
    state.status !== 'current' &&
    snapshot.content.features.find((f) => f.id === state.changedById)?.name;
  // PMI-4a: after a change of the shape, the items the evaluation found unchanged.
  const kept = states && [...states.values()].filter((s) => s.current).length;
  const itemStale = (id: string) => !!states && states.get(id)?.current !== true;
  return (
    <Section title="PMI">
      <div data-testid="cad-pmi">
        {unreadable || !asset ? (
          <p className="cad-muted">The PMI kept with this body could not be read.</p>
        ) : (
          <>
            {stale ? (
              <p className="cad-pmi-stale" role="note">
                Stale: {changedBy ?? 'a feature'} joined this body with another body that has PMI,
                so this PMI is not checked against the body&apos;s faces and is not highlighted.
              </p>
            ) : state.status === 'changed' ? (
              <p className="cad-pmi-stale" role="note">
                {changedBy ?? 'A feature'} changed the shape after the import.{' '}
                {snapshot.meshes?.current
                  ? `${kept} of ${asset.items.length} items have all their faces, edges and datums unchanged and are kept; the others are stale.`
                  : 'Which items are kept is shown once the body is evaluated.'}
              </p>
            ) : (
              <p className="cad-muted">
                PMI kept from the STEP file. Choose an item to highlight its faces and edges, and
                its presentation lines where the file has them. A saved view sets the camera and
                shows only its PMI.
              </p>
            )}
            {asset.views?.length ? (
              <>
                <h4 className="cad-pmi-kind">Saved views ({asset.views.length})</h4>
                <ul className="cad-pmi-list" aria-label="Saved views">
                  <li>
                    <button
                      type="button"
                      className="cad-item"
                      aria-pressed={shownView === undefined}
                      disabled={stale}
                      onClick={() => controller.showPmiView(undefined)}
                    >
                      <span>All PMI</span>
                    </button>
                  </li>
                  {asset.views.map((v) => {
                    const n = asset.items.filter(
                      (i) => i.views?.includes(v.id) && !itemStale(i.id),
                    ).length;
                    return (
                      <li key={v.id}>
                        <button
                          type="button"
                          className="cad-item"
                          aria-pressed={shownView === v.id}
                          disabled={stale}
                          onClick={() => controller.showPmiView(v.id)}
                        >
                          <span>{v.name || v.id}</span>
                          <small>
                            {n} {n === 1 ? 'item' : 'items'}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {(Object.keys(pmiKindTitles) as CadPmiKind[]).map((kind) => {
              const items = asset.items.filter((i) => i.kind === kind);
              if (!items.length) return null;
              return (
                <Fragment key={kind}>
                  <h4 className="cad-pmi-kind">
                    {pmiKindTitles[kind]} ({items.length})
                  </h4>
                  <ul className="cad-pmi-list" aria-label={pmiKindTitles[kind]}>
                    {items.map((item) => {
                      const s = states?.get(item.id);
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="cad-item"
                            aria-pressed={focus === item.id}
                            disabled={stale || itemStale(item.id)}
                            onClick={() =>
                              controller.focusPmi(focus === item.id ? undefined : item.id)
                            }
                          >
                            <span>{cadPmiItemText(item, asset)}</span>
                            <small>
                              {targetCount(item)}
                              {item.presentation ? ' · presented' : ''}
                              {s && !s.current
                                ? s.reason === 'datum'
                                  ? ' · stale (a datum is stale)'
                                  : ' · stale (changed)'
                                : ''}
                            </small>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Fragment>
              );
            })}
          </>
        )}
      </div>
    </Section>
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
/**
 * #661: a body's material: a preset from the library copies its colour, opacity and finish;
 * changing one value makes the look custom (the preset's name is dropped). Display only.
 */
function AppearanceSection({
  body,
  controller,
  readOnly,
}: {
  body: CadBody;
  controller: CadController;
  readOnly: boolean;
}) {
  const a = body.appearance;
  const finish = finishOf(a);
  const set = (appearance: CadAppearance) =>
    void controller.run({ type: 'setAppearance', bodyId: body.id, appearance });
  /** One value changed by hand: the look is no longer the preset's. */
  const custom = (patch: Partial<CadAppearance>) => {
    const { material: _preset, ...rest } = { ...a, ...patch };
    // A field patched to undefined is left out (CR6a: no emission, no transmission).
    for (const k of Object.keys(rest) as (keyof typeof rest)[])
      if (rest[k] === undefined) delete rest[k];
    set(rest);
  };
  const preset = geometryMaterialPresets.find((p) => p.id === a.material);
  if (readOnly)
    return (
      <Section title="Appearance">
        <dl className="cad-metrics" data-testid="cad-appearance">
          <dt>Material</dt>
          <dd>{preset?.name ?? 'Custom'}</dd>
          <dt>Colour</dt>
          <dd>
            <span className="cad-swatch" style={{ background: a.color }} aria-hidden="true" />{' '}
            {a.color}
          </dd>
          <dt>Roughness</dt>
          <dd>{finish.roughness}</dd>
          <dt>Metalness</dt>
          <dd>{finish.metalness}</dd>
          <dt>Opacity</dt>
          <dd>{a.opacity}</dd>
          <dt>Emission</dt>
          <dd>{a.emission ? `${a.emission.color} × ${a.emission.strength}` : 'None'}</dd>
          <dt>Transmission</dt>
          <dd>{a.transmission ?? 0}</dd>
          <dt>Index of refraction</dt>
          <dd>{a.ior ?? geometryLightLimits.defaultIor}</dd>
        </dl>
        <TextureSection body={body} controller={controller} readOnly />
      </Section>
    );
  const unit = (key: 'roughness' | 'metalness' | 'opacity', label: string, value: number) => (
    <CommitInput
      label={label}
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={value}
      onCommit={(v) => custom({ [key]: Number(v) })}
    />
  );
  return (
    <Section title="Appearance">
      <div data-testid="cad-appearance">
        <label className="ep-field">
          Material
          <select
            value={preset?.id ?? ''}
            onChange={(e) => {
              const p = geometryMaterialPresets.find((x) => x.id === e.target.value);
              if (!p) return custom({});
              set({
                color: p.color,
                opacity: p.opacity,
                roughness: p.roughness,
                metalness: p.metalness,
                ...(p.emission ? { emission: { ...p.emission } } : {}),
                ...(p.transmission !== undefined ? { transmission: p.transmission } : {}),
                ...(p.ior !== undefined ? { ior: p.ior } : {}),
                material: p.id,
              });
            }}
          >
            <option value="">Custom</option>
            {geometryMaterialPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="cad-row">
          <span className="cad-swatch" style={{ background: a.color }} aria-hidden="true" />
          <CommitInput
            label="Colour"
            value={a.color}
            onCommit={(v) => {
              const color = v.trim().toLowerCase();
              if (!/^#[0-9a-f]{6}$/.test(color)) return false;
              custom({ color });
            }}
          />
        </div>
        {unit('roughness', 'Roughness', finish.roughness)}
        {unit('metalness', 'Metalness', finish.metalness)}
        {unit('opacity', 'Opacity', a.opacity)}
        <LightFields appearance={a} onChange={custom} />
        <TextureSection body={body} controller={controller} readOnly={false} />
      </div>
    </Section>
  );
}
/**
 * CR6a: the light a body gives off (a lamp: colour and strength, 0 for none) and lets through
 * (a lens: transmission 0–1 and its index of refraction). The view draws the light as a glow and
 * the transmission as a lower opacity; a path-traced render draws them as light and refraction.
 */
function LightFields({
  appearance: a,
  onChange,
}: {
  appearance: CadAppearance;
  onChange: (patch: Partial<CadAppearance>) => void;
}) {
  const [lo, hi] = geometryLightLimits.emissionStrength;
  const strength = a.emission?.strength ?? 0;
  const emissionColor = a.emission?.color ?? '#ffffff';
  /** An emission of strength 0 is none: the field is left out. */
  const emit = (color: string, value: number) => {
    onChange({ emission: value > 0 ? { color, strength: value } : undefined });
  };
  const ranged = (v: string, [min, max]: readonly [number, number]) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  return (
    <div data-testid="cad-appearance-light">
      <CommitInput
        label="Emission strength"
        type="number"
        min={lo}
        max={hi}
        step={0.5}
        value={strength}
        onCommit={(v) => {
          const n = ranged(v, geometryLightLimits.emissionStrength);
          if (n === undefined) return false;
          emit(emissionColor, n);
        }}
      />
      <CommitInput
        label="Emission colour"
        value={emissionColor}
        onCommit={(v) => {
          const color = v.trim().toLowerCase();
          if (!/^#[0-9a-f]{6}$/.test(color)) return false;
          emit(color, strength || 1);
        }}
      />
      <CommitInput
        label="Transmission"
        type="number"
        min={0}
        max={1}
        step={0.05}
        value={a.transmission ?? 0}
        onCommit={(v) => {
          const n = ranged(v, geometryLightLimits.transmission);
          if (n === undefined) return false;
          onChange({ transmission: n || undefined });
        }}
      />
      <CommitInput
        label="Index of refraction"
        type="number"
        min={geometryLightLimits.ior[0]}
        max={geometryLightLimits.ior[1]}
        step={0.01}
        value={a.ior ?? geometryLightLimits.defaultIor}
        onCommit={(v) => {
          const n = ranged(v, geometryLightLimits.ior);
          if (n === undefined) return false;
          onChange({ ior: n });
        }}
      />
    </div>
  );
}
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
  const [divider, setDivider] = useState('');
  // CR3b: a panel cut out along a sketch's closed chain, the gap between it and this body.
  const [panelSketch, setPanelSketch] = useState('');
  const [panelGap, setPanelGap] = useState(String(cadPanelGapDefaultMm));
  const [panelKeep, setPanelKeep] = useState<'inside' | 'outside'>('inside');
  const gapMm = Number(panelGap);
  const [press, setPress] = useState('');
  const [pressSide, setPressSide] = useState<'left' | 'right'>('left');
  const [pressDepth, setPressDepth] = useState('2');
  const [pressToward, setPressToward] = useState<'front' | 'back'>('front');
  const [pressRadius, setPressRadius] = useState('0.5');
  const [keep, setKeep] = useState<keyof typeof trimSideLabels>('outside');
  // CR3c: closed chains of the sketch that cut nothing are left out instead of refused.
  const [skipMissed, setSkipMissed] = useState(false);
  const [offset, setOffset] = useState('0');
  const [thickness, setThickness] = useState('1');
  const [side, setSide] = useState<'front' | 'back' | 'both'>('front');
  const [distance, setDistance] = useState('2');
  const [offsetSide, setOffsetSide] = useState<'front' | 'back'>('back');
  const d = Number(distance);
  const [mirrorAxis, setMirrorAxis] = useState<'x' | 'y' | 'z'>('y');
  const sheetMesh =
    snapshot.meshes?.contentHash === snapshot.contentHash
      ? snapshot.meshes.meshes.find((m) => m.bodyId === body.id && !m.lod && !m.beforeFailure)
      : undefined;
  const front = useMemo(() => (sheetMesh ? sheetFront(sheetMesh) : undefined), [sheetMesh]);
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
    void controller
      .trimBody(body, made, kept, kind === 'sketch' && skipMissed ? 'skip' : undefined)
      .then((ok) => ok && setTool(''));
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
        {byCurve && (
          <>
            <p className="cad-muted">
              Every closed line of the sketch is cut at once (a row of windows).
            </p>
            <label className="cad-check">
              <input
                type="checkbox"
                checked={skipMissed}
                onChange={(e) => setSkipMissed(e.target.checked)}
              />
              Leave out lines that miss the surface
            </label>
          </>
        )}
        <button type="button" disabled={!tool || snapshot.busy} onClick={trim}>
          Trim
        </button>
      </Section>
      <Section title="Split" open={false}>
        <label className="ep-field">
          Divide along
          <select
            data-testid="cad-split-sketch"
            value={divider}
            onChange={(e) => setDivider(e.target.value)}
          >
            <option value="">Choose…</option>
            {doc.sketches.map((s) => (
              <option key={s.id} value={s.id}>
                Sketch {s.name} (along its normal)
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!divider || snapshot.busy}
          onClick={() => void controller.splitBody(body, divider)}
        >
          Split, keeping every piece
        </button>
      </Section>
      <Section title="Panel" open={false}>
        <label className="ep-field">
          Cut out along
          <select
            data-testid="cad-panel-sketch"
            value={panelSketch}
            onChange={(e) => setPanelSketch(e.target.value)}
          >
            <option value="">Choose…</option>
            {doc.sketches.map((s) => (
              <option key={s.id} value={s.id}>
                Sketch {s.name} (a closed line, along its normal)
              </option>
            ))}
          </select>
        </label>
        <label className="ep-field">
          Panel
          <select
            value={panelKeep}
            onChange={(e) => setPanelKeep(e.target.value as typeof panelKeep)}
          >
            <option value="inside">Inside the line</option>
            <option value="outside">Outside the line</option>
          </select>
        </label>
        <CommitInput
          label="Gap (mm)"
          type="number"
          step={0.5}
          value={panelGap}
          onCommit={setPanelGap}
        />
        <button
          type="button"
          disabled={
            !panelSketch ||
            !(gapMm >= cadPanelGapMm[0] && gapMm <= cadPanelGapMm[1]) ||
            snapshot.busy
          }
          onClick={() => void controller.cutPanel(body, panelSketch, gapMm, panelKeep)}
        >
          Cut out a panel
        </button>
      </Section>
      <Section title="Press line" open={false}>
        <label className="ep-field">
          Along
          <select
            data-testid="cad-press-sketch"
            value={press}
            onChange={(e) => setPress(e.target.value)}
          >
            <option value="">Choose…</option>
            {doc.sketches.map((s) => (
              <option key={s.id} value={s.id}>
                Sketch {s.name} (along its normal)
              </option>
            ))}
          </select>
        </label>
        <label className="ep-field">
          Moved side
          <select
            value={pressSide}
            onChange={(e) => setPressSide(e.target.value as typeof pressSide)}
          >
            <option value="left">Left (inside a closed line)</option>
            <option value="right">Right (outside a closed line)</option>
          </select>
        </label>
        <CommitInput
          label="Depth (mm)"
          type="number"
          step={0.5}
          value={pressDepth}
          onCommit={setPressDepth}
        />
        <label className="ep-field">
          Towards
          <select
            value={pressToward}
            onChange={(e) => setPressToward(e.target.value as typeof pressToward)}
          >
            <option value="front">The front (its normal)</option>
            <option value="back">The back</option>
          </select>
        </label>
        <CommitInput
          label="Step R (mm)"
          type="number"
          step={0.1}
          value={pressRadius}
          onCommit={setPressRadius}
        />
        <button
          type="button"
          disabled={!press || snapshot.busy}
          onClick={() =>
            void controller.pressLine(body, press, {
              side: pressSide,
              depthMm: Number(pressDepth),
              toward: pressToward,
              radiusMm: Number(pressRadius),
            })
          }
        >
          Press the line
        </button>
      </Section>
      {/* CR4b (86M6): which way "the front" is, before choosing a side below. */}
      <p className="cad-muted" data-testid="cad-sheet-front">
        {front
          ? `Its front (its normal) faces mostly ${front.axis}${front.share < 0.9 ? ` (${Math.round(100 * front.share)}% of its area along it)` : ''}.`
          : 'Its front faces no one way (its normals cancel).'}
      </p>
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
      <Section title="Mirror copy" open={false}>
        <label className="ep-field">
          Across
          <select
            value={mirrorAxis}
            onChange={(e) => setMirrorAxis(e.target.value as typeof mirrorAxis)}
          >
            <option value="y">The plane y = 0 (left to right)</option>
            <option value="x">The plane x = 0</option>
            <option value="z">The plane z = 0</option>
          </select>
        </label>
        <button
          type="button"
          disabled={snapshot.busy}
          onClick={() => void controller.mirrorCopy(body, mirrorAxis)}
        >
          Mirror into a new body
        </button>
      </Section>
      <Section title="Offset surface" open={false}>
        <CommitInput
          label="Distance (mm)"
          type="number"
          step={0.5}
          value={distance}
          onCommit={setDistance}
        />
        <label className="ep-field">
          Towards
          <select
            value={offsetSide}
            onChange={(e) => setOffsetSide(e.target.value as typeof offsetSide)}
          >
            <option value="front">The front (its normal)</option>
            <option value="back">The back</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!(d >= 0.01 && d <= 100) || snapshot.busy}
          onClick={() => void controller.offsetSurface(body, d, offsetSide)}
        >
          Offset into a new sheet
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
  // CR6d: a grid, rows of the row along a second axis.
  const [rows, setRows] = useState('1');
  const [rowAxis, setRowAxis] = useState('y');
  const [rowStep, setRowStep] = useState('10');
  const circular = layout === 'circle';
  // K5a: along the open chain a sketch draws.
  const path = layout.startsWith('path:') ? layout.slice(5) : undefined;
  const paths = snapshot.content.sketches.filter((s) => sketchDefaultPath(s));
  const n = Number(count);
  const by = Number(step);
  const linear = !path && !circular;
  const rowN = Number(rows);
  const rowBy = Number(rowStep);
  const gridded = linear && rowN > 1;
  const rowsValid =
    !gridded ||
    (Number.isInteger(rowN) &&
      rowN * n <= 1000 &&
      rowAxis !== layout &&
      Number.isFinite(rowBy) &&
      rowBy !== 0);
  const valid =
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 1000 &&
    (!!path || (Number.isFinite(by) && by !== 0)) &&
    (!linear || (Number.isInteger(rowN) && rowN >= 1 && rowsValid));
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
      : {
          type: 'linear',
          direction: axes[layout]!,
          count: { literal: n },
          spacing: mm(by),
          ...(gridded
            ? {
                rows: {
                  direction: axes[rowAxis]!,
                  count: { literal: rowN },
                  spacing: mm(rowBy),
                },
              }
            : {}),
        };
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
      {linear && (
        <>
          <label className="ep-field">
            Rows
            <input
              type="number"
              min={1}
              max={1000}
              step={1}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
            />
          </label>
          {gridded && (
            <>
              <label className="ep-field">
                Rows along
                <select value={rowAxis} onChange={(e) => setRowAxis(e.target.value)}>
                  {(['x', 'y', 'z'] as const).map((a) => (
                    <option key={a} value={a} disabled={a === layout}>
                      {a.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ep-field">
                Row spacing (mm)
                <input type="number" value={rowStep} onChange={(e) => setRowStep(e.target.value)} />
              </label>
              {!rowsValid && (
                <p className="cad-muted" role="alert">
                  The rows need another axis than the row, a spacing, and 1,000 copies at most.
                </p>
              )}
            </>
          )}
        </>
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

/**
 * CR6d: a round groove (a stitch line, a seam) along the chain a sketch draws, carried along the
 * sketch's normal onto the solid's nearest faces: a half-round of the radius.
 */
function GrooveSection({
  body,
  doc,
  snapshot,
  controller,
}: {
  body: CadBody;
  doc: CadDocument;
  snapshot: CadSnapshot;
  controller: CadController;
}) {
  const [sketch, setSketch] = useState('');
  const [radius, setRadius] = useState('1');
  const r = Number(radius);
  const valid = r >= cadGrooveRadiusMm[0] && r <= cadGrooveRadiusMm[1];
  return (
    <Section title="Groove" open={false}>
      <label className="ep-field">
        Along
        <select
          data-testid="cad-groove-sketch"
          value={sketch}
          onChange={(e) => setSketch(e.target.value)}
        >
          <option value="">Choose…</option>
          {doc.sketches.map((s) => (
            <option key={s.id} value={s.id}>
              Sketch {s.name} (along its normal)
            </option>
          ))}
        </select>
      </label>
      <CommitInput
        label="Groove R (mm)"
        type="number"
        step={0.1}
        value={radius}
        onCommit={setRadius}
      />
      {!valid && (
        <p className="cad-muted" role="alert">
          The radius is {cadGrooveRadiusMm[0]}–{cadGrooveRadiusMm[1]} mm.
        </p>
      )}
      <button
        type="button"
        disabled={!sketch || !valid || snapshot.busy}
        onClick={() => void controller.groove(body, sketch, r)}
      >
        Cut the groove
      </button>
    </Section>
  );
}

/**
 * WM1a: a spur gear's fields. Each commit is one edit; values the gear cannot have (undercut,
 * pointed tips, windows that do not fit) are refused by validation with their code.
 */
function GearFields({
  args: a,
  doc,
  onCommit,
}: {
  args: CadSpurGearArgs;
  doc: CadDocument;
  onCommit: (args: CadSpurGearArgs) => void;
}) {
  const coefficient = (
    label: string,
    key: 'profileShift' | 'addendum' | 'dedendum' | 'toothThickness',
    placeholder = '× module',
  ) => (
    <CommitInput
      label={label}
      value={a[key] ?? ''}
      placeholder={placeholder}
      onCommit={(text) => {
        const v = Number(text);
        if (text.trim() && Number.isFinite(v)) onCommit({ ...a, [key]: v });
      }}
    />
  );
  const s = a.spokes;
  return (
    <>
      <LengthField
        label="Module"
        length={a.module}
        doc={doc}
        onCommit={(module) => onCommit({ ...a, module })}
      />
      <CountField
        label="Teeth"
        count={a.teeth}
        doc={doc}
        onCommit={(teeth) => onCommit({ ...a, teeth })}
      />
      <label className="ep-field">
        Tooth profile
        <select
          value={a.profile}
          onChange={(e) => {
            // WM1b: each profile has its own tooth fields; switching starts from its defaults.
            const {
              pressureAngle: _a,
              profileShift: _x,
              matingTeeth: _z,
              toothThickness: _s,
              ...rest
            } = a;
            void [_a, _x, _z, _s];
            onCommit(
              e.target.value === 'cycloidal'
                ? {
                    ...rest,
                    profile: 'cycloidal',
                    matingTeeth: a.teeth,
                    toothThickness: 0.5,
                    addendum: 1.3,
                    dedendum: 1.6,
                  }
                : {
                    ...rest,
                    profile: 'involute',
                    pressureAngle: { literalRad: (20 * Math.PI) / 180 },
                    profileShift: 0,
                    addendum: 1,
                    dedendum: 1.25,
                  },
            );
          }}
        >
          <option value="involute">Involute</option>
          <option value="cycloidal">Cycloidal (watch)</option>
        </select>
      </label>
      {a.profile === 'cycloidal' ? (
        <>
          <CountField
            label="Mating teeth"
            count={a.matingTeeth ?? a.teeth}
            doc={doc}
            onCommit={(matingTeeth) => onCommit({ ...a, matingTeeth })}
          />
          {coefficient('Tooth thickness', 'toothThickness', '× circular pitch')}
        </>
      ) : (
        <>
          <AngleField
            label="Pressure angle"
            angle={a.pressureAngle ?? { literalRad: (20 * Math.PI) / 180 }}
            doc={doc}
            onCommit={(pressureAngle) => onCommit({ ...a, pressureAngle })}
          />
          {coefficient('Profile shift', 'profileShift')}
        </>
      )}
      {coefficient('Addendum', 'addendum')}
      {coefficient('Dedendum', 'dedendum')}
      <LengthField
        label="Face width"
        length={a.faceWidth}
        doc={doc}
        onCommit={(faceWidth) => onCommit({ ...a, faceWidth })}
      />
      <LengthField
        label="Bore"
        length={a.bore}
        doc={doc}
        onCommit={(bore) => onCommit({ ...a, bore })}
      />
      {s ? (
        <>
          <CountField
            label="Spokes"
            count={s.count}
            doc={doc}
            onCommit={(count) => onCommit({ ...a, spokes: { ...s, count } })}
          />
          <LengthField
            label="Spoke width"
            length={s.width}
            doc={doc}
            onCommit={(width) => onCommit({ ...a, spokes: { ...s, width } })}
          />
          <LengthField
            label="Rim"
            length={s.rim}
            doc={doc}
            onCommit={(rim) => onCommit({ ...a, spokes: { ...s, rim } })}
          />
          <LengthField
            label="Hub"
            length={s.hub}
            doc={doc}
            onCommit={(hub) => onCommit({ ...a, spokes: { ...s, hub } })}
          />
          <button
            type="button"
            onClick={() => {
              const { spokes: _, ...rest } = a;
              void _;
              onCommit(rest);
            }}
          >
            Remove spokes
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            // A start that fits most gears: arms and rings in proportion to the root circle.
            const v = parameterValues(doc);
            const m = resolveLength(a.module, v);
            const root = (m * resolveCount(a.teeth, v)) / 2 - 1.25 * m;
            const ring = Math.max(m, root * 0.12);
            onCommit({
              ...a,
              spokes: {
                count: { literal: 5 },
                rim: { literalMm: Number(ring.toFixed(3)) },
                hub: { literalMm: Number(ring.toFixed(3)) },
                width: { literalMm: Number(ring.toFixed(3)) },
              },
            });
          }}
        >
          Add spokes
        </button>
      )}
    </>
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
 * CR1e: a fillet's varying radius from the inspector's fields: none when both are empty, `null`
 * when they cannot be read (points as `at:R`, comma-separated; they need an end R).
 */
function filletVariation(
  endR: string,
  radii: string,
): { endMm: number; points: { at: number; radiusMm: number }[] } | undefined | null {
  if (!endR.trim() && !radii.trim()) return undefined;
  if (!positive(endR)) return null;
  const points = radii.trim()
    ? radii.split(',').map((part) => {
        const [at, r] = part.split(':').map((x) => Number(x.trim()));
        return { at: at!, radiusMm: r! };
      })
    : [];
  if (points.some((p) => !Number.isFinite(p.at) || !(p.radiusMm > 0))) return null;
  return { endMm: Number(endR), points };
}

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
  const [endR, setEndR] = useState('');
  const [radii, setRadii] = useState('');
  const [flareLine, setFlareLine] = useState('');
  const [flareHeight, setFlareHeight] = useState('10');
  const [flareJoin, setFlareJoin] = useState<'G1' | 'G2'>('G1');
  const [flangeWidth, setFlangeWidth] = useState('10');
  const [flangeAngle, setFlangeAngle] = useState('90');
  const [flangeToward, setFlangeToward] = useState<'front' | 'back'>('front');
  const vary = filletVariation(endR, radii);
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
          <NumberField label="Fillet end R (mm, optional)" value={endR} onChange={setEndR} />
          <label>
            R along the edge (optional)
            <input
              data-testid="cad-fillet-radii"
              placeholder="0.5:8, 0.75:6"
              value={radii}
              onChange={(e) => setRadii(e.target.value)}
            />
          </label>
          <div className="cad-row">
            <button
              type="button"
              disabled={!editable || !positive(size) || vary === null}
              onClick={() =>
                void controller.blendPickedEdge('fillet', Number(size), vary ?? undefined)
              }
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
      {referable &&
        !snapshot.readOnly &&
        body?.state === 'active' &&
        body.kind === 'sheet' &&
        info.kind === 'edge' && (
          <Section title="Flare from this arch" open={false}>
            <label className="ep-field">
              Along
              <select
                data-testid="cad-flare-sketch"
                value={flareLine}
                onChange={(e) => setFlareLine(e.target.value)}
              >
                <option value="">Choose…</option>
                {snapshot.content.sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    Sketch {s.name} (along its normal)
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Height (mm)" value={flareHeight} onChange={setFlareHeight} />
            <label className="ep-field">
              Joining the sheet
              <select
                value={flareJoin}
                onChange={(e) => setFlareJoin(e.target.value as 'G1' | 'G2')}
              >
                <option value="G1">G1 (tangent)</option>
                <option value="G2">G2 (curvature too)</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!editable || !flareLine || !positive(flareHeight)}
              onClick={() =>
                void controller.flarePickedEdge(flareLine, Number(flareHeight), flareJoin)
              }
            >
              Flare the arch out
            </button>
          </Section>
        )}
      {referable &&
        !snapshot.readOnly &&
        body?.state === 'active' &&
        body.kind === 'sheet' &&
        info.kind === 'edge' && (
          <Section title="Flange this edge" open={false}>
            <p className="cad-muted">
              Collect edges of this sheet first to flange them all at once (with this one among
              them).
            </p>
            <NumberField label="Width (mm)" value={flangeWidth} onChange={setFlangeWidth} />
            <NumberField
              label="Angle from the sheet (°)"
              value={flangeAngle}
              onChange={setFlangeAngle}
            />
            <label className="ep-field">
              Towards
              <select
                data-testid="cad-flange-toward"
                value={flangeToward}
                onChange={(e) => setFlangeToward(e.target.value as 'front' | 'back')}
              >
                <option value="front">The front (its normal)</option>
                <option value="back">The back</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!editable || !positive(flangeWidth) || !positive(flangeAngle)}
              onClick={() =>
                void controller.flangePickedEdge(
                  Number(flangeWidth),
                  Number(flangeAngle),
                  flangeToward,
                )
              }
            >
              Stand the flange up
            </button>
          </Section>
        )}
      {info.kind === 'edge' && body?.state === 'active' && !snapshot.reference && (
        <>
          <ContinuitySection controller={controller} snapshot={snapshot} />
          <CombSection controller={controller} snapshot={snapshot} />
          <GapFlushSection controller={controller} snapshot={snapshot} />
        </>
      )}
      {referable && !snapshot.readOnly && body?.state === 'active' && info.kind === 'face' && (
        <SpotWeldSection controller={controller} snapshot={snapshot} editable={editable} />
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
  const status = useStatusProps();
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
                  <Output data-testid="cad-rebind-candidate">
                    Candidate {at + 1} of {selectable.length}
                    {hint ? ` at (${hint.centroid.map((c) => fmt(c, 1)).join(', ')})` : ''}
                  </Output>
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
        <p className="cad-muted" {...status}>
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
  const [kind, setKind] = useState<'boundarySurface' | 'fill' | 'curveNetwork'>('boundarySurface');
  const [chosen, setChosen] = useState<string[]>([]);
  const [tangent, setTangent] = useState<Set<string>>(new Set());
  // CR1d: the curves of a network that run across (v); the others run along (u).
  const [across, setAcross] = useState<Set<string>>(new Set());
  const [tolerance, setTolerance] = useState('0.01');
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
  const network = kind === 'curveNetwork';
  const ways = {
    u: chosen.filter((k) => !across.has(k)),
    v: chosen.filter((k) => across.has(k)),
  };
  const [netMin, netMax] = cadCurveNetwork.curves;
  const [min, max] = network
    ? [2 * netMin, 2 * netMax]
    : cadBoundaryCurves[kind === 'fill' ? 'fill' : 'surface'];
  const networkReady =
    !network ||
    (ways.u.length >= netMin &&
      ways.u.length <= netMax &&
      ways.v.length >= netMin &&
      ways.v.length <= netMax &&
      Number(tolerance) >= cadCurveNetwork.toleranceMm[0] &&
      Number(tolerance) <= cadCurveNetwork.toleranceMm[1]);
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
            onChange={(e) => setKind(e.target.value as 'boundarySurface' | 'fill' | 'curveNetwork')}
          >
            <option value="boundarySurface">Boundary surface (3 or 4 curves)</option>
            <option value="fill">Fill (3 to 16 curves)</option>
            <option value="curveNetwork">Curve network (2 to 16 each way)</option>
          </select>
        </label>
        {network && (
          <>
            <p>
              Choose the curves along (u) in order, and mark the curves across (v), also in order.
              Each curve along must cross each curve across.
            </p>
            <label className="ep-field">
              Meeting tolerance (mm)
              <input
                type="number"
                step="any"
                value={tolerance}
                onChange={(e) => setTolerance(e.target.value)}
              />
            </label>
          </>
        )}
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
                  {at >= 0 && !network && <small> (curve {at + 1})</small>}
                  {at >= 0 && network && (
                    <small>
                      {' '}
                      ({across.has(key) ? 'v' : 'u'}{' '}
                      {(across.has(key) ? ways.v : ways.u).indexOf(key) + 1})
                    </small>
                  )}
                </label>
                {network && at >= 0 && (
                  <label className="cad-check">
                    <input
                      type="checkbox"
                      checked={across.has(key)}
                      onChange={(e) =>
                        setAcross((t) => {
                          const next = new Set(t);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    Across (v)
                  </label>
                )}
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
            disabled={chosen.length < min || chosen.length > max || !networkReady}
            onClick={async () => {
              if (network) {
                const of = (keys: string[]) => keys.map((key) => options.get(key)!.curve);
                if (await controller.addCurveNetwork(of(ways.u), of(ways.v), Number(tolerance)))
                  onClose();
                return;
              }
              const curves = chosen.map((key) => ({
                curve: options.get(key)!.curve,
                continuity: kind === 'fill' && tangent.has(key) ? ('G1' as const) : ('G0' as const),
              }));
              if (await controller.addBoundary(kind, curves)) onClose();
            }}
          >
            Create {kind === 'fill' ? 'fill' : network ? 'curve network' : 'boundary surface'}
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

const profileKindLabels: Record<CadProfileKind, string> = {
  hat: 'Hat (flanges out at its open side)',
  z: 'Z (a flange each way)',
  channel: 'Channel (no flanges)',
  flat: 'Flat plate (a closure)',
};
const profileUpLabels = {
  normal: "Along the path sketch's normal",
  inPlane: "Across the path, in the sketch's plane",
} as const;

/**
 * CR4d: a member: a hat, Z, channel or flat section by its dimensions, swept along the open chain
 * of a sketch into a new sheet.
 */
function MemberDialog({
  controller,
  doc,
  onClose,
}: {
  controller: CadController;
  doc: CadDocument;
  onClose: () => void;
}) {
  const [path, setPath] = useState(doc.sketches[0]?.id ?? '');
  const [kind, setKind] = useState<CadProfileKind>('hat');
  const [height, setHeight] = useState('30');
  const [width, setWidth] = useState('40');
  const [flange, setFlange] = useState('15');
  const [radius, setRadius] = useState('3');
  const [up, setUp] = useState<'normal' | 'inPlane'>('normal');
  const [flip, setFlip] = useState(false);
  const values = [height, width, flange, radius].map(Number);
  const ok =
    !!path && values.every((v) => Number.isFinite(v) && v >= 0) && values[0]! > 0 && values[1]! > 0;
  return (
    <Dialog title="Member" onClose={onClose}>
      <div className="cad-export">
        <p>
          A sheet of a section carried along the open chain the path sketch draws: a hat opens
          towards its flanges, so two hats facing each other (one flipped) meet on their flanges.
        </p>
        <label className="ep-field">
          Path
          <select value={path} onChange={(e) => setPath(e.target.value)}>
            {doc.sketches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ep-field">
          Section
          <select value={kind} onChange={(e) => setKind(e.target.value as CadProfileKind)}>
            {cadProfileKinds.map((k) => (
              <option key={k} value={k}>
                {profileKindLabels[k]}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Height (mm)" value={height} onChange={setHeight} />
        <NumberField label="Width (mm)" value={width} onChange={setWidth} />
        <NumberField label="Flange width (mm)" value={flange} onChange={setFlange} />
        <NumberField label="Bend R (mm)" value={radius} onChange={setRadius} />
        <label className="ep-field">
          Height points
          <select value={up} onChange={(e) => setUp(e.target.value as 'normal' | 'inPlane')}>
            <option value="normal">{profileUpLabels.normal}</option>
            <option value="inPlane">{profileUpLabels.inPlane}</option>
          </select>
        </label>
        <label className="cad-check">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} />
          Flip (the other way)
        </label>
        <div className="cad-row">
          <button
            type="button"
            disabled={!ok}
            onClick={async () => {
              const [heightMm, widthMm, flangeMm, radiusMm] = values as [
                number,
                number,
                number,
                number,
              ];
              if (
                await controller.addProfileSweep(
                  path,
                  { kind, heightMm, widthMm, flangeMm, radiusMm },
                  up,
                  flip,
                )
              )
                onClose();
            }}
          >
            Create member
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
  shown,
  onToggle,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  narrow: boolean;
  /** Bodies drawn in the viewport now. */
  shown: ReadonlySet<string>;
  /** Shows or hides a body in the viewport only: never an edit, so readOnly allows it too. */
  onToggle(id: string): void;
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
  const [making, setMaking] = useState<'loft' | 'sweep' | 'member' | 'surface' | 'boundary'>();
  const button = (
    kind: 'body' | 'feature' | 'parameter',
    id: string,
    label: string,
    extra?: string,
  ) => (
    <button
      type="button"
      className="cad-item"
      aria-pressed={selection?.kind === kind && selection.id === id}
      onClick={() => controller.select({ kind, id })}
    >
      {label}
      {extra && <small>{extra}</small>}
    </button>
  );
  const item = (...args: Parameters<typeof button>) => <li key={args[1]}>{button(...args)}</li>;
  const active = doc.bodies.filter((b) => b.state === 'active');
  const values = parameterValues(doc);
  return (
    <nav className="cad-navigator" aria-label="CAD elements">
      <Section title={`Bodies (${active.length})`}>
        <ul aria-label="Bodies">
          {active.map((b) => {
            const on = shown.has(b.id);
            const Icon = on ? Eye : EyeOff;
            // A body of several disjoint solids says so, so a body is not read as one member (#538).
            const solids = solidCount(snapshot, b.id);
            return (
              <li key={b.id} className="cad-body-row">
                {button(
                  'body',
                  b.id,
                  b.name,
                  solids ? `${fmtGrouped(solids, 0)} solids` : undefined,
                )}
                <label className="cad-eye" title={on ? 'Hide in the view' : 'Show in the view'}>
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={`Show ${b.name}`}
                    onChange={() => onToggle(b.id)}
                  />
                  <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                </label>
              </li>
            );
          })}
        </ul>
      </Section>
      {!!doc.spotWelds?.length && <SpotWeldList controller={controller} snapshot={snapshot} />}
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
                onClick={() => setMaking('member')}
              >
                Member…
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
        {making === 'member' && (
          <MemberDialog controller={controller} doc={doc} onClose={() => setMaking(undefined)} />
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
      placing && assembly && format === 'glb'
        ? await assembly.exportGlb()
        : format !== 'step'
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
              onChange={() => (setFormat('glb'), reset())}
            />
            {placing
              ? 'GLB (each placed part’s display mesh at its pose, with colours, metres, Y-up)'
              : 'GLB (display mesh with colours, metres, Y-up)'}
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
              : 'STEP (AP214, exact solids or surfaces, one per body, millimetres; AP242 when kept PMI is written)'}
          </label>
          {placing && (
            <p className="cad-muted">An assembly is written as STEP or as GLB (not STL).</p>
          )}
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
        {ready?.report.format === 'step' && ready.bytes.byteLength > cadLimits.stepBytes && (
          // WM5c: written up to `stepExportBytes`, read only up to `stepBytes`.
          <p className="cad-muted" role="note">
            This file is larger than 16 MiB: other CAD tools can open it, but this editor cannot
            import it back.
          </p>
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
  pmi: 'PMI the import could not keep (saved views, presentation it could not tie to a kept item, or items it could not match to a part)',
  nesting: 'nested sub-assemblies (flattened; each path stays in the component name)',
};
const pmiFamilyText: Record<string, string> = {
  dimension: 'Dimensions',
  'geometric-tolerance': 'Geometric tolerances',
  datum: 'Datums',
  'datum-target': 'Datum targets',
  'datum-feature': 'Datum features',
  'datum-system': 'Datum systems',
  callout: 'Callouts',
  annotation: 'Annotations (presentation)',
  view: 'Saved views',
  'component-path': 'References through an assembly path',
  other: 'Other PMI entities',
};
const pmiAxisText: Record<string, string> = {
  semantic: 'meaning matches the file',
  target: 'on as many faces or edges as in the file',
  presentation: 'presentation',
  view: 'saved views',
  path: 'read through an assembly path (own reader)',
  unsupported: 'not checked by this kernel',
};
/** PMI-2: the semantic PMI the import keeps on its parts, by kind. */
function PmiKeptRow({ kept }: { kept: CadStepPmiReport['kept'] }) {
  const counts = (Object.entries(kept) as [string, number][]).filter(([, n]) => n > 0);
  return (
    <>
      <dt>PMI kept</dt>
      <dd>
        {counts.length
          ? counts
              .map(
                ([kind, n]) =>
                  `${(pmiFamilyText[kind] ?? kind).toLowerCase()}: ${fmtGrouped(n, 0)}`,
              )
              .join(', ')
          : 'None'}
      </dd>
    </>
  );
}
/**
 * PMI-1/PMI-2 (docs/cad/pmi.md, PMI-U3): the import keeps the semantic PMI it verified on one
 * part, and asks before it imports a file of which it would keep less. The dialog lists what the
 * file holds, what the kernel read and what it would keep; only an explicit choice imports the
 * file without the rest. The original file is kept either way.
 */
function StepPmiDialog({
  fileName,
  report,
  onCancel,
  onDiscard,
}: {
  fileName: string;
  report: CadStepPmiReport;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const census = Object.entries(report.census) as [string, number][];
  return (
    <Dialog title="STEP with PMI" onClose={onCancel}>
      <div className="cad-export">
        <p>
          {fileName} has product manufacturing information (PMI) that this version cannot keep in
          full. It keeps the dimensions, tolerances, datums and datum targets that match the file
          and sit on one part, with the presentation lines of the callouts that show them; saved
          views and the rest are not kept. The original file is kept unchanged with the document.
        </p>
        <dl className="cad-export-report" aria-label="PMI in the file">
          {census.length ? (
            census.map(([family, n]) => (
              <Fragment key={family}>
                <dt>{pmiFamilyText[family] ?? family}</dt>
                <dd>{fmtGrouped(n, 0)} in the file</dd>
              </Fragment>
            ))
          ) : (
            <>
              <dt>PMI</dt>
              <dd>Parts of PMI items only</dd>
            </>
          )}
        </dl>
        <dl className="cad-export-report" aria-label="PMI kept">
          <PmiKeptRow kept={report.kept} />
        </dl>
        <table className="cad-compare cad-pmi-read" aria-label="PMI read">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Checked</th>
              <th scope="col">In file</th>
              <th scope="col">Read</th>
              <th scope="col">Not read</th>
            </tr>
          </thead>
          <tbody>
            {report.axes.map((a) => (
              <tr key={`${a.axis}-${a.family}`}>
                <td>{pmiFamilyText[a.family] ?? a.family}</td>
                <td>{pmiAxisText[a.axis] ?? a.axis}</td>
                <td>{fmtGrouped(a.inFile, 0)}</td>
                <td>{fmtGrouped(a.read, 0)}</td>
                <td>{fmtGrouped(a.unread, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {report.complete
            ? 'Every PMI item was read and matched the file on the checks above, but not all of it can be kept.'
            : 'Some PMI could not be read or checked; only what is listed as kept is kept.'}{' '}
          Agreeing here does not cover exports: an exported file will not carry this PMI.
        </p>
        <div className="cad-row">
          <button type="button" onClick={onDiscard}>
            Import with the PMI that is kept
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
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
          {report.pmi && <PmiKeptRow kept={report.pmi.kept} />}
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
          <dd>
            {report.maxToleranceMm.toExponential(2)} mm
            {report.maxToleranceMm > preview.resultLimitMm &&
              ` (above this document's limit of ${preview.resultLimitMm} mm: the body can be placed, measured and exported, but not used in Booleans or other features)`}
          </dd>
          <dt>Healing</dt>
          <dd>None (the solid is kept as read)</dd>
          {report.pmi && <PmiKeptRow kept={report.pmi.kept} />}
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
  /**
   * "none" when the Host shows its own role=status around the Surface: the Surface's notices
   * stay polite live regions without the role. By default they are role=status named
   * "CAD の状態" (the measure panel "Distance").
   */
  statusRole?: CadStatusRole;
}
export function CadSurface({ statusRole = 'status', ...props }: CadSurfaceProps) {
  return (
    <StatusRoleContext.Provider value={statusRole}>
      <Surface {...props} />
    </StatusRoleContext.Provider>
  );
}
function Surface({
  controller,
  hostHistory,
  name = 'cad',
  onExportPng,
  onExportFile,
  onExportCsv,
  gpuBytes,
  assembly,
}: Omit<CadSurfaceProps, 'statusRole'>) {
  const [exportingFile, setExportingFile] = useState(false);
  const [rendering, setRendering] = useState(false);
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
  // Private view state: which named view is shown. Opens with the first one that shows every
  // body, otherwise with the whole model (SU2).
  const [viewId, setShownViewId] = useState<string | null>(
    () =>
      initialView(
        snapshot.content.namedViews,
        new Set(snapshot.content.bodies.filter((b) => b.state === 'active').map((b) => b.id)),
      )?.id ?? null,
  );
  // Undo of Save view, or another edit, removed the view shown: keep the camera, show all bodies.
  const shownView = snapshot.content.namedViews.some((v) => v.id === viewId) ? viewId : null;
  // Bodies the eye in the Bodies list showed or hid against the view: choosing a view resets it.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const setViewId = (id: string | null) => {
    setShownViewId(id);
    setToggled(new Set());
  };
  const toggleBody = (id: string) =>
    setToggled((t) => {
      const next = new Set(t);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const shownIds = shownBodies(snapshot.content, shownView, toggled);
  async function saveView() {
    const current = view.current?.currentView();
    const bodyIds = shownIds;
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
  /** Whether the view shows the confirmed content now; reports why not. PNG and Render (#664). */
  function pictureReady(): boolean {
    const refuse = (message: string) => (controller.report(message), false);
    // The Host guard flushes pending inputs first; a field it commits starts a new evaluation.
    try {
      guardExport?.();
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
    const now = controller.getSnapshot();
    if (now.reference) return refuse(describeCode('kernel-reference-only'));
    if (mismatched(now)) return refuse(describeCode('assembly-pose-mismatch'));
    // A joint being made shows poses that are not content (R2b-2c).
    if (assembly?.getSnapshot().creating) return refuse(describeCode('joint-creating'));
    if (now.busy || !now.meshes?.current || now.geometryState !== 'ready')
      return refuse('形状を計算中です。計算が終わってから、もう一度操作してください。');
    if (!drawn) return refuse(describeCode('png-not-drawn'));
    // A drag shows a placement that is not committed (and Escape may still cancel it).
    if (view.current?.dragging || view.current?.draggingJoint)
      return refuse(
        view.current.dragging
          ? 'bodyを移動している途中です。離すかEscapeで取り消してから、もう一度操作してください。'
          : 'jointを動かしている途中です。離すかEscapeで取り消してから、もう一度操作してください。',
      );
    return true;
  }
  async function exportPng(background: boolean) {
    if (!pictureReady()) return;
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
  /** PMI-1: a file whose PMI the import would not keep, waiting for the user's choice. */
  const [pmiConsent, setPmiConsent] = useState<{
    fileName: string;
    bytes: Uint8Array;
    report: CadStepPmiReport;
  }>();
  async function importStep(file: File) {
    // Refused before reading, so a very large file is never held in memory.
    if (file.size > cadLimits.stepBytes) return controller.report(describeCode('step-too-large'));
    await readStep(file.name, new Uint8Array(await file.arrayBuffer()));
  }
  async function readStep(fileName: string, bytes: Uint8Array, pmi?: 'discard') {
    const onPmi = (report: CadStepPmiReport) => setPmiConsent({ fileName, bytes, report });
    const options = pmi ? { pmi, onPmi } : { onPmi };
    // A file with assembly usages (R2b-5), as the kernel's scan finds them, goes to the assembly.
    await controller.prepareStepImport(fileName, bytes, {
      ...options,
      ...(assembly ? { assembly: () => assembly.prepareStepImport(fileName, bytes, options) } : {}),
    });
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
                  icon={Cog}
                  label="Add gear"
                  reason="Involute spur gear: module, teeth, bore and spoke windows"
                  disabled={disabled}
                  onClick={() => void controller.addGear()}
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
                  disabled={disabled || !shownIds.length}
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
                <IconButton
                  icon={Aperture}
                  label="Render image"
                  reason="Path-traced still image of this view; available when the shape is up to date and drawn"
                  disabled={!pngExportable}
                  onClick={() => pictureReady() && setRendering(true)}
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
            <Navigator
              controller={controller}
              snapshot={snapshot}
              narrow={narrow}
              shown={new Set(shownIds)}
              onToggle={toggleBody}
            />
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
              <Inspector controller={controller} snapshot={snapshot} assembly={assembly} />
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
          toggled={toggled}
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
      {pmiConsent && (
        <StepPmiDialog
          fileName={pmiConsent.fileName}
          report={pmiConsent.report}
          onCancel={() => setPmiConsent(undefined)}
          onDiscard={() => {
            setPmiConsent(undefined);
            void readStep(pmiConsent.fileName, pmiConsent.bytes, 'discard');
          }}
        />
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
      {rendering && (
        <PathRenderDialog
          name={name}
          source={() => view.current?.renderSource()}
          onSavePng={onExportPng && ((png) => onExportPng(png, { background: true }))}
          onClose={() => setRendering(false)}
        />
      )}
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

/**
 * CR3d: the gap and flush between two bodies' border edges. The picked edge becomes the first
 * edge; picking another body's edge then measures from the first to it.
 */
function GapFlushSection({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const view = snapshot.gapFlush;
  const s = snapshot.selection;
  const picked = s?.kind === 'edge' ? { bodyId: s.id, pick: s.pick } : undefined;
  const isFirst = view && picked?.bodyId === view.from.bodyId && picked.pick === view.from.pick;
  const other = view && picked && picked.bodyId !== view.from.bodyId;
  const ready = snapshot.meshes?.current === true;
  return (
    <Section title="Gap and flush">
      <p className="cad-muted">
        Measures from one surface body&apos;s border edge to another&apos;s at {cadGapFlush.samples}{' '}
        points along the first edge: the gap across it in its face, and the flush along its
        face&apos;s normal. Display only.
      </p>
      {view && !isFirst && (
        <p>
          First edge: {view.from.bodyId}, edge {view.from.pick}.
        </p>
      )}
      <button
        type="button"
        disabled={!ready || isFirst || view?.status === 'running'}
        onClick={() => controller.chooseGapFlushEdge()}
      >
        Gap from this edge
      </button>{' '}
      {other && (
        <button
          type="button"
          disabled={!ready || view.status === 'running'}
          onClick={() => void controller.measureGapFlush()}
        >
          {view.status === 'running' ? 'Measuring…' : 'Measure gap and flush to this edge'}
        </button>
      )}
    </Section>
  );
}

/**
 * CR4e: a spot weld row from the picked face. The picked face becomes the first flange; picking
 * another body's face then makes the row along the first flange's centre line.
 */
function SpotWeldSection({
  controller,
  snapshot,
  editable,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
  editable: boolean;
}) {
  const L = cadSpotWeldLimits;
  const [pitch, setPitch] = useState(String(L.defaultPitchMm));
  const [end, setEnd] = useState(String(L.defaultEndDistanceMm));
  const [gap, setGap] = useState(String(L.defaultMaxGapMm));
  const start = snapshot.weldStart;
  const s = snapshot.selection;
  const picked = s?.kind === 'face' ? { bodyId: s.id, pick: s.pick } : undefined;
  const isFirst = start && picked?.bodyId === start.bodyId && picked.pick === start.pick;
  const other = start && picked && picked.bodyId !== start.bodyId;
  const name = (id: string) => snapshot.content.bodies.find((b) => b.id === id)?.name ?? id;
  return (
    <Section title="Spot welds" open={!!start}>
      <p className="cad-muted">
        Places weld points along the first flange&apos;s centre line, a pitch apart, and measures
        each to the second flange. Points further than the largest gap are drawn red.
      </p>
      {start && !isFirst && (
        <p data-testid="cad-weld-start">
          First flange: {name(start.bodyId)}, face {start.pick}.
        </p>
      )}
      <button
        type="button"
        disabled={!editable || isFirst}
        onClick={() => controller.chooseWeldFlange()}
      >
        {isFirst ? 'First flange chosen' : 'Weld from this flange'}
      </button>
      {other && (
        <>
          <NumberField label="Pitch (mm)" value={pitch} onChange={setPitch} />
          <NumberField label="From the ends (mm)" value={end} onChange={setEnd} />
          <NumberField label="Largest gap (mm)" value={gap} onChange={setGap} />
          <button
            type="button"
            disabled={!editable || !positive(pitch) || !positive(gap) || !(Number(end) >= 0)}
            onClick={() =>
              void controller.weldToPickedFace(Number(pitch), Number(end), Number(gap))
            }
          >
            Weld to this flange
          </button>
        </>
      )}
    </Section>
  );
}

/** CR4e: the document's spot weld rows, each with its points, gaps and values to change. */
function SpotWeldList({
  controller,
  snapshot,
}: {
  controller: CadController;
  snapshot: CadSnapshot;
}) {
  const welds = snapshot.content.spotWelds ?? [];
  return (
    <Section title={`Spot welds (${welds.length})`}>
      <ul aria-label="Spot welds" className="cad-weld-list">
        {welds.map((w) => (
          <SpotWeldRow
            key={w.id}
            controller={controller}
            weld={w}
            points={snapshot.spotWelds?.find((p) => p.id === w.id)}
            editable={!snapshot.readOnly && snapshot.canEdit}
            bodyName={(id) => snapshot.content.bodies.find((b) => b.id === id)?.name ?? id}
          />
        ))}
      </ul>
    </Section>
  );
}

function SpotWeldRow({
  controller,
  weld,
  points,
  editable,
  bodyName,
}: {
  controller: CadController;
  weld: CadSpotWeld;
  points: CadSpotWeldPoints | undefined;
  editable: boolean;
  bodyName: (id: string) => string;
}) {
  const [pitch, setPitch] = useState(String(weld.pitchMm));
  const [end, setEnd] = useState(String(weld.endDistanceMm));
  const [gap, setGap] = useState(String(weld.maxGapMm));
  useEffect(() => {
    setPitch(String(weld.pitchMm));
    setEnd(String(weld.endDistanceMm));
    setGap(String(weld.maxGapMm));
  }, [weld.pitchMm, weld.endDistanceMm, weld.maxGapMm]);
  const changed =
    Number(pitch) !== weld.pitchMm ||
    Number(end) !== weld.endDistanceMm ||
    Number(gap) !== weld.maxGapMm;
  return (
    <li data-testid={`cad-weld-${weld.id}`}>
      <strong>{weld.name}</strong>{' '}
      <span className="cad-muted">
        {bodyName(weld.flanges[0].bodyId)} → {bodyName(weld.flanges[1].bodyId)}
      </span>
      <p data-testid="cad-weld-points">
        {!points
          ? 'Points are made when the shape is evaluated.'
          : points.status === 'ok'
            ? `${points.gaps.length} points along ${fmt(points.lengthMm)} mm, ${points.tooFar} too far (largest gap ${fmt(Math.max(0, ...points.gaps))} mm)`
            : describeCode(points.code)}
      </p>
      <NumberField label="Pitch (mm)" value={pitch} onChange={setPitch} />
      <NumberField label="From the ends (mm)" value={end} onChange={setEnd} />
      <NumberField label="Largest gap (mm)" value={gap} onChange={setGap} />
      <button
        type="button"
        disabled={!editable || !changed}
        onClick={() =>
          void controller.updateSpotWeld(weld.id, {
            pitchMm: Number(pitch),
            endDistanceMm: Number(end),
            maxGapMm: Number(gap),
          })
        }
      >
        Apply
      </button>{' '}
      <button
        type="button"
        disabled={!editable}
        onClick={() => void controller.removeSpotWeld(weld.id)}
      >
        Remove
      </button>
    </li>
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
