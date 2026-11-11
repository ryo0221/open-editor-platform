import type { Vec3 } from './edit';
import { editFail } from './topology';

/**
 * C7b sculpting on a multires surface: brushes move the displaced vertices in place, and only the
 * vertices a stroke touched are read back into displacements when it is made (one edit). The
 * surface is the multires' top level, all quads.
 */
export type SculptBrushKind = 'draw' | 'inflate' | 'smooth' | 'pinch' | 'flatten';
export const sculptBrushKinds: readonly SculptBrushKind[] = Object.freeze([
  'draw',
  'inflate',
  'smooth',
  'pinch',
  'flatten',
]);

export interface SculptBrush {
  kind: SculptBrushKind;
  /** mm, in the surface's space. */
  radius: number;
  /** 0–1. */
  strength: number;
  /** Draw, Inflate and Pinch the other way (Shift). Smooth and Flatten ignore it. */
  invert: boolean;
  /** Also dab mirrored across x = 0. */
  symmetry: boolean;
}

/** Vertices changed by a dab: their indices and the range a GPU buffer update must cover. */
export interface SculptChange {
  vertices: number[];
  first: number;
  last: number;
}

/** How far the brush reaches a vertex at distance d of radius r: (1 − (d/r)²)². */
const falloff = (d2: number, r2: number) => {
  const t = 1 - d2 / r2;
  return t > 0 ? t * t : 0;
};

/** The vertices, normals and neighbours of a surface being sculpted. Mutable. */
export class SculptSurface {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Per quad, its area-weighted normal (not normalised). */
  private readonly quadNormals: Float32Array;
  private readonly neighbourStart: Uint32Array;
  private readonly neighbours: Uint32Array;
  private readonly quadStart: Uint32Array;
  private readonly quadsOf: Uint32Array;
  /** Vertices a stroke since the last `takeTouched` moved. */
  private touched = new Set<number>();
  private grid!: { origin: Vec3; cell: number; n: number; start: Uint32Array; items: Uint32Array };
  /** Where each vertex was when the grid was built: a vertex that drifts a cell rebuilds it. */
  private indexed!: Float32Array;
  /** A Grab moved a vertex more than a cell: the grid is rebuilt before the next query. */
  private stale = false;
  /** Scratch marks for `settle` (one stamp per call), so it builds no `Set`s. */
  private stamp = 0;
  private readonly quadStamp: Uint32Array;
  private readonly vertexStamp: Uint32Array;
  private readonly quadList: Uint32Array;
  private readonly vertexList: Uint32Array;
  /** Mean edge length: how near a ray must pass a vertex to hit it. */
  readonly spacing: number;
  /**
   * Measurement only (C7e): when set, each dab adds its phase times here (ms): `brush` (the
   * neighbours and the moves), `apply`, `settle` (normals, the buffer range, the grid check); a
   * Grab move adds `apply` and `settle`.
   * Unset, nothing is timed and the results are the same.
   */
  timing: { brush: number; apply: number; settle: number } | undefined;

