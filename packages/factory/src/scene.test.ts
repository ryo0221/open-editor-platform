import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BimEvaluator, bimDirectKernel, bimViewBounds } from '@editor-platform/bim';
import { f31BoxBuilding } from '@editor-platform/bim-core';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  f170SmallLine,
  FactoryReplay,
  factoryId,
  factoryStates,
  runFactory,
} from '@editor-platform/factory-core';
import { factoryAutoLayout } from './layout';
import { factoryBuildingPick, factoryBuildingView } from './view3d';
import {
  factoryIdleColor,
  factoryLookBounds,
  factoryPlateMm,
  factorySceneColors,
  factorySceneSolids,
  factoryStateColors,
  factoryWorkerMesh,
} from './scene';

const instances = (solids: ReturnType<typeof factorySceneSolids>['solids'], color: string) =>
  solids.filter((s) => s.meshes![0]!.color === color).flatMap((s) => s.instances);

// TS-2662: FT4b the factory as 3D boxes at a replay time.
describe('FT4b scene (TS-2662)', () => {
  it('draws every object idle before a run, in its state colour during one, with its parts', () => {
    const doc = f170SmallLine();
    const places = factoryAutoLayout(doc);
    const idle = factorySceneSolids(doc, places, undefined);
    expect(instances(idle.solids, factoryIdleColor).map((i) => i.path[0])).toEqual(
      doc.objects.map((o) => o.id),
    );
    expect(idle.bounds).toBeDefined();
    const r = runFactory(doc, { record: true });
    const frame = new FactoryReplay(doc, r.timeline!, places, r.endMs).at(r.endMs / 2);
    const scene = factorySceneSolids(doc, places, frame, 'machining');
    doc.objects.forEach((o, i) => {
      const s = frame.states[i]!;
      const color = s >= 0 ? factoryStateColors[factoryStates[s]!] : factoryIdleColor;
      const inst = instances(scene.solids, color).find((x) => x.path[0] === o.id);
      expect(inst).toBeDefined();
      expect(inst!.selected).toBe(o.id === 'machining');
    });
    expect(instances(scene.solids, factorySceneColors.part)).toHaveLength(frame.parts.length);
    // Pick IDs of parts are never valid document IDs (a leading space).
    expect(
      instances(scene.solids, factorySceneColors.part).every(
        (i) => i.path[0]!.startsWith(' part:') && !factoryId(i.path[0]),
      ),
    ).toBe(true);
  });

  it('picks building elements under IDs no factory object can have', () => {
    const doc = f170SmallLine();
    const id = doc.objects[0]!.id;
    // A building element with the same ID as an object is not that object.
    expect(factoryBuildingPick(id)).not.toBe(id);
    expect(factoryId(factoryBuildingPick(id))).toBe(false);
  });

  it('scales, turns and places a box by its matrix', () => {
    const doc = f170SmallLine();
    const o = doc.objects[1]!;
    const places = new Map([[o.id, { x: 1000, y: 2000, angle: 90 }]]);
    const scene = factorySceneSolids(
      { ...doc, objects: [{ ...o, size: { widthMm: 2000, depthMm: 1000, heightMm: 1500 } }] },
      places,
      undefined,
    );
    const m = scene.solids[0]!.instances[0]!.matrix;
    // x axis (width) turned onto +y, y axis (depth) onto -x, height up.
    expect(m.map((v) => Math.round(v))).toEqual([
      0, 2000, 0, 0, -1000, 0, 0, 0, 0, 0, 1500, 0, 1000, 2000, 0, 1,
    ]);
  });
});

// TS-2664: FT4c workers as walking figures.
describe('FT4c worker figures (TS-2664)', () => {
  it('draws a worker as the blocky figure, its legs moving with the stride', () => {
    const standing = factoryWorkerMesh();
    const a = factoryWorkerMesh(0);
    const b = factoryWorkerMesh(0.25);
    // A person's height, in millimetres, standing on the floor.
    let [lo, hi] = [Infinity, -Infinity];
    for (let i = 2; i < standing.positions.length; i += 3) {
      lo = Math.min(lo, standing.positions[i]!);
      hi = Math.max(hi, standing.positions[i]!);
    }
    expect(Math.abs(lo)).toBeLessThan(100);
    expect(hi).toBeGreaterThan(1400);
    expect(hi).toBeLessThan(2100);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
    expect(a.normals).toHaveLength(a.positions.length);
  });

  it('faces a walker its way and a standing worker its object', () => {
    const doc = {
      ...f170SmallLine(),
      workerPools: [{ id: 'ops', name: 'Ops', count: 2, skills: [], walkSpeedMmS: 1000 }],
    };
    const o = doc.objects[1]!;
    const places = new Map([[o.id, { x: 5000, y: 0, angle: 0 }]]);
    const frame = {
      timeMs: 1000,
      states: doc.objects.map(() => -1),
      parts: [],
      vehicles: [],
      workers: [
        { pool: 0, worker: 0, x: 0, y: 0, heading: Math.PI / 2, walking: true },
        { pool: 0, worker: 1, x: 5000, y: 0, heading: 0, walking: false },
      ],
    };
    const scene = factorySceneSolids(doc, places, frame);
    const figures = instances(scene.solids, factorySceneColors.worker);
    expect(figures.map((i) => i.path[0])).toEqual([' worker:ops:0', ' worker:ops:1']);
    // The figure's own −y, turned by the matrix: its facing.
    const facing = (m: number[]) => [-m[4]!, -m[5]!].map((v) => Math.round(v * 1000) / 1000);
    expect(facing(figures[0]!.matrix)).toEqual([0, 1]);
    // In front of the object (its −y side), facing it (+y).
    const stand = figures[1]!.matrix;
    expect(stand[13]).toBeLessThan(0);
    expect(facing(stand)).toEqual([0, 1]);
    // Walking and standing are different meshes.
    const meshes = scene.solids.filter((s) => s.meshes![0]!.color === factorySceneColors.worker);
    expect(meshes).toHaveLength(2);
  });
});

