import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BackSide,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  AxesHelper,
  InstancedMesh,
  Matrix4,
  Quaternion,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  combTip,
  curvatureColor,
  type CadCamera,
  type CadCombSample,
  type CadProjection,
  poseMatrix,
  type CadSolvedPose,
  type CadTopologyKind,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { defaultGrid, gridFor, orbitRotateSpeed, viewOf, type Bounds } from './view-math';
import {
  disposeParts,
  lodLevel,
  movedKey,
  partPath,
  partsBytes,
  partsGroup,
  poseParts,
  type ViewLevel,
  type ViewportPart,
} from './assembly-view';
import type { CadDragRay } from './joint-drag';
import { cadBudgets } from './controller';

export interface ViewportBody {
  mesh: CadMesh;
  color: string;
  /** The body's native appearance opacity (0–1). */
  opacity: number;
  selected: boolean;
  /** A sheet is drawn from both sides, its back in a darker tint (docs/cad/r2a-freeform.md). */
  sheet?: boolean;
  /** The picked face or edge of this body (pick ids of `mesh`), drawn highlighted. */
  highlight?: CadTopologyPick;
  /** One curvature value per node of `mesh`, for the curvature shading (NaN: none there). */
  curvature?: Float32Array;
}
/** Opacity of a failed body's shape before the failure (U4): a reference, never picked. */
const beforeFailureOpacity = 0.3;
/**
 * How bodies are shaded (docs/cad/r2a-freeform.md, 連続性の判定と表示); display only.
 * `zebra`: black and white stripes reflected from `stripes` bands around the world `axis`,
 * from the display mesh's normals; with `selectedOnly`, only on the selected body (the others
 * keep their colour). `curvature`: each body's `curvature` values in a diverging
 * colour map over ±`range` (a body without values is shaded as usual).
 */
export type CadShading =
  | { mode: 'shaded' }
  | { mode: 'zebra'; axis: 'x' | 'y' | 'z'; stripes: number; selectedOnly?: boolean }
  | { mode: 'curvature'; range: number };
