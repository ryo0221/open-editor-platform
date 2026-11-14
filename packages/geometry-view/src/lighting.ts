/**
 * Lighting for the CAD and bim 3D views (issue #665, texture stage 0). The standard lighting is
 * an ambient light and one directional light, as the views had before. The realistic lighting
 * adds an environment map (three.js `RoomEnvironment` through PMREM, so no image files are
 * loaded), ACES Filmic tone mapping and the directional light's shadow on the shown solids and
 * on a ground plane below them. Display only: no domain state, nothing picked.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  DirectionalLight,
  Mesh,
  type MeshStandardMaterial,
  NoToneMapping,
  type Object3D,
  PCFSoftShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  type Scene,
  ShadowMaterial,
  type Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import {
  geometryDefaultFinish,
  geometryLightLimits,
  type GeometryLight,
} from '@editor-platform/geometry-core';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** The sun's direction from the model's centre (z up), as the views have always lit it. */
const sunDirection = new Vector3(1, -1.5, 2).normalize();
/** Side of the shadow map in texels: 2048² depth texels, about 16 MB of GPU memory. */
const shadowMapSize = 2048;
/** How dark the ground shadow is (0–1). */
const groundShadowOpacity = 0.22;
/** Strength of the room's light and of the sun under the realistic lighting. */
const environmentIntensity = 0.7;
const realisticSun = 1.3;
/** three.js's ACES curve brightens the mid tones (÷ 0.6): a lower exposure keeps the colours. */
const exposure = 0.85;
const noRaycast = () => {};

export interface ViewLightingOptions {
  /** Intensity of the standard ambient light. */
  ambient: number;
  /** Intensity of the standard directional light. */
  sun?: number;
  /** Makes the environment map; by default `RoomEnvironment` through PMREM (needs WebGL). */
  environment?: (renderer: WebGLRenderer) => Texture;
}

function roomEnvironment(renderer: WebGLRenderer): Texture {
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  return texture;
}

/**
 * Gives a solid's material its look's finish (#661). The metalness is kept in `userData`: a
 * metal reflects its surroundings, and the standard lighting has none (no environment), so it
 * would draw black; `ViewLighting` draws it at the default metalness under the standard
 * lighting and at its own under the realistic one.
 */
export function setViewFinish(
  material: MeshStandardMaterial,
  look: (GeometryLight & { roughness?: number; metalness?: number }) | undefined,
) {
  material.roughness = look?.roughness ?? geometryDefaultFinish.roughness;
  material.metalness = look?.metalness ?? geometryDefaultFinish.metalness;
  material.userData.metalness = material.metalness;
  setViewLight(material, look);
  return material;
}
/**
 * CR6a: a look's light on a solid's material. The emission is drawn as the material's emissive
 * (its strength capped at 1, as the view has no tone for brighter), the transmission as a lower
 * opacity (the view does not refract). Both are kept as given in `userData` for the path tracer,
 * which draws the emission as a light and the transmission refracted (`pathRenderScene`).
 */
export function setViewLight(material: MeshStandardMaterial, look: GeometryLight | undefined) {
  // A look set again starts from the material as it was before any light: the emissive and the
  // see-through state the last look gave are taken back, so the fade never compounds.
  const base = (material.userData.lightBase ??= {
    opacity: material.opacity,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
  }) as { opacity: number; transparent: boolean; depthWrite: boolean };
  if (material.userData.emission || material.userData.transmission !== undefined) {
    material.opacity = base.opacity;
    material.transparent = base.transparent;
    material.depthWrite = base.depthWrite;
    if (material.userData.emission) {
      material.emissive.set(0x000000);
      material.emissiveIntensity = 0;
    }
  } else {
    // The material's own state, changed by its owner since: the base to come back to.
    base.opacity = material.opacity;
    base.transparent = material.transparent;
    base.depthWrite = material.depthWrite;
  }
  delete material.userData.emission;
  delete material.userData.transmission;
  delete material.userData.ior;
  delete material.userData.opacity;
  if (look?.emission && look.emission.strength > 0) {
    material.emissive.set(look.emission.color);
    material.emissiveIntensity = Math.min(look.emission.strength, 1);
    material.userData.emission = { ...look.emission };
  }
  if (look?.transmission) {
    material.userData.transmission = look.transmission;
    material.userData.ior = look.ior ?? geometryLightLimits.defaultIor;
    // The opacity the look asks for, before the stand-in for the light it lets through.
    material.userData.opacity = material.opacity;
    material.opacity *= 1 - viewTransmissionFade * look.transmission;
    material.transparent = true;
    material.depthWrite = false;
  }
}
/** CR6a: how much a fully transmitting look fades in the view's stand-in (opacity × 0.25). */
export const viewTransmissionFade = 0.75;
function applyFinishes(root: Object3D, realistic: boolean) {
  root.traverse((o) => {
    const material = (o as Mesh).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      const metalness = m.userData.metalness;
      if (typeof metalness !== 'number' || !(m as MeshStandardMaterial).isMeshStandardMaterial)
        continue;
      (m as MeshStandardMaterial).metalness = realistic
        ? metalness
        : Math.min(metalness, geometryDefaultFinish.metalness);
    }
  });
}

