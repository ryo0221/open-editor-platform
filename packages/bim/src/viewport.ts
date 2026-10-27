import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  type Material,
  type Mesh,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  disposeInstances,
  instancePath,
  instancesGroup,
  type ViewSolid,
} from '@editor-platform/geometry-view';

export interface BimViewportOptions {
  /** A click on an element (its ID) or on nothing; `add` with Shift or Ctrl/⌘. */
  onPick(id: string | undefined, add: boolean): void;
  /**
   * While drawing: the pointer's point on the level's plane, moved, clicked or double-clicked,
   * and how many millimetres one screen pixel spans there.
   */
  onPlan?(xy: [number, number], kind: 'move' | 'click' | 'double', mmPerPx: number): void;
  onContextLost(): void;
}
/** The plan of a level: looked at from above, cut `cutMm` above the level. */
export interface BimPlanView {
  elevationMm: number;
  cutMm: number;
}
/** What a drawing shows over the plan: its points, the pointer, and whether it closes. */
export interface BimDraftMarks {
  points: [number, number][];
  hover?: [number, number];
  closed: boolean;
  /** The drawn line through the points and the hover, arcs as many points (OH-U2). */
  line?: [number, number][];
}
/** A grid axis as the view draws it: a dashed line with its label at both ends. */
export interface BimViewAxis {
  label: string;
  start: [number, number];
  end: [number, number];
}
type Bounds = [[number, number, number], [number, number, number]];
const noRaycast = () => {};

/**
 * The building's 3D view (Three.js, z up, millimetres): the instanced solids of
 * `geometry-view`, orbit/pan/zoom, and a click that names the element under the pointer.
 */
