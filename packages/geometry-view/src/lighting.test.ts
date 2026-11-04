import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  Raycaster,
  Scene,
  Texture,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it } from 'vitest';
import { setViewFinish, ViewLighting } from './lighting';

/** The parts of a renderer the lighting sets; no WebGL. */
const fakeRenderer = () =>
  ({
    domElement: { dataset: {} as Record<string, string> },
    shadowMap: { enabled: false, type: 0 },
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
  }) as unknown as WebGLRenderer & { domElement: { dataset: Record<string, string> } };

function setup() {
  const scene = new Scene();
  const renderer = fakeRenderer();
  const environment = new Texture();
  const lighting = new ViewLighting(scene, renderer, {
    ambient: 0.6,
    environment: () => environment,
  });
  const solids = new Group();
  const opaque = new Mesh(new BoxGeometry(100, 50, 20), new MeshStandardMaterial());
  opaque.position.set(50, 25, 30);
  const glass = new Mesh(
    new BoxGeometry(10, 10, 10),
    new MeshStandardMaterial({ transparent: true, opacity: 0.5 }),
  );
  glass.position.set(10, 10, 30);
  solids.add(opaque, glass);
  scene.add(solids);
  scene.updateMatrixWorld();
  const ground = scene.getObjectByName('view-lighting-ground') as Mesh;
  return { scene, renderer, environment, lighting, solids, opaque, glass, ground };
}

describe('ViewLighting (#665)', () => {
  it('starts with the standard lighting: no environment, tone mapping or shadows', () => {
    const { scene, renderer, lighting, solids, opaque, ground } = setup();
    lighting.prepare([solids]);
    expect(lighting.realistic).toBe(false);
    expect(renderer.domElement.dataset.lighting).toBe('standard');
    expect(scene.environment).toBeNull();
    expect(renderer.toneMapping).toBe(NoToneMapping);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(opaque.castShadow).toBe(false);
    expect(ground.visible).toBe(false);
  });

  it('realistic: environment, ACES, shadows from opaque solids, the ground under the lowest point', () => {
    const { scene, renderer, environment, lighting, solids, opaque, glass, ground } = setup();
    lighting.setRealistic(true);
    lighting.prepare([solids]);
    expect(renderer.domElement.dataset.lighting).toBe('realistic');
    expect(scene.environment).toBe(environment);
    expect(renderer.toneMapping).toBe(ACESFilmicToneMapping);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect([opaque.castShadow, opaque.receiveShadow]).toEqual([true, true]);
    // See-through solids cast no shadow.
    expect(glass.castShadow).toBe(false);
    expect(ground.visible).toBe(true);
    // The box spans z 20–40; the ground lies just under 20 and reaches past the box.
    expect(ground.position.z).toBeLessThan(20);
    expect(ground.position.z).toBeGreaterThan(19.9);
    expect(ground.scale.x).toBeGreaterThan(100);
    // The ground is never picked.
    const ray = new Raycaster(new Vector3(50, 25, 1000), new Vector3(0, 0, -1));
    expect(ray.intersectObject(ground)).toEqual([]);
    // A plan hides the ground and the shadows.
    lighting.prepare([solids], false);
    expect(ground.visible).toBe(false);
    // Back in 3D, the ground comes back without any other change.
    lighting.prepare([solids]);
    expect(ground.visible).toBe(true);
  });

  it('makes the environment again after a lost context is restored', () => {
    const scene = new Scene();
    const made: Texture[] = [];
    const lighting = new ViewLighting(scene, fakeRenderer(), {
      ambient: 0.6,
      environment: () => {
        made.push(new Texture());
        return made.at(-1)!;
      },
    });
    lighting.setRealistic(true);
    lighting.contextRestored();
    expect(made).toHaveLength(2);
    expect(scene.environment).toBe(made[1]);
    lighting.setRealistic(false);
    lighting.contextRestored();
    expect(made).toHaveLength(2);
    expect(scene.environment).toBeNull();
  });

  it('switching back draws the standard lighting again', () => {
    const { scene, renderer, lighting, solids, ground } = setup();
    lighting.setRealistic(true);
    lighting.prepare([solids]);
    lighting.setRealistic(false);
    lighting.prepare([solids]);
    expect(renderer.domElement.dataset.lighting).toBe('standard');
    expect(scene.environment).toBeNull();
    expect(renderer.toneMapping).toBe(NoToneMapping);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(ground.visible).toBe(false);
    const ambient = scene.children.find((o): o is AmbientLight => o instanceof AmbientLight);
    expect(ambient?.intensity).toBe(0.6);
  });

  it('draws a metal at the default metalness under the standard lighting, at its own under the realistic one (#661)', () => {
    const { scene, lighting, solids } = setup();
    const metal = setViewFinish(new MeshStandardMaterial(), { roughness: 0.3, metalness: 1 });
    const plain = setViewFinish(new MeshStandardMaterial(), undefined);
    solids.add(
      new Mesh(new BoxGeometry(1, 1, 1), metal),
      new Mesh(new BoxGeometry(1, 1, 1), plain),
    );
    scene.updateMatrixWorld();
    lighting.invalidate();
    lighting.prepare([solids]);
    expect([metal.roughness, metal.metalness]).toEqual([0.3, 0.05]);
    expect([plain.roughness, plain.metalness]).toEqual([0.55, 0.05]);
    lighting.setRealistic(true);
    lighting.prepare([solids]);
    expect(metal.metalness).toBe(1);
    lighting.setRealistic(false);
    lighting.prepare([solids]);
    expect(metal.metalness).toBe(0.05);
  });
});