// TS-2668: FT4c an object drawn by its CAD look, on a plate in its state colour.
describe('FT4c CAD looks (TS-2668)', () => {
  // A 200 × 100 × 50 mm box from (1000, 0, 10) in the version's frame, moved by its matrix.
  const box = () => {
    const c = (i: number) => [1000 + (i & 1 ? 200 : 0), i & 2 ? 100 : 0, 10 + (i & 4 ? 50 : 0)];
    return {
      positions: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7].flatMap(c)),
      normals: new Float32Array(24),
      indices: new Uint32Array([0, 1, 2]),
      color: '#888888',
      opacity: 1,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
    };
  };
  it('centres the look on the object, turned with it, standing on the plate', () => {
    const doc = f170SmallLine();
    const o = doc.objects[1]!;
    o.look = { artifactId: 'a', versionId: 'v', contentHash: 'h' };
    const look = [box()];
    // Kept for the same evaluated look (the same object back).
    expect(factoryLookBounds(look)).toBe(factoryLookBounds(look));
    expect(factoryLookBounds(look)).toEqual([
      [1000, 0, 15],
      [1200, 100, 65],
    ]);
    const places = new Map([[o.id, { x: 5000, y: 2000, angle: 90 }]]);
    const plain = factorySceneSolids(doc, places, undefined);
    const scene = factorySceneSolids(doc, places, undefined, o.id, undefined, (h) =>
      h === 'h' ? look : undefined,
    );
    // The plate: the object's box, as thin as a plate.
    const plate = instances(scene.solids, factoryIdleColor).find((i) => i.path[0] === o.id)!;
    expect(plate.matrix[10]).toBeCloseTo(factoryPlateMm);
    expect(instances(plain.solids, factoryIdleColor)[0]!.matrix[10]).toBeGreaterThan(
      factoryPlateMm,
    );
    const drawn = instances(scene.solids, '#888888');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.path).toEqual([o.id]);
    expect(drawn[0]!.selected).toBe(true);
    // The box's middle bottom corner lands on the object, on the plate; its x turned onto y.
    const m = drawn[0]!.matrix;
    const at = (p: number[]) =>
      [0, 1, 2].map((r) =>
        Math.round(m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!),
      );
    expect(at([1100, 50, 10])).toEqual([5000, 2000, factoryPlateMm]);
    expect(at([1200, 50, 10])).toEqual([5000, 2100, factoryPlateMm]);
    // Another frame draws the same look with the same view mesh (the view caches by it).
    const again = factorySceneSolids(doc, places, undefined, undefined, 1, () => look);
    const mesh = (r: typeof scene) =>
      r.solids.find((x) => x.meshes![0]!.color === '#888888')!.meshes![0]!.mesh;
    expect(mesh(again)).toBe(mesh(scene));
    // A surface body keeps its two sides.
    const sheet = factorySceneSolids(doc, places, undefined, o.id, undefined, () => [
      { ...box(), sheet: true },
    ]);
    expect(sheet.solids.find((x) => x.meshes![0]!.color === '#888888')!.meshes![0]!.sheet).toBe(
      true,
    );
    expect(scene.solids.find((x) => x.meshes![0]!.color === '#888888')!.meshes![0]!.sheet).toBe(
      false,
    );
    // Not ready (or no mesh): the box as before.
    const pending = factorySceneSolids(doc, places, undefined, o.id, undefined, () => undefined);
    expect(instances(pending.solids, '#888888')).toHaveLength(0);
    expect(
      instances(pending.solids, factoryIdleColor).find((i) => i.path[0] === o.id)!.matrix[10],
    ).toBe(instances(plain.solids, factoryIdleColor).find((i) => i.path[0] === o.id)!.matrix[10]);
  });
});

// TS-2662: FT4b the building is framed on what the factory view draws, not the storeys above.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('FT4b building view with the kernel (TS-2662)', { timeout: 120_000 }, () => {
  it('frames only the elements below the cut', async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    const oc = await factory({ wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`) });
    const bim = f31BoxBuilding();
    const r = await new BimEvaluator(bimDirectKernel(oc)).evaluate(bim);
    if (r.status !== 'ok') throw new Error('not evaluated');
    const view = factoryBuildingView(bim, r);
    const all = bimViewBounds(r, bim)!;
    // The roof (at 6,000 mm) and the 2F slab start above the cut: neither drawn nor framed.
    const drawn = new Set(view.solids.flatMap((s) => s.instances.map((i) => i.path[0])));
    expect(drawn.has(factoryBuildingPick('r-roof'))).toBe(false);
    expect(drawn.has(factoryBuildingPick('s-2f'))).toBe(false);
    expect(drawn.has(factoryBuildingPick('w-south'))).toBe(true);
    expect(all[1][2]).toBeGreaterThan(6000);
    expect(view.bounds![1][2]).toBeLessThanOrEqual(6000);
    expect(view.bounds![0][2]).toBe(all[0][2]);
  });
});
