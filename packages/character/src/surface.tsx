import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { FileDown, FileUp, Pause, Play, Redo2, Square, Undo2 } from 'lucide-react';
import {
  applyCharacterOperation,
  characterContentHash,
  characterCubePart,
  characterMaterialImage,
  characterEditorCommand,
  characterHistoryOverflow,
  characterIds,
  characterMeshEdit,
  characterBindMesh,
  characterSkinBind,
  characterSkinUnbind,
  characterMorphAdd,
  characterMorphedMesh,
  characterMorphShape,
  characterMorphRemove,
  characterSkinWeights,
  characterWeightBones,
  freshCharacterId,
  identityTransform,
  poseAt,
  restMatrices,
  worldMatrices,
  type CharacterAssetRef,
  type CharacterDocument,
  type CharacterJointValueKey,
  type CharacterKeyAddress,
  type CharacterOperation,
  type CharacterTrackTarget,
  type Vec3,
  exportGlb,
  GltfExportError,
} from '@editor-platform/character-core';
import type { EditorSession } from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
} from '@editor-platform/editor-ui';
import { checkCharacterAssets, decodeCharacterAssets } from './assets';
import { DopeSheet } from './dope-sheet';
import { BoneInspector, boneTree } from './bone-inspector';
import { BoneOverlay, type ShownBone } from './bone-overlay';
import { PoseInspector } from './pose-inspector';
import {
  IkInspector,
  IkOverlay,
  bonesAbove,
  ikDropOperation,
  liveChains,
  type ShownIkHandle,
} from './ik-inspector';
import { WeightJobs } from './weights-job';
import {
  WeightOverlay,
  WeightPaintInspector,
  brushSegment,
  defaultBrush,
  facingVertices,
  followView,
  type ShownWeight,
  type WeightBrush,
} from './weight-paint';
import { PropInspector } from './prop-inspector';
import {
  missingJoints,
  propFrames,
  type CharacterPropChoice,
  type CharacterPropView,
  type PropFrame,
} from './props';
import { characterFrame, prepareMesh, type PartFrame, type PreparedMesh } from './frame';
import {
  advance,
  choose,
  formatTicks,
  pause,
  play,
  restPlayback,
  seek,
  stop,
  ticksPerSecond,
  type Playback,
} from './playback';
import { CharacterViewport, type CharacterImages } from './viewport';
import {
  MeshEditError,
  boneWeightsOf,
  cornerNormals,
  paintWeights,
  subdividedFaceCount,
  subdivisionLimits,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';
import {
  cageInput,
  cageMirror,
  emptySelection,
  liveSelection,
  overlayGeometry,
  pickElement,
  pickKnifePoint,
  previewMove,
  shapeMove,
  runKnife,
  runMeshOperation,
  selectAll,
  selectLoop,
  selectionCenter,
  toggle,
  uvLayout,
  type KnifePick,
  type MeshOperation,
  type MeshSelection,
} from './mesh-edit';
import { KnifeLine } from './knife-view';
import { MeshInspector } from './mesh-inspector';
import { MorphInspector, morphWeightOperation } from './morph-inspector';
import { cageOverlay, disposeOverlay } from './mesh-overlay';
import { gizmoHandles, type GizmoAxis } from './gizmo';
import { MeshGizmo } from './gizmo-view';
import { SubdivisionJobs } from './subdivision-job';
import { MaterialMaps } from './material-maps';

/** A part's smoothed display mesh, per cage and level (C3i). */
type Smoothed =
  | { state: 'pending' }
  | { state: 'ready'; mesh: PreparedMesh }
  | { state: 'refused'; message: string };

/** What the Host's importer reported for the shown document. */
export interface CharacterImportReport {
  fileName: string;
  losses: string[];
  /** VRM terms of use, shown as they are; the Host decides what they allow. */
  vrm?: { version: '0' | '1'; meta: Record<string, string> };
}
export interface CharacterSurfaceProps {
  session: EditorSession<CharacterDocument>;
  /** Asset bytes by asset ID, kept by the Host; checked against the document before use. */
  assets: ReadonlyMap<string, Uint8Array>;
  readOnly?: boolean;
  /** Trusted edit authority, re-read when an edit applies. Default: not read-only. */
  canEdit?: () => boolean;
  /** Offered as "Import glTF or VRM" when given; the Host reads the file and replaces the view. */
  onImport?(file: File): void;
  /**
   * C6d: offered as "Export GLB" when given. The Surface writes the document as it is (with its
   * assets) and hands the file to the Host to save; what glTF cannot hold is listed beside it.
   */
  onExport?(file: { name: string; bytes: Uint8Array; losses: string[] }): void;
  /** The Host's refusal of the last import, shown as an alert. */
  importError?: string;
  report?: CharacterImportReport;
  /**
   * Each drawn frame, for a Host's diagnostics and the browser tests; `view` projects points
   * (millimetres, world) to the view's pixels with the camera as it is when called.
   */
  onFrame?(
    frame: readonly PartFrame[],
    playback: Playback,
    props: readonly PropFrame[],
    view: CharacterViewProbe,
  ): void;
  /** Called with the new content after each edit the Surface applied, for the Host to save. */
  onApplied?(content: CharacterDocument): void;
  /**
   * Host admission before an edit applies: called with the content the edit would make, throws
   * to refuse it (for example when the Host could no longer save it). Nothing changes then.
   */
  admit?(next: CharacterDocument): void;
  /**
   * C2b: what the Host made of each prop's version, by prop ID. Without it props are listed
   * and edited but not drawn.
   */
  props?: ReadonlyMap<string, CharacterPropView>;
  /** Saved versions offered as props; with `onAddProp`, shown as "Add prop". */
  propChoices?: readonly CharacterPropChoice[];
  /** The Host keeps the version with the character, then adds the prop as one edit. */
  onAddProp?(choice: CharacterPropChoice): void;
  /**
   * C3: keeps a new mesh asset's bytes (saved) before the content names them; resolves when
   * kept, rejects to refuse. With it, parts can be added and their meshes edited.
   */
  onMeshAsset?(asset: { ref: CharacterAssetRef; bytes: Uint8Array }): Promise<void>;
  /** Host history; without it the Surface shows its own Undo and Redo over the session. */
  onUndo?(): void;
  onRedo?(): void;
}

/** Projects world points (x, y, z, … in millimetres) to view pixels `[x, y, depth]`. */
export interface CharacterViewProbe {
  project(points: readonly number[]): [number, number, number][];
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Up to this many vertices, a painted part shows a weight dot on each facing vertex. */
const weightDotLimit = 5000;

/** C1 viewer: shows a character, plays its actions (play, pause, stop, seek) and hides parts. */
export function CharacterSurface(props: CharacterSurfaceProps) {
  const { session, assets, readOnly = false } = props;
  // `session.content` is a fresh copy on every read: read it once per session and revision, so
  // a Host's own Undo or a new session shows on the next render without re-reading each frame.
  const [, setRendered] = useState(0);
  const refresh = () => setRendered((n) => n + 1);
  const sequence = session.revision.sequence;
  const doc = useMemo(() => session.content, [session, sequence]);
  // Every revision is a new copy, so key the byte decoding on the asset records' content: an
  // edit that leaves the assets alone (visibility, a material) keeps the meshes, images and
  // camera. Whether those meshes fit the document is checked again for every document.
  const assetKey = JSON.stringify(doc.assets);
  // Bytes this Surface handed the Host for a mesh edit, by SHA-256: used until the Host's map
  // has them, so the edited part never flashes as missing.
  const staged = useRef(new Map<string, Uint8Array>());
  const [stagedCount, setStagedCount] = useState(0);
  // Staged bytes are dropped once the Host's map has them, and with the session they were for.
  useEffect(() => {
    for (const ref of doc.assets) if (assets.has(ref.id)) staged.current.delete(ref.sha256);
  }, [assets, assetKey]);
  useEffect(() => () => staged.current.clear(), [session]);
  const allAssets = useMemo(() => {
    if (!staged.current.size) return assets;
    const out = new Map(assets);
    for (const ref of doc.assets)
      if (!out.has(ref.id)) {
        const b = staged.current.get(ref.sha256);
        if (b) out.set(ref.id, b);
      }
    return out;
  }, [assets, assetKey, stagedCount]);
  const decoded = useMemo(
    () => decodeCharacterAssets(doc.assets, allAssets),
    [assetKey, allAssets],
  );
  const read = useMemo(() => checkCharacterAssets(doc, decoded), [doc, decoded]);
  /** C6d: the last export's file name and losses, or why it was refused. */
  const [exported, setExported] = useState<
    { name: string; losses: string[] } | { error: string }
  >();
  const exportFile = () => {
    const content = session.content;
    try {
      const images = new Map([...decoded.images].map(([id, x]) => [id, x.bytes]));
      const out = exportGlb(content, decoded.meshes, images);
      const name = `${content.name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_').trim() || 'character'}.glb`;
      props.onExport?.({ name, ...out });
      setExported({ name, losses: out.losses });
    } catch (e) {
      if (!(e instanceof GltfExportError)) throw e;
      setExported({ error: e.message });
    }
  };
  const prepared = useMemo(() => {
    const out = new Map<string, PreparedMesh>();
    for (const [id, mesh] of decoded.meshes) out.set(id, prepareMesh(mesh));
    return out;
  }, [decoded]);
  // C3 mesh edit mode: the chosen part, whether its cage is being edited, the selection (view
  // state, never an edit), mirror editing, and a running edit (the Host is keeping its bytes).
  const [partId, setPartId] = useState<string>();
  const [editing, setEditing] = useState(false);
  /** C6b: the morph whose shape mesh editing changes (undefined edits the mesh itself). */
  const [shapeMorph, setShapeMorph] = useState<string>();
  // A selection belongs to the cage (asset SHA-256) it was made on: indices mean nothing on
  // another one, so an Undo or Redo to another cage shows none.
  const [selectionState, setSelectionState] = useState<{ sel: MeshSelection; cage?: string }>(
    () => ({ sel: emptySelection('face') }),
  );
  const selection = selectionState.sel;
  const [symmetry, setSymmetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const part = doc.parts.find((p) => p.id === partId);
  const cageSha = part ? doc.assets.find((a) => a.id === part.mesh)?.sha256 : undefined;
  const setSelection = (
    next: MeshSelection | ((s: MeshSelection) => MeshSelection),
    cage: string | undefined = cageSha,
  ) =>
    setSelectionState((prev) => ({
      sel: typeof next === 'function' ? next(prev.sel) : next,
      ...(cage ? { cage } : {}),
    }));
  const meshEditing = editing && !!part && !!props.onMeshAsset && !readOnly;
  // C5c weight painting: on a bound part, in the rest pose (where its weights are painted).
  const [painting, setPainting] = useState(false);
  const paintSkin = part ? doc.skins.find((k) => k.partId === part.id) : undefined;
  const paintOn = painting && !!paintSkin && !!props.onMeshAsset && !readOnly && !meshEditing;
  const restView = meshEditing || paintOn;
  // C5d: an IK handle being dragged, previewed as the edit its drop would make.
  const [ikDrag, setIkDrag] = useState<{ handle: ShownIkHandle; point: Vec3 }>();
  /** C6a: a morph weight slider being dragged; previewed as the edit it makes when let go. */
  const [morphDrag, setMorphDrag] = useState<{ id: string; weight: number }>();
  // Subdivision (C3): parts with levels are drawn from a smoothed copy of their cage, under a
  // display-only mesh key; the document and its assets stay the cage. The smoothing runs in a
  // worker (C3i): until it is done the part shows its cage, with a note.
  const smoothed = useRef(new WeakMap<EpmMesh, Map<number, Smoothed>>());
  const jobs = useRef<SubdivisionJobs>(undefined);
  useEffect(() => {
    const j = new SubdivisionJobs();
    jobs.current = j;
    return () => {
      j.dispose();
      if (jobs.current === j) jobs.current = undefined;
    };
  }, []);
  const [smoothedCount, setSmoothedCount] = useState(0);
  const display = useMemo(() => {
    const meshes = new Map(prepared);
    const shownDoc = structuredClone(doc);
    const notes: string[] = [];
    const missing: { cage: EpmMesh; levels: number }[] = [];
    // The part whose cage is edited is shown as its cage is: no morph moves it off the overlay.
    // So is the part whose weights are painted: the dots sit on the shape the weights are for.
    // A morph's shape being edited is shown at weight 1, as the cage overlay shows it (C6b).
    if (restView)
      for (const m of shownDoc.morphs)
        if (m.partId === partId) m.weight = meshEditing && m.id === shapeMorph ? 1 : 0;
    // Display keys never name an asset of the document (or another display key).
    const taken = new Set(doc.assets.map((a) => a.id));
    const keys = new Map<string, string>();
    for (const part of shownDoc.parts) {
      const levels = part.subdivision?.levels ?? 0;
      const cage = decoded.meshes.get(part.mesh);
      if (!levels || !cage) continue;
      let key = keys.get(`${part.mesh} ${levels}`);
      if (!key) {
        key = `${part.mesh}~subdivided-${levels}`;
        while (taken.has(key)) key += '~';
        taken.add(key);
        keys.set(`${part.mesh} ${levels}`, key);
      }
      if (subdividedFaceCount(cage, levels) > subdivisionLimits.faces) {
        notes.push(`${part.name}: too many faces at level ${levels}; showing the cage`);
        continue;
      }
      const ready = smoothed.current.get(cage)?.get(levels);
      if (!ready || ready.state === 'pending') {
        if (!ready && !missing.some((m) => m.cage === cage && m.levels === levels))
          missing.push({ cage, levels });
        notes.push(`${part.name}: smoothing (level ${levels})…`);
        continue;
      }
      if (ready.state === 'refused') {
        notes.push(`${part.name}: ${ready.message}; showing the cage`);
        continue;
      }
      meshes.set(key, ready.mesh);
      part.mesh = key;
    }
    return { doc: shownDoc, meshes, notes, missing };
    // smoothedCount: a smoothing finished, so the cache has more.
  }, [prepared, decoded, doc, restView, partId, smoothedCount, meshEditing, shapeMorph]);
  useEffect(() => {
    for (const { cage, levels } of display.missing) {
      const cache = smoothed.current.get(cage) ?? new Map<number, Smoothed>();
      smoothed.current.set(cage, cache);
      if (cache.has(levels) || !jobs.current) continue;
      cache.set(levels, { state: 'pending' });
      jobs.current.run(cage, levels).then(
        (mesh) => {
          cache.set(levels, { state: 'ready', mesh: prepareMesh(mesh) });
          setSmoothedCount((n) => n + 1);
        },
        (e: unknown) => {
          if (e instanceof MeshEditError)
            cache.set(levels, { state: 'refused', message: e.message });
          // Cancelled (the view went away) or the worker failed: asked again next time.
          else cache.delete(levels);
          setSmoothedCount((n) => n + 1);
        },
      );
    }
  }, [display]);
  const images = useDecodedImages(decoded.images);
  const [playback, setPlayback] = useState<Playback>(() =>
    restPlayback(doc.actions[0]?.id ?? null),
  );
  // A new session starts over on its first action. This is set while rendering, so no frame
  // (and no camera fit) of the new document is ever computed with the old session's playhead.
  const [playbackSession, setPlaybackSession] = useState(session);
  if (playbackSession !== session) {
    setPlaybackSession(session);
    setPlayback((p) => choose(p, doc.actions[0]?.id ?? null));
  }
  // A replaced document (a re-import, or Undo/Redo across one) whose actions no longer include
  // the chosen one starts over on its own first action; edits that keep the action keep it.
  if (playback.actionId !== null && !doc.actions.some((a) => a.id === playback.actionId))
    setPlayback((p) => choose(p, doc.actions[0]?.id ?? null));
  const action = doc.actions.find((a) => a.id === playback.actionId) ?? null;
  const [failure, setFailure] = useState<string>();
  // The bones overlay subscribes to redraws once the view exists (its effect runs after ours).
  const [viewReady, setViewReady] = useState(false);
  const [editError, setEditError] = useState<string>();

  const host = useRef<HTMLDivElement>(null);
  /** The focusable view region (its keys are the view's). */
  const viewRegion = useRef<HTMLDivElement>(null);
  const viewport = useRef<CharacterViewport>(undefined);
  useEffect(() => {
    if (!host.current) return;
    try {
      viewport.current = new CharacterViewport(host.current, {
        onContextLost: () => setFailure('The 3D view lost its graphics context. Reload to retry.'),
        onPick: (x, y, additive) => pick.current(x, y, additive),
      });
      setViewReady(true);
    } catch {
      setFailure('3D view unavailable: WebGL could not start.');
    }
    return () => {
      viewport.current?.dispose();
      viewport.current = undefined;
      setViewReady(false);
    };
  }, []);
  // Another document (a new session) is framed again even when it reuses the same assets;
  // edits within one session keep the camera the user chose.
  useEffect(() => viewport.current?.refit(), [session]);
  // Structure (parts, materials, textures) rebuilds the meshes; the pose only moves corners.
  const shown = !read.problems.length;
  const shownParts = useRef<string>(undefined);
  useEffect(() => {
    // Fail closed: assets that do not match leave nothing of an earlier model on screen.
    const ids = doc.parts.map((p) => p.id).join(' ');
    if (shown)
      viewport.current?.show(display.doc, display.meshes, images, shownParts.current === ids);
    else viewport.current?.clearView();
    shownParts.current = shown ? ids : undefined;
  }, [shown, display, images, doc.parts, doc.materials]);
  /** The action of `d` with the playing action's ID (a preview's own copy of it). */
  const actionOf = (d: CharacterDocument) =>
    action ? (d.actions.find((a) => a.id === action.id) ?? null) : null;
  const ikPreview = (d: CharacterDocument): CharacterDocument => {
    if (!ikDrag) return d;
    const op = ikDropOperation(d, ikDrag.handle, ikDrag.point, action?.id, playback.tick);
    try {
      return op ? applyCharacterOperation(d, op) : d;
    } catch {
      return d;
    }
  };
  /** A morph slider's drag shows the edit its release makes (a key, or the weight). */
  const morphPreview = (d: CharacterDocument): CharacterDocument => {
    if (!morphDrag) return d;
    const op = morphWeightOperation(d, morphDrag.id, morphDrag.weight, action?.id, playback.tick);
    try {
      return op ? applyCharacterOperation(d, op) : d;
    } catch {
      return d;
    }
  };
  // Mesh edit mode shows the rest pose: the cage is edited where it is bound.
  const frame = useMemo(() => {
    if (!shown) return [];
    // An IK drag shows its drop's edit: the preview's own action (its keys) is sampled.
    // Applied to the document itself (the display copy names display-only meshes the
    // document's checks refuse); an IK edit changes only skeletons and actions.
    const previewed =
      restView || (!ikDrag && !morphDrag) ? undefined : morphPreview(ikPreview(doc));
    const shownDoc = previewed
      ? {
          ...display.doc,
          skeletons: previewed.skeletons,
          actions: previewed.actions,
          morphs: previewed.morphs,
        }
      : display.doc;
    const out = characterFrame(
      shownDoc,
      display.meshes,
      restView ? null : actionOf(shownDoc),
      restView ? 0 : playback.tick,
      !restView,
    );
    // A skinned part's cage is edited in bind space (where its vertices are): it is drawn there
    // too, not through its rest-pose joints, so the drawing, the overlay and picking agree.
    if (!restView || !display.doc.skins.some((k) => k.partId === partId)) return out;
    return out.map((p) => {
      if (p.partId !== partId) return p;
      const mesh = display.doc.parts.find((q) => q.id === partId)?.mesh;
      const prep = mesh ? display.meshes.get(mesh) : undefined;
      const d = prep?.display;
      if (!d) return p;
      // A morph's shape being edited (C6b) is drawn as the overlay shows it: at weight 1.
      const k =
        meshEditing && shapeMorph ? prep.mesh.morphs.findIndex((m) => m.id === shapeMorph) : -1;
      if (k < 0)
        return {
          ...p,
          positions: d.positions.slice(),
          normals: d.normals.slice(),
          flipped: new Uint8Array(p.flipped.length),
        };
      const positions = d.positions.slice();
      const deltas = d.morphPositions[k]!;
      for (let i = 0; i < positions.length; i++) positions[i]! += deltas[i]!;
      return {
        ...p,
        positions,
        normals: cornerNormals(characterMorphedMesh(prep.mesh, shapeMorph!)),
        flipped: new Uint8Array(p.flipped.length),
      };
    });
  }, [
    shown,
    display,
    action,
    playback.tick,
    restView,
    partId,
    ikDrag,
    morphDrag,
    doc,
    meshEditing,
    shapeMorph,
  ]);
  const views = props.props ?? noViews;
  const pose = useMemo(() => poseAt(doc, action, playback.tick), [doc, action, playback.tick]);
  // Props stand beside the character even when its own assets do not match.
  const shownProps = useMemo(() => propFrames(doc, views, pose), [doc, views, pose]);
  // A prop whose shape arrives later is framed then too, unless the camera was moved meanwhile.
  const readyProps = doc.props
    .filter((p) => views.get(p.id)?.status === 'ready')
    .map((p) => p.id)
    .join(' ');
  const lastReady = useRef(readyProps);
  useEffect(() => {
    const before = new Set(lastReady.current.split(' '));
    lastReady.current = readyProps;
    if (readyProps.split(' ').some((id) => id && !before.has(id)))
      viewport.current?.refitUnlessMoved();
  }, [readyProps]);
  const probe = useMemo<CharacterViewProbe>(
    () => ({
      project: (points) =>
        viewport.current?.project(Float32Array.from(points), identity) ??
        points.filter((_, i) => i % 3 === 0).map(() => [Number.NaN, Number.NaN, 2]),
    }),
    [],
  );
  const onFrame = useRef(props.onFrame);
  onFrame.current = props.onFrame;
  useEffect(() => {
    viewport.current?.draw(frame, shownProps);
    onFrame.current?.(frame, playback, shownProps, probe);
  }, [frame, shownProps, images, prepared]);

  // Real-time playback; the playhead is view state, never an edit.
  useEffect(() => {
    if (!playback.playing) return;
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      const elapsed = now - last;
      last = now;
      setPlayback((p) => advance(p, action, elapsed));
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [playback.playing, action]);
  // Space plays or pauses only while focus is inside this Surface (not in a field or button).
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const key = (e: KeyboardEvent) => {
      if (
        e.key !== ' ' ||
        e.defaultPrevented ||
        isTextInput(e.target) ||
        (e.target instanceof Element && e.target.closest('button,a,[role=button]'))
      )
        return;
      e.preventDefault();
      setPlayback((p) => (p.playing ? pause(p) : play(p, action)));
    };
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
  }, [action]);

  // Read when an edit applies, which may be after an await: the latest props decide.
  const authority = useRef({ readOnly, canEdit: props.canEdit });
  authority.current = { readOnly, canEdit: props.canEdit };
  const canEdit = () => !authority.current.readOnly && (authority.current.canEdit?.() ?? true);
  /** One operation as one session edit; a refusal is shown and changes nothing. */
  const edit = (op: CharacterOperation) => {
    let done = false;
    try {
      props.admit?.(applyCharacterOperation(session.content, op));
      session.execute(
        characterEditorCommand(op, {
          expectedHash: characterContentHash(session.content),
          canEdit,
        }),
      );
      setEditError(undefined);
      props.onApplied?.(session.content);
      done = true;
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    }
    refresh();
    return done;
  };
  const setVisible = (id: string, visible: boolean) =>
    edit({ type: 'setPartVisible', id, visible });

  // ---- C3: mesh editing ----
  const cage = part ? decoded.meshes.get(part.mesh) : undefined;
  // ---- C5b: binding a part with automatic weights (in a worker; Cancel stops it) ----
  const weightJobs = useRef<WeightJobs>(undefined);
  useEffect(() => {
    const j = new WeightJobs();
    weightJobs.current = j;
    return () => {
      j.dispose();
      if (weightJobs.current === j) weightJobs.current = undefined;
    };
  }, []);
  const [weighting, setWeighting] = useState<{ done: number; total: number }>();
  const [bindTo, setBindTo] = useState('');
  const partSkin = part ? doc.skins.find((k) => k.partId === part.id) : undefined;
  const bindPart = async () => {
    const skeletonId = doc.skeletons.some((s) => s.id === bindTo) ? bindTo : doc.skeletons[0]?.id;
    if (!part || !cage || !skeletonId || !weightJobs.current) return;
    const base = characterContentHash(session.content);
    const from = session;
    const at = session.content;
    let plan: ReturnType<typeof characterWeightBones>;
    try {
      plan = characterWeightBones(at, part.id, skeletonId);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    setWeighting({ done: 0, total: plan.bones.length });
    let weighted: EpmMesh;
    try {
      // A bound part's vertices live in character space (its transform applied once).
      const baked = characterBindMesh(at, part.id, cage);
      weighted = await weightJobs.current.run(baked, plan.bones, plan.boneIds, (done, total) =>
        setWeighting({ done, total }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setEditError(message === 'character-weights-cancelled' ? undefined : message);
      return;
    } finally {
      setWeighting(undefined);
      setBusy(false);
    }
    // The document may have changed while the weights were computed: they are for the old one.
    if (currentSession.current !== from || characterContentHash(session.content) !== base) {
      setEditError('character-base-mismatch');
      return;
    }
    let bind: ReturnType<typeof characterSkinBind>;
    try {
      bind = characterSkinBind(at, part.id, skeletonId, weighted);
    } catch (e) {
      // A degenerate bone (no inverse) or a mesh that does not encode: shown, nothing changes.
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    await commitAsset(bind, bind.op, base);
  };
  const unbindPart = () => {
    if (!partSkin || !cage) return;
    let un: ReturnType<typeof characterSkinUnbind>;
    try {
      un = characterSkinUnbind(doc, partSkin.id, cage);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      refresh();
      return;
    }
    void commitAsset(un, un.op, characterContentHash(session.content));
  };
  // ---- C6a: morphs (adding or removing one changes the part's mesh) ----
  const addMorph = () => {
    if (!part || !cage) return;
    const own = doc.morphs.filter((m) => m.partId === part.id).length;
    let add: ReturnType<typeof characterMorphAdd>;
    try {
      add = characterMorphAdd(doc, part.id, cage, `Morph ${own + 1}`);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    void commitAsset(add, add.op, characterContentHash(session.content));
  };
  const removeMorph = (id: string) => {
    if (!cage) return;
    let rm: ReturnType<typeof characterMorphRemove>;
    try {
      rm = characterMorphRemove(doc, id, cage);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return;
    }
    void commitAsset(rm, rm.op, characterContentHash(session.content));
  };
  // ---- C5c: weight painting (a stroke is one edit) ----
  const [brush, setBrush] = useState<WeightBrush>(defaultBrush);
  const [paintBoneChoice, setPaintBone] = useState<string>();
  const paintBones = paintSkin
    ? (doc.skeletons.find((s) => s.id === paintSkin.skeletonId)?.bones ?? [])
    : [];
  const paintBone = paintBones.some((b) => b.id === paintBoneChoice)
    ? paintBoneChoice!
    : (cage?.boneIds.find((id) => paintBones.some((b) => b.id === id)) ?? paintBones[0]?.id ?? '');
  // The stroke being dragged: where the vertices were on screen when it began, and how much the
  // brush reached each. Its weights are previewed until it is made.
  const stroke = useRef<{
    pointerId: number;
    /** The document and cage it was started on: a stroke on another one is refused. */
    session: EditorSession<CharacterDocument>;
    base: string;
    cage: EpmMesh;
    bone: string;
    screen: [number, number, number][];
    facing: Uint8Array;
    touched: Map<number, number>;
    /** The last pointer sample: dabs fill the way from it, so a fast drag leaves no gaps. */
    last?: [number, number];
  }>(undefined);
  const [paintPreview, setPaintPreview] = useState<EpmMesh>();
  const [paintPointer, setPaintPointer] = useState<[number, number]>();
  useEffect(() => {
    viewport.current?.setPaintButtons(paintOn);
    if (!paintOn) {
      stroke.current = undefined;
      setPaintPreview(undefined);
      setPaintPointer(undefined);
    }
  }, [paintOn]);
  const paintDots = weightDotLimit >= (cage ? cage.positions.length / 3 : 0);
  const weightPoints = (): ShownWeight[] => {
    const view = viewport.current;
    if (!view || !cage || !paintDots) return [];
    const mesh = paintPreview ?? cage;
    const screen = view.project(mesh.positions, identity);
    const facing = facingVertices(mesh, view.cameraPosition());
    const weights = boneWeightsOf(mesh, paintBone);
    const out: ShownWeight[] = [];
    screen.forEach((q, vertex) => {
      if (facing[vertex] && Math.abs(q[2]) <= 1)
        out.push({ vertex, x: q[0], y: q[1], weight: weights[vertex]! });
    });
    return out;
  };
  const local = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  const dab = (x: number, y: number) => {
    const s = stroke.current;
    const view = viewport.current;
    if (!s || !view) return;
    // A zoom or resize during the stroke: pick where the vertices are now.
    followView(s, view.project(s.cage.positions, identity), () =>
      facingVertices(s.cage, view.cameraPosition()),
    );
    brushSegment(s.screen, s.facing, s.last ?? [x, y], [x, y], brush, s.touched);
    s.last = [x, y];
    try {
      setPaintPreview(paintWeights(s.cage, s.bone, s.touched, brush.mode));
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    }
  };
  /** A left-button drag on the view paints (the view turns with the other buttons). */
  const startStroke = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!paintOn) return;
    // Another finger during a stroke neither replaces it nor turns the view under it.
    if (stroke.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.button !== 0 || busy || !cage || !paintBone) return;
    const view = viewport.current;
    if (!view) return;
    // Captured before the canvas sees it: the drag paints and does not turn the view.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // The bone painted stays chosen, even when a stroke takes it out of the skin.
    setPaintBone(paintBone);
    stroke.current = {
      pointerId: e.pointerId,
      session,
      base: characterContentHash(session.content),
      cage,
      bone: paintBone,
      screen: view.project(cage.positions, identity),
      facing: facingVertices(cage, view.cameraPosition()),
      touched: new Map(),
    };
    const [x, y] = local(e);
    setPaintPointer([x, y]);
    dab(x, y);
  };
  const endStroke = (e: ReactPointerEvent<HTMLDivElement>, cancel: boolean) => {
    const s = stroke.current;
    if (!s || s.pointerId !== e.pointerId) return;
    stroke.current = undefined;
    if (cancel || !s.touched.size || !paintSkin) {
      setPaintPreview(undefined);
      return;
    }
    const base = session.content;
    // The document (or the session) changed during the drag: the stroke was for another one.
    if (currentSession.current !== s.session || characterContentHash(base) !== s.base) {
      setEditError('character-base-mismatch');
      setPaintPreview(undefined);
      return;
    }
    let paint: ReturnType<typeof characterSkinWeights>;
    try {
      paint = characterSkinWeights(
        base,
        paintSkin.id,
        paintWeights(s.cage, s.bone, s.touched, brush.mode),
      );
    } catch (x) {
      setEditError(x instanceof Error ? x.message : String(x));
      setPaintPreview(undefined);
      return;
    }
    void commitAsset(paint, paint.op, characterContentHash(base)).finally(() =>
      setPaintPreview(undefined),
    );
  };
  // C6b: a shape is edited on the cage as its morph makes it; the morph must still be the
  // part's (an edit or Undo may have removed it, which ends shape editing below).
  const shapeLive =
    !!shapeMorph &&
    !!part &&
    doc.morphs.some((m) => m.id === shapeMorph && m.partId === part.id) &&
    !!cage?.morphs.some((m) => m.id === shapeMorph);
  const shownCage = useMemo(
    () => (cage && shapeLive ? characterMorphedMesh(cage, shapeMorph!) : cage),
    [cage, shapeLive, shapeMorph],
  );
  useEffect(() => {
    if (!shapeMorph) return;
    if (!editing) setShapeMorph(undefined);
    else if (!shapeLive) {
      setShapeMorph(undefined);
      setEditing(false);
    }
  }, [shapeMorph, shapeLive, editing]);
  const cageEdit = useMemo(() => (shownCage ? cageInput(shownCage) : undefined), [shownCage]);
  const input = cageEdit?.input;
  const uvShown = useMemo(() => (input ? uvLayout(input) : undefined), [input]);
  // A selection only lives while it fits the shown cage (an edit, Undo or Redo can change it).
  const liveSel = useMemo(
    () =>
      cage && selectionState.cage === cageSha
        ? liveSelection(cage, selection, input)
        : emptySelection(selection.mode),
    [cage, selectionState, cageSha, input],
  );
  /** Where the cage sits at rest: a skinned part is bound in character space. */
  const cageMatrix = useMemo(() => {
    if (!part) return identityMatrix;
    if (doc.skins.some((k) => k.partId === part.id)) return identityMatrix;
    return restMatrices(doc).parts.get(part.id) ?? identityMatrix;
  }, [doc, part]);
  // C3g: a move dragged on the gizmo is previewed on the cage overlay, and made on release.
  const [moveDrag, setMoveDrag] = useState<{ axis: GizmoAxis; distance: number }>();
  // C3h: the knife, when on, with its first point once picked (on the shown cage).
  const [knife, setKnife] = useState<{ start?: KnifePick }>();
  const knifeOn = meshEditing && !!knife && !shapeMorph;
  const [pointer, setPointer] = useState<[number, number]>();
  const dragging = !!moveDrag;
  const dragMirror = useMemo(
    () => (dragging && symmetry && input ? cageMirror(input) : undefined),
    [dragging, symmetry, input],
  );
  const shownInput = useMemo(() => {
    if (!input || !moveDrag?.distance) return input;
    const delta: [number, number, number] = [0, 0, 0];
    delta[moveDrag.axis] = moveDrag.distance;
    const positions = previewMove(input, liveSel, delta, dragMirror);
    return { ...input, mesh: { ...input.mesh, positions } };
  }, [input, liveSel, moveDrag, dragMirror]);
  // A drag ends when the cage or the selection it moves is replaced (an edit, Undo, Redo).
  // The gizmo starts over too (its drag state is keyed), so a release cannot move the new cage.
  // Only a drag in progress needs it: a gizmo that just appeared keeps its arrows (a pointer
  // may already be on one).
  const [gizmoEpoch, setGizmoEpoch] = useState(0);
  const draggingNow = useRef(false);
  draggingNow.current = dragging;
  useEffect(() => {
    if (!draggingNow.current) return;
    setMoveDrag(undefined);
    setGizmoEpoch((n) => n + 1);
  }, [input, liveSel]);
  // A knife's first point belongs to the cage it was picked on; leaving edit mode turns it off.
  useEffect(() => setKnife((k) => (k ? {} : k)), [input]);
  useEffect(() => {
    if (!meshEditing) setKnife(undefined);
  }, [meshEditing]);
  useEffect(() => {
    if (!knife?.start) return;
    // Captured first, so Escape drops the point and does not also close a panel; only from
    // the view itself (a menu, dialog or field elsewhere keeps its own Escape).
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!(e.target instanceof Node) || !viewRegion.current?.contains(e.target)) return;
      e.stopPropagation();
      setKnife({});
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [knife]);
  /** The knife's first point where the view is now. */
  const knifeStart = (): [number, number] | undefined => {
    const view = viewport.current;
    const start = knife?.start;
    if (!view || !start || !input) return undefined;
    const p = input.mesh.positions;
    const at = new Float32Array(3);
    if ('vertex' in start.point)
      at.set(p.subarray(3 * start.point.vertex, 3 * start.point.vertex + 3));
    else {
      const [a, b] = start.point.edge,
        t = start.point.t;
      for (let d = 0; d < 3; d++) at[d] = p[3 * a + d]! + t * (p[3 * b + d]! - p[3 * a + d]!);
    }
    const [q] = view.project(at, cageMatrix);
    return q && q[2] > -1 && q[2] < 1 ? [q[0], q[1]] : undefined;
  };
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    if (!meshEditing || !shownInput || !shown) {
      view.setOverlay(null);
      return;
    }
    const overlay = cageOverlay(overlayGeometry(shownInput, liveSel), cageMatrix);
    view.setOverlay(overlay);
    return () => {
      view.setOverlay(null);
      disposeOverlay(overlay);
    };
  }, [meshEditing, shownInput, liveSel, cageMatrix, shown]);
  /** The gizmo's handles where the view is now: from the (moved) selection's centre. */
  const gizmo = () => {
    const view = viewport.current;
    if (!view || !shownInput || !cage) return [];
    const c = selectionCenter(shownInput, liveSel);
    if (!c) return [];
    // A step of a hundredth of the cage's size keeps the on-screen axis direction local.
    const p = cage.positions;
    let size = 0;
    for (let d = 0; d < 3; d++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let i = d; i < p.length; i += 3) {
        lo = Math.min(lo, p[i]!);
        hi = Math.max(hi, p[i]!);
      }
      size = Math.max(size, hi - lo);
    }
    const step = Math.max(size / 100, 1e-3);
    const points = new Float32Array(12);
    for (let k = 0; k < 4; k++) {
      points.set(c, 3 * k);
      if (k) points[3 * k + k - 1] = c[k - 1]! + step;
    }
    return gizmoHandles(view.project(points, cageMatrix), step);
  };
  const subscribeView = useCallback(
    (f: () => void) => viewport.current?.onRendered(f) ?? (() => {}),
    [],
  );
  const dropMove = (axis: GizmoAxis, distance: number) => {
    setMoveDrag(undefined);
    if (!distance) return;
    const delta: [number, number, number] = [0, 0, 0];
    delta[axis] = distance;
    runOperation({ kind: 'move', delta });
  };
  const pick = useRef((_x: number, _y: number, _additive: boolean) => {});
  pick.current = (x, y, additive) => {
    if (!meshEditing || !input || busy) return;
    const screen = viewport.current?.project(input.mesh.positions, cageMatrix);
    if (!screen) return;
    if (knife) {
      const view = viewport.current!;
      const hit = pickKnifePoint(
        input,
        screen,
        x,
        y,
        10,
        (q) => view.project(new Float32Array(q), cageMatrix)[0]!,
      );
      if (!hit) return;
      if (!knife.start) {
        setKnife({ start: hit });
        return;
      }
      let mesh: EpmMesh;
      try {
        mesh = runKnife(input, knife.start, hit, screen);
      } catch (e) {
        if (!(e instanceof MeshEditError)) throw e;
        setEditError(e.message);
        setKnife({});
        return;
      }
      setKnife({});
      if (shapeMorph) return;
      commitCage(mesh, emptySelection(liveSel.mode));
      return;
    }
    const hit = pickElement(input, liveSel.mode, screen, x, y);
    if (hit === undefined) {
      if (!additive) setSelection(emptySelection(liveSel.mode));
      return;
    }
    setSelection(toggle(liveSel, hit, additive));
  };
  /** Keeps the Undo history's asset bytes within the budget, forgetting the oldest entries. */
  const currentSession = useRef(session);
  currentSession.current = session;
  const keepHistoryBudget = () => {
    const drop = characterHistoryOverflow(session.historyEntries('undo'), [
      session.content,
      ...session.historyEntries('redo'),
    ]);
    if (drop) session.forgetOldestUndo(drop);
    // Bytes no content of the history names any more are not kept for it.
    const named = new Set<string>();
    for (const d of [
      session.content,
      ...session.historyEntries('undo'),
      ...session.historyEntries('redo'),
    ])
      for (const a of d.assets) named.add(a.sha256);
    for (const sha of [...staged.current.keys()]) if (!named.has(sha)) staged.current.delete(sha);
  };
  /**
   * One new asset (a mesh or an image) as one edit: the Host keeps the bytes first; the edit then applies only
   * to the document it was made from (an edit or Undo meanwhile refuses it).
   */
  const commitAsset = async (
    asset: { ref: CharacterAssetRef; bytes: Uint8Array },
    op: CharacterOperation,
    base: string,
  ) => {
    if (!props.onMeshAsset || !canEdit()) {
      setEditError('permission-denied');
      return false;
    }
    setBusy(true);
    const from = session;
    try {
      // Admitted by the Host like any edit, before it keeps the bytes.
      props.admit?.(applyCharacterOperation(session.content, op));
      await props.onMeshAsset(asset);
      // The Host may have shown another document while it kept the bytes.
      if (currentSession.current !== from) throw new Error('character-base-mismatch');
      staged.current.set(asset.ref.sha256, asset.bytes);
      setStagedCount((n) => n + 1);
      session.execute(characterEditorCommand(op, { expectedHash: base, canEdit }));
      keepHistoryBudget();
      setEditError(undefined);
      props.onApplied?.(session.content);
      return true;
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const runOperation = (op: MeshOperation) => {
    if (!part || !input) return;
    if (shapeMorph && (!shapeLive || !cage || op.kind !== 'move')) {
      setEditError('Only moving vertices changes a morph shape.');
      return;
    }
    if (shapeMorph && op.kind === 'move') {
      // A shape keeps every vertex of the cage (unused ones too): its deltas match it one for one.
      let positions: Float32Array;
      try {
        positions = shapeMove(input, liveSel, op.delta, symmetry);
      } catch (e) {
        if (!(e instanceof MeshEditError)) throw e;
        setEditError(e.message);
        return;
      }
      commitShape(positions, liveSel);
      return;
    }
    let result: ReturnType<typeof runMeshOperation>;
    try {
      result = runMeshOperation(input, liveSel, op, symmetry);
    } catch (e) {
      if (!(e instanceof MeshEditError)) throw e;
      setEditError(e.message);
      return;
    }
    commitCage(result.mesh, result.selection);
  };
  /** C6b: the morph's new shape (the moved cage) as one edit of the part's mesh. */
  const commitShape = (moved: Float32Array, selection: MeshSelection) => {
    if (!part || !cage || !shapeMorph) return;
    const base = session.content;
    let e: ReturnType<typeof characterMorphShape>;
    try {
      e = characterMorphShape(base, part.id, cage, shapeMorph, moved);
    } catch (x) {
      setEditError(x instanceof Error ? x.message : String(x));
      return;
    }
    void commitAsset({ ref: e.ref, bytes: e.bytes }, e.op, characterContentHash(base)).then(
      (ok) => ok && setSelection(selection, e.ref.sha256),
    );
  };
  /** A new cage of the chosen part as one edit, keeping `selection` on it once made. */
  const commitCage = (mesh: EpmMesh, selection: MeshSelection) => {
    if (!part) return;
    const base = session.content;
    const e = characterMeshEdit(base, part.id, mesh);
    void commitAsset({ ref: e.ref, bytes: e.bytes }, e.op, characterContentHash(base)).then(
      (ok) => ok && setSelection(selection, e.ref.sha256),
    );
  };
  /** C4c: a PNG or JPEG file as the material's colour image (one edit). */
  const setImage = async (materialId: string, file: File) => {
    const base = session.content;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let e: ReturnType<typeof characterMaterialImage>;
    try {
      e = characterMaterialImage(base, materialId, 'color', bytes);
    } catch (x) {
      setEditError(
        x instanceof Error && x.message === 'character-image-size'
          ? 'The image is over 16 MB.'
          : 'Choose a PNG or JPEG image.',
      );
      refresh();
      return;
    }
    await commitAsset({ ref: e.ref, bytes: e.bytes }, e.op, characterContentHash(base));
  };
  const addCube = () => {
    const base = session.content;
    const c = characterCubePart(base);
    void commitAsset({ ref: c.ref, bytes: c.bytes }, c.op, characterContentHash(base)).then(
      (ok) => {
        if (!ok) return;
        setPartId(c.op.part.id);
        setBoneIdState(undefined);
        setPropId(undefined);
      },
    );
  };
  // Pose mode: the chosen bone, and the keys selected in the dope sheet (view state).
  const [boneId, setBoneIdState] = useState<string>();
  // One element is chosen at a time: a bone or a prop.
  const [propId, setPropId] = useState<string>();
  const setBoneId = (id: string | undefined) => {
    setBoneIdState(id);
    if (id) {
      setPropId(undefined);
      choosePart(undefined);
    }
  };
  const chooseProp = (id: string | undefined) => {
    setPropId(id);
    if (id) {
      setBoneIdState(undefined);
      choosePart(undefined);
    }
  };
  const choosePart = (id: string | undefined) => {
    setPartId(id);
    setEditing(false);
    setPainting(false);
    setSelection((s) => emptySelection(s.mode));
    if (id) {
      setBoneIdState(undefined);
      setPropId(undefined);
    }
  };
  const prop = doc.props.find((p) => p.id === propId);
  const [choice, setChoice] = useState('');
  const [keys, setKeys] = useState<CharacterKeyAddress[]>([]);
  const allBones = doc.skeletons.flatMap((s) => s.bones);
  const bone = allBones.find((b) => b.id === boneId);
  const boneSkeleton = bone ? doc.skeletons.find((s) => s.bones.includes(bone)) : undefined;
  // C5a: rig editing. New bones hang 200 mm along their parent's Z; IDs are never reused.
  const rigEditable = !readOnly && !playback.playing;
  const boneName = (skeleton: { bones: { name: string }[] }) => {
    const names = new Set(skeleton.bones.map((b) => b.name));
    for (let n = 1; ; n++)
      if (!names.has(n === 1 ? 'Bone' : `Bone ${n}`)) return n === 1 ? 'Bone' : `Bone ${n}`;
  };
  const addSkeleton = () => {
    const taken = characterIds(doc);
    const id = freshCharacterId(doc, 'skeleton', taken);
    taken.add(id);
    const root = freshCharacterId(doc, 'bone', taken);
    const names = new Set(doc.skeletons.map((s) => s.name));
    let name = 'Skeleton';
    for (let n = 2; names.has(name); n++) name = `Skeleton ${n}`;
    const ok = edit({
      type: 'addSkeleton',
      skeleton: {
        id,
        name,
        parentPartId: null,
        bones: [{ id: root, name: 'Root', parentId: null, rest: identityTransform() }],
      },
    });
    if (ok) setBoneId(root);
  };
  const addChildBone = () => {
    if (!bone || !boneSkeleton) return;
    const id = freshCharacterId(doc, 'bone');
    const ok = edit({
      type: 'addBone',
      skeletonId: boneSkeleton.id,
      bone: {
        id,
        name: boneName(boneSkeleton),
        parentId: bone.id,
        rest: { ...identityTransform(), translation: [0, 0, 200] },
      },
    });
    if (ok) setBoneId(id);
  };
  const bonesShown = (): ShownBone[] => {
    const view = viewport.current;
    if (!view || !allBones.length) return [];
    const shownDoc = ikPreview(doc);
    const world = worldMatrices(
      shownDoc,
      ikDrag ? poseAt(shownDoc, actionOf(shownDoc), playback.tick) : pose,
    ).bones;
    const ids = allBones.map((b) => b.id);
    const points = new Float32Array(ids.length * 3);
    ids.forEach((id, i) => {
      const m = world.get(id);
      if (m) points.set([m[12]!, m[13]!, m[14]!], 3 * i);
    });
    const screen = view.project(points, identity);
    const at = new Map(
      ids.map((id, i) => [
        id,
        screen[i]![2] <= 1 ? ([screen[i]![0], screen[i]![1]] as [number, number]) : undefined,
      ]),
    );
    return allBones.flatMap((b) => {
      const head = at.get(b.id);
      if (!head) return [];
      const parent = b.parentId ? at.get(b.parentId) : undefined;
      return [{ id: b.id, name: b.name, head, ...(parent ? { parent } : {}) }];
    });
  };
  // Keys that an edit, Undo or another action removed are no longer selected.
  const liveKeys = keys.filter((k) =>
    action?.tracks.some((t) => t.id === k.trackId && t.keys.some((x) => x.id === k.keyId)),
  );
  const frameTicks = action
    ? Math.max(
        1,
        Math.round((ticksPerSecond * action.frameRate.denominator) / action.frameRate.numerator),
      )
    : 1;
  /** A key already at the playhead with this value: Enter on an unchanged field adds no edit. */
  const keyedAlready = (target: CharacterTrackTarget, value: number | number[]) => {
    const track = action?.tracks.find((t) => JSON.stringify(t.target) === JSON.stringify(target));
    const key = track?.keys.find((k) => k.tick === playback.tick);
    if (!key) return false;
    const a = ([] as number[]).concat(key.value),
      b = ([] as number[]).concat(value);
    return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < 1e-9);
  };
  /** False when the key was refused (shown), so a Host's flush refuses the save too. */
  const keyBone = (property: 'rotation' | 'translation', value: number[]): boolean => {
    if (!action || !bone) return false;
    if (keyedAlready({ kind: 'bone', id: bone.id, property }, value)) return true;
    const taken = characterIds(doc);
    const trackId = freshCharacterId(doc, `${action.id}/${bone.id}/${property}`, taken);
    return edit({
      type: 'setKey',
      actionId: action.id,
      target: { kind: 'bone', id: bone.id, property },
      tick: playback.tick,
      value: value as [number, number, number],
      trackId,
      keyId: freshCharacterId(doc, `${trackId}#${playback.tick}`, taken),
    });
  };
  const keyJoint = (joint: string, key: CharacterJointValueKey, value: number): boolean => {
    if (!action || !prop) return false;
    const view = views.get(prop.id);
    const bound =
      view?.status === 'ready'
        ? view.joints.find((j) => j.id === joint)?.values.find((v) => v.key === key)
        : undefined;
    // The version's own limits hold for keys too: a value past them is refused, not clamped.
    if (bound && ((bound.min ?? -Infinity) > value || (bound.max ?? Infinity) < value)) {
      setEditError(`joint-limit: ${joint} ${key}`);
      return false;
    }
    if (keyedAlready({ kind: 'prop-joint', id: prop.id, joint, property: key }, value)) return true;
    const taken = characterIds(doc);
    const trackId = freshCharacterId(doc, `${action.id}/${prop.id}/${joint}/${key}`, taken);
    return edit({
      type: 'setKey',
      actionId: action.id,
      target: { kind: 'prop-joint', id: prop.id, joint, property: key },
      tick: playback.tick,
      value,
      trackId,
      keyId: freshCharacterId(doc, `${trackId}#${playback.tick}`, taken),
    });
  };
  // C5d: a solving chain's handle is its target (a rig edit moves it); a free chain's is its
  // tip, and a drag keys the chain's bones at the playhead.
  const keyable = !readOnly && !!action && !playback.playing;
  const ikHandles = (): ShownIkHandle[] => {
    const view = viewport.current;
    if (!view) return [];
    const world = worldMatrices(doc, pose).bones;
    const found = doc.skeletons.flatMap((k) =>
      liveChains(k)
        .filter((c) => (c.enabled ? rigEditable : keyable))
        .map((chain) => {
          const m = world.get(chain.tipBoneId);
          const p: Vec3 = chain.enabled
            ? chain.target
            : m
              ? [m[12]!, m[13]!, m[14]!]
              : [NaN, NaN, NaN];
          return { skeletonId: k.id, chain, p };
        }),
    );
    const screen = view.project(new Float32Array(found.flatMap((h) => h.p)), identity);
    return found.map((h, i) => ({ skeletonId: h.skeletonId, chain: h.chain, at: screen[i]! }));
  };
  const ikPoint = (h: ShownIkHandle, x: number, y: number) =>
    viewport.current?.unproject(x, y, h.at[2]);
  const dropIk = (h: ShownIkHandle, x: number, y: number) => {
    setIkDrag(undefined);
    const point = ikPoint(h, x, y);
    if (!point || !point.every(Number.isFinite)) return;
    if (!(h.chain.enabled ? rigEditable : keyable)) return;
    // Nothing when the chain is no longer the one dragged (an edit or Undo changed it).
    const op = ikDropOperation(doc, h, point, action?.id, playback.tick);
    if (op) edit(op);
  };
  const history = (direction: 'undo' | 'redo') => {
    // History restores snapshots without running a command: check authority here too.
    if (!canEdit()) {
      setEditError('permission-denied');
      return;
    }
    const own = direction === 'undo' ? props.onUndo : props.onRedo;
    if (own) own();
    else if (direction === 'undo' ? session.canUndo : session.canRedo) {
      if (direction === 'undo') session.undo();
      else session.redo();
    }
    refresh();
  };
  const file = useRef<HTMLInputElement>(null);
  const bones = doc.skeletons.reduce((n, s) => n + s.bones.length, 0);

  return (
    <div className="character-surface" ref={root}>
      <EditorLayout
        viewKey="character"
        leftLabel="Parts"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Character tools">
            {!props.onUndo && (
              <>
                <IconButton
                  icon={Undo2}
                  label="Undo"
                  disabled={readOnly || !session.canUndo}
                  reason={readOnly ? 'Read only' : 'Nothing to undo'}
                  onClick={() => history('undo')}
                />
                <IconButton
                  icon={Redo2}
                  label="Redo"
                  disabled={readOnly || !session.canRedo}
                  reason={readOnly ? 'Read only' : 'Nothing to redo'}
                  onClick={() => history('redo')}
                />
              </>
            )}
            {props.onExport && (
              <IconButton
                icon={FileDown}
                label="Export GLB"
                disabled={!!decoded.problems.length}
                reason="Some assets could not be read"
                onClick={exportFile}
              />
            )}
            {props.onImport && (
              <>
                <IconButton
                  icon={FileUp}
                  label="Import glTF or VRM"
                  disabled={readOnly}
                  reason="Read only"
                  onClick={() => file.current?.click()}
                />
              </>
            )}
          </Toolbar>
        }
        status={
          <span className="character-status" aria-live="polite">
            {doc.name} · {doc.parts.length} parts · {bones} bones ·{' '}
            <span data-testid="character-view-state">
              {failure
                ? 'View unavailable'
                : !shown
                  ? 'Assets do not match'
                  : doc.parts.length
                    ? playback.playing
                      ? 'Playing'
                      : 'Ready'
                    : 'Nothing to show'}
            </span>
            {readOnly ? ' · Read only' : ''}
          </span>
        }
        left={
          <div className="character-panel">
            <ul className="character-parts" aria-label="Parts">
              {doc.parts.map((p) => (
                <li key={p.id}>
                  <input
                    type="checkbox"
                    checked={p.visible}
                    disabled={readOnly}
                    aria-label={`Show ${p.name}`}
                    onChange={(e) => setVisible(p.id, e.target.checked)}
                  />
                  <button
                    type="button"
                    aria-pressed={p.id === partId}
                    onClick={() => choosePart(p.id === partId ? undefined : p.id)}
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
            {props.onMeshAsset && !readOnly && (
              <button type="button" disabled={busy} onClick={addCube}>
                Add cube
              </button>
            )}
            {(doc.props.length > 0 || (props.onAddProp && !readOnly)) && (
              <ul className="character-props" aria-label="Props">
                {doc.props.map((p) => {
                  const view = views.get(p.id);
                  return (
                    <li key={p.id}>
                      <input
                        type="checkbox"
                        checked={p.visible}
                        disabled={readOnly}
                        aria-label={`Show ${p.name}`}
                        onChange={(e) =>
                          edit({ type: 'setPropVisible', id: p.id, visible: e.target.checked })
                        }
                      />
                      <button
                        type="button"
                        aria-pressed={p.id === propId}
                        onClick={() => chooseProp(p.id === propId ? undefined : p.id)}
                      >
                        {p.name}
                      </button>
                      {view?.status !== 'ready' && (
                        <span className="character-prop-state">
                          {view?.status === 'failed'
                            ? 'Not shown'
                            : view?.status === 'pending'
                              ? 'Calculating'
                              : ''}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {props.onAddProp && !readOnly && (
              <div className="character-add-prop">
                <select
                  aria-label="Prop version"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">
                    {props.propChoices?.length
                      ? 'Choose a saved CAD version'
                      : 'No saved CAD versions'}
                  </option>
                  {(props.propChoices ?? []).map((c) => (
                    <option key={choiceKey(c)} value={choiceKey(c)}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!choice}
                  onClick={() => {
                    const c = props.propChoices?.find((x) => choiceKey(x) === choice);
                    if (c) props.onAddProp?.(c);
                    setChoice('');
                  }}
                >
                  Add prop
                </button>
              </div>
            )}
            {allBones.length > 0 && (
              <ul className="character-bones" aria-label="Bones">
                {doc.skeletons.flatMap((sk) =>
                  boneTree(sk).map(({ bone: b, depth }) => (
                    <li key={b.id} style={{ paddingInlineStart: `${depth * 12}px` }}>
                      <button
                        type="button"
                        aria-pressed={b.id === boneId}
                        onClick={() => setBoneId(b.id === boneId ? undefined : b.id)}
                      >
                        {b.name}
                      </button>
                    </li>
                  )),
                )}
              </ul>
            )}
            {!readOnly && (
              <button type="button" disabled={playback.playing} onClick={addSkeleton}>
                Add skeleton
              </button>
            )}
          </div>
        }
        inspector={
          <div className="character-panel">
            {part && paintOn && (
              <WeightPaintInspector
                partName={part.name}
                bones={paintBones}
                bone={paintBone}
                brush={brush}
                busy={busy}
                onBone={setPaintBone}
                onBrush={setBrush}
                onDone={() => setPainting(false)}
              />
            )}
            {part && !meshEditing && !paintOn && (
              <Section title={part.name}>
                <dl className="character-facts">
                  <dt>Vertices</dt>
                  <dd>{cage ? cage.positions.length / 3 : '–'}</dd>
                  <dt>Faces</dt>
                  <dd>{cage ? cage.faceSizes.length : '–'}</dd>
                  <dt>Subdivision</dt>
                  <dd>{part.subdivision?.levels ?? 0}</dd>
                </dl>
                <MaterialMaps
                  materials={part.materials.flatMap((id) => {
                    const m = doc.materials.find((x) => x.id === id);
                    return m ? [m] : [];
                  })}
                  assets={doc.assets}
                  editable={!!props.onMeshAsset && !readOnly}
                  busy={busy}
                  onImage={(id, file) => void setImage(id, file)}
                  onClear={(id) => edit({ type: 'setMaterialMap', id, role: 'color', asset: null })}
                />
                {props.onMeshAsset && !readOnly && (
                  <div className="character-bind" aria-label="Skeleton binding" role="group">
                    {partSkin ? (
                      <>
                        <span className="character-hint">
                          Bound to{' '}
                          {doc.skeletons.find((s) => s.id === partSkin.skeletonId)?.name ?? '–'}
                        </span>
                        <button
                          type="button"
                          disabled={busy || !cage}
                          onClick={() => {
                            setPlayback(pause);
                            setPainting(true);
                          }}
                        >
                          Paint weights
                        </button>
                        <button type="button" disabled={busy || !cage} onClick={unbindPart}>
                          Unbind
                        </button>
                      </>
                    ) : weighting ? (
                      <>
                        <span className="character-hint" role="status">
                          Weighting… {weighting.done} / {weighting.total} bones
                        </span>
                        <button type="button" onClick={() => weightJobs.current?.cancel()}>
                          Cancel
                        </button>
                      </>
                    ) : doc.skeletons.length ? (
                      <>
                        <select
                          aria-label="Skeleton to bind"
                          value={bindTo}
                          disabled={busy}
                          onChange={(e) => setBindTo(e.target.value)}
                        >
                          {doc.skeletons.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={busy || !cage || playback.playing}
                          onClick={() => void bindPart()}
                        >
                          Bind with automatic weights
                        </button>
                      </>
                    ) : (
                      <span className="character-hint">Add a skeleton to bind this part.</span>
                    )}
                  </div>
                )}
                {props.onMeshAsset && !readOnly ? (
                  <div className="character-mesh-row">
                    <button
                      type="button"
                      disabled={busy || !cage}
                      onClick={() => {
                        setPlayback(pause);
                        setShapeMorph(undefined);
                        setEditing(true);
                      }}
                    >
                      Edit mesh
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (edit({ type: 'removePart', id: part.id })) choosePart(undefined);
                      }}
                    >
                      Remove part
                    </button>
                  </div>
                ) : (
                  <p className="character-hint">
                    {readOnly ? 'Read only.' : 'This Host does not edit meshes.'}
                  </p>
                )}
              </Section>
            )}
            {part && meshEditing && (
              <MeshInspector
                partName={part.name}
                selection={liveSel}
                vertexCount={cage ? cage.positions.length / 3 : 0}
                faceCount={cage ? cage.faceSizes.length : 0}
                {...(cageEdit?.problem
                  ? { problem: cageEdit.problem }
                  : !cage
                    ? { problem: 'The mesh is not loaded.' }
                    : {})}
                busy={busy}
                symmetry={symmetry}
                subdivision={part.subdivision}
                onMode={(mode) => setSelection(emptySelection(mode))}
                onSelectAll={() => input && setSelection(selectAll(input, liveSel.mode))}
                onSelectNone={() => setSelection(emptySelection(liveSel.mode))}
                onSelectLoop={() => input && setSelection(selectLoop(input, liveSel))}
                onSymmetry={setSymmetry}
                uv={uvShown}
                knife={knifeOn ? (knife?.start ? 'second' : 'first') : undefined}
                onKnife={(on) => setKnife(on ? {} : undefined)}
                onRun={runOperation}
                onSubdivision={(subdivision) =>
                  edit({ type: 'setPartSubdivision', id: part.id, subdivision })
                }
                onDone={() => setEditing(false)}
                {...(shapeLive
                  ? { shape: doc.morphs.find((m) => m.id === shapeMorph)?.name ?? '' }
                  : {})}
              />
            )}
            {part && !meshEditing && !paintOn && (
              <MorphInspector
                key={`morphs-${part.id}`}
                partName={part.name}
                morphs={doc.morphs
                  .filter((m) => m.partId === part.id)
                  .map((morph) => ({ morph, weight: pose.morphs.get(morph.id) ?? morph.weight }))}
                structureEditable={
                  !!props.onMeshAsset && !readOnly && !playback.playing && !busy && !!cage
                }
                weightEditable={!readOnly && !playback.playing}
                reason={readOnly ? 'Read only.' : 'Pause to change the weights.'}
                keying={!!action}
                onAdd={addMorph}
                onRename={(id, name) => edit({ type: 'rename', collection: 'morphs', id, name })}
                onRemove={removeMorph}
                onEditShape={(id) => {
                  setPlayback(pause);
                  setShapeMorph(id);
                  setEditing(true);
                }}
                onWeight={(id, weight) => {
                  const op = morphWeightOperation(doc, id, weight, action?.id, playback.tick);
                  return op ? edit(op) : false;
                }}
                onPreview={setMorphDrag}
              />
            )}
            {bone && boneSkeleton && (
              <BoneInspector
                key={bone.id}
                skeleton={boneSkeleton}
                bone={bone}
                editable={rigEditable}
                reason={readOnly ? 'Read only.' : 'Pause to edit the rig.'}
                onRename={(name) =>
                  edit({ type: 'renameBone', skeletonId: boneSkeleton.id, id: bone.id, name })
                }
                onRest={(rest) =>
                  edit({ type: 'setBoneRest', skeletonId: boneSkeleton.id, id: bone.id, rest })
                }
                onParent={(parentId) =>
                  edit({
                    type: 'setBoneParent',
                    skeletonId: boneSkeleton.id,
                    id: bone.id,
                    parentId,
                  })
                }
                onAddChild={addChildBone}
                onRemove={() => {
                  if (edit({ type: 'removeBone', skeletonId: boneSkeleton.id, id: bone.id }))
                    setBoneId(undefined);
                }}
                onRemoveSkeleton={() => {
                  if (edit({ type: 'removeSkeleton', id: boneSkeleton.id })) setBoneId(undefined);
                }}
              />
            )}
            {bone && boneSkeleton && (
              <IkInspector
                key={`ik-${bone.id}`}
                skeleton={boneSkeleton}
                bone={bone}
                editable={rigEditable}
                reason={readOnly ? 'Read only.' : 'Pause to edit the rig.'}
                onAdd={() => {
                  const id = freshCharacterId(doc, `${bone.id}/ik`);
                  const m = worldMatrices(doc, pose).bones.get(bone.id);
                  const above = bonesAbove(boneSkeleton, bone);
                  edit({
                    type: 'addIkChain',
                    skeletonId: boneSkeleton.id,
                    chain: {
                      id,
                      name: `${bone.name} IK`,
                      tipBoneId: bone.id,
                      length: Math.min(2, above),
                      target: m ? [m[12]!, m[13]!, m[14]!] : [0, 0, 0],
                      pole: null,
                      enabled: false,
                    },
                  });
                }}
                onSet={(chain) => edit({ type: 'setIkChain', skeletonId: boneSkeleton.id, chain })}
                onRemove={(id) => edit({ type: 'removeIkChain', skeletonId: boneSkeleton.id, id })}
                onLimits={(limits) =>
                  edit({ type: 'setBoneLimits', skeletonId: boneSkeleton.id, id: bone.id, limits })
                }
              />
            )}
            {bone && (
              <PoseInspector
                boneName={bone.name}
                pose={poseAt(doc, action, playback.tick).bones.get(bone.id) ?? bone.rest}
                tick={playback.tick}
                canKey={!readOnly && !!action && !playback.playing}
                reason={
                  readOnly
                    ? 'Read only.'
                    : !action
                      ? 'Choose an action to key the pose.'
                      : 'Pause to key the pose.'
                }
                onKey={(property, value) => keyBone(property, value)}
              />
            )}
            {prop && (
              <PropInspector
                key={prop.id}
                prop={prop}
                view={props.props?.get(prop.id)}
                values={pose.joints.get(prop.id) ?? noValues}
                missing={missingJoints(doc, prop.id, views.get(prop.id))}
                tick={playback.tick}
                readOnly={readOnly}
                canKey={!readOnly && !!action && !playback.playing}
                reason={
                  readOnly
                    ? 'Read only.'
                    : !action
                      ? 'Choose an action to key the joints.'
                      : 'Pause to key the joints.'
                }
                onKey={keyJoint}
                onPlace={(placement) => edit({ type: 'setPropPlacement', id: prop.id, placement })}
                onRemove={() => {
                  if (edit({ type: 'removeProp', id: prop.id })) setPropId(undefined);
                }}
              />
            )}
            <Section title="Model">
              <dl className="character-facts">
                <dt>Parts</dt>
                <dd>{doc.parts.length}</dd>
                <dt>Bones</dt>
                <dd>{bones}</dd>
                <dt>Morphs</dt>
                <dd>{doc.morphs.length}</dd>
                <dt>Props</dt>
                <dd>{doc.props.length}</dd>
                <dt>Actions</dt>
                <dd>{doc.actions.length}</dd>
              </dl>
            </Section>
            {props.report && (
              <Section title="Import">
                <p className="character-file">{props.report.fileName}</p>
                {props.report.losses.length ? (
                  <>
                    <p>Not carried over:</p>
                    <ul aria-label="Import losses" className="character-losses">
                      {props.report.losses.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>Everything was carried over.</p>
                )}
              </Section>
            )}
            {exported && (
              <Section title="Export">
                {'error' in exported ? (
                  <p role="alert">{exported.error}</p>
                ) : (
                  <>
                    <p className="character-file">{exported.name}</p>
                    {exported.losses.length ? (
                      <>
                        <p>Not written:</p>
                        <ul aria-label="Export losses" className="character-losses">
                          {exported.losses.map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p>Everything was written.</p>
                    )}
                  </>
                )}
              </Section>
            )}
            {props.report?.vrm && (
              <Section title={`VRM ${props.report.vrm.version} terms`}>
                <dl className="character-terms" aria-label="VRM terms">
                  {Object.entries(props.report.vrm.meta).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </Section>
            )}
          </div>
        }
      >
        <div className="character-stage">
          {/* Focusable, so a click or Tab into the view takes the playback shortcuts. */}
          <div
            ref={viewRegion}
            className="character-viewport"
            role="region"
            aria-label="Character view"
            tabIndex={0}
            onPointerDownCapture={startStroke}
            onPointerDown={(e) => e.currentTarget.focus({ preventScroll: true })}
            onPointerMove={(e) => {
              if (paintOn) {
                const [x, y] = local(e);
                setPaintPointer([x, y]);
                if (stroke.current?.pointerId === e.pointerId) dab(x, y);
              }
              if (!knife?.start) return;
              const r = e.currentTarget.getBoundingClientRect();
              setPointer([e.clientX - r.left, e.clientY - r.top]);
            }}
            onPointerUp={(e) => endStroke(e, false)}
            onPointerCancel={(e) => endStroke(e, true)}
            onPointerLeave={() => {
              if (!stroke.current) setPaintPointer(undefined);
            }}
          >
            <div ref={host} className="character-canvas-host" />
            {viewReady && paintOn && shown && !failure && (
              <WeightOverlay
                points={weightPoints}
                brush={brush}
                pointer={paintPointer}
                subscribe={subscribeView}
              />
            )}
            {paintOn && !paintDots && shown && !failure && (
              <div className="character-viewport-note" role="status">
                Too many vertices to show weight dots; painting still works.
              </div>
            )}
            {viewReady && !restView && shown && !failure && allBones.length > 0 && (
              <BoneOverlay
                bones={bonesShown}
                selected={boneId}
                subscribe={subscribeView}
                onPick={(id) => setBoneId(id)}
              />
            )}
            {viewReady && !restView && shown && !failure && (
              <IkOverlay
                handles={ikHandles}
                subscribe={subscribeView}
                onDrag={(h, x, y) => {
                  const point = ikPoint(h, x, y);
                  if (point?.every(Number.isFinite)) setIkDrag({ handle: h, point });
                }}
                onDrop={dropIk}
                onCancel={() => setIkDrag(undefined)}
              />
            )}
            {knifeOn && shown && !failure && (
              <KnifeLine start={knifeStart} pointer={pointer} subscribe={subscribeView} />
            )}
            {meshEditing && shown && !failure && !knifeOn && liveSel.items.length > 0 && (
              <MeshGizmo
                key={gizmoEpoch}
                handles={gizmo}
                subscribe={subscribeView}
                disabled={busy}
                onDrag={(axis, distance) => setMoveDrag({ axis, distance })}
                onDrop={dropMove}
                onCancel={() => setMoveDrag(undefined)}
                onClick={(x, y, additive) => pick.current(x, y, additive)}
              />
            )}
            {display.notes.length > 0 && shown && !failure && (
              <div className="character-viewport-note" role="status">
                {display.notes.join('; ')}
              </div>
            )}
            {(failure || props.importError || !shown) && (
              <div className="character-viewport-note" role="alert">
                {failure ?? props.importError ?? `Assets do not match: ${read.problems.join('; ')}`}
              </div>
            )}
          </div>
          {/* The transport stays visible at every width, outside the compact toolbar. */}
          <div className="character-transport" role="group" aria-label="Playback">
            <label className="character-pick">
              Action
              <select
                aria-label="Action"
                value={playback.actionId ?? ''}
                onChange={(e) => setPlayback((p) => choose(p, e.target.value || null))}
              >
                <option value="">Rest pose</option>
                {doc.actions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {playback.playing ? (
              <IconButton
                icon={Pause}
                label="Pause"
                shortcut="Space"
                onClick={() => setPlayback(pause)}
              />
            ) : (
              <IconButton
                icon={Play}
                label="Play"
                shortcut="Space"
                disabled={!action}
                reason="Choose an action"
                onClick={() => setPlayback((p) => play(p, action))}
              />
            )}
            <IconButton
              icon={Square}
              label="Stop"
              disabled={!action}
              reason="Choose an action"
              onClick={() => setPlayback(stop)}
            />
            <input
              className="character-time"
              type="range"
              aria-label="Time"
              min={0}
              max={action?.duration ?? 0}
              step={1}
              value={playback.tick}
              disabled={!action}
              aria-valuetext={formatTicks(playback.tick)}
              onChange={(e) => setPlayback((p) => seek(pause(p), action, Number(e.target.value)))}
              onKeyDown={(e) => {
                // Arrows step one frame of the action's rate, Page keys one second.
                const by = action ? frameStep(e.key, action.frameRate) : 0;
                if (!by) return;
                e.preventDefault();
                setPlayback((p) => seek(pause(p), action, p.tick + by));
              }}
            />
            <output className="character-time-readout" data-testid="character-time">
              {formatTicks(playback.tick)} / {formatTicks(action?.duration ?? 0)}
            </output>
            <label className="character-pick">
              <input
                type="checkbox"
                checked={playback.loop}
                onChange={(e) => setPlayback((p) => ({ ...p, loop: e.target.checked }))}
              />
              Loop
            </label>
          </div>
          {/* Shown under the view at every width: a refusal from any panel is never hidden. */}
          {editError && (
            <p role="alert" className="character-error">
              {editError}
            </p>
          )}
          {action && (
            <DopeSheet
              doc={doc}
              action={action}
              tick={playback.tick}
              frame={frameTicks}
              selected={liveKeys}
              readOnly={readOnly}
              onSelect={setKeys}
              onSeek={(t) => setPlayback((p) => seek(pause(p), action, t))}
              onDelete={() => {
                if (edit({ type: 'deleteKeys', actionId: action.id, keys: liveKeys })) setKeys([]);
              }}
              onMove={(delta) =>
                edit({ type: 'moveKeys', actionId: action.id, keys: liveKeys, delta })
              }
              onEasing={(easing) =>
                edit({ type: 'setKeyEasing', actionId: action.id, keys: liveKeys, easing })
              }
              jointName={(id, joint) => {
                const view = views.get(id);
                return view?.status === 'ready'
                  ? view.joints.find((j) => j.id === joint)?.name
                  : undefined;
              }}
            />
          )}
        </div>
      </EditorLayout>
      {props.onImport && (
        <input
          ref={file}
          type="file"
          hidden
          aria-label="glTF or VRM file"
          accept=".glb,.gltf,.vrm,model/gltf-binary,model/gltf+json"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) props.onImport?.(f);
          }}
        />
      )}
    </div>
  );
}

const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const choiceKey = (c: CharacterPropChoice) => `${c.artifactId} ${c.versionId}`;
const noViews: ReadonlyMap<string, CharacterPropView> = new Map();
const noValues: ReadonlyMap<string, Partial<Record<CharacterJointValueKey, number>>> = new Map();

function frameStep(key: string, rate: { numerator: number; denominator: number }): number {
  const frame = Math.max(1, Math.round((ticksPerSecond * rate.denominator) / rate.numerator));
  return key === 'ArrowRight' || key === 'ArrowUp'
    ? frame
    : key === 'ArrowLeft' || key === 'ArrowDown'
      ? -frame
      : key === 'PageUp'
        ? ticksPerSecond
        : key === 'PageDown'
          ? -ticksPerSecond
          : key === 'Home'
            ? -Number.MAX_SAFE_INTEGER
            : key === 'End'
              ? Number.MAX_SAFE_INTEGER
              : 0;
}

/** PNG and JPEG bytes decoded to bitmaps, flipped so UV v points up; undecodable ones are left. */
function useDecodedImages(
  images: ReadonlyMap<string, { bytes: Uint8Array; mediaType: string }>,
): CharacterImages {
  const [decoded, setDecoded] = useState<CharacterImages>(new Map());
  useEffect(() => {
    let live = true;
    const out = new Map<string, ImageBitmap>();
    void Promise.all(
      [...images].map(async ([id, { bytes, mediaType }]) => {
        try {
          const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType });
          out.set(id, await createImageBitmap(blob, { imageOrientation: 'flipY' }));
        } catch {
          // The material keeps its colour; the image stays in the document unchanged.
        }
      }),
    ).then(() => {
      if (live) setDecoded(out);
      else for (const b of out.values()) b.close();
    });
    return () => {
      live = false;
    };
  }, [images]);
  return decoded;
}
