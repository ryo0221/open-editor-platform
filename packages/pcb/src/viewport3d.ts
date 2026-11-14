import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pcbFinishOf, type Pcb3dPiece } from './scene3d';

export interface PcbFaceSheet {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  picture: HTMLCanvasElement;
}

/**
 * The board's 3D view (PB7b, Three.js, z up, mm): the kernel's pieces in their colours and the
 * two face pictures as sheets on the board, with orbit, pan and zoom.
 */
export class PcbViewport3d {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(35, 1, 0.5, 20_000);
  private readonly controls: OrbitControls;
  private group: Group | undefined;
  private readonly resize: ResizeObserver;
  private frame = 0;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.className = 'pcb-3d-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.append(canvas);
    this.scene.background = new Color('#e9edf1');
    this.camera.up.set(0, 0, 1);
    // Metal reflects its surroundings: without them it would look black.
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
    this.scene.add(new HemisphereLight('#ffffff', '#8a8f99', 1.4));
    this.scene.add(new AmbientLight('#ffffff', 0.35));
    const key = new DirectionalLight('#ffffff', 2.2);
    key.position.set(-0.6, -1, 1.6);
    const rim = new DirectionalLight('#ffffff', 0.8);
    rim.position.set(1, 0.8, -0.6);
    this.scene.add(key, rim);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => this.draw());
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(host);
    this.layout();
  }

  /** Shows `pieces` and the face sheets; `fit` aims the camera at the board. */
  show(pieces: readonly Pcb3dPiece[], sheets: readonly PcbFaceSheet[], fit: boolean) {
    this.clear();
    const group = new Group();
    for (const p of pieces) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(p.mesh.positions, 3));
      g.setAttribute('normal', new BufferAttribute(p.mesh.normals, 3));
      g.setIndex(new BufferAttribute(p.mesh.indices, 1));
      const finish = pcbFinishOf[p.material];
      const mesh = new Mesh(g, new MeshStandardMaterial({ color: new Color(p.color), ...finish }));
      mesh.name = p.name;
      group.add(mesh);
    }
    for (const s of sheets) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(s.positions, 3));
      g.setAttribute('normal', new BufferAttribute(s.normals, 3));
      g.setAttribute('uv', new BufferAttribute(s.uvs, 2));
      g.setIndex(new BufferAttribute(s.indices, 1));
      const map = new CanvasTexture(s.picture);
      map.colorSpace = SRGBColorSpace;
      map.anisotropy = 8;
      const mesh = new Mesh(
        g,
        new MeshStandardMaterial({
          map,
          alphaTest: 0.5,
          side: DoubleSide,
          metalness: 0.1,
          roughness: 0.55,
        }),
      );
      mesh.name = 'Board face';
      group.add(mesh);
    }
    this.group = group;
    this.scene.add(group);
    if (fit) this.fit();
    this.draw();
  }

  /** Aims at the whole model from the front, above and to the left. */
  fit() {
    if (!this.group) return;
    const box = new Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3()).length();
    // The narrower of the two fields of view: a tall canvas sees less across than up.
    const half = Math.tan((this.camera.fov * Math.PI) / 360);
    const distance = (size / (2 * Math.min(half, half * this.camera.aspect))) * 1.15;
    const dir = new Vector3(-0.45, -0.75, 0.62).normalize();
    this.camera.position.copy(centre).addScaledVector(dir, distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(centre);
    this.controls.update();
    this.draw();
  }

  /** Looks from `direction` (towards the board), keeping the target and distance. */
  look(direction: [number, number, number]) {
    const d = new Vector3(...direction).normalize();
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(d, -distance);
    this.controls.update();
    this.draw();
  }

  /** The current picture as PNG bytes (a still for the record). */
  async capture(): Promise<Blob | null> {
    this.render();
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private clear() {
    if (!this.group) return;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry.dispose();
      const m = o.material as MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
    });
    this.group = undefined;
  }

  private layout() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  private draw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }
}