  constructor(
    positions: Float32Array,
    readonly quads: Uint32Array,
  ) {
    if (quads.length % 4 !== 0) editFail('selection', 'quads');
    this.positions = positions.slice();
    const V = positions.length / 3;
    this.normals = new Float32Array(3 * V);
    this.quadNormals = new Float32Array((3 * quads.length) / 4);
    // Neighbours along quad edges (each edge seen from both quads; duplicates removed per vertex).
    const degree = new Uint32Array(V + 1);
    for (let i = 0; i < quads.length; i++) degree[quads[i] + 1] += 2;
    for (let v = 0; v < V; v++) degree[v + 1] += degree[v];
    const raw = new Uint32Array(degree[V]);
    const fill = degree.slice(0, V);
    for (let f = 0; f < quads.length; f += 4)
      for (let k = 0; k < 4; k++) {
        const a = quads[f + k],
          b = quads[f + ((k + 1) % 4)];
        raw[fill[a]++] = b;
        raw[fill[b]++] = a;
      }
    const start = new Uint32Array(V + 1);
    const list: number[] = [];
    for (let v = 0; v < V; v++) {
      const seen = new Set<number>();
      for (let k = degree[v]; k < degree[v + 1]; k++) seen.add(raw[k]);
      for (const x of seen) list.push(x);
      start[v + 1] = list.length;
    }
    this.neighbourStart = start;
    this.neighbours = Uint32Array.from(list);
    const qs = new Uint32Array(V + 1);
    for (let i = 0; i < quads.length; i++) qs[quads[i] + 1]++;
    for (let v = 0; v < V; v++) qs[v + 1] += qs[v];
    const qf = qs.slice(0, V);
    this.quadsOf = new Uint32Array(quads.length);
    for (let i = 0; i < quads.length; i++) this.quadsOf[qf[quads[i]]++] = i >> 2;
    this.quadStart = qs;
    this.quadStamp = new Uint32Array(quads.length / 4);
    this.quadList = new Uint32Array(quads.length / 4);
    this.vertexStamp = new Uint32Array(V);
    this.vertexList = new Uint32Array(V);
    for (let q = 0; q < quads.length / 4; q++) this.quadNormal(q);
    for (let v = 0; v < V; v++) this.vertexNormal(v);
    let sum = 0,
      count = 0;
    for (let v = 0; v < V; v++)
      for (let k = start[v]; k < start[v + 1]; k++) {
        const u = this.neighbours[k];
        if (u <= v) continue;
        sum += Math.hypot(
          this.positions[3 * u] - this.positions[3 * v],
          this.positions[3 * u + 1] - this.positions[3 * v + 1],
          this.positions[3 * u + 2] - this.positions[3 * v + 2],
        );
        count++;
      }
    this.spacing = count ? sum / count : 1;
    this.refresh();
  }

  get vertexCount() {
    return this.positions.length / 3;
  }

  private quadNormal(q: number) {
    const P = this.positions,
      Q = this.quads;
    const a = 3 * Q[4 * q],
      b = 3 * Q[4 * q + 1],
      c = 3 * Q[4 * q + 2],
      d = 3 * Q[4 * q + 3];
    const ux = P[c] - P[a],
      uy = P[c + 1] - P[a + 1],
      uz = P[c + 2] - P[a + 2];
    const vx = P[d] - P[b],
      vy = P[d + 1] - P[b + 1],
      vz = P[d + 2] - P[b + 2];
    this.quadNormals[3 * q] = uy * vz - uz * vy;
    this.quadNormals[3 * q + 1] = uz * vx - ux * vz;
    this.quadNormals[3 * q + 2] = ux * vy - uy * vx;
  }
  private vertexNormal(v: number) {
    let x = 0,
      y = 0,
      z = 0;
    for (let k = this.quadStart[v]; k < this.quadStart[v + 1]; k++) {
      const q = 3 * this.quadsOf[k];
      x += this.quadNormals[q];
      y += this.quadNormals[q + 1];
      z += this.quadNormals[q + 2];
    }
    const l = Math.hypot(x, y, z);
    const o = 3 * v;
    if (l > 0) {
      this.normals[o] = x / l;
      this.normals[o + 1] = y / l;
      this.normals[o + 2] = z / l;
    }
  }

