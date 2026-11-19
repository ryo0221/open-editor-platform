/**
 * FT4b: the factory as 3D solids at a moment of a replay (docs/cad/factory-twin.md). Every box
 * is one instance of a unit box, scaled, turned and placed by its matrix; one solid per colour.
 * Objects are drawn in the colour of the state they show, parts as small boxes (along a
 * conveyor, stacked on other objects), vehicles on their lanes. FT4c: workers are the blocky
 * character figure, walking (its `walk` action) between objects and standing at them.
 */
import {
  blockyFigure,
  multiplyMat4,
  occupantFigure,
  poseAt,
  type CharacterFixture,
} from '@editor-platform/character-core';
import {
  factoryDefaultLaneMm,
  factoryObjectSize,
  factoryStates,
  type FactoryDocument,
  type FactoryPlacement,
  type FactoryReplayFrame,
  type FactoryState,
} from '@editor-platform/factory-core';
import type { ViewMesh, ViewSolid } from '@editor-platform/geometry-view';

export const factoryStateColors: Record<FactoryState, string> = {
  working: '#16a34a',
  waiting: '#cbd5e1',
  blocked: '#dc2626',
  setup: '#2563eb',
  failed: '#7c2d12',
  paused: '#a855f7',
  unstaffed: '#f59e0b',
  transport: '#0891b2',
  held: '#db2777',
};
/** Before a run, or before an object has a state. */
export const factoryIdleColor = '#e2e8f0';
export const factorySceneColors = {
  part: '#f97316',
  lane: '#94a3b8',
  vehicle: '#334155',
  loaded: '#0f766e',
  worker: '#1d4ed8',
} as const;

/**
 * Pick IDs of what is not an object. Each starts with a space, which no document ID may (IDs
 * have no whitespace at their edges), so none is ever taken for an object.
 */
export const factoryScenePick = {
  part: (n: number) => ` part:${n}`,
  vehicle: (fleet: string, k: number) => ` vehicle:${fleet}:${k}`,
  worker: (pool: string, k: number) => ` worker:${pool}:${k}`,
  segment: (id: string) => ` segment:${id}`,
};

export const factoryPartMm = 400;
/** FT4c: a machine drawn by its CAD look stands on a plate in its state colour, this thick. */
export const factoryPlateMm = 40;

/**
 * FT4c: one mesh of an object's CAD look (a saved CAD version, evaluated by the Host), in the
 * version's own frame (mm, z up) by `matrix` (column-major).
 */
export interface FactoryLookMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: string;
  opacity: number;
  /** A surface body (no inside): drawn from both sides. */
  sheet?: boolean;
  matrix: number[];
}

/**
 * The bounds of look meshes, each through its matrix (its local box's corners). Kept per list of
 * meshes (the Host's evaluated look, shared by its placements and replay frames).
 */
export function factoryLookBounds(meshes: readonly FactoryLookMesh[]): Bounds | undefined {
  if (lookBoundsCache.has(meshes)) return lookBoundsCache.get(meshes);
  const b = lookBounds(meshes);
  lookBoundsCache.set(meshes, b);
  return b;
}
const lookBoundsCache = new WeakMap<readonly FactoryLookMesh[], Bounds | undefined>();
function lookBounds(meshes: readonly FactoryLookMesh[]): Bounds | undefined {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const [a, b] = meshBounds({ origin: [0, 0, 0], ...m });
    if (!Number.isFinite(a[0])) continue;
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
      const M = m.matrix;
      for (let r = 0; r < 3; r++) {
        const v = M[r]! * c[0]! + M[4 + r]! * c[1]! + M[8 + r]! * c[2]! + M[12 + r]!;
        lo[r] = Math.min(lo[r]!, v);
        hi[r] = Math.max(hi[r]!, v);
      }
    }
  }
  return Number.isFinite(lo[0]) ? [lo, hi] : undefined;
}
const lookViewMeshes = new WeakMap<FactoryLookMesh, ViewMesh>();
const vehicleSize = { w: 1200, d: 800, h: 400 };
const workerSize = { w: 500, d: 400, h: 1700 };

