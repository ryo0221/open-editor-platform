import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  AxesHelper,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';

export interface ViewportBody {
  mesh: CadMesh;
  color: string;
  /** The body's native appearance opacity (0–1). */
  opacity: number;
  selected: boolean;
}
export interface CadViewportOptions {
  onPick(bodyId: string | null): void;
  onContextLost(): void;
}

/**
 * Three.js renderer confined to display: no CAD state, no editing. Z-up, millimetres.
 * Picking is offered only for meshes that match the current content (`pickable`).
 */
export class CadViewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.1, 100_000);
  private readonly controls: OrbitControls;
  private readonly bodies = new Group();
  private readonly resize: ResizeObserver;
  private pickable = false;
  private down: { x: number; y: number } | undefined;
  private frame = 0;
  private fitted = false;
  constructor(
    private readonly host: HTMLElement,
    private readonly options: CadViewportOptions,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'cad-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    host.append(this.renderer.domElement);
    this.scene.background = new Color('#f4f6f8');
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(120, -160, 120);
    const grid = new GridHelper(400, 40, '#b8c2cc', '#dde3e8');
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid, new AxesHelper(30), new AmbientLight('#ffffff', 0.6), this.bodies);
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(1, -1.5, 2);
    this.scene.add(sun);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      options.onContextLost();
    });
    canvas.addEventListener('pointerdown', (e) => (this.down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      // A drag is camera navigation, never a selection.
      if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return;
      this.down = undefined;
      if (this.pickable) options.onPick(this.pick(e));
    });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(host);
    this.layout();
  }
  private layout() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }
  private render() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.renderer.render(this.scene, this.camera));
  }
  private pick(e: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(
      this.bodies.children.filter((c) => c instanceof Mesh),
      false,
    )[0];
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
  /** Replaces displayed geometry. `current: false` shows the previous shape dimmed and unpickable. */
  show(bodies: ViewportBody[], current: boolean) {
    this.clear();
    this.pickable = current;
    for (const { mesh, color, opacity: native, selected } of bodies) {
      // Stale dimming multiplies the native opacity instead of replacing it.
      const opacity = native * (current ? 1 : 0.35);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
      geometry.setIndex(new BufferAttribute(mesh.indices, 1));
      const material = new MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.05,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
        emissive: selected ? new Color('#2563eb') : new Color('#000000'),
        emissiveIntensity: selected ? 0.35 : 0,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      const solid = new Mesh(geometry, material);
      solid.userData.bodyId = mesh.bodyId;
      const edges = new LineSegments(
        new EdgesGeometry(geometry, 25),
        new LineBasicMaterial({
          color: selected ? '#1d4ed8' : '#33414f',
          transparent: opacity < 1,
          opacity,
        }),
      );
      // Positions are relative to the mesh origin (Float32 precision far from the model origin).
      for (const object of [solid, edges]) object.position.set(...mesh.origin);
      this.bodies.add(solid, edges);
    }
    if (!this.fitted && bodies.length) {
      this.fit();
      this.fitted = true;
    }
    this.render();
  }
  fit() {
    const box = new Box3().setFromObject(this.bodies);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2 || 50;
    // Fit the narrower of the vertical and horizontal fields of view (portrait phones).
    const vertical = (this.camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    const distance = (radius * 1.1) / Math.sin(Math.min(vertical, horizontal) / 2);
    const direction = new Vector3(0.55, -0.75, 0.6).normalize();
    this.camera.position.copy(center.clone().addScaledVector(direction, distance));
    this.camera.near = distance / 1000;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }
  /** PNG of the current view, rendered now so the drawing buffer holds this frame. */
  capture(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
  }
  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