  /**
   * Rebuilds the lookup of vertices by place. A query reaches one cell further than it needs, so
   * moved vertices stay findable; a dab that moves one more than a cell calls it again.
   */
  refresh() {
    this.stale = false;
    const P = this.positions;
    const V = this.vertexCount;
    const min: Vec3 = [Infinity, Infinity, Infinity],
      max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < V; v++)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], P[3 * v + k]);
        max[k] = Math.max(max[k], P[3 * v + k]);
      }
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-6);
    const n = 64;
    const cell = (size * 1.0001) / n;
    const key = (v: number) => {
      const c = [0, 1, 2].map((k) =>
        Math.min(n - 1, Math.max(0, Math.floor((P[3 * v + k] - min[k]) / cell))),
      );
      return c[0] + n * (c[1] + n * c[2]);
    };
    const start = new Uint32Array(n * n * n + 1);
    const keys = new Uint32Array(V);
    for (let v = 0; v < V; v++) {
      keys[v] = key(v);
      start[keys[v] + 1]++;
    }
    for (let i = 0; i < n * n * n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n * n * n);
    const items = new Uint32Array(V);
    for (let v = 0; v < V; v++) items[fill[keys[v]]++] = v;
    this.grid = { origin: min, cell, n, start, items };
    this.indexed = P.slice();
  }

  /** Every vertex within `radius` of `center` (plus one cell of slack for moved vertices). */
  near(center: Vec3, radius: number, visit: (v: number, d2: number) => void) {
    if (this.stale) this.refresh();
    const { origin, cell, n, start, items } = this.grid;
    const P = this.positions;
    const lo = [0, 1, 2].map((k) =>
      Math.max(0, Math.floor((center[k] - radius - origin[k]) / cell) - 1),
    );
    const hi = [0, 1, 2].map((k) =>
      Math.min(n - 1, Math.floor((center[k] + radius - origin[k]) / cell) + 1),
    );
    const r2 = radius * radius;
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let x = lo[0]; x <= hi[0]; x++) {
          const c = x + n * (y + n * z);
          for (let i = start[c]; i < start[c + 1]; i++) {
            const v = items[i];
            const d2 =
              (P[3 * v] - center[0]) ** 2 +
              (P[3 * v + 1] - center[1]) ** 2 +
              (P[3 * v + 2] - center[2]) ** 2;
            if (d2 <= r2) visit(v, d2);
          }
        }
  }

  /**
   * The first vertex along a ray (origin, unit direction) that faces back along it and lies
   * within `tolerance` of it (default 1.5 × the mean edge length): where a brush lands.
   */
  raycast(origin: Vec3, dir: Vec3, tolerance = 1.5 * this.spacing): number | undefined {
    if (this.stale) this.refresh();
    const { origin: o, cell, n } = this.grid;
    const P = this.positions,
      N = this.normals;
    // March the ray through the grid's box, a third of a cell at a time.
    const lo = o,
      hi = [o[0] + n * cell, o[1] + n * cell, o[2] + n * cell];
    let t0 = 0,
      t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < 1e-12) {
        if (origin[k] < lo[k] || origin[k] > hi[k]) return undefined;
        continue;
      }
      const a = (lo[k] - origin[k]) / dir[k],
        b = (hi[k] - origin[k]) / dir[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1) return undefined;
    const step = Math.max(Math.min(cell, tolerance * 2) / 3, 1e-9);
    const tol2 = tolerance * tolerance;
    let best: number | undefined;
    let bestT = Infinity;
    for (let t = t0; t <= t1 + step; t += step) {
      if (best !== undefined && t > bestT + tolerance * 2) break;
      const p: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
      this.near(p, tolerance, (v) => {
        const wx = P[3 * v] - origin[0],
          wy = P[3 * v + 1] - origin[1],
          wz = P[3 * v + 2] - origin[2];
        const along = wx * dir[0] + wy * dir[1] + wz * dir[2];
        const off = wx * wx + wy * wy + wz * wz - along * along;
        if (off > tol2 || along < 0) return;
        if (N[3 * v] * dir[0] + N[3 * v + 1] * dir[1] + N[3 * v + 2] * dir[2] >= 0) return;
        if (along < bestT) {
          bestT = along;
          best = v;
        }
      });
    }
    return best;
  }

  /** One dab at `center` (and its mirror with symmetry). `mask` (0–1 per vertex) holds vertices. */
  dab(center: Vec3, brush: SculptBrush, mask?: Float32Array): SculptChange {
    if (!(brush.radius > 0) || !Number.isFinite(brush.radius))
      editFail('selection', 'brush radius');
    const strength = Math.min(Math.max(brush.strength, 0), 1);
    const centers: Vec3[] = [center];
    if (brush.symmetry && Math.abs(center[0]) > 1e-9)
      centers.push([-center[0], center[1], center[2]]);
    // Both sides read the same starting shape; their moves add up, then apply together.
    const timing = this.timing;
    let t = timing ? performance.now() : 0;
    const lap = (phase: 'brush' | 'apply' | 'settle') => {
      if (!timing) return;
      const now = performance.now();
      timing[phase] += now - t;
      t = now;
    };
    const moves = new Map<number, Vec3>();
    for (const c of centers) this.dabAt(c, brush, strength, mask, moves);
    lap('brush');
    const changed = new Set<number>();
    const P = this.positions;
    for (const [v, d] of moves) {
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue;
      for (let k = 0; k < 3; k++) P[3 * v + k] += d[k];
      changed.add(v);
    }
    lap('apply');
    const out = this.settle(changed);
    lap('settle');
    return out;
  }

  /**
   * After vertices moved: the normals of the quads around them and of those quads' vertices, and
   * the range a GPU buffer update must cover. The moved vertices count as touched; one that drifted
   * a grid cell rebuilds the grid.
   */
  /**
   * After vertices moved: the normals of their quads and of those quads' vertices, the range of
   * vertices to upload, and the grid if one left its cell by more than the slack `near` gives (at
   * once, or with `defer` before the next query: a Grab drag asks no queries).
   */
  private settle(changed: Set<number>, defer = false): SculptChange {
    const P = this.positions;
    // Marks instead of Sets: a new stamp per call (cleared on the rare wrap-around).
    if (++this.stamp === 0xffffffff) {
      this.quadStamp.fill(0);
      this.vertexStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const QS = this.quadStamp,
      VS = this.vertexStamp,
      QL = this.quadList,
      VL = this.vertexList;
    let nq = 0;
    for (const v of changed)
      for (let k = this.quadStart[v]; k < this.quadStart[v + 1]; k++) {
        const q = this.quadsOf[k];
        if (QS[q] === stamp) continue;
        QS[q] = stamp;
        QL[nq++] = q;
      }
    let nv = 0;
    for (let i = 0; i < nq; i++) {
      const q = QL[i];
      this.quadNormal(q);
      for (let k = 0; k < 4; k++) {
        const v = this.quads[4 * q + k];
        if (VS[v] === stamp) continue;
        VS[v] = stamp;
        VL[nv++] = v;
      }
    }
    let first = Infinity,
      last = -1;
    for (let i = 0; i < nv; i++) {
      const v = VL[i];
      this.vertexNormal(v);
      if (v < first) first = v;
      if (v > last) last = v;
    }
    for (const v of changed) this.touched.add(v);
    if (!this.stale) {
      const I = this.indexed,
        c2 = this.grid.cell * this.grid.cell;
      for (const v of changed) {
        const o = 3 * v;
        if ((P[o] - I[o]) ** 2 + (P[o + 1] - I[o + 1]) ** 2 + (P[o + 2] - I[o + 2]) ** 2 > c2) {
          if (defer) this.stale = true;
          else this.refresh();
          break;
        }
      }
    }
    return { vertices: [...changed], first: last < 0 ? 0 : first, last };
  }

  private dabAt(
    center: Vec3,
    brush: SculptBrush,
    strength: number,
    mask: Float32Array | undefined,
    moves: Map<number, Vec3>,
  ) {
    const P = this.positions,
      N = this.normals;
    const r = brush.radius,
      r2 = r * r;
    const hits: { v: number; w: number }[] = [];
    this.near(center, r, (v, d2) => {
      const w = falloff(d2, r2) * (mask ? 1 - Math.min(Math.max(mask[v], 0), 1) : 1);
      if (w > 0) hits.push({ v, w });
    });
    if (!hits.length) return;
    // The area's normal and middle (weighted by the falloff).
    let nx = 0,
      ny = 0,
      nz = 0,
      cx = 0,
      cy = 0,
      cz = 0,
      ws = 0;
    for (const { v, w } of hits) {
      nx += N[3 * v] * w;
      ny += N[3 * v + 1] * w;
      nz += N[3 * v + 2] * w;
      cx += P[3 * v] * w;
      cy += P[3 * v + 1] * w;
      cz += P[3 * v + 2] * w;
      ws += w;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    cx /= ws;
    cy /= ws;
    cz /= ws;
    const sign = brush.invert ? -1 : 1;
    // A full-strength dab moves the middle a tenth of the radius (Draw, Inflate).
    const reach = 0.1 * r * strength;
    for (const { v, w } of hits) {
      const o = 3 * v;
      let d: Vec3;
      if (brush.kind === 'draw')
        d = [nx * reach * w * sign, ny * reach * w * sign, nz * reach * w * sign];
      else if (brush.kind === 'inflate')
        d = [N[o] * reach * w * sign, N[o + 1] * reach * w * sign, N[o + 2] * reach * w * sign];
      else if (brush.kind === 'smooth') {
        let ax = 0,
          ay = 0,
          az = 0;
        const s = this.neighbourStart[v],
          e = this.neighbourStart[v + 1];
        if (e === s) continue;
        for (let k = s; k < e; k++) {
          const u = 3 * this.neighbours[k];
          ax += P[u];
          ay += P[u + 1];
          az += P[u + 2];
        }
        const n = e - s;
        const t = strength * w;
        d = [(ax / n - P[o]) * t, (ay / n - P[o + 1]) * t, (az / n - P[o + 2]) * t];
      } else if (brush.kind === 'pinch') {
        // Toward the centre, along the surface (its normal component removed).
        let px = center[0] - P[o],
          py = center[1] - P[o + 1],
          pz = center[2] - P[o + 2];
        const along = px * nx + py * ny + pz * nz;
        px -= along * nx;
        py -= along * ny;
        pz -= along * nz;
        const t = 0.3 * strength * w * sign;
        d = [px * t, py * t, pz * t];
      } else {
        // Flatten: toward the plane through the middle, at right angles to the area's normal.
        const dist = (P[o] - cx) * nx + (P[o + 1] - cy) * ny + (P[o + 2] - cz) * nz;
        const t = -dist * strength * w;
        d = [nx * t, ny * t, nz * t];
      }
      // Collected, not applied: every move reads the same starting shape (Smooth reads
      // neighbours, the mirrored dab the first one's area).
      const e = moves.get(v);
      if (e) for (let k = 0; k < 3; k++) e[k] += d[k];
      else moves.set(v, d);
    }
  }

  /**
   * C7c: paints the mask (0–1 per vertex, 1 holds a vertex still) at `center`; `erase` takes it
   * away. Positions do not change. Returns the vertices whose mask changed.
   */
  maskDab(
    mask: Float32Array,
    center: Vec3,
    radius: number,
    strength: number,
    erase: boolean,
    symmetry: boolean,
  ): SculptChange {
    if (!(radius > 0) || !Number.isFinite(radius)) editFail('selection', 'brush radius');
    if (mask.length !== this.vertexCount) editFail('selection', 'mask length');
    const s = Math.min(Math.max(strength, 0), 1) * (erase ? -1 : 1);
    const centers: Vec3[] = [center];
    if (symmetry && Math.abs(center[0]) > 1e-9) centers.push([-center[0], center[1], center[2]]);
    const changed = new Set<number>();
    for (const c of centers)
      this.near(c, radius, (v, d2) => {
        const w = falloff(d2, radius * radius);
        if (w <= 0) return;
        const m = Math.min(Math.max(mask[v] + s * w, 0), 1);
        if (m !== mask[v]) {
          mask[v] = m;
          changed.add(v);
        }
      });
    let first = Infinity,
      last = -1;
    for (const v of changed) {
      first = Math.min(first, v);
      last = Math.max(last, v);
    }
    return { vertices: [...changed], first: last < 0 ? 0 : first, last };
  }

  /**
   * C7c Grab: takes hold of the vertices within `radius` of `center` (weighted by the falloff and
   * the mask) as a stroke starts. `move(delta)` puts each at its start plus its weight × delta
   * (mm, absolute, so the drag never accumulates error); with symmetry the mirrored vertices
   * follow the delta mirrored across x = 0. Where both holds reach a vertex, their x pulls add up
   * (and cancel on the mirror plane) and y and z follow the stronger, so a mirrored drag stays
   * symmetric and does not pull the middle twice as far.
   */
  grab(
    center: Vec3,
    radius: number,
    mask?: Float32Array,
    symmetry = false,
  ): { vertices: number; move(delta: Vec3): SculptChange } {
    if (!(radius > 0) || !Number.isFinite(radius)) editFail('selection', 'brush radius');
    if (mask && mask.length !== this.vertexCount) editFail('selection', 'mask length');
    const hold = (m: number) => (mask ? 1 - Math.min(Math.max(mask[m], 0), 1) : 1);
    const weights = new Map<number, [number, number]>();
    this.near(center, radius, (v, d2) => {
      const w = falloff(d2, radius * radius) * hold(v);
      if (w > 0) weights.set(v, [w, 0]);
    });
    // With symmetry the mirrored hold is taken even from the mirror plane itself (where it is the
    // same hold): its x pull then cancels the other's, so the middle stays on x = 0.
    if (symmetry)
      this.near([-center[0], center[1], center[2]], radius, (v, d2) => {
        const w = falloff(d2, radius * radius) * hold(v);
        if (w <= 0) return;
        const e = weights.get(v);
        if (e) e[1] = w;
        else weights.set(v, [0, w]);
      });
    const list = [...weights.keys()];
    const start = new Float32Array(3 * list.length);
    list.forEach((v, i) => start.set(this.positions.subarray(3 * v, 3 * v + 3), 3 * i));
    return {
      vertices: list.length,
      move: (delta) => {
        const timing = this.timing;
        const t0 = timing ? performance.now() : 0;
        const changed = new Set<number>();
        const P = this.positions;
        list.forEach((v, i) => {
          const [w, m] = weights.get(v)!;
          const x = start[3 * i] + w * delta[0] - m * delta[0],
            y = start[3 * i + 1] + Math.max(w, m) * delta[1],
            z = start[3 * i + 2] + Math.max(w, m) * delta[2];
          if (P[3 * v] === x && P[3 * v + 1] === y && P[3 * v + 2] === z) return;
          P[3 * v] = x;
          P[3 * v + 1] = y;
          P[3 * v + 2] = z;
          changed.add(v);
        });
        const t1 = timing ? performance.now() : 0;
        const out = this.settle(changed, true);
        if (timing) {
          timing.apply += t1 - t0;
          timing.settle += performance.now() - t1;
        }
        return out;
      },
    };
  }

  /** The vertices moved since the last call (what a stroke's edit reads back). */
  takeTouched(): Set<number> {
    const t = this.touched;
    this.touched = new Set();
    return t;
  }
}

/**
 * Dabs from `from` to `to` (mm), at most a quarter of the radius apart, so a fast drag sculpts
 * the whole way. Returns every vertex changed.
 */
export function sculptSegment(
  surface: SculptSurface,
  from: Vec3,
  to: Vec3,
  brush: SculptBrush,
  mask?: Float32Array,
): SculptChange {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const steps = Math.max(1, Math.ceil(len / Math.max(brush.radius / 4, 1e-9)));
  const all = new Set<number>();
  let first = Infinity,
    last = -1;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const c = surface.dab(
      [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ],
      brush,
      mask,
    );
    for (const v of c.vertices) all.add(v);
    if (c.last >= 0) {
      first = Math.min(first, c.first);
      last = Math.max(last, c.last);
    }
  }
  return { vertices: [...all], first: last < 0 ? 0 : first, last };
}

/** Two triangles per quad (a, b, c and a, c, d), for drawing. */
export function sculptTriangles(quads: Uint32Array): Uint32Array {
  const out = new Uint32Array((quads.length / 4) * 6);
  for (let q = 0, o = 0; q < quads.length; q += 4, o += 6) {
    out[o] = quads[q];
    out[o + 1] = quads[q + 1];
    out[o + 2] = quads[q + 2];
    out[o + 3] = quads[q];
    out[o + 4] = quads[q + 2];
    out[o + 5] = quads[q + 3];
  }
  return out;
}