/** The comb's colour: teeth and the line through their tips. */
const combColor = '#7c3aed';
const zebraVertex = `
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = mv.xyz;
  vViewNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;
const zebraFragment = `
uniform vec3 axis;
uniform float stripes;
uniform float opacity;
varying vec3 vViewNormal;
varying vec3 vViewPosition;
void main() {
  vec3 n = normalize(vViewNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 view = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(vViewPosition);
  // The reflected ray in world space: the stripes are fixed around the world axis.
  vec3 r = transpose(mat3(viewMatrix)) * reflect(view, n);
  float k = acos(clamp(dot(r, axis), -1.0, 1.0)) / 3.14159265 * stripes;
  float w = max(fwidth(k), 1e-4);
  float band = smoothstep(0.5 - w, 0.5 + w, abs(fract(k) - 0.5) * 2.0);
  vec3 color = mix(vec3(0.08), vec3(0.86), band);
  // The selection is marked by its outline: the stripes keep their contrast.
  gl_FragColor = vec4(color, opacity);
}`;
/** A face or edge picked on the shown mesh: evaluation-scoped pick ids (CadMesh). */
export interface CadTopologyPick {
  bodyId: string;
  kind: 'face' | 'edge';
  id: number;
}
/** Screen distance within which a click picks an edge. */
export const edgePickPx = 8;
/** A camera to show: a named view's, or the one `currentView()` returned. */
export interface CadViewportView {
  camera: CadCamera;
  projection: CadProjection;
}
export interface CadViewportOptions {
  onPick(bodyId: string | null): void;
  onContextLost(): void;
  /** The browser gave the WebGL context back: the Surface shows its meshes again. */
  onContextRestored?(): void;
  /** GPU buffer budget for what is shown (CAD26); `cadBudgets.gpuBytes` by default. */
  gpuBytes?: number;
  /** Bytes refused by the GPU budget for the last `show`, or undefined when it fit. */
  onGpuBudget?(refusedBytes: number | undefined): void;
  /** With the measure tool on, a click on a body gives a point instead of a selection. */
  onMeasure?(point: CadMeasurePoint): void;
  /** With face or edge picking on, a click gives the face or edge under it (or null). */
  onPickTopology?(pick: CadTopologyPick | null): void;
  /** R2b: a click on a placed part gives its component path instead of a body. */
  onPickComponent?(path: string[]): void;
}
/** A point picked for a distance: model-space mm on the shape shown for the current content. */
export interface CadMeasurePoint {
  bodyId: string;
  point: Vec3;
  /**
   * The click was within `measureSnapPx` of one of the body's B-rep vertices, and the point is
   * that vertex as the kernel gives it (exact). Otherwise it is where the click meets the display
   * mesh, which lies within the display deflection of the surface (approximate).
   */
  vertex: boolean;
}
/** Screen distance within which a click snaps to a B-rep vertex. */
export const measureSnapPx = 12;
/**
 * The Move tool (docs/cad/operations.md, body move): primary drag on a body moves it in its own
 * horizontal plane. Only the display moves during the gesture; `onMove` is called once at the
 * end with the whole translation. Escape or a cancelled pointer leaves the content unchanged.
 */
export interface CadMoveTool {
  canMove(bodyId: string): boolean;
  /** Resolves false when the edit was refused; the body then returns to its place. */
  onMove(bodyId: string, delta: Vec3): Promise<boolean>;
  /**
   * A drag that cannot move: the body's position is bound (`bound`), or the view looks along the
   * movement plane so the pointer has no well-defined point on it (`edge-on`).
   */
  onRefused(bodyId: string, reason: 'bound' | 'edge-on'): void;
}

/**
 * R2b-2c: a connector picked for a new joint. A face, edge or vertex of a shown body (no
 * `path`) or of a placed part's instance (its component path), with the mesh whose pick table
 * `index` reads and the picked point in assembly coordinates.
 */
export interface CadConnectorPick {
  path?: string[];
  mesh: CadMesh;
  kind: CadTopologyKind;
  index: number;
  point: Vec3;
}
/** R2b-2c: with this tool on, a click picks a connector instead of a selection. */
export interface CadConnectorTool {
  onPick(pick: CadConnectorPick | null): void;
}
/**
 * R2b-2c dragging a joint's value: a primary drag on an instance under `moves` (the joint's
 * child and what hangs from it) is the joint's, everything else navigates and selects as before.
 * The display moves by the matrices `move` returns; `end` is called once.
 */
export interface CadJointDragTool {
  /** Direct components a drag may start on. */
  moves: ReadonlySet<string>;
  /**
   * Everything the drag shows moving, by first path step, with the frame its motion is seen in
   * (R2b-3: a pattern copy turns about its own place); `moves` by the motion itself otherwise.
   */
  frames?: ReadonlyMap<string, CadSolvedPose>;
  /** Starts at the grabbed point (Shift: the other freedom), or says why it cannot. */
  start(ray: CadDragRay, grab: Vec3, alternate: boolean): string | undefined;
  /** The child's motion since the start, in assembly coordinates; undefined keeps the last. */
  move(ray: CadDragRay): CadSolvedPose | undefined;
  /** Resolves false when nothing was applied; the parts then return to their place. */
  end(commit: boolean): Promise<boolean>;
  /** A drag that cannot start, reported once the pointer actually drags. */
  onRefused(reason: string): void;
}
/** What a joint drag shows moving, by first path step. */
const posed = (tool: CadJointDragTool) => (tool.frames ? new Set(tool.frames.keys()) : tool.moves);
/** Axes drawn at a connector frame, as a share of the shown parts' size. */
const frameMarkShare = 0.08;

/** sin(10°): the least angle between a drag ray and the horizontal movement plane. */
const minDragElevation = Math.sin((10 * Math.PI) / 180);

/**
 * Three.js renderer confined to display: no CAD state, no editing. Z-up, millimetres.
 * Picking is offered only for meshes that match the current content (`pickable`).
 */
export class CadViewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly perspective = new PerspectiveCamera(45, 1, 0.1, 100_000);
  private readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, -100_000, 100_000);
  /** Height of the orthographic view in mm at zoom 1. */
  private orthographicSpan = 100;
  private camera: PerspectiveCamera | OrthographicCamera = this.perspective;
  private controls: OrbitControls;
  /** The up vector the current controls orbit around. */
  private readonly orbitUp = new Vector3(0, 0, 1);
  private grid: GridHelper;
  private axes: AxesHelper;
  private gridKey = '';
  private gridVisible = true;
  private readonly bodies = new Group();
  /** Placed parts of an assembly (R2b), instanced per version. */
  private parts = new Group();
  /** The measured points and the line between them, drawn over the shape. */
  private readonly marks = new Group();
  /** The curvature comb drawn over the shape. */
  private readonly combs = new Group();
  private shading: CadShading = { mode: 'shaded' };
  private measuring = false;
  private topologyTool: 'face' | 'edge' | undefined;
  private readonly resize: ResizeObserver;
  private pickable = false;
  private gpuBudget: number | undefined;
  /** The last placed parts, admitted again when the budget or the native geometry changes. */
  private lastParts: ViewportPart[] = [];
  /** R2b-4: each part instance's level (LOD) as drawn, by its path. */
  private levels = new Map<string, ViewLevel>();
  /** A redraw of the parts at new levels, after the camera moved (throttled). */
  private relevel: ReturnType<typeof setTimeout> | undefined;
  /** Whether the parts' shapes are drawn, and their bytes when drawn with shapes. */
  private partsFit = true;
  private partsFullBytes = 0;
  /** Told whether the parts' shapes fit each time they are admitted (R2b). */
  onPartsFit: ((fits: boolean) => void) | undefined;
  /** What the last `show` was given, drawn again when the GPU budget changes. */
  private lastShown: { bodies: ViewportBody[]; current: boolean; dim: boolean } = {
    bodies: [],
    current: false,
    dim: true,
  };
  private down: { x: number; y: number } | undefined;
  private moveTool: CadMoveTool | undefined;
  /** A move refused on pointerdown, reported only if that pointer goes on to drag. */
  private refusal: { bodyId: string; reason: 'bound' | 'edge-on'; pointerId: number } | undefined;
  /**
   * A finished move shown where it was dropped until the edit's own meshes arrive: meshes other
   * than the ones it was dropped on, or the move's refusal.
   */
  private moved: { bodyId: string; delta: Vector3; mesh: CadMesh | undefined } | undefined;
  /** The mesh shown for each body, to tell the move's own meshes from a redraw of the old ones. */
  private shownMeshes = new Map<string, CadMesh>();
  /** Pointers down on the canvas: a second touch is navigation, never a body move. */
  private readonly pointers = new Set<number>();
  private drag:
    | { bodyId: string; pointerId: number; plane: Plane; start: Vector3; delta: Vector3 }
    | undefined;
  private connectorTool: CadConnectorTool | undefined;
  private jointTool: CadJointDragTool | undefined;
  private jointDrag: { pointerId: number; tool: CadJointDragTool; key: string } | undefined;
  private jointRefusal: { reason: string; pointerId: number } | undefined;
  /**
   * A joint drag's preview on the parts: kept while the parts shown are those it started from
   * (a released drag until its edit's poses arrive), dropped when they move or it is refused.
   */
  private partsPose:
    | { moves: ReadonlySet<string>; delta: Matrix4 | ReadonlyMap<string, Matrix4>; key: string }
    | undefined;
  /** Connector frames and picked points of a joint being made, drawn over the model. */
  private readonly jointMarks = new Group();
  private frame = 0;
  /** The camera was placed (by a fit or a saved view): a later fit keeps its direction. */
  private fitted = false;
  /**
   * Which layers the automatic opening fit has taken in. The native bodies and the placed parts
   * arrive separately, so each layer's first content fits again; a saved view ends it.
   */
  private autoFit = { bodies: false, parts: false };
  constructor(
    private readonly host: HTMLElement,
    private readonly options: CadViewportOptions,
  ) {
    this.gpuBudget = options.gpuBytes;
    // alpha: a PNG without background keeps transparent pixels.
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'cad-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    host.append(this.renderer.domElement);
    this.scene.background = new Color('#f4f6f8');
    for (const camera of [this.perspective, this.orthographic]) camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 120);
    [this.grid, this.axes] = this.helpers(defaultGrid);
    this.scene.add(
      this.grid,
      this.axes,
      new AmbientLight('#ffffff', 0.6),
      this.bodies,
      this.parts,
      this.marks,
      this.jointMarks,
      this.combs,
    );
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(1, -1.5, 2);
    this.scene.add(sun);
    this.controls = this.makeControls();
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      // The GPU buffers are gone with the context: release their objects too (CAD26).
      this.clear();
      options.onContextLost();
    });
    canvas.addEventListener('webglcontextrestored', () => options.onContextRestored?.());
    canvas.addEventListener('pointerdown', (e) => {
      this.pointers.add(e.pointerId);
      this.down = { x: e.clientX, y: e.clientY };
      // A second touch (pinch or two-finger pan) cancels a body move and leaves navigation on.
      if (this.drag && e.pointerId !== this.drag.pointerId) return this.endMove(false);
      if (this.jointDrag && e.pointerId !== this.jointDrag.pointerId)
        return this.endJointDrag(false);
      if (this.moveTool && e.isPrimary && e.button === 0 && this.pointers.size === 1)
        this.startMove(e);
      else if (this.jointTool && e.isPrimary && e.button === 0 && this.pointers.size === 1)
        this.startJointDrag(e);
    });
    // Releases are tracked on the window: a finger whose move was cancelled (capture released) may
    // lift outside the canvas, and a stale id would block every later move.
    window.addEventListener('pointerup', this.release, true);
    window.addEventListener('pointercancel', this.release, true);
    canvas.addEventListener('pointermove', (e) => {
      // A refused move is reported once the pointer actually drags, not on a click.
      if (this.refusal?.pointerId === e.pointerId && !this.still(e)) {
        const { bodyId, reason } = this.refusal;
        this.refusal = undefined;
        this.moveTool?.onRefused(bodyId, reason);
      }
      if (this.jointRefusal?.pointerId === e.pointerId && !this.still(e)) {
        const { reason } = this.jointRefusal;
        this.jointRefusal = undefined;
        this.jointTool?.onRefused(reason);
      }
      this.moveTo(e);
      this.moveJointDrag(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.refusal = undefined;
      this.jointRefusal = undefined;
      const still = this.still(e);
      if (this.jointDrag?.pointerId === e.pointerId) {
        if (!still) return this.endJointDrag(true);
        // A click on the child selects, as without the drag.
        this.endJointDrag(false);
      } else if (this.drag?.pointerId === e.pointerId) {
        if (!still) return this.endMove(true);
        // A click on a body with Move on selects it, as with Move off.
        this.endMove(false);
      } else if (!still) return; // A drag is camera navigation, never a selection.
      this.down = undefined;
      if (!this.pickable) return;
      if (this.connectorTool) return this.connectorTool.onPick(this.pickConnector(e));
      if (this.topologyTool) return options.onPickTopology?.(this.pickTopology(e));
      if (!this.measuring) {
        // The nearest of the bodies and the placed parts.
        const hit = this.hits(this.ray(e), [...this.solids(), ...this.parts.children])[0];
        const path = partPath(hit);
        return path ? options.onPickComponent?.(path) : options.onPick(this.pick(e));
      }
      const point = this.measurePoint(e);
      if (point) options.onMeasure?.(point);
    });
    canvas.addEventListener('pointercancel', () => {
      this.refusal = undefined;
      this.jointRefusal = undefined;
      this.endMove(false);
      this.endJointDrag(false);
    });
    window.addEventListener('keydown', this.onKey, true);
    // A resize changes every instance's size on screen as a camera move does.
    this.resize = new ResizeObserver(() => {
      this.layout();
      this.scheduleLevels();
    });
    this.resize.observe(host);
    this.layout();
  }
  private layout() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.frameOrthographic();
    this.render();
  }
  private frameOrthographic() {
    const { clientWidth: w, clientHeight: h } = this.host;
    const half = this.orthographicSpan / 2;
    const aspect = w && h ? w / h : 1;
    Object.assign(this.orthographic, {
      left: -half * aspect,
      right: half * aspect,
      top: half,
      bottom: -half,
    });
    this.orthographic.updateProjectionMatrix();
  }
  private helpers({ step, divisions, center }: typeof defaultGrid): [GridHelper, AxesHelper] {
    const grid = new GridHelper(step * divisions, divisions, '#b8c2cc', '#dde3e8');
    grid.rotation.x = Math.PI / 2;
    grid.position.set(center[0], center[1], 0);
    return [grid, new AxesHelper(step * 3)];
  }
  /** Sizes the grid to the shown model, replacing it only when its cells change. */
  private fitGrid(bounds: Bounds | undefined) {
    const spec = bounds ? gridFor(bounds) : defaultGrid;
    const key = JSON.stringify(spec);
    if (key === this.gridKey) return;
    this.gridKey = key;
    for (const helper of [this.grid, this.axes]) {
      this.scene.remove(helper);
      helper.dispose();
    }
    [this.grid, this.axes] = this.helpers(spec);
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid, this.axes);
  }
  /** Shows or hides the ground grid at z = 0 (display only; the axes stay). */
  setGrid(visible: boolean) {
    this.gridVisible = visible;
    this.grid.visible = visible;
    this.render();
  }
  /** Whether the pointer is still within a click's distance of where it went down. */
  private still(e: PointerEvent) {
    return !!this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) <= 4;
  }
  private makeControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    controls.rotateSpeed = orbitRotateSpeed;
    // Rebuilt controls (a view with another camera or up) keep the Move tool's orbit-off state.
    controls.enableRotate = !this.moveTool;
    controls.addEventListener('change', () => {
      this.render();
      this.scheduleLevels();
    });
    return controls;
  }
  private use(camera: PerspectiveCamera | OrthographicCamera) {
    this.camera = camera;
  }
  /**
   * OrbitControls takes its orbit axis from camera.up when it is created, so rebuild it after the
   * camera or its up vector changes (a named view may look along Z with Y up).
   */
  private orbit() {
    if (this.controls.object === this.camera && this.orbitUp.equals(this.camera.up)) return;
    const target = this.controls.target.clone();
    this.controls.dispose();
    this.controls = this.makeControls();
    this.controls.target.copy(target);
    this.orbitUp.copy(this.camera.up);
  }
  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }
  private release = (e: PointerEvent) => this.pointers.delete(e.pointerId);
  /** Whether a body is being dragged: its display offset is not committed content. */
  get dragging() {
    return !!this.drag;
  }
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || (!this.drag && !this.jointDrag)) return;
    // Escape cancels the gesture before it reaches selection handling.
    e.preventDefault();
    e.stopPropagation();
    this.endMove(false);
    this.endJointDrag(false);
  };
  /** Turns the Move tool on (primary drag moves bodies; pan and zoom stay, orbit is off) or off. */
  setMoveTool(tool: CadMoveTool | undefined) {
    this.endMove(false);
    this.moveTool = tool;
    this.controls.enableRotate = !tool;
  }
  private ray(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray;
  }
  /**
   * The ray's hits on `objects`, nearest first, that the camera draws: a raycaster from the
   * camera ignores its near and far planes, so clipped surfaces are dropped by view depth.
   */
  private hits(ray: Raycaster, objects: Object3D[]) {
    const view = this.camera.matrixWorldInverse;
    const { near, far } = this.camera;
    return ray.intersectObjects(objects, false).filter((h) => {
      const depth = -h.point.clone().applyMatrix4(view).z;
      return depth >= near && depth <= far;
    });
  }
  private startMove(e: PointerEvent) {
    if (!this.pickable) return;
    const ray = this.ray(e);
    const hit = this.hits(ray, this.solids())[0];
    const bodyId = hit?.object.userData.bodyId as string | undefined;
    if (!hit || !bodyId) return;
    // Rays nearly parallel to the horizontal plane meet it far away or not at all: a small pointer
    // motion would be a huge move. Refuse below about 10° instead of guessing.
    const pointerId = e.pointerId;
    if (Math.abs(ray.ray.direction.z) < minDragElevation)
      return void (this.refusal = { bodyId, reason: 'edge-on', pointerId });
    if (!this.moveTool!.canMove(bodyId))
      return void (this.refusal = { bodyId, reason: 'bound', pointerId });
    // The horizontal plane through the grabbed point: the body slides along X and Y.
    const plane = new Plane(new Vector3(0, 0, 1), -hit.point.z);
    this.drag = {
      bodyId,
      pointerId: e.pointerId,
      plane,
      start: hit.point.clone(),
      delta: new Vector3(),
    };
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.controls.enabled = false;
  }
  private moveTo(e: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const { ray } = this.ray(e);
    // A perspective ray toward the horizon: keep the last position instead of jumping far away.
    if (Math.abs(ray.direction.z) < minDragElevation) return;
    const at = ray.intersectPlane(drag.plane, new Vector3());
    if (!at) return;
    drag.delta.subVectors(at, drag.start).setZ(0);
    this.offsetBody(drag.bodyId, drag.delta);
  }
  private endMove(commit: boolean) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    this.down = undefined;
    this.controls.enabled = true;
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    // 0.01 mm steps keep typed coordinates readable.
    const delta = drag.delta.toArray().map((v) => Math.round(v * 100) / 100) as Vec3;
    if (commit && delta.some((v) => v !== 0)) {
      const moved = (this.moved = {
        bodyId: drag.bodyId,
        delta: new Vector3(...delta),
        mesh: this.shownMeshes.get(drag.bodyId),
      });
      void this.moveTool?.onMove(drag.bodyId, delta).then((applied) => {
        if (applied || this.moved !== moved) return;
        this.moved = undefined;
        this.offsetBody(moved.bodyId, new Vector3());
      });
      return;
    }
    this.offsetBody(drag.bodyId, new Vector3());
  }
  /** Display-only translation of one body's meshes; the next `show` replaces them. */
  private offsetBody(bodyId: string, delta: Vector3) {
    for (const child of this.bodies.children) {
      if (child.userData.bodyId !== bodyId) continue;
      const origin = child.userData.origin as Vec3;
      child.position.set(origin[0] + delta.x, origin[1] + delta.y, origin[2] + delta.z);
    }
    this.render();
  }
  /** R2b-2c: clicks pick connectors (faces, edges, vertices) for a new joint, or select again. */
  setConnectorTool(tool: CadConnectorTool | undefined) {
    const was = !!this.connectorTool;
    this.connectorTool = tool;
    // A connector is picked on the standard meshes: every instance is drawn with them meanwhile.
    if (was !== !!tool && this.lastParts.length) this.showParts(this.lastParts);
  }
  /** R2b-2c: drags on a joint's child change its value (see CadJointDragTool), or stop doing so. */
  setJointDragTool(tool: CadJointDragTool | undefined) {
    // A drag under way keeps the tool it started with; turning drags off cancels it.
    if (!tool) this.endJointDrag(false);
    this.jointTool = tool;
  }
  /** Whether a joint's value is being dragged: its shown poses are not committed content. */
  get draggingJoint() {
    return !!this.jointDrag;
  }
  private dragRay(e: PointerEvent): CadDragRay {
    const { ray } = this.ray(e);
    return { origin: ray.origin.toArray() as Vec3, direction: ray.direction.toArray() as Vec3 };
  }
  private startJointDrag(e: PointerEvent) {
    const tool = this.jointTool!;
    if (!this.pickable) return;
    const hit = this.hits(this.ray(e), [...this.solids(), ...this.parts.children])[0];
    const path = partPath(hit);
    // Only the joint's child (and what hangs from it) is grabbed: anything else navigates.
    if (!hit || !path || !tool.moves.has(path[0]!)) return;
    const refused = tool.start(this.dragRay(e), hit.point.toArray() as Vec3, e.shiftKey);
    if (refused) return void (this.jointRefusal = { reason: refused, pointerId: e.pointerId });
    this.jointDrag = { pointerId: e.pointerId, tool, key: movedKey(this.lastParts, posed(tool)) };
    this.partsPose = undefined;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.controls.enabled = false;
  }
  private moveJointDrag(e: PointerEvent) {
    const drag = this.jointDrag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const motion = drag.tool.move(this.dragRay(e));
    if (!motion) return;
    const delta = new Matrix4().compose(
      new Vector3(...motion.translationMm),
      new Quaternion(...motion.rotation),
      new Vector3(1, 1, 1),
    );
    // A copy's motion is the drag's seen from its own frame: C·D·C⁻¹.
    const frames = drag.tool.frames;
    const deltas = frames
      ? new Map(
          [...frames].map(([step, f]) => {
            const c = new Matrix4().fromArray(poseMatrix(f));
            return [step, c.clone().multiply(delta).multiply(c.invert())] as const;
          }),
        )
      : delta;
    this.partsPose = { moves: posed(drag.tool), delta: deltas, key: drag.key };
    poseParts(this.parts, this.partsPose.moves, deltas);
    this.render();
  }
  private endJointDrag(commit: boolean) {
    const drag = this.jointDrag;
    if (!drag) return;
    this.jointDrag = undefined;
    this.down = undefined;
    this.controls.enabled = true;
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    const pose = commit ? this.partsPose : undefined;
    if (!pose) this.unposeParts();
    // The released preview stays until the edit's poses arrive (or it is refused).
    void drag.tool.end(commit && !!pose).then((applied) => {
      if (!applied && this.partsPose === pose) this.unposeParts();
    });
  }
  private unposeParts() {
    if (!this.partsPose) return;
    this.partsPose = undefined;
    poseParts(this.parts, new Set());
    this.render();
  }
  /**
   * The connector under the pointer: on the nearest shown body or placed part's shape, its
   * vertex within `measureSnapPx`, else its edge within `edgePickPx`, else its face; elements
   * hidden behind a surface are never taken.
   */
  private pickConnector(e: PointerEvent): CadConnectorPick | null {
    const shapes = [...this.solids(), ...this.parts.children.filter((o) => o instanceof Mesh)];
    const ray = this.ray(e);
    const hit = this.hits(ray, shapes)[0];
    if (!hit || typeof hit.faceIndex !== 'number') return null;
    let mesh: CadMesh | undefined;
    let path: string[] | undefined;
    const toWorld = new Matrix4();
    if (hit.object instanceof InstancedMesh) {
      if (hit.instanceId === undefined) return null;
      mesh = hit.object.userData.mesh as CadMesh | undefined;
      path = (hit.object.userData.paths as string[][])[hit.instanceId];
      const frames = hit.object.userData.frames as Matrix4[] | undefined;
      if (frames) toWorld.copy(frames[hit.instanceId]!);
    } else {
      const bodyId = hit.object.userData.bodyId as string | undefined;
      mesh = bodyId ? this.shownMeshes.get(bodyId) : undefined;
    }
    // A part drawn as a box has no pick table: nothing to connect to yet.
    if (!mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(e.clientX, e.clientY);
    const screen = (p: Vector3) => {
      const ndc = p.clone().project(this.camera);
      return new Vector2(
        ((ndc.x + 1) / 2) * rect.width + rect.left,
        ((1 - ndc.y) / 2) * rect.height + rect.top,
      );
    };
    const world = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]).applyMatrix4(toWorld);
    const pick = (kind: CadTopologyKind, index: number, at: Vector3): CadConnectorPick => ({
      ...(path ? { path } : {}),
      mesh: mesh!,
      kind,
      index,
      point: at.toArray() as Vec3,
    });
    let vertex: { i: number; px: number; at: Vector3 } | undefined;
    mesh.topology.vertices.forEach((v, i) => {
      const at = world(v.centroid);
      const px = screen(at).distanceTo(pointer);
      if (px > measureSnapPx || (vertex && px >= vertex.px)) return;
      if (!this.clipToView(at.clone(), at.clone()) || this.occluded(at, shapes)) return;
      vertex = { i, px, at };
    });
    if (vertex) return pick('vertex', vertex.i, vertex.at);
    const origin = mesh.origin;
    let edge: { id: number; px: number; at: Vector3 } | undefined;
    for (let s = 0; s < mesh.edgeIds.length; s++) {
      const k = s * 6;
      const e6 = mesh.edges;
      const a = world([e6[k]! + origin[0], e6[k + 1]! + origin[1], e6[k + 2]! + origin[2]]);
      const b = world([e6[k + 3]! + origin[0], e6[k + 4]! + origin[1], e6[k + 5]! + origin[2]]);
      if (!this.clipToView(a, b)) continue;
      const [sa, sb] = [screen(a), screen(b)];
      const ab = sb.clone().sub(sa);
      const t = ab.lengthSq()
        ? Math.min(1, Math.max(0, pointer.clone().sub(sa).dot(ab) / ab.lengthSq()))
        : 0;
      const px = sa.clone().addScaledVector(ab, t).distanceTo(pointer);
      if (px > edgePickPx || (edge && px >= edge.px)) continue;
      const at = new Vector3();
      ray.ray.distanceSqToSegment(a, b, undefined, at);
      if (this.occluded(at, shapes)) continue;
      edge = { id: mesh.edgeIds[s]!, px, at };
    }
    if (edge) return pick('edge', edge.id - 1 - mesh.edgeBase, edge.at);
    const face = mesh.faceIds[hit.faceIndex];
    return face === undefined ? null : pick('face', face - 1 - mesh.faceBase, hit.point.clone());
  }
  /**
   * R2b-2c: draws connector frames (x red, y green, z blue) and picked points over the model,
   * or clears them.
   */
  showJointMarks(marks: { frames: CadSolvedPose[]; points: Vec3[] }) {
    for (const child of [...this.jointMarks.children]) {
      this.jointMarks.remove(child);
      const x = child as Points | LineSegments;
      x.geometry.dispose();
      (x.material as { dispose(): void }).dispose();
    }
    const box = new Box3().setFromObject(this.parts).union(new Box3().setFromObject(this.bodies));
    const size = (box.isEmpty() ? 100 : box.getSize(new Vector3()).length()) * frameMarkShare;
    for (const frame of marks.frames) {
      const geometry = new BufferGeometry();
      const o = new Vector3(...frame.translationMm);
      const q = new Quaternion(...frame.rotation);
      const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
      const points = axes.flatMap((a) => [
        ...o.toArray(),
        ...o.clone().addScaledVector(a.applyQuaternion(q), size).toArray(),
      ]);
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
      const colors = [
        [0.86, 0.15, 0.15],
        [0.09, 0.64, 0.29],
        [0.15, 0.39, 0.92],
      ].flatMap((c) => [...c, ...c]);
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
      const line = new LineSegments(
        geometry,
        new LineBasicMaterial({ vertexColors: true, depthTest: false }),
      );
      line.renderOrder = 3;
      this.jointMarks.add(line);
    }
    if (marks.points.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(marks.points.flat()), 3),
      );
      const dots = new Points(
        geometry,
        new PointsMaterial({
          color: '#7c3aed',
          size: 10,
          sizeAttenuation: false,
          depthTest: false,
        }),
      );
      dots.renderOrder = 3;
      this.jointMarks.add(dots);
    }
    this.render();
  }
  /** Turns the measure tool on or off; it leaves selection and navigation as they are. */
  setMeasureTool(on: boolean) {
    this.measuring = on;
  }
  /** Clicks pick faces or edges (the pick table) instead of bodies, or bodies again. */
  setTopologyTool(kind: 'face' | 'edge' | undefined) {
    this.topologyTool = kind;
  }
  /**
   * The face under the pointer, or the edge drawn within `edgePickPx` of it that no surface
   * hides (nearest on screen, then nearest to the camera).
   */
  private pickTopology(e: PointerEvent): CadTopologyPick | null {
    const solids = this.solids();
    const ray = this.ray(e);
    const hit = this.hits(ray, solids)[0];
    if (this.topologyTool === 'face') {
      const bodyId = hit?.object.userData.bodyId as string | undefined;
      const mesh = bodyId ? this.shownMeshes.get(bodyId) : undefined;
      const id =
        mesh && typeof hit?.faceIndex === 'number' ? mesh.faceIds[hit.faceIndex] : undefined;
      return mesh && id !== undefined ? { bodyId: mesh.bodyId, kind: 'face', id } : null;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const screen = (p: Vector3) => {
      const ndc = p.clone().project(this.camera);
      return new Vector2(
        ((ndc.x + 1) / 2) * rect.width + rect.left,
        ((1 - ndc.y) / 2) * rect.height + rect.top,
      );
    };
    const pointer = new Vector2(e.clientX, e.clientY);
    // Depth along the pick ray, as the surface hit's distance is measured (an orthographic
    // ray starts on the near plane, not at the camera).
    const along = (p: Vector3) => p.clone().sub(ray.ray.origin).dot(ray.ray.direction);
    let best: { pick: CadTopologyPick; px: number; depth: number } | undefined;
    for (const mesh of this.shownMeshes.values()) {
      const origin = new Vector3(...mesh.origin);
      for (let s = 0; s < mesh.edgeIds.length; s++) {
        const a = new Vector3(mesh.edges[s * 6]!, mesh.edges[s * 6 + 1]!, mesh.edges[s * 6 + 2]!);
        const b = new Vector3(
          mesh.edges[s * 6 + 3]!,
          mesh.edges[s * 6 + 4]!,
          mesh.edges[s * 6 + 5]!,
        );
        a.add(origin);
        b.add(origin);
        // Only the part between the camera's near and far planes is drawn, and can be picked.
        if (!this.clipToView(a, b)) continue;
        const [sa, sb] = [screen(a), screen(b)];
        const ab = sb.clone().sub(sa);
        const t = ab.lengthSq()
          ? Math.min(1, Math.max(0, pointer.clone().sub(sa).dot(ab) / ab.lengthSq()))
          : 0;
        const px = sa.clone().addScaledVector(ab, t).distanceTo(pointer);
        if (px > edgePickPx) continue;
        // The segment point nearest the pick ray: `t` is a screen parameter, which in a
        // perspective view is not the parameter of the same point on the world segment.
        const onSegment = new Vector3();
        ray.ray.distanceSqToSegment(a, b, undefined, onSegment);
        const depth = along(onSegment);
        // Hidden edges are not picked: no surface may lie clearly in front of the candidate
        // along the ray through its own projected point (the pointer's ray can miss every
        // surface while the candidate, a few pixels away, sits behind one).
        if (this.occluded(onSegment, solids)) continue;
        if (best && (px > best.px || (px === best.px && depth >= best.depth))) continue;
        best = { pick: { bodyId: mesh.bodyId, kind: 'edge', id: mesh.edgeIds[s]! }, px, depth };
      }
    }
    return best?.pick ?? null;
  }
  /** Whether a drawn surface lies clearly in front of `p` along the view ray through `p`. */
  private occluded(p: Vector3, solids: Object3D[]): boolean {
    const ndc = p.clone().project(this.camera);
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.camera);
    const depth = p.clone().sub(ray.ray.origin).dot(ray.ray.direction);
    const front = this.hits(ray, solids)[0];
    return !!front && depth > front.distance + Math.max(1e-3, depth * 1e-3);
  }
  /**
   * Clips the world segment a–b in place to the camera's near–far range; false when none of it
   * is in that range (behind the camera, or past the far plane).
   */
  private clipToView(a: Vector3, b: Vector3): boolean {
    const view = this.camera.matrixWorldInverse;
    // View-space depth: the camera looks down −z, so a visible point has near ≤ −z ≤ far.
    const [da, db] = [-a.clone().applyMatrix4(view).z, -b.clone().applyMatrix4(view).z];
    const { near, far } = this.camera;
    let [t0, t1] = [0, 1];
    for (const [lo, from, to] of [
      [near, da, db],
      [-far, -da, -db],
    ] as const) {
      // Keep the part where depth − lo ≥ 0 along the segment.
      const [fa, fb] = [from - lo, to - lo];
      if (fa < 0 && fb < 0) return false;
      if (fa < 0) t0 = Math.max(t0, fa / (fa - fb));
      else if (fb < 0) t1 = Math.min(t1, fa / (fa - fb));
    }
    if (t0 > t1) return false;
    const [ca, cb] = [a.clone(), b.clone()];
    a.lerpVectors(ca, cb, t0);
    b.lerpVectors(ca, cb, t1);
    return true;
  }
  private measurePoint(e: PointerEvent): CadMeasurePoint | undefined {
    const solids = this.solids();
    const hit = this.hits(this.ray(e), solids)[0];
    const bodyId = hit?.object.userData.bodyId as string | undefined;
    if (!hit || !bodyId) return undefined;
    // The hit body's vertices within the snap distance on screen, nearest first; the first one
    // nothing hides is the point. A vertex behind the shape is never taken.
    const rect = this.renderer.domElement.getBoundingClientRect();
    const vertices = this.shownMeshes.get(bodyId)?.vertices ?? new Float64Array();
    const near: { point: Vec3; px: number; ndc: Vector3 }[] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      const point: Vec3 = [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!];
      const ndc = new Vector3(...point).project(this.camera);
      const px = Math.hypot(
        ((ndc.x + 1) / 2) * rect.width + rect.left - e.clientX,
        ((1 - ndc.y) / 2) * rect.height + rect.top - e.clientY,
      );
      if (px <= measureSnapPx) near.push({ point, px, ndc });
    }
    // Nearest on screen first; at the same spot, nearest to the camera.
    near.sort((a, b) => a.px - b.px || a.ndc.z - b.ndc.z);
    // The display mesh has a node at every B-rep vertex, rounded to Float32 relative to the
    // mesh origin. The ray goes to that rendered node, so rounding never makes it miss or graze
    // the shape; the measured point stays the kernel's coordinate. The vertex is visible when no
    // surface lies in front of the node beyond that rounding, however close an occluder is.
    const solid = hit.object as Mesh;
    const nodes = solid.geometry.getAttribute('position');
    const radius = solid.geometry.boundingSphere?.radius ?? 0;
    const tolerance = Math.max(1e-6, radius * 1e-6);
    const ray = new Raycaster();
    for (const { point } of near) {
      const node = this.renderedNode(solid, nodes, point, tolerance * 10);
      if (!node) continue;
      const ndc = node.clone().project(this.camera);
      ray.setFromCamera(new Vector2(ndc.x, ndc.y), this.camera);
      const at = ray.ray.origin.distanceTo(node);
      const first = this.hits(ray, solids)[0];
      if (!first || first.distance >= at - tolerance) return { bodyId, point, vertex: true };
    }
    return { bodyId, point: hit.point.toArray() as Vec3, vertex: false };
  }
  /** The display mesh's node at a kernel vertex (world space), or undefined if none is that close. */
  private renderedNode(
    solid: Mesh,
    nodes: {
      count: number;
      getX(i: number): number;
      getY(i: number): number;
      getZ(i: number): number;
    },
    [x, y, z]: Vec3,
    within: number,
  ): Vector3 | undefined {
    const [ox, oy, oz] = [x - solid.position.x, y - solid.position.y, z - solid.position.z];
    let best = within;
    let found: Vector3 | undefined;
    for (let i = 0; i < nodes.count; i++) {
      const d = Math.hypot(nodes.getX(i) - ox, nodes.getY(i) - oy, nodes.getZ(i) - oz);
      if (d <= best) {
        best = d;
        found = new Vector3(nodes.getX(i), nodes.getY(i), nodes.getZ(i)).add(solid.position);
      }
    }
    return found;
  }
  /** Draws the measured points (and the line between two) over the shape, or clears them. */
  showMeasure(points: readonly Vec3[]) {
    this.clearMarks();
    if (points.length) {
      // Relative to the first point, as the bodies are, so Float32 keeps far-away marks apart.
      const origin = points[0]!;
      const local = points.flatMap((p) => p.map((v, i) => v - origin[i]!));
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(local), 3));
      const dots = new Points(
        geometry,
        new PointsMaterial({ color: '#d9480f', size: 9, sizeAttenuation: false, depthTest: false }),
      );
      dots.renderOrder = 2;
      dots.position.set(...origin);
      this.marks.add(dots);
      if (points.length === 2) {
        const line = new LineSegments(
          geometry.clone(),
          new LineBasicMaterial({ color: '#d9480f', depthTest: false }),
        );
        line.renderOrder = 1;
        line.position.set(...origin);
        this.marks.add(line);
      }
    }
    this.render();
  }
  private clearMarks() {
    for (const child of [...this.marks.children]) {
      this.marks.remove(child);
      if (child instanceof Points || child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as { dispose(): void }).dispose();
      }
    }
  }
  /** The shown bodies' solids (not the highlight drawn over them), for rays. */
  private solids() {
    return this.bodies.children.filter(
      (c) => c instanceof Mesh && !c.userData.highlight && !c.userData.beforeFailure,
    );
  }
  private pick(e: PointerEvent): string | null {
    const hit = this.hits(this.ray(e), this.solids())[0];
    return (hit?.object.userData.bodyId as string | undefined) ?? null;
  }
  private clear() {
    for (const child of [...this.bodies.children]) {
      this.bodies.remove(child);
      if (child instanceof Mesh || child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as { dispose(): void }).dispose();
      }
    }
  }
  /** The picked face's triangles or the picked edge's segments, drawn over the shape. */
  private highlighted(mesh: CadMesh, pick: CadTopologyPick) {
    const geometry = new BufferGeometry();
    let object: Mesh | LineSegments;
    if (pick.kind === 'face') {
      // The face's own triangles in a buffer of their own: the GPU budget counts each uploaded
      // buffer, so the highlight never shares (and hides) the solid's position buffer.
      const points: number[] = [];
      for (let t = 0; t < mesh.faceIds.length; t++)
        if (mesh.faceIds[t] === pick.id)
          for (let k = 0; k < 3; k++) {
            const v = mesh.indices[t * 3 + k]!;
            points.push(...mesh.positions.subarray(v * 3, v * 3 + 3));
          }
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
      object = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: '#2563eb',
          transparent: true,
          opacity: 0.45,
          depthTest: false,
          // Seen from behind too: a sheet's face can be picked from its back.
          side: DoubleSide,
        }),
      );
    } else {
      const points: number[] = [];
      for (let s = 0; s < mesh.edgeIds.length; s++)
        if (mesh.edgeIds[s] === pick.id) points.push(...mesh.edges.subarray(s * 6, s * 6 + 6));
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
      object = new LineSegments(
        geometry,
        new LineBasicMaterial({ color: '#f97316', depthTest: false }),
      );
    }
    object.renderOrder = 1;
    object.position.set(...mesh.origin);
    object.userData.bodyId = mesh.bodyId;
    // A Move drag offsets every object of the body from its origin, the highlight included.
    object.userData.origin = mesh.origin;
    object.userData.highlight = true;
    return object;
  }
  /** GPU buffers of the shown geometry (solids and edges), each attribute once. */
  /** Changes the GPU budget (CAD26) and draws the last shown geometry again under it. */
  setGpuBudget(bytes: number | undefined) {
    if (bytes === this.gpuBudget) return;
    this.gpuBudget = bytes;
    this.show(this.lastShown.bodies, this.lastShown.current, this.lastShown.dim);
  }
  get gpuBytes(): number {
    const seen = new Set<unknown>();
    let bytes = 0;
    for (const child of this.bodies.children)
      if (child instanceof Mesh || child instanceof LineSegments) {
        const { attributes, index } = child.geometry;
        for (const a of [...Object.values(attributes), ...(index ? [index] : [])])
          if (!seen.has(a.array)) {
            seen.add(a.array);
            bytes += (a.array as ArrayLike<number> & { byteLength: number }).byteLength;
          }
      }
    return bytes;
  }
  /**
   * Replaces displayed geometry. `current: false` shows the previous shape dimmed and unpickable.
   * The old resources are disposed first; geometry over the GPU budget is not shown (CAD26).
   */
  /** `dim` (default: not current) draws an earlier content's meshes faded. */
  show(bodies: ViewportBody[], current: boolean, dim = !current) {
    this.lastShown = { bodies, current, dim };
    this.clear();
    this.pickable = current;
    const shading = this.shading;
    for (const { mesh, color, opacity: native, selected, sheet, highlight, curvature } of bodies) {
      // Stale dimming multiplies the native opacity instead of replacing it.
      const opacity = native * (dim ? 0.35 : 1) * (mesh.beforeFailure ? beforeFailureOpacity : 1);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new BufferAttribute(mesh.indices, 1));
      const colored = shading.mode === 'curvature' && !!curvature;
      if (colored) {
        const colors = new Float32Array(mesh.positions.length);
        for (let i = 0; i < curvature.length; i++)
          colors.set(curvatureColor(curvature[i]!, shading.range), i * 3);
        geometry.setAttribute('color', new BufferAttribute(colors, 3));
      }
      const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
      const zebra =
        shading.mode === 'zebra' && (!shading.selectedOnly || selected)
          ? new ShaderMaterial({
              vertexShader: zebraVertex,
              fragmentShader: zebraFragment,
              uniforms: {
                axis: {
                  value: new Vector3(
                    shading.axis === 'x' ? 1 : 0,
                    shading.axis === 'y' ? 1 : 0,
                    shading.axis === 'z' ? 1 : 0,
                  ),
                },
                stripes: { value: shading.stripes },
                opacity: { value: opacity },
              },
              // Both sides: a sheet's back reflects the stripes too.
              side: sheet ? DoubleSide : FrontSide,
              transparent: opacity < 1,
              depthWrite: opacity >= 1,
              ...offset,
            })
          : undefined;
      const material =
        zebra ??
        new MeshStandardMaterial({
          color: colored ? '#ffffff' : color,
          vertexColors: colored,
          roughness: 0.55,
          metalness: 0.05,
          transparent: opacity < 1,
          opacity,
          depthWrite: opacity >= 1,
          // A light tint only: the outline marks the selection, the body keeps its own colour.
          emissive: selected ? new Color('#2563eb') : new Color('#000000'),
          emissiveIntensity: selected ? 0.12 : 0,
          ...offset,
        });
      const solid = new Mesh(geometry, material);
      solid.userData.bodyId = mesh.bodyId;
      // The back of a sheet: the same triangles seen from behind, darker so the sides differ.
      const back =
        sheet && !zebra
          ? new Mesh(
              geometry,
              Object.assign(material.clone(), {
                side: BackSide,
                color: new Color(colored ? '#ffffff' : color).multiplyScalar(0.55),
              }),
            )
          : undefined;
      const outline = new EdgesGeometry(geometry, 25);
      const edges = new LineSegments(
        outline,
        new LineBasicMaterial({
          color: selected ? '#2563eb' : '#33414f',
          transparent: opacity < 1,
          opacity,
        }),
      );
      // The selected body's edges behind other shapes, faint, so its outline reads whole.
      const through = selected
        ? new LineSegments(
            outline,
            new LineBasicMaterial({
              color: '#2563eb',
              transparent: true,
              opacity: 0.35 * opacity,
              depthTest: false,
              depthWrite: false,
            }),
          )
        : undefined;
      if (through) through.renderOrder = 2;
      const drawn = [solid, edges, ...(back ? [back] : []), ...(through ? [through] : [])];
      // Positions are relative to the mesh origin (Float32 precision far from the model origin).
      for (const object of drawn) {
        object.position.set(...mesh.origin);
        object.userData.bodyId = mesh.bodyId;
        object.userData.origin = mesh.origin;
        if (mesh.beforeFailure) object.userData.beforeFailure = true;
      }
      this.bodies.add(...drawn);
      if (highlight) this.bodies.add(this.highlighted(mesh, highlight));
    }
    const budget = this.gpuBudget ?? cadBudgets.gpuBytes;
    const bytes = this.gpuBytes;
    if (bytes > budget) {
      this.clear();
      bodies = [];
    }
    this.options.onGpuBudget?.(bytes > budget ? bytes : undefined);
    // A shape before a failure is drawn only: no pick, snap or move reads it.
    this.shownMeshes = new Map(
      bodies.filter((b) => !b.mesh.beforeFailure).map((b) => [b.mesh.bodyId, b.mesh]),
    );
    // Until the body's mesh changes (the move's own result), a redraw of the meshes it was
    // dropped on (a selection, the edit starting) keeps the dropped position.
    const moved = this.moved;
    if (moved && this.shownMeshes.get(moved.bodyId) === moved.mesh)
      this.offsetBody(moved.bodyId, moved.delta);
    else this.moved = undefined;
    const box = new Box3().setFromObject(this.bodies);
    this.fitGrid(
      box.isEmpty() ? undefined : [box.min.toArray() as Vec3, box.max.toArray() as Vec3],
    );
    if (!this.autoFit.bodies && bodies.length) {
      this.autoFit.bodies = true;
      this.fit();
      this.fitted = true;
    }
    // The placed parts share the budget with these bodies: admit them again when that changes.
    const partsFit = this.gpuBytes + this.partsFullBytes <= (this.gpuBudget ?? cadBudgets.gpuBytes);
    if (this.lastParts.length && partsFit !== this.partsFit) this.showParts(this.lastParts);
    this.render();
  }
  /** Shades bodies this way from the next `show` on; display only. */
  setShading(shading: CadShading) {
    this.shading = shading;
  }
  /**
   * Draws a curvature comb over the shape (model space): a tooth from each sample away from the
   * centre of curvature, `scale` mm per 1/mm, and the line through the tips. Undefined clears it.
   */
  showComb(comb: { samples: readonly CadCombSample[]; scale: number } | undefined) {
    this.clearComb();
    if (comb?.samples.length) {
      // Relative to the first sample, as the bodies are, for Float32 precision.
      const origin = comb.samples[0]!.at;
      const local = (p: Vec3) => p.map((v, i) => v - origin[i]!);
      const tips = comb.samples.map((s) => local(combTip(s, comb.scale)));
      const teeth = new BufferGeometry();
      teeth.setAttribute(
        'position',
        new BufferAttribute(
          new Float32Array(comb.samples.flatMap((s, i) => [...local(s.at), ...tips[i]!])),
          3,
        ),
      );
      const envelope = new BufferGeometry();
      envelope.setAttribute(
        'position',
        new BufferAttribute(
          new Float32Array(tips.slice(1).flatMap((tip, i) => [...tips[i]!, ...tip])),
          3,
        ),
      );
      for (const [geometry, opacity] of [
        [teeth, 0.6],
        [envelope, 1],
      ] as const) {
        const line = new LineSegments(
          geometry,
          new LineBasicMaterial({ color: combColor, depthTest: false, transparent: true, opacity }),
        );
        line.renderOrder = 2;
        line.position.set(...origin);
        this.combs.add(line);
      }
    }
    this.render();
  }
  private clearComb() {
    for (const child of [...this.combs.children]) {
      this.combs.remove(child);
      if (child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as { dispose(): void }).dispose();
      }
    }
  }
  /** Shows a saved camera. Opening with it replaces the first automatic fit. */
  setView({ camera, projection }: CadViewportView) {
    this.fitted = true;
    this.autoFit = { bodies: true, parts: true };
    const [position, target] = [new Vector3(...camera.position), new Vector3(...camera.target)];
    const distance = position.distanceTo(target);
    if (projection.type === 'perspective') {
      this.use(this.perspective);
      this.perspective.fov = (projection.fovRad * 180) / Math.PI;
      this.perspective.near = distance / 1000;
      this.perspective.far = distance * 100;
    } else {
      this.use(this.orthographic);
      this.orthographicSpan = projection.spanMm;
      this.orthographic.zoom = 1;
      // Depth range around the target, however far back the saved camera stands.
      this.orthographic.near = distance - 100_000;
      this.orthographic.far = distance + 100_000;
      this.frameOrthographic();
    }
    // Validation allows any length; OrbitControls needs a unit vector.
    this.camera.up.set(...camera.up).normalize();
    this.orbit();
    this.camera.position.copy(position);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();
    this.render();
  }
  /** The camera as it is now, for Save view. */
  currentView(): CadViewportView {
    const camera = {
      position: this.camera.position.toArray() as Vec3,
      target: this.controls.target.toArray() as Vec3,
      up: this.camera.up.toArray() as Vec3,
    };
    return viewOf(
      camera,
      this.camera === this.perspective
        ? { type: 'perspective', fovRad: (this.perspective.fov * Math.PI) / 180 }
        : { type: 'orthographic', spanMm: this.orthographicSpan / this.orthographic.zoom },
    );
  }
  /**
   * R2b-4: how large a world box shows on screen (the diagonal of its projected extent, px),
   * 0 when it lies outside the view; one around or behind the camera counts as the whole view.
   */
  screenSize([lo, hi]: [Vec3, Vec3]) {
    const camera = this.camera;
    camera.updateMatrixWorld();
    const { clientWidth: w, clientHeight: h } = this.host;
    const p = new Vector3();
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
      // The camera looks along −z: a corner at z ≥ 0 in its frame does not project.
      if (p.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return Math.hypot(w, h);
      p.project(camera);
      for (const k of [0, 1, 2] as const) {
        min[k] = Math.min(min[k]!, p.getComponent(k));
        max[k] = Math.max(max[k]!, p.getComponent(k));
      }
    }
    if (max[0]! < -1 || min[0]! > 1 || max[1]! < -1 || min[1]! > 1 || min[2]! > 1) return 0;
    const dx = ((Math.min(max[0]!, 1) - Math.max(min[0]!, -1)) * w) / 2;
    const dy = ((Math.min(max[1]!, 1) - Math.max(min[1]!, -1)) * h) / 2;
    return Math.hypot(dx, dy);
  }
  /**
   * Replaces the placed parts (R2b). Over the GPU budget with the bodies, the parts are drawn as
   * boxes instead; returns whether their shapes fit.
   */
  showParts(parts: ViewportPart[]): boolean {
    this.lastParts = parts;
    this.scene.remove(this.parts);
    disposeParts(this.parts);
    const levels = new Map<string, ViewLevel>();
    let group = partsGroup(parts, (part, inst) => {
      const key = inst.path.join('\u0000');
      const level = this.levelOf(part, inst, this.levels.get(key));
      levels.set(key, level);
      return level;
    });
    this.levels = levels;
    // How many instances each level drew, for a Host's diagnostics and the E2E (R2b-4).
    const counts = { standard: 0, coarse: 0, box: 0 };
    for (const l of levels.values()) counts[l]++;
    this.renderer.domElement.dataset.partLevels = Object.entries(counts).flat().join(' ');
    this.partsFullBytes = partsBytes(group);
    const fits = this.gpuBytes + this.partsFullBytes <= (this.gpuBudget ?? cadBudgets.gpuBytes);
    if (!fits) {
      disposeParts(group);
      group = partsGroup(parts.map((p) => ({ ...p, box: p.box ?? 'simplified' })));
    }
    this.parts = group;
    this.scene.add(group);
    // A joint drag's preview holds over a redraw of the parts it moved, not over their new poses.
    if (this.partsPose && movedKey(parts, this.partsPose.moves) !== this.partsPose.key)
      this.partsPose = undefined;
    if (this.partsPose) poseParts(group, this.partsPose.moves, this.partsPose.delta);
    if (!this.autoFit.parts && parts.some((p) => p.instances.length)) {
      this.autoFit.parts = true;
      this.fit();
      this.fitted = true;
    }
    this.render();
    this.partsFit = fits;
    this.onPartsFit?.(fits);
    return fits;
  }
  /**
   * R2b-4 (LOD): an instance's level from its box's size on screen; the standard mesh while a
   * connector is picked.
   */
  private levelOf(part: Pick<ViewportPart, 'bounds'>, inst: { matrix: number[] }, was?: ViewLevel) {
    if (this.connectorTool) return 'standard';
    const m = new Matrix4().fromArray(inst.matrix);
    const [lo, hi] = part.bounds;
    const box = new Box3();
    for (let i = 0; i < 8; i++)
      box.expandByPoint(
        new Vector3(
          i & 1 ? hi[0] : lo[0],
          i & 2 ? hi[1] : lo[1],
          i & 4 ? hi[2] : lo[2],
        ).applyMatrix4(m),
      );
    return lodLevel(this.screenSize([box.min.toArray(), box.max.toArray()]), was);
  }
  /** Parts that grew or shrank on screen change level once the camera rests a moment. */
  private scheduleLevels() {
    clearTimeout(this.relevel);
    this.relevel = setTimeout(() => this.levelParts(), 150);
  }
  /** Draws the parts again when an instance's level changed since they were drawn. */
  private levelParts() {
    if (this.jointDrag || !this.lastParts.length) return;
    const changed = this.lastParts.some(
      (part) =>
        !!(part.meshes || part.coarse) &&
        !part.box &&
        part.instances.some((inst) => {
          const was = this.levels.get(inst.path.join('\u0000'));
          return this.levelOf(part, inst, was) !== was;
        }),
    );
    if (changed) this.showParts(this.lastParts);
  }
  /** Fits the shown bodies. `reset` also returns to the perspective three-quarter view. */
  fit({ reset = false }: { reset?: boolean } = {}) {
    if (reset) this.use(this.perspective);
    const box = new Box3().setFromObject(this.bodies).union(new Box3().setFromObject(this.parts));
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2 || 50;
    // Fit the narrower of the vertical and horizontal fields of view (portrait phones).
    const aspect = this.perspective.aspect;
    const vertical = (this.perspective.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const distance = (radius * 1.1) / Math.sin(Math.min(vertical, horizontal) / 2);
    // Keep the direction the user turned to; the first fit and a reset look from the front left.
    const direction =
      this.fitted && !reset
        ? this.camera.position.clone().sub(this.controls.target).normalize()
        : new Vector3(0.55, -0.75, 0.6).normalize();
    if (reset) this.camera.up.set(0, 0, 1);
    this.orbit();
    this.camera.position.copy(center.clone().addScaledVector(direction, distance));
    if (this.camera === this.perspective) {
      this.perspective.near = distance / 1000;
      this.perspective.far = distance * 100;
    } else {
      this.orthographicSpan = (radius * 2.2) / Math.min(1, aspect);
      this.orthographic.zoom = 1;
      this.orthographic.near = distance - radius * 2;
      this.orthographic.far = distance + radius * 2;
      this.frameOrthographic();
    }
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
    this.scheduleLevels();
  }
  /**
   * PNG of the current view, rendered now so the drawing buffer holds this frame. Without
   * background, the background colour, grid and axes are left out (transparent pixels).
   */
  capture({ background = true }: { background?: boolean } = {}): Promise<Blob | null> {
    const backdrop = this.scene.background;
    if (!background) {
      this.scene.background = null;
      this.grid.visible = this.axes.visible = false;
    }
    // Measurement and connector marks are not part of the model's picture.
    this.marks.visible = this.jointMarks.visible = false;
    this.renderer.render(this.scene, this.camera);
    this.scene.background = backdrop;
    this.grid.visible = this.gridVisible;
    this.axes.visible = this.marks.visible = this.jointMarks.visible = true;
    return new Promise((resolve) => {
      this.renderer.domElement.toBlob(resolve, 'image/png');
      // Put the normal frame back on screen after the PNG is read.
      this.render();
    });
  }
  dispose() {
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerup', this.release, true);
    window.removeEventListener('pointercancel', this.release, true);
    cancelAnimationFrame(this.frame);
    clearTimeout(this.relevel);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    disposeParts(this.parts);
    this.clearMarks();
    this.showJointMarks({ frames: [], points: [] });
    this.clearComb();
    this.grid.dispose();
    this.axes.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