/** The standard or the realistic lighting of one scene, switched with `setRealistic`. */
export class ViewLighting {
  private readonly ambient: AmbientLight;
  private readonly sun: DirectionalLight;
  private readonly ground: Mesh<PlaneGeometry, ShadowMaterial>;
  private environment: Texture | undefined;
  private on = false;
  /** The shadow camera and the ground must be fitted again to what is shown. */
  private stale = true;
  /** The shown materials' metalness must be set again for the lighting (#661). */
  private finishesStale = true;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly options: ViewLightingOptions,
  ) {
    this.ambient = new AmbientLight('#ffffff', options.ambient);
    this.sun = new DirectionalLight('#ffffff', options.sun ?? 1.6);
    this.sun.position.copy(sunDirection);
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.ground = new Mesh(
      new PlaneGeometry(1, 1),
      new ShadowMaterial({ opacity: groundShadowOpacity, depthWrite: false }),
    );
    this.ground.name = 'view-lighting-ground';
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.ground.raycast = noRaycast;
    // The ground is drawn before the solids, so their edges and faces stay over it.
    this.ground.renderOrder = -1;
    scene.add(this.ambient, this.sun, this.sun.target, this.ground);
    renderer.domElement.dataset.lighting = 'standard';
  }

  get realistic(): boolean {
    return this.on;
  }

  /**
   * CR7g-3: the objects this lighting added to the scene (its lights and the ground), for a view
   * that draws only some of the scene's children (the character view's export).
   */
  get objects(): readonly Object3D[] {
    return [this.ambient, this.sun, this.sun.target, this.ground];
  }

  /** Switches the realistic lighting on or off; off draws exactly the standard lighting. */
  setRealistic(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    const renderer = this.renderer;
    // Which lighting is drawn, for a Host's diagnostics and the E2E.
    renderer.domElement.dataset.lighting = on ? 'realistic' : 'standard';
    renderer.toneMapping = on ? ACESFilmicToneMapping : NoToneMapping;
    renderer.toneMappingExposure = on ? exposure : 1;
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = PCFSoftShadowMap;
    if (on && !this.environment)
      this.environment = (this.options.environment ?? roomEnvironment)(renderer);
    this.scene.environment = on ? (this.environment ?? null) : null;
    // RoomEnvironment is built y up; the views are z up.
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);
    // The room is about as bright as a white sky: at full strength it washes the colours out.
    this.scene.environmentIntensity = environmentIntensity;
    // The environment lights the solids from every side: the flat ambient would wash them out.
    this.ambient.intensity = on ? 0 : this.options.ambient;
    this.sun.intensity = on ? realisticSun : (this.options.sun ?? 1.6);
    this.sun.castShadow = on;
    this.ground.visible = false;
    this.stale = this.finishesStale = true;
    // Materials compiled without shadows or tone mapping must be compiled again.
    this.scene.traverse((o) => {
      const material = (o as Mesh).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true;
    });
  }

  /** The shown solids changed: fit the shadow and the ground to them before the next draw. */
  invalidate() {
    this.stale = this.finishesStale = true;
  }

  /**
   * Called before each draw with the groups that hold the solids. With the realistic lighting
   * on and the content changed, marks their opaque meshes as casting and receiving shadows and
   * fits the shadow camera and the ground to their bounds. `ground: false` (a plan) hides the
   * ground and the shadows.
   */
  prepare(roots: readonly Object3D[], ground = true) {
    if (this.finishesStale) {
      this.finishesStale = false;
      for (const root of roots) applyFinishes(root, this.on);
    }
    if (!this.on) return;
    this.sun.castShadow = ground;
    if (!ground) {
      this.ground.visible = false;
      // Back in 3D, the ground is fitted (and shown) again.
      this.stale = true;
      return;
    }
    if (!this.stale) return;
    this.stale = false;
    const box = new Box3();
    for (const root of roots) {
      // Only what is shown: a hidden part or a pooled, unused mesh neither casts a shadow nor
      // moves the ground (Codex, #1091).
      root.traverseVisible((o) => {
        if (!(o as Mesh).isMesh) return;
        const mesh = o as Mesh;
        // Faded and see-through solids (a reference build, glass, spaces) cast no shadow; a mesh
        // with several materials (a character's part) only when all of them are opaque.
        const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as {
          transparent?: boolean;
          opacity?: number;
        }[];
        const opaque = materials.every((m) => !m.transparent || (m.opacity ?? 1) >= 0.99);
        mesh.castShadow = opaque;
        mesh.receiveShadow = opaque;
        box.union(new Box3().setFromObject(mesh));
      });
    }
    if (box.isEmpty()) {
      this.ground.visible = false;
      return;
    }
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.length() / 2, 1);
    // The light looks at the centre from outside the bounding sphere, along the sun's direction.
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(sunDirection, radius * 2);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    const camera = this.sun.shadow.camera;
    // The ground reaches past the bounds, and the shadow camera covers the ground's shadows.
    const reach = radius * 1.6;
    Object.assign(camera, {
      left: -reach,
      right: reach,
      top: reach,
      bottom: -reach,
      near: radius * 0.1,
      far: radius * 4,
    });
    camera.updateProjectionMatrix();
    // Bias in the light's depth range and along the normal, scaled to the model, against acne.
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = (reach * 2) / shadowMapSize;
    this.sun.shadow.needsUpdate = true;
    this.ground.scale.set(reach * 2, reach * 2, 1);
    // Just under the lowest point, so it never cuts a face lying at the bottom.
    this.ground.position.set(center.x, center.y, box.min.z - Math.max(radius * 1e-4, 0.01));
    this.ground.updateMatrixWorld();
    this.ground.visible = true;
  }

  /**
   * After a lost WebGL context is restored: the environment map was rendered on the GPU and has
   * no image to upload again, so it is made again on the new context.
   */
  contextRestored() {
    this.environment?.dispose();
    this.environment = undefined;
    if (this.on) {
      this.environment = (this.options.environment ?? roomEnvironment)(this.renderer);
      this.scene.environment = this.environment;
    }
    this.stale = true;
  }

  dispose() {
    this.scene.remove(this.ambient, this.sun, this.sun.target, this.ground);
    this.sun.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.environment?.dispose();
    this.environment = undefined;
    if (this.on) this.scene.environment = null;
  }
}