let figure: CharacterFixture | undefined;

/** The unit box: x and y from -0.5 to 0.5, z from 0 to 1, each face with its own normal. */
function unitBox(): ViewMesh {
  const c = (i: number) => [i & 1 ? 0.5 : -0.5, i & 2 ? 0.5 : -0.5, i & 4 ? 1 : 0];
  const faces: [number[], number[]][] = [
    [
      [0, 2, 3, 1],
      [0, 0, -1],
    ],
    [
      [4, 5, 7, 6],
      [0, 0, 1],
    ],
    [
      [0, 1, 5, 4],
      [0, -1, 0],
    ],
    [
      [2, 6, 7, 3],
      [0, 1, 0],
    ],
    [
      [0, 4, 6, 2],
      [-1, 0, 0],
    ],
    [
      [1, 3, 7, 5],
      [1, 0, 0],
    ],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [f, n] of faces) {
    const first = positions.length / 3;
    for (const i of f) {
      positions.push(...c(i));
      normals.push(...n);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return {
    origin: [0, 0, 0],
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
const box = unitBox();

/** Column-major matrix: scale by (w, d, h), turn by `angle` (radians) about z, move to (x, y, z). */
function placeBox(x: number, y: number, z: number, w: number, d: number, h: number, angle = 0) {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [c * w, s * w, 0, 0, -s * d, c * d, 0, 0, 0, 0, h, 0, x, y, z, 1];
}

type Bounds = [[number, number, number], [number, number, number]];

/**
 * FT4c: the blocky figure (F-C1) as one mesh, standing on z 0 and facing −y in its own space:
 * walking at `stride` (0 to 1 through one stride), or standing (no stride).
 */
export function factoryWorkerMesh(stride?: number): ViewMesh {
  figure ??= blockyFigure();
  const { doc, meshes } = figure;
  const walk = stride === undefined ? null : (doc.actions.find((a) => a.id === 'walk') ?? null);
  const tick = walk ? (((stride! % 1) + 1) % 1) * walk.duration : 0;
  const posed = occupantFigure(doc, meshes, poseAt(doc, walk, tick), {
    headBone: 'head',
    hipBone: 'hip',
  });
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of posed.figure) {
    const first = positions.length / 3;
    for (let k = 0; k < m.positions.length; k++) positions.push(m.positions[k]!);
    for (let k = 0; k < m.indices.length; k++) indices.push(m.indices[k]! + first);
  }
  const normals = new Array<number>(positions.length).fill(0);
  for (let k = 0; k < indices.length; k += 3) {
    const [a, b, c] = [indices[k]! * 3, indices[k + 1]! * 3, indices[k + 2]! * 3];
    const e1 = [0, 1, 2].map((i) => positions[b + i]! - positions[a + i]!);
    const e2 = [0, 1, 2].map((i) => positions[c + i]! - positions[a + i]!);
    const n = [
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ];
    for (const v of [a, b, c]) for (let i = 0; i < 3; i++) normals[v + i]! += n[i]!;
  }
  for (let k = 0; k < normals.length; k += 3) {
    const l = Math.hypot(normals[k]!, normals[k + 1]!, normals[k + 2]!) || 1;
    for (let i = 0; i < 3; i++) normals[k + i]! /= l;
  }
  return {
    origin: [0, 0, 0],
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
const standingMesh = (() => {
  let m: ViewMesh | undefined;
  return () => (m ??= factoryWorkerMesh());
})();
const meshBounds = (m: ViewMesh): Bounds => {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
      hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
    }
  return [lo, hi];
};

/** Collects instances by colour (and opacity) into solids. */
class Boxes {
  private readonly byLook = new Map<string, ViewSolid>();
  readonly lo: [number, number, number] = [Infinity, Infinity, Infinity];
  readonly hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  add(
    id: string,
    color: string,
    at: { x: number; y: number; z: number; w: number; d: number; h: number; angle?: number },
    selected = false,
    opacity = 1,
  ) {
    const key = `${color}|${opacity}`;
    let s = this.byLook.get(key);
    if (!s) {
      s = {
        meshes: [{ mesh: box, color, opacity, sheet: false }],
        bounds: [
          [-0.5, -0.5, 0],
          [0.5, 0.5, 1],
        ],
        instances: [],
      };
      this.byLook.set(key, s);
    }
    s.instances.push({
      path: [id],
      matrix: placeBox(at.x, at.y, at.z, at.w, at.d, at.h, at.angle),
      selected,
    });
    const r = Math.hypot(at.w, at.d) / 2;
    this.lo[0] = Math.min(this.lo[0], at.x - r);
    this.lo[1] = Math.min(this.lo[1], at.y - r);
    this.lo[2] = Math.min(this.lo[2], at.z);
    this.hi[0] = Math.max(this.hi[0], at.x + r);
    this.hi[1] = Math.max(this.hi[1], at.y + r);
    this.hi[2] = Math.max(this.hi[2], at.z + at.h);
  }
  private readonly looks = new Map<FactoryLookMesh, ViewSolid>();
  /**
   * An object's CAD look, centred on (x, y) and standing on z (its own bounds' middle and
   * bottom), turned by `angle` (radians).
   */
  look(
    id: string,
    meshes: readonly FactoryLookMesh[],
    bounds: Bounds,
    at: { x: number; y: number; z: number; angle: number },
    selected: boolean,
  ) {
    const [lo, hi] = bounds;
    const [c, n] = [Math.cos(at.angle), Math.sin(at.angle)];
    const [cx, cy] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    const place = [c, n, 0, 0, -n, c, 0, 0, 0, 0, 1, 0, at.x, at.y, at.z, 1];
    const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -cx, -cy, -lo[2], 1];
    const frame = multiplyMat4(place, shift);
    for (const m of meshes) {
      let s = this.looks.get(m);
      if (!s) {
        // The same view mesh for the same look mesh across frames (the view caches by it).
        let mesh = lookViewMeshes.get(m);
        if (!mesh) {
          mesh = {
            origin: [0, 0, 0],
            positions: m.positions,
            normals: m.normals,
            indices: m.indices,
          };
          lookViewMeshes.set(m, mesh);
        }
        s = {
          meshes: [{ mesh, color: m.color, opacity: m.opacity, sheet: !!m.sheet }],
          bounds: meshBounds(mesh),
          instances: [],
        };
        this.looks.set(m, s);
      }
      s.instances.push({ path: [id], matrix: multiplyMat4(frame, m.matrix), selected });
    }
    const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2;
    this.lo[0] = Math.min(this.lo[0], at.x - r);
    this.lo[1] = Math.min(this.lo[1], at.y - r);
    this.lo[2] = Math.min(this.lo[2], at.z);
    this.hi[0] = Math.max(this.hi[0], at.x + r);
    this.hi[1] = Math.max(this.hi[1], at.y + r);
    this.hi[2] = Math.max(this.hi[2], at.z + hi[2] - lo[2]);
  }
  private readonly figures = new Map<ViewMesh, ViewSolid>();
  /** A figure `mesh` (standing on z 0, facing −y) at (x, y), facing `heading` (radians). */
  figure(id: string, mesh: ViewMesh, color: string, x: number, y: number, heading: number) {
    let s = this.figures.get(mesh);
    if (!s) {
      s = {
        meshes: [{ mesh, color, opacity: 1, sheet: false }],
        bounds: meshBounds(mesh),
        instances: [],
      };
      this.figures.set(mesh, s);
    }
    // Its −y turned to the heading: turned by heading + 90°.
    const r = heading + Math.PI / 2;
    const [c, n] = [Math.cos(r), Math.sin(r)];
    s.instances.push({
      path: [id],
      matrix: [c, n, 0, 0, -n, c, 0, 0, 0, 0, 1, 0, x, y, 0, 1],
      selected: false,
    });
    const [lo, hi] = s.bounds;
    const reach = Math.max(-lo[0], -lo[1], hi[0], hi[1]);
    this.lo[0] = Math.min(this.lo[0], x - reach);
    this.lo[1] = Math.min(this.lo[1], y - reach);
    this.lo[2] = Math.min(this.lo[2], lo[2]);
    this.hi[0] = Math.max(this.hi[0], x + reach);
    this.hi[1] = Math.max(this.hi[1], y + reach);
    this.hi[2] = Math.max(this.hi[2], hi[2]);
  }
  solids(): ViewSolid[] {
    return [...this.byLook.values(), ...this.looks.values(), ...this.figures.values()];
  }
  bounds(): Bounds | undefined {
    return Number.isFinite(this.lo[0]) ? [this.lo, this.hi] : undefined;
  }
}

/**
 * The scene at `frame` (none: before a run, every object in the idle colour). `places` is where
 * each object stands (its `at`, or where the plan puts it).
 */
export function factorySceneSolids(
  doc: FactoryDocument,
  places: ReadonlyMap<string, FactoryPlacement>,
  frame: FactoryReplayFrame | undefined,
  selection?: string,
  /** FT4c: where walkers are in their stride, in strides (default: one a second of replay). */
  stride?: number,
  /** FT4c: an object's CAD look by content hash, when the Host has it ready. */
  looks?: (contentHash: string) => readonly FactoryLookMesh[] | undefined,
): { solids: ViewSolid[]; bounds: Bounds | undefined } {
  const out = new Boxes();
  const rad = (p: FactoryPlacement) => ((p.angle ?? 0) * Math.PI) / 180;
  doc.objects.forEach((o, i) => {
    const at = places.get(o.id);
    if (!at) return;
    const size = factoryObjectSize(o);
    const s = frame?.states[i] ?? -1;
    const color = s >= 0 ? factoryStateColors[factoryStates[s]!] : factoryIdleColor;
    // A machine with its CAD look ready: the look on a plate in the state colour.
    const meshes = o.look && looks?.(o.look.contentHash);
    const lb = meshes?.length ? factoryLookBounds(meshes) : undefined;
    if (meshes && lb) {
      out.add(
        o.id,
        color,
        {
          x: at.x,
          y: at.y,
          z: 0,
          w: size.widthMm,
          d: size.depthMm,
          h: factoryPlateMm,
          angle: rad(at),
        },
        selection === o.id,
      );
      out.look(
        o.id,
        meshes,
        lb,
        { x: at.x, y: at.y, z: factoryPlateMm, angle: rad(at) },
        selection === o.id,
      );
      return;
    }
    out.add(
      o.id,
      color,
      {
        x: at.x,
        y: at.y,
        z: 0,
        w: size.widthMm,
        d: size.depthMm,
        h: o.kind === 'conveyor' ? size.heightMm - factoryPartMm / 4 : size.heightMm,
        angle: rad(at),
      },
      selection === o.id,
    );
  });
  // Lanes: thin strips on the floor.
  const nodes = new Map((doc.paths?.nodes ?? []).map((n) => [n.id, n]));
  const lane =
    Math.max(0, ...(doc.fleets ?? []).map((f) => f.widthMm ?? factoryDefaultLaneMm)) ||
    factoryDefaultLaneMm;
  for (const g of doc.paths?.segments ?? []) {
    const a = nodes.get(g.from);
    const b = nodes.get(g.to);
    if (!a || !b) continue;
    out.add(
      factoryScenePick.segment(g.id),
      factorySceneColors.lane,
      {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        z: 0,
        w: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        d: lane,
        h: 10,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      },
      selection === g.id,
      0.6,
    );
  }
  if (!frame) return { solids: out.solids(), bounds: out.bounds() };
  // Parts: along a conveyor on its belt; elsewhere in rows on top of the object.
  const stacked = new Map<number, number>();
  for (const p of frame.parts) {
    const o = doc.objects[p.object];
    const at = o && places.get(o.id);
    if (!o || !at) continue;
    const size = factoryObjectSize(o);
    const a = rad(at);
    const [c, s] = [Math.cos(a), Math.sin(a)];
    let x: number;
    let y: number;
    let z = size.heightMm;
    if (o.kind === 'conveyor' && p.along !== undefined) {
      const u = (p.along - 0.5) * (size.widthMm - factoryPartMm);
      x = at.x + u * c;
      y = at.y + u * s;
      z = size.heightMm - factoryPartMm / 4;
    } else {
      const k = stacked.get(p.object) ?? 0;
      stacked.set(p.object, k + 1);
      const per = Math.max(1, Math.floor(size.widthMm / (factoryPartMm * 1.25)));
      const rows = Math.max(1, Math.floor(size.depthMm / (factoryPartMm * 1.25)));
      const layer = Math.floor(k / (per * rows));
      const u = ((k % per) - (per - 1) / 2) * factoryPartMm * 1.25;
      const v = ((Math.floor(k / per) % rows) - (rows - 1) / 2) * factoryPartMm * 1.25;
      x = at.x + u * c - v * s;
      y = at.y + u * s + v * c;
      z = size.heightMm + layer * factoryPartMm;
    }
    out.add(factoryScenePick.part(p.part), factorySceneColors.part, {
      x,
      y,
      z,
      w: factoryPartMm,
      d: factoryPartMm,
      h: factoryPartMm,
      angle: a,
    });
  }
  const fleets = doc.fleets ?? [];
  for (const v of frame.vehicles) {
    const f = fleets[v.fleet];
    if (!f) continue;
    const id = factoryScenePick.vehicle(f.id, v.vehicle);
    out.add(id, v.loaded ? factorySceneColors.loaded : factorySceneColors.vehicle, {
      x: v.x,
      y: v.y,
      z: 0,
      ...{ w: vehicleSize.w, d: vehicleSize.d, h: vehicleSize.h },
      angle: v.heading,
    });
    if (v.loaded)
      out.add(id, factorySceneColors.part, {
        x: v.x,
        y: v.y,
        z: vehicleSize.h,
        w: factoryPartMm,
        d: factoryPartMm,
        h: factoryPartMm,
        angle: v.heading,
      });
  }
  const pools = doc.workerPools ?? [];
  // A worker at an object stands in front of it (its -y side), side by side with the others.
  const standing = new Map<string, FactoryPlacement & { depth: number }>();
  for (const o of doc.objects) {
    const at = places.get(o.id);
    if (at) standing.set(`${at.x},${at.y}`, { ...at, depth: factoryObjectSize(o).depthMm });
  }
  const crowd = new Map<string, number>();
  let walking: ViewMesh | undefined;
  for (const w of frame.workers) {
    const p = pools[w.pool];
    if (!p) continue;
    let [x, y, heading] = [w.x, w.y, w.heading];
    const key = `${w.x},${w.y}`;
    const at = w.walking ? undefined : standing.get(key);
    if (at) {
      const k = crowd.get(key) ?? 0;
      crowd.set(key, k + 1);
      const a = rad(at);
      const u = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * workerSize.w * 1.5;
      const v = -(at.depth / 2 + workerSize.d);
      x = at.x + u * Math.cos(a) - v * Math.sin(a);
      y = at.y + u * Math.sin(a) + v * Math.cos(a);
      // Facing the object.
      heading = a + Math.PI / 2;
    }
    const mesh = w.walking
      ? (walking ??= factoryWorkerMesh(stride ?? frame.timeMs / 1000))
      : standingMesh();
    out.figure(
      factoryScenePick.worker(p.id, w.worker),
      mesh,
      factorySceneColors.worker,
      x,
      y,
      heading,
    );
  }
  return { solids: out.solids(), bounds: out.bounds() };
}
