import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  GridHelper,
  Group,
  Matrix4,
  Mesh,
  MOUSE,
  MeshMatcapMaterial,
  MeshStandardMaterial,
  CanvasTexture,
  Object3D,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CharacterDocument } from '@editor-platform/character-core';
import { frameBounds, type PartFrame, type PreparedMesh } from './frame';
import type { CharacterPropMesh, PropFrame } from './props';

export interface CharacterViewportOptions {
  onContextLost(): void;
  /**
   * A click (not a drag) on the view, in canvas pixels, for mesh edit mode (C3e); `additive`
   * with Shift. Orbiting stays on drags.
   */
  onPick?(x: number, y: number, additive: boolean): void;
}
/** Decoded image per asset ID; the Surface decodes, the viewport only uploads. */
export type CharacterImages = ReadonlyMap<string, ImageBitmap>;

/**
 * The character's 3D view (Three.js, Z up, millimetres): one mesh per part whose corners the
 * Surface poses on the CPU each frame (`characterFrame`), orbit/pan/zoom, a floor grid.
 */
export class CharacterViewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 1, 1_000_000);
  private readonly controls: OrbitControls;
  private readonly group = new Group();
  private readonly meshes = new Map<string, Mesh<BufferGeometry, MeshStandardMaterial[]>>();
  /** Per part, which triangles its index buffer currently winds the other way (`PartFrame.flipped`). */
  private readonly mirrored = new Map<string, Uint8Array>();
  private readonly textures: Texture[] = [];
  private readonly resize: ResizeObserver;
  private grid: GridHelper | undefined;
  private frame = 0;
  private fitted = false;
  /** The person orbited, panned or zoomed since the last fit: never framed again for them. */
  private moved = false;
  private shownMeshes: ReadonlyMap<string, PreparedMesh> | undefined;
  /** Props (C2b): one GPU geometry per mesh the Host gave, one Mesh per drawn copy. */
  private readonly propGroup = new Group();
  private readonly propGeometry = new Map<
    CharacterPropMesh,
    { geometry: BufferGeometry; material: MeshStandardMaterial }
  >();
  private readonly propMeshes: Mesh[] = [];
  private readonly lights: Object3D[];

  constructor(
    private readonly host: HTMLElement,
    options: CharacterViewportOptions,
  ) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.className = 'character-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    this.scene.background = new Color('#eef1f4');
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2500, -3500, 1800);
    const sun = new DirectionalLight('#ffffff', 2);
    sun.position.set(0.4, -0.8, 1);
    const fill = new DirectionalLight('#ffffff', 0.6);
    fill.position.set(-0.6, 0.7, 0.4);
    this.lights = [new AmbientLight('#ffffff', 0.9), sun, fill];
    this.scene.add(...this.lights, this.group, this.propGroup);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => this.request());
    this.controls.addEventListener('start', () => (this.moved = true));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      options.onContextLost();
    });
    let down: { x: number; y: number; t: number } | undefined;
    canvas.addEventListener('pointerdown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : undefined;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = undefined;
      if (moved > 4) return;
      const r = canvas.getBoundingClientRect();
      options.onPick?.(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
    });
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(host);
    this.layout();
  }

  /** Builds the parts' meshes and materials for a document; `draw` then poses them. */
  show(
    doc: CharacterDocument,
    meshes: ReadonlyMap<string, PreparedMesh>,
    images: CharacterImages,
    /** C3: the same parts with edited meshes keep the camera (a mesh edit is not a new model). */
    keepCamera = false,
  ) {
    // C8: an export draws the meshes it started with; a new display (a subdivision finishing,
    // say) is built when it ends.
    if (this.capture) {
      this.capture.deferred = [doc, meshes, images, keepCamera];
      return;
    }
    this.clear();
    const materials = new Map(
      doc.materials.map((m) => {
        // Each map the document keeps: colour in sRGB, normal and occlusion as linear data.
        const texture = (id: string | undefined, srgb: boolean) => {
          const image = id ? images.get(id) : undefined;
          if (!image) return undefined;
          const t = new Texture(image);
          // Images are decoded flipped (UV v up), so Three must not flip them again; with v up
          // the normal map's green axis already matches Three's tangent frame.
          t.flipY = false;
          if (srgb) t.colorSpace = SRGBColorSpace;
          // glTF's default (and the only sampling the import keeps): UVs outside 0–1 tile.
          t.wrapS = RepeatWrapping;
          t.wrapT = RepeatWrapping;
          t.needsUpdate = true;
          this.textures.push(t);
          return t;
        };
        const map = texture(m.maps.color, true);
        const normalMap = texture(m.maps.normal, false);
        const aoMap = texture(m.maps.occlusion, false);
        return [
          m.id,
          new MeshStandardMaterial({
            color: new Color(m.color),
            opacity: m.opacity,
            transparent: m.opacity < 1,
            roughness: m.roughness,
            metalness: m.metalness,
            side: m.doubleSided ? DoubleSide : FrontSide,
            ...(map ? { map } : {}),
            ...(normalMap ? { normalMap } : {}),
            ...(aoMap ? { aoMap } : {}),
          }),
        ] as const;
      }),
    );
    for (const part of doc.parts) {
      const prepared = meshes.get(part.mesh);
      if (!prepared) continue;
      const d = prepared.display;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(d.positions.slice(), 3));
      geometry.setAttribute('normal', new BufferAttribute(d.normals.slice(), 3));
      if (d.uvs) geometry.setAttribute('uv', new BufferAttribute(d.uvs, 2));
      // C7d: the frame a baked normal map was made in (Three would otherwise derive its own).
      if (prepared.tangents)
        geometry.setAttribute('tangent', new BufferAttribute(prepared.tangents.slice(), 4));
      geometry.setIndex(new BufferAttribute(d.indices.slice(), 1));
      this.mirrored.set(part.id, new Uint8Array(d.indices.length / 3));
      for (const [start, count, slot] of d.groups) geometry.addGroup(start, count, slot);
      const slots = part.materials.map((id) => materials.get(id)!);
      const mesh = new Mesh(geometry, slots);
      mesh.name = part.id;
      mesh.frustumCulled = false;
      this.meshes.set(part.id, mesh);
      this.group.add(mesh);
    }
    // New meshes are framed again; a material or visibility change keeps the camera.
    if (meshes !== this.shownMeshes && !keepCamera) this.fitted = false;
    this.shownMeshes = meshes;
  }

  /** Poses every part (and prop) to a frame and draws it. The first frame fits the camera. */
  draw(frame: readonly PartFrame[], props: readonly PropFrame[] = []) {
    // An export is drawing its own frames: the caller draws again after `endCapture`.
    if (this.capture) return;
    this.pose(frame, props);
    // Fitting waits for something visible: a model that starts hidden is framed when shown.
    if (!this.fitted) this.fitted = this.fit(frame, props);
    this.request();
  }
  private pose(frame: readonly PartFrame[], props: readonly PropFrame[]) {
    this.drawProps(props);
    for (const p of frame) {
      const mesh = this.meshes.get(p.partId);
      if (!mesh) continue;
      mesh.visible = p.visible;
      const g = mesh.geometry;
      (g.getAttribute('position') as BufferAttribute).copyArray(p.positions).needsUpdate = true;
      (g.getAttribute('normal') as BufferAttribute).copyArray(p.normals).needsUpdate = true;
      const tangent = g.getAttribute('tangent') as BufferAttribute | undefined;
      if (tangent && p.tangents?.length === tangent.array.length)
        tangent.copyArray(p.tangents).needsUpdate = true;
      // Wind the triangles whose mirroring changed the other way (in place, one buffer per part).
      const wound = this.mirrored.get(p.partId);
      if (wound && wound.length === p.flipped.length) {
        const index = g.getIndex()!;
        const a = index.array;
        let changed = false;
        for (let t = 0; t < wound.length; t++)
          if (wound[t] !== p.flipped[t]) {
            [a[3 * t + 1], a[3 * t + 2]] = [a[3 * t + 2], a[3 * t + 1]];
            wound[t] = p.flipped[t]!;
            changed = true;
          }
        if (changed) index.needsUpdate = true;
      }
      g.computeBoundingSphere();
    }
  }

  /**
   * C8: draws frames for an export at `width × height` (device pixels), through a copy of the
   * view's camera with the output's aspect (the vertical field of view kept). The view stops
   * drawing on its own meanwhile, and shows the exported frames letterboxed; the grid, the
   * edit overlay and the sculpt surface are left out. `endCapture` restores the view.
   */
  beginCapture(width: number, height: number) {
    if (this.capture) throw new Error('A capture is already running.');
    const canvas = this.renderer.domElement;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    const gl = this.renderer.getContext();
    const camera = this.camera.clone();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const hidden = [this.grid, this.overlay, this.sculpt].filter(
      (o): o is Object3D => !!o && o.visible,
    );
    this.capture = { camera, hidden, lights: this.lights };
    for (const o of hidden) o.visible = false;
    canvas.classList.add('character-canvas-capturing');
    if (
      gl.drawingBufferWidth !== width ||
      gl.drawingBufferHeight !== height ||
      gl.isContextLost()
    ) {
      this.endCapture();
      throw new CaptureUnsupported(
        `This browser can draw at most ${gl.drawingBufferWidth} × ${gl.drawingBufferHeight} here.`,
      );
    }
  }
  /**
   * C8b: poses and draws one exported frame and returns the canvas holding it, for the caller
   * to take (`new VideoFrame(canvas)`) before anything draws again.
   */
  captureCanvas(frame: readonly PartFrame[], props: readonly PropFrame[] = []): HTMLCanvasElement {
    const capture = this.capture;
    if (!capture) throw new Error('No capture is running.');
    if (this.renderer.getContext().isContextLost()) throw contextLost();
    this.pose(frame, props);
    this.renderCapture(capture);
    if (this.renderer.getContext().isContextLost()) throw contextLost();
    return this.renderer.domElement;
  }
  /** Poses and draws one exported frame; resolves with it as PNG bytes. */
  async captureFrame(
    frame: readonly PartFrame[],
    props: readonly PropFrame[] = [],
  ): Promise<Uint8Array> {
    const capture = this.capture;
    if (!capture) throw new Error('No capture is running.');
    this.pose(frame, props);
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw contextLost();
    this.renderCapture(capture);
    // toBlob takes the canvas as it is now (the drawing buffer is preserved).
    const blob = await new Promise<Blob | null>((resolve) =>
      this.renderer.domElement.toBlob(resolve, 'image/png'),
    );
    // A lost context still hands over a PNG, of the cleared canvas: never keep it.
    if (gl.isContextLost()) throw contextLost();
    if (!blob) throw new CaptureUnsupported('The frame could not be read from the view.');
    return new Uint8Array(await blob.arrayBuffer());
  }
  /** Draws only the parts and props: anything added to the scene since the capture began is left out. */
  private renderCapture(capture: NonNullable<typeof this.capture>) {
    const shown = new Set<Object3D>([this.group, this.propGroup, ...capture.lights]);
    const off = this.scene.children.filter((o) => !shown.has(o) && o.visible);
    for (const o of off) o.visible = false;
    this.renderer.render(this.scene, capture.camera);
    for (const o of off) o.visible = true;
  }
  endCapture() {
    const capture = this.capture;
    if (!capture) return;
    this.capture = undefined;
    for (const o of capture.hidden) o.visible = true;
    if (capture.deferred) this.show(...capture.deferred);
    this.renderer.domElement.classList.remove('character-canvas-capturing');
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.layout();
  }
  private capture:
    | {
        camera: PerspectiveCamera;
        hidden: Object3D[];
        lights: Object3D[];
        /** The last `show` asked for while capturing. */
        deferred?: Parameters<CharacterViewport['show']>;
      }
    | undefined;
  private drawProps(props: readonly PropFrame[]) {
    const used = new Set<CharacterPropMesh>();
    let n = 0;
    for (const p of props) {
      if (!p.visible) continue;
      for (const i of p.instances) {
        used.add(i.mesh);
        let gpu = this.propGeometry.get(i.mesh);
        if (!gpu) {
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new BufferAttribute(i.mesh.positions, 3));
          geometry.setAttribute('normal', new BufferAttribute(i.mesh.normals, 3));
          geometry.setIndex(new BufferAttribute(i.mesh.indices, 1));
          geometry.computeBoundingSphere();
          const material = new MeshStandardMaterial({
            color: new Color(i.mesh.color),
            opacity: i.mesh.opacity,
            transparent: i.mesh.opacity < 1,
            roughness: 0.6,
            metalness: 0.1,
            side: DoubleSide,
          });
          gpu = { geometry, material };
          this.propGeometry.set(i.mesh, gpu);
        }
        let mesh = this.propMeshes[n];
        if (!mesh) {
          mesh = new Mesh();
          mesh.matrixAutoUpdate = false;
          this.propMeshes.push(mesh);
          this.propGroup.add(mesh);
        }
        mesh.geometry = gpu.geometry;
        mesh.material = gpu.material;
        mesh.matrix.fromArray(i.matrix);
        mesh.matrixWorldNeedsUpdate = true;
        mesh.visible = true;
        n++;
      }
    }
    for (let k = n; k < this.propMeshes.length; k++) this.propMeshes[k]!.visible = false;
    // Meshes no prop draws now (a prop removed or hidden, another version) are released.
    for (const [mesh, gpu] of this.propGeometry)
      if (!used.has(mesh)) {
        gpu.geometry.dispose();
        gpu.material.dispose();
        this.propGeometry.delete(mesh);
      }
  }

  /**
   * Frames what is visible: the camera looks at its middle from the front, a little above.
   * Returns false (camera unchanged) when nothing is visible.
   */
  fit(frame: readonly PartFrame[], props: readonly PropFrame[] = []): boolean {
    const box = unionBounds(frameBounds(frame), propBounds(props));
    this.grid?.removeFromParent();
    this.grid?.dispose();
    this.grid = undefined;
    if (!box) return false;
    const [lo, hi] = box;
    const center = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
    // The bounding sphere fits both the vertical and the horizontal field of view.
    const radius = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 0.5);
    const vertical = (this.camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const along = Math.hypot(0.35, 1, 0.3);
    const distance = ((radius / Math.sin(Math.min(vertical, horizontal))) * 1.05) / along;
    this.camera.near = Math.max(size / 1000, 0.1);
    this.camera.far = Math.max(size, distance) * 100;
    this.camera.position.set(
      center.x + distance * 0.35,
      center.y - distance,
      center.z + distance * 0.3,
    );
    this.controls.target.copy(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    const step = 10 ** Math.floor(Math.log10(size));
    const span = Math.ceil((size * 2) / step) * step;
    this.grid = new GridHelper(span, Math.round(span / step), '#a8b0ba', '#cfd5dc');
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(center.x, center.y, lo[2]);
    this.scene.add(this.grid);
    return true;
  }

  /**
   * Points (mm, in the space `matrix` places) in canvas pixels, with normalised depth −1…1;
   * points behind the camera get a depth outside that range.
   */
  project(points: Float32Array, matrix: number[]): [number, number, number][] {
    const m = new Matrix4().fromArray(matrix);
    this.camera.updateMatrixWorld();
    const w = Math.max(this.host.clientWidth, 1),
      h = Math.max(this.host.clientHeight, 1);
    const v = new Vector3();
    const out: [number, number, number][] = [];
    for (let i = 0; i < points.length; i += 3) {
      v.set(points[i]!, points[i + 1]!, points[i + 2]!).applyMatrix4(m);
      const ahead = v.clone().applyMatrix4(this.camera.matrixWorldInverse).z < 0;
      v.project(this.camera);
      out.push([((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h, ahead ? v.z : 2]);
    }
    return out;
  }
  /**
   * Weight paint (C5c): the left button paints, so the right one turns the view (it pans
   * otherwise); off restores the usual buttons.
   */
  setPaintButtons(on: boolean) {
    this.controls.mouseButtons.RIGHT = on ? MOUSE.ROTATE : MOUSE.PAN;
  }
  /** Where the camera is (mm, character space). */
  /** The point (character space mm) at canvas pixels `x, y` and normalised depth `depth`. */
  unproject(x: number, y: number, depth: number): [number, number, number] {
    this.camera.updateMatrixWorld();
    const w = Math.max(this.host.clientWidth, 1),
      h = Math.max(this.host.clientHeight, 1);
    const v = new Vector3((x / w) * 2 - 1, 1 - (y / h) * 2, depth).unproject(this.camera);
    return [v.x, v.y, v.z];
  }
  cameraPosition(): [number, number, number] {
    const c = this.camera.position;
    return [c.x, c.y, c.z];
  }
  /** The mesh edit overlay (C3e), drawn over the parts; null removes it. */
  setOverlay(overlay: Object3D | null) {
    this.overlay?.removeFromParent();
    this.overlay = overlay ?? undefined;
    if (overlay) this.scene.add(overlay);
    this.request();
  }
  private overlay: Object3D | undefined;

  /**
   * C7b: the multires surface being sculpted, drawn in place of its part (the Surface hides the
   * part). The buffers share the given arrays: after a dab, `updateSculpt` uploads the range.
   * C7c: `mask` (0–1 per vertex, shared too) darkens held vertices; `matcap` shades the surface
   * with a clay matcap instead of the lit material.
   */
  setSculpt(
    sculpt: {
      positions: Float32Array;
      normals: Float32Array;
      triangles: Uint32Array;
      /** Mesh space to character space (column-major). */
      matrix: number[];
      mask?: Float32Array;
      matcap?: boolean;
    } | null,
  ) {
    if (this.sculpt) {
      this.sculpt.geometry.dispose();
      (this.sculpt.material as MeshStandardMaterial).dispose();
      this.sculpt.removeFromParent();
      this.sculpt = undefined;
    }
    this.sculptMask = sculpt?.mask;
    if (sculpt) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(sculpt.positions, 3));
      g.setAttribute('normal', new BufferAttribute(sculpt.normals, 3));
      const colors = new Float32Array(sculpt.positions.length).fill(1);
      g.setAttribute('color', new BufferAttribute(colors, 3));
      g.setIndex(new BufferAttribute(sculpt.triangles, 1));
      g.computeBoundingSphere();
      const material = sculpt.matcap
        ? new MeshMatcapMaterial({ matcap: this.clay(), vertexColors: true })
        : new MeshStandardMaterial({
            color: '#c9c4bc',
            roughness: 0.55,
            metalness: 0,
            vertexColors: true,
          });
      const mesh = new Mesh(g, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(sculpt.matrix);
      mesh.frustumCulled = false;
      this.sculpt = mesh;
      this.scene.add(mesh);
      this.maskColors(0, sculpt.positions.length / 3 - 1);
    }
    this.request();
  }
  /** Held vertices drawn darker and blue (C7c), white elsewhere (the material's own colour). */
  private maskColors(first: number, last: number) {
    const a = this.sculpt?.geometry.getAttribute('color') as BufferAttribute | undefined;
    const m = this.sculptMask;
    if (!a) return;
    const c = a.array as Float32Array;
    for (let v = first; v <= last; v++) {
      const t = m ? 0.65 * Math.min(Math.max(m[v] ?? 0, 0), 1) : 0;
      c[3 * v] = 1 - t * 0.75;
      c[3 * v + 1] = 1 - t * 0.6;
      c[3 * v + 2] = 1 - t * 0.2;
    }
  }
  /** A clay matcap, drawn once: warm grey, lit from the upper left, darker at the rim. */
  private clay(): CanvasTexture {
    if (this.clayTexture) return this.clayTexture;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(96, 84, 8, 128, 128, 128);
    g.addColorStop(0, '#f4efe8');
    g.addColorStop(0.45, '#c2b8ab');
    g.addColorStop(0.85, '#6e655c');
    g.addColorStop(1, '#3b3631');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    this.clayTexture = t;
    return t;
  }
  private clayTexture: CanvasTexture | undefined;
  private sculptMask: Float32Array | undefined;
  /** Uploads vertices `first`…`last` of the sculpted surface after a dab (and their mask). */
  updateSculpt(first: number, last: number) {
    const g = this.sculpt?.geometry;
    if (!g || last < first) return;
    this.maskColors(first, last);
    for (const name of ['position', 'normal', 'color']) {
      const a = g.getAttribute(name) as BufferAttribute;
      // Added to the ranges still waiting for the next frame (three clears them on upload).
      a.addUpdateRange(3 * first, 3 * (last - first + 1));
      a.needsUpdate = true;
    }
    this.request();
  }
  private sculpt: Mesh | undefined;
  /** The ray (character space, unit direction) through canvas pixels `x, y`. */
  ray(x: number, y: number): { origin: [number, number, number]; dir: [number, number, number] } {
    const a = this.unproject(x, y, -1),
      b = this.unproject(x, y, 1);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    return { origin: a, dir: [d[0]! / l, d[1]! / l, d[2]! / l] };
  }

  /**
   * C8c: what a path-traced still draws: the parts and props as they are now, and the view's
   * camera (the grid, the overlays and the sculpt surface are left out).
   */
  pathSource(): { roots: Object3D[]; camera: PerspectiveCamera } {
    return { roots: [this.group, this.propGroup], camera: this.camera };
  }

  /** Fits the camera again on the next frame with something visible (a new document). */
  refit() {
    this.fitted = false;
    this.moved = false;
  }
  /**
   * Fits again on the next frame unless the person has moved the camera since the last fit: for
   * props whose shape arrives after the first frame (their Host was still evaluating them).
   */
  refitUnlessMoved() {
    if (!this.moved) this.fitted = false;
  }

  /** Removes every part, so a refused document shows nothing. */
  clearView() {
    this.clear();
    this.clearProps();
    this.shownMeshes = undefined;
    this.grid?.removeFromParent();
    this.request();
  }
  private clearProps() {
    for (const gpu of this.propGeometry.values()) {
      gpu.geometry.dispose();
      gpu.material.dispose();
    }
    this.propGeometry.clear();
    for (const m of this.propMeshes.splice(0)) m.removeFromParent();
  }
  private clear() {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      for (const m of mesh.material) m.dispose();
      mesh.removeFromParent();
    }
    this.meshes.clear();
    this.mirrored.clear();
    for (const t of this.textures.splice(0)) t.dispose();
  }
  private layout() {
    if (this.capture) return;
    const w = Math.max(this.host.clientWidth, 1),
      h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request();
  }
  private request() {
    if (this.frame || this.capture) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
      for (const f of this.rendered) f();
    });
  }
  private readonly rendered = new Set<() => void>();
  /** Calls `f` after each drawn frame (the camera may have moved); returns the unsubscribe. */
  onRendered(f: () => void) {
    this.rendered.add(f);
    return () => void this.rendered.delete(f);
  }
  dispose() {
    this.endCapture();
    this.setSculpt(null);
    this.clayTexture?.dispose();
    cancelAnimationFrame(this.frame);
    this.rendered.clear();
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.clearProps();
    this.grid?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** The view cannot draw an exported frame (size beyond the browser's, or no pixels back). */
const contextLost = () =>
  new CaptureUnsupported('The graphics context was lost during the export; nothing was saved.');
export class CaptureUnsupported extends Error {
  override name = 'CaptureUnsupported';
}

type Box = [[number, number, number], [number, number, number]];
/** The visible props' corners, transformed (the box of each copy's points). */
function propBounds(props: readonly PropFrame[]): Box | undefined {
  let box: Box | undefined;
  const m = new Matrix4();
  const v = new Vector3();
  for (const p of props) {
    if (!p.visible) continue;
    for (const i of p.instances) {
      m.fromArray(i.matrix);
      const a = i.mesh.positions;
      for (let k = 0; k < a.length; k += 3) {
        v.set(a[k]!, a[k + 1]!, a[k + 2]!).applyMatrix4(m);
        if (!box)
          box = [
            [v.x, v.y, v.z],
            [v.x, v.y, v.z],
          ];
        else
          for (let d = 0; d < 3; d++) {
            const x = v.getComponent(d);
            box[0][d] = Math.min(box[0][d]!, x);
            box[1][d] = Math.max(box[1][d]!, x);
          }
      }
    }
  }
  return box;
}
function unionBounds(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a || !b) return a ?? b;
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])],
  ];
}