export class BimViewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly perspective = new PerspectiveCamera(40, 1, 10, 2_000_000);
  private readonly orthographic = new OrthographicCamera(-1, 1, 1, -1, 1, 4_000_000);
  private camera: PerspectiveCamera | OrthographicCamera = this.perspective;
  private controls: OrbitControls;
  private plan: BimPlanView | undefined;
  /** Half the height the plan shows (mm). */
  private planSpan = 20_000;
  private readonly marks = new Group();
  private readonly axes = new Group();
  private axesShown: { axes: BimViewAxis[]; z: number } | undefined;
  /** Clicks go to `onPlan` instead of picking. */
  drawing = false;
  private group: Group | undefined;
  private grid: GridHelper | undefined;
  private readonly resize: ResizeObserver;
  private frame = 0;
  private fitted = false;
  private down: { x: number; y: number } | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: BimViewportOptions,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const canvas = this.renderer.domElement;
    canvas.className = 'bim-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    this.scene.background = new Color('#f4f6f8');
    this.perspective.up.set(0, 0, 1);
    this.perspective.position.set(20_000, -30_000, 20_000);
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(1, -1.5, 2);
    this.scene.add(new AmbientLight('#ffffff', 0.7), sun, this.marks, this.axes);
    this.controls = this.makeControls();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.clear();
      options.onContextLost();
    });
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      const down = this.down;
      this.down = undefined;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      if (this.drawing) {
        const xy = this.planPoint(e);
        if (xy) options.onPlan?.(xy, 'click', this.mmPerPx());
        return;
      }
      options.onPick(this.pick(e), e.shiftKey || e.ctrlKey || e.metaKey);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const xy = this.planPoint(e);
      if (xy) options.onPlan?.(xy, 'move', this.mmPerPx());
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!this.drawing) return;
      const xy = this.planPoint(e);
      if (xy) options.onPlan?.(xy, 'double', this.mmPerPx());
    });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(host);
    this.layout();
  }

  /** Shows the solids; the first content that has bounds frames the 3D camera. */
  show(solids: ViewSolid[], bounds: Bounds | undefined) {
    this.clear();
    this.group = instancesGroup(solids);
    this.scene.add(this.group);
    // A plan keeps its framing while drawing; only Fit view or another level reframes it.
    if (bounds && !this.fitted && !this.plan) {
      this.fit(bounds);
      this.fitted = true;
    }
    this.render();
  }
  /** Frames the bounds: from the south-west and above in 3D, from straight above in a plan. */
  fit(bounds: Bounds) {
    const [lo, hi] = bounds;
    const center = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const radius = Math.max(new Vector3(...hi).distanceTo(new Vector3(...lo)) / 2, 1_000);
    if (this.plan) {
      center.z = this.plan.elevationMm;
      // The span is the half height; a canvas narrower than tall shows less width than that.
      const { clientWidth: w, clientHeight: h } = this.host;
      const aspect = w && h ? w / h : 1;
      this.planSpan = Math.max((hi[0] - lo[0]) / aspect, hi[1] - lo[1], 2_000) * 0.65;
      this.orthographic.zoom = 1;
      this.frameOrthographic();
      this.orthographic.position.set(center.x, center.y, this.plan.elevationMm + 1_000_000);
    } else {
      const distance = radius / Math.sin((this.perspective.fov * Math.PI) / 360);
      const dir = new Vector3(-0.55, -0.75, 0.45).normalize();
      this.perspective.position.copy(center).addScaledVector(dir, distance);
    }
    this.controls.target.copy(center);
    this.controls.update();
    this.placeGrid(lo, hi);
    this.render();
  }
  /**
   * Shows a level's plan (orthographic, from above, cut above the level, pan and zoom only), or
   * the 3D view again with `undefined`.
   */
  setPlan(plan: BimPlanView | undefined, bounds: Bounds | undefined) {
    const was = this.plan;
    this.plan = plan;
    this.renderer.clippingPlanes = plan
      ? [new Plane(new Vector3(0, 0, -1), plan.elevationMm + plan.cutMm)]
      : [];
    if (!plan) this.drawing = false;
    if (!!was !== !!plan) {
      const target = this.controls.target.clone();
      this.camera = plan ? this.orthographic : this.perspective;
      this.controls.dispose();
      this.controls = this.makeControls();
      this.controls.target.copy(target);
    }
    if (was?.elevationMm !== plan?.elevationMm) this.drawAxes();
    // An empty building frames 20 m around the origin.
    if (!was || !plan || was.elevationMm !== plan.elevationMm)
      this.fit(
        bounds ?? [
          [-5_000, -5_000, 0],
          [15_000, 15_000, 0],
        ],
      );
    else this.render();
  }
  /**
   * Draws the grid axes at `z` (the lowest level in 3D; a plan draws them on its level). Never
   * picked: a click goes through to the element under it.
   */
  setAxes(axes: BimViewAxis[], z: number) {
    this.axesShown = { axes, z };
    this.drawAxes();
  }
  private drawAxes() {
    for (const child of [...this.axes.children]) {
      this.axes.remove(child);
      if (child instanceof Sprite) {
        child.material.map?.dispose();
        child.material.dispose();
      } else {
        (child as LineSegments).geometry.dispose();
        ((child as LineSegments).material as LineDashedMaterial).dispose();
      }
    }
    if (!this.axesShown) return this.render();
    const { axes } = this.axesShown;
    const z = this.plan ? this.plan.elevationMm + 3 : this.axesShown.z;
    if (axes.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute(
          axes.flatMap((a) => [...a.start, z, ...a.end, z]),
          3,
        ),
      );
      const lines = new LineSegments(
        geometry,
        new LineDashedMaterial({ color: '#b45309', dashSize: 600, gapSize: 300 }),
      );
      lines.computeLineDistances();
      lines.raycast = noRaycast;
      this.axes.add(lines);
    }
    for (const a of axes)
      for (const at of [a.start, a.end]) {
        // On a plan the labels stay over everything; in 3D the building hides those behind it.
        const label = axisLabel(a.label, !!this.plan);
        label.position.set(at[0], at[1], z);
        this.axes.add(label);
      }
    this.render();
  }
  /** Draws the points of a drawing in progress and the pointer over the plan. */
  setMarks(marks: BimDraftMarks | undefined) {
    for (const child of [...this.marks.children]) {
      this.marks.remove(child);
      (child as LineSegments).geometry.dispose();
      ((child as LineSegments).material as LineBasicMaterial).dispose();
    }
    if (marks && this.plan) {
      const z = this.plan.elevationMm + 5;
      const path = [...marks.points, ...(marks.hover ? [marks.hover] : [])];
      const line = marks.line ?? path;
      const segments: number[] = [];
      for (let i = 1; i < line.length; i++) segments.push(...line[i - 1]!, z, ...line[i]!, z);
      if (marks.closed && path.length > 2) segments.push(...line.at(-1)!, z, ...line[0]!, z);
      const lines = new BufferGeometry();
      lines.setAttribute('position', new Float32BufferAttribute(segments, 3));
      const dots = new BufferGeometry();
      dots.setAttribute(
        'position',
        new Float32BufferAttribute(
          path.flatMap((p) => [...p, z]),
          3,
        ),
      );
      this.marks.add(
        new LineSegments(lines, new LineBasicMaterial({ color: '#2563eb', depthTest: false })),
        new Points(
          dots,
          new PointsMaterial({
            color: '#2563eb',
            size: 7,
            sizeAttenuation: false,
            depthTest: false,
          }),
        ),
      );
    }
    this.render();
  }
  dispose() {
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    this.clear();
    this.setMarks(undefined);
    this.axesShown = undefined;
    this.drawAxes();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private makeControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);
    if (this.plan) {
      // A plan only pans and zooms; a left drag pans, a left click draws or picks.
      controls.enableRotate = false;
      controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
      controls.screenSpacePanning = true;
    }
    controls.addEventListener('change', () => this.render());
    return controls;
  }
  private ndc(e: { clientX: number; clientY: number }) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }
  /** Millimetres one CSS pixel spans on the plan (the orthographic view's height over its zoom). */
  private mmPerPx() {
    const height = this.renderer.domElement.getBoundingClientRect().height || 1;
    const o = this.orthographic;
    return (o.top - o.bottom) / o.zoom / height;
  }
  /** The pointer's point on the plan's level, in plan millimetres. */
  private planPoint(e: { clientX: number; clientY: number }): [number, number] | undefined {
    if (!this.plan) return undefined;
    const ray = new Raycaster();
    ray.setFromCamera(this.ndc(e), this.camera);
    const hit = ray.ray.intersectPlane(
      new Plane(new Vector3(0, 0, 1), -this.plan.elevationMm),
      new Vector3(),
    );
    return hit ? [hit.x, hit.y] : undefined;
  }
  private frameOrthographic() {
    const { clientWidth: w, clientHeight: h } = this.host;
    const aspect = w && h ? w / h : 1;
    Object.assign(this.orthographic, {
      left: -this.planSpan * aspect,
      right: this.planSpan * aspect,
      top: this.planSpan,
      bottom: -this.planSpan,
    });
    this.orthographic.up.set(0, 1, 0);
    this.orthographic.updateProjectionMatrix();
  }
  private pick(e: PointerEvent): string | undefined {
    if (!this.group) return undefined;
    const ray = new Raycaster();
    ray.setFromCamera(this.ndc(e), this.camera);
    // A plan picks what it shows: from the cut down, so nothing above the cut is hit, and an
    // element the cut passes through is hit from inside (both sides count for this pick).
    const restore: (() => void)[] = [];
    if (this.plan) {
      ray.ray.origin.z = this.plan.elevationMm + this.plan.cutMm;
      for (const child of this.group.children) {
        if (child.type === 'LineSegments') continue;
        const material = (child as Mesh).material as Material;
        const side = material.side;
        material.side = DoubleSide;
        restore.push(() => (material.side = side));
      }
    }
    let hits;
    try {
      // Transparent spaces lie around everything: an opaque element behind one wins.
      hits = ray.intersectObjects(this.group.children, false);
    } finally {
      for (const undo of restore) undo();
    }
    const solid = hits.find((h) => {
      const material = (h.object as { material?: { transparent?: boolean } }).material;
      return h.object.type !== 'LineSegments' && !material?.transparent;
    });
    return instancePath(solid ?? hits.find((h) => h.object.type !== 'LineSegments'))?.[0];
  }
  private placeGrid(lo: number[], hi: number[]) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    const span = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, 10_000) * 1.6;
    const step = 1_000;
    const divisions = Math.ceil(span / step);
    this.grid = new GridHelper(divisions * step, divisions, '#b8c2cc', '#dde3e8');
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set((lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, lo[2]! - 1);
    this.scene.add(this.grid);
  }
  private clear() {
    if (!this.group) return;
    this.scene.remove(this.group);
    disposeInstances(this.group);
    this.group = undefined;
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
  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      // Labels keep their size on screen: a plan's camera has no perspective to shrink them by.
      // In 3D they are smaller: at a site's scale a row of them stood in front of the building.
      const size = this.plan ? (this.planSpan * 2 * 0.045) / this.orthographic.zoom : 0.028;
      for (const child of this.axes.children)
        if (child instanceof Sprite) child.scale.set(size, size, 1);
      this.renderer.render(this.scene, this.camera);
    });
  }
}

/** A grid label in a circle, a fixed size on screen; `over` draws it over every solid. */
function axisLabel(text: string, over: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  if (g) {
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#b45309';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#7c2d12';
    g.font = `bold ${text.length > 2 ? 18 : 26}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 32, 33);
  }
  const sprite = new Sprite(
    new SpriteMaterial({
      map: new CanvasTexture(canvas),
      sizeAttenuation: false,
      depthTest: !over,
    }),
  );
  sprite.raycast = noRaycast;
  return sprite;
}
