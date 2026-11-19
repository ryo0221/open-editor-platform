/**
 * VS10a (docs/cad/vehicle-simulation.md, V3): the shower's particles. Rain or a nozzle throws
 * drops; a drop flies under gravity until it meets the surface and becomes film there. Film runs
 * down the surface along gravity's part in the surface's plane at a set speed, onto the next
 * triangles; it drops off again past a free edge (the surface turns away more than 30° in one
 * step) or on an overhang (its outward normal points down past −0.3). A seal's ribbon
 * (`sealRibbon`) stops film where the seal is closed and lets it through where it leaks; film
 * crossing a leaking stretch towards the inside of the seal's loop is counted as entered there.
 * A drop meets the ribbons too: a closed one holds it (ponding on the seal), a leaking one lets it
 * in when it crosses inwards.
 * Film that stops (on a level face, or held against a ribbon or a corner) is ponding. Drops that
 * fall below the surfaces drain.
 *
 * This is a particle model to find the paths a leak can take, not a flow solution (VS-U5):
 * surface tension, capillarity, wind and the film's thickness are left out, and the volume each
 * particle carries only scales the counts.
 */
import { CfdError } from './errors';
import {
  TriangleGrid,
  add,
  checkTriangles,
  cross,
  dot,
  norm,
  scale,
  sub,
  unit,
  type Vec3,
} from './triangle-grid';
import type { TriangleSurface } from './voxelize';

/** Rain over a rectangle: drops start at `heightMm`, at random in [min, max] (x, y), falling along `direction`. */
export interface RainEmitter {
  kind: 'rain';
  /** The rain's rate (mm of water an hour on a face across it). */
  rateMmPerH: number;
  /** The direction the rain falls (normalised; [0, 0, −1] is straight down). */
  direction: Vec3;
  /** The drops' speed as they start (mm/s). */
  speedMmPerS: number;
  /** The rectangle the drops start over (x, y) and its height (z). */
  min: [number, number];
  max: [number, number];
  heightMm: number;
}

/** A nozzle: drops from `origin` in a cone of half angle `coneDeg` round `direction`. */
export interface NozzleEmitter {
  kind: 'nozzle';
  origin: Vec3;
  direction: Vec3;
  coneDeg: number;
  speedMmPerS: number;
  /** Its flow (litres a minute). */
  flowLPerMin: number;
}

export type ShowerEmitter = RainEmitter | NozzleEmitter;

/**
 * A seal as a barrier: its ribbon round the loop, each point's base, top (along the base face's
 * `normal` when given) and whether it leaks.
 */
export interface ShowerSeal {
  id: string;
  ribbon: readonly { base: Vec3; top: Vec3; normal?: Vec3; leak: boolean }[];
}

/** The lowest a closed ribbon stands as a barrier (mm), and how far a film's ray is lifted. */
const barrierMinMm = 1;
const filmLiftMm = 0.5;

export interface ShowerInput {
  /** Every surface the water meets, wound outward where it is closed. */
  surface: TriangleSurface;
  seals: readonly ShowerSeal[];
  emitters: readonly ShowerEmitter[];
  /** Gravity (mm/s²); [0, 0, −9810] by default. */
  gravity?: Vec3;
  /** The time simulated and its step (s). */
  durationS: number;
  stepS: number;
  /** Particles started per second, over all emitters (shared by their flows). */
  particlesPerS: number;
  /** Emitters stop at this time (s); the duration by default, so the water left can run off. */
  emitUntilS?: number;
  /** The film's speed down a vertical face (mm/s); 150 by default. */
  filmSpeedMmPerS?: number;
  /** A drop's top speed (mm/s); 7000 by default. */
  terminalMmPerS?: number;
  /** A film that moves under this distance (mm) in `stallS` is ponding; 1 mm in 0.5 s by default. */
  stallMm?: number;
  stallS?: number;
  /** The random sequence (rain and cone positions). */
  seed?: number;
  /** A frame of every particle every `frameEvery` steps and at the end (for the view and a video). */
  frameEvery?: number;
  onFrame?(frame: ShowerFrame): void;
}

/** A particle's state. */
export type ShowerState = 'drop' | 'film' | 'pond' | 'entered' | 'drained';
const stateCodes: readonly ShowerState[] = ['drop', 'film', 'pond', 'entered', 'drained'];

export interface ShowerFrame {
  timeS: number;
  /** x, y, z of each particle started so far. */
  positions: Float32Array;
  /** Each particle's state as its index in `showerStates`. */
  states: Uint8Array;
}
export const showerStates = stateCodes;

/** Where water went in through a seal: the seal, its ribbon point, the place and the volume. */
export interface ShowerEntry {
  sealId: string;
  point: number;
  position: Vec3;
  particles: number;
  volumeMm3: number;
}

/** Where film stopped, gathered on a grid of `pondCellMm`. */
export interface ShowerPond {
  position: Vec3;
  particles: number;
  volumeMm3: number;
}

export interface ShowerResult {
  particles: number;
  /** The volume one particle carries (mm³). */
  particleVolumeMm3: number;
  counts: Record<ShowerState, number>;
  entries: ShowerEntry[];
  ponds: ShowerPond[];
  /** Entered volume per seal (mm³). */
  enteredBySeal: Record<string, number>;
  steps: number;
}

/** The shower's limits: particles started, steps, emitters and ribbon points. */
export const showerLimits = Object.freeze({
  particles: 200_000,
  steps: 200_000,
  /** particles × steps: the work of a run. */
  work: 2e9,
  emitters: 16,
  ribbonPoints: 200_000,
  pondCellMm: 20,
});

/** mulberry32: a small seeded random sequence in [0, 1). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two unit vectors across `d` (unit). */
function across(d: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(d, a));
  return [u, cross(d, u)];
}

/** An emitter's flow (mm³/s). */
function flowOf(e: ShowerEmitter): number {
  if (e.kind === 'nozzle') return (e.flowLPerMin * 1e6) / 60;
  // Rain falling along d over a rectangle in plan: a face across it gets rate · |d_z| per plan area.
  const area = (e.max[0] - e.min[0]) * (e.max[1] - e.min[1]);
  return (e.rateMmPerH / 3600) * area * Math.abs(unit(e.direction)[2]);
}

const finite = (v: readonly number[]) => v.every(Number.isFinite);

function check(input: ShowerInput) {
  const fail = (m: string) => {
    throw new CfdError('config', m);
  };
  const { durationS, stepS, particlesPerS } = input;
  if (!(durationS > 0) || !Number.isFinite(durationS)) fail('durationS must be > 0');
  if (!(stepS > 0) || !(stepS <= durationS)) fail('stepS must be > 0 and ≤ durationS');
  if (!(particlesPerS > 0) || !Number.isFinite(particlesPerS)) fail('particlesPerS must be > 0');
  const steps = Math.ceil(durationS / stepS - 1e-9);
  const emitUntil = Math.min(input.emitUntilS ?? durationS, durationS);
  if (!(emitUntil >= 0)) fail('emitUntilS must be ≥ 0');
  const particles = Math.ceil(particlesPerS * emitUntil);
  if (steps > showerLimits.steps) fail(`${steps} steps (at most ${showerLimits.steps})`);
  if (particles > showerLimits.particles)
    fail(`${particles} particles (at most ${showerLimits.particles})`);
  if (particles * steps > showerLimits.work)
    fail(`${particles} particles × ${steps} steps is past ${showerLimits.work}`);
  // Optional settings must be numbers that move a particle: NaN would hang the ray queries
  // (Codex on #1269).
  const positive = (v: number | undefined) => v === undefined || (v > 0 && Number.isFinite(v));
  if (!positive(input.filmSpeedMmPerS)) fail('filmSpeedMmPerS must be > 0');
  if (!positive(input.terminalMmPerS)) fail('terminalMmPerS must be > 0');
  if (!positive(input.stallMm) || !positive(input.stallS)) fail('stallMm and stallS must be > 0');
  if (input.gravity && (!finite(input.gravity) || !(norm(input.gravity) > 0)))
    fail('gravity must be finite and not zero');
  if (!input.emitters.length || input.emitters.length > showerLimits.emitters)
    fail(`the shower takes 1–${showerLimits.emitters} emitters`);
  for (const e of input.emitters) {
    if (!(e.speedMmPerS >= 0) || !(norm(e.direction) > 0) || !finite(e.direction))
      fail('an emitter needs a direction and a speed ≥ 0');
    if (e.kind === 'rain') {
      if (!(e.rateMmPerH > 0) || !finite([...e.min, ...e.max, e.heightMm]))
        fail('rain needs a rate > 0 and a finite rectangle');
      if (!(e.max[0] > e.min[0] && e.max[1] > e.min[1])) fail('the rain rectangle is empty');
      if (Math.abs(unit(e.direction)[2]) < 1e-3) fail('rain must fall (its direction has a z)');
    } else {
      if (!(e.flowLPerMin > 0) || !finite(e.origin)) fail('a nozzle needs a flow > 0');
      if (!(e.coneDeg >= 0 && e.coneDeg <= 90)) fail('a nozzle cone is 0–90°');
    }
  }
  const points = input.seals.reduce((n, s) => n + s.ribbon.length, 0);
  if (points > showerLimits.ribbonPoints)
    fail(`${points} ribbon points (at most ${showerLimits.ribbonPoints})`);
  for (const s of input.seals)
    if (s.ribbon.length < 3) fail(`seal ${s.id}: a ribbon needs 3 points or more`);
  if (input.gravity && (!finite(input.gravity) || !(norm(input.gravity) > 0)))
    fail('gravity must be finite and not zero');
  checkTriangles(input.surface);
  if (!input.surface.triangles.length)
    throw new CfdError('surface-invalid', 'the shower has no surface');
  return { steps, particles, emitUntil };
}

/**
 * The connected pieces of a surface: triangles sharing a corner (by position, as faces meshed
 * apart repeat their edges' points) are one piece. A film stays on its piece.
 */
function pieces(surface: TriangleSurface): Int32Array {
  const p = surface.positions;
  const t = surface.triangles;
  const key = new Map<string, number>();
  const node = new Int32Array(p.length / 3);
  for (let v = 0; v < node.length; v++) {
    const k = `${Math.round(p[3 * v]! * 1e4)},${Math.round(p[3 * v + 1]! * 1e4)},${Math.round(p[3 * v + 2]! * 1e4)}`;
    let n = key.get(k);
    if (n === undefined) key.set(k, (n = key.size));
    node[v] = n;
  }
  const up = Int32Array.from({ length: key.size }, (_, k) => k);
  const find = (a: number): number => {
    while (up[a] !== a) a = up[a] = up[up[a]!]!;
    return a;
  };
  for (let f = 0; f < t.length; f += 3) {
    const a = find(node[t[f]!]!);
    for (let c = 1; c < 3; c++) {
      const b = find(node[t[f + c]!]!);
      if (a !== b) up[b] = a;
    }
  }
  const out = new Int32Array(t.length / 3);
  for (let f = 0; f < out.length; f++) out[f] = find(node[t[3 * f]!]!);
  return out;
}

/** The spacing (mm) at which a long film step is checked for a hole under it. */
const holeStepMm = 0.5;

/** The ribbons as triangles, each with its seal, point, whether it is open and its inward side. */
function ribbons(seals: readonly ShowerSeal[]) {
  const positions: number[] = [];
  const triangles: number[] = [];
  const owner: { seal: number; point: number; open: boolean; inward: Vec3 }[] = [];
  seals.forEach((s, si) => {
    const r = s.ribbon;
    const n = r.length;
    // The loop's area vector (Newell): the loop runs anticlockwise round it, so the inside is on
    // the left of each stretch, convex or not (Codex on #1269).
    let area: Vec3 = [0, 0, 0];
    for (let k = 0; k < n; k++) area = add(area, cross(r[k]!.base, r[(k + 1) % n]!.base));
    // The barrier stands at least `barrierMinMm` high, so a film step's lifted ray meets it even
    // where the closure presses the seal flat (Codex on #1269).
    const top = (p: ShowerSeal['ribbon'][number]) => {
      const h = norm(sub(p.top, p.base));
      const up = p.normal ? unit(p.normal) : h > 0 ? unit(sub(p.top, p.base)) : unit(area);
      return add(p.base, scale(up, Math.max(h, barrierMinMm)));
    };
    for (let k = 0; k < n; k++) {
      const a = r[k]!;
      const b = r[(k + 1) % n]!;
      const first = positions.length / 3;
      positions.push(...a.base, ...b.base, ...top(b), ...top(a));
      triangles.push(first, first + 1, first + 2, first, first + 2, first + 3);
      const w = unit(cross(area, sub(b.base, a.base)));
      const open = a.leak || b.leak;
      const o = { seal: si, point: a.leak || !b.leak ? k : (k + 1) % n, open, inward: w };
      owner.push(o, o);
    }
  });
  if (!triangles.length) return null;
  return {
    grid: new TriangleGrid({
      positions: new Float64Array(positions),
      triangles: new Uint32Array(triangles),
    }),
    owner,
  };
}

export function runShower(input: ShowerInput): ShowerResult {
  const { steps, particles: cap, emitUntil } = check(input);
  // The step; the last one is cut to what is left of the duration (Codex on #1269).
  let dt = input.stepS;
  const g = input.gravity ?? ([0, 0, -9810] as Vec3);
  const gLen = norm(g);
  const filmSpeed = input.filmSpeedMmPerS ?? 150;
  const terminal = input.terminalMmPerS ?? 7000;
  const stallMm = input.stallMm ?? 1;
  const stallS = input.stallS ?? 0.5;
  const rand = random(input.seed ?? 1);
  const surface = new TriangleGrid(input.surface);
  const piece = pieces(input.surface);
  const walls = ribbons(input.seals);
  // Below the lowest point of the surfaces (along gravity) a drop has drained.
  const down = unit(g);
  let lowest = -Infinity;
  const pos = input.surface.positions;
  for (let i = 0; i < pos.length; i += 3)
    lowest = Math.max(lowest, dot([pos[i]!, pos[i + 1]!, pos[i + 2]!], down));
  const drainAt = lowest + 1;

  const flows = input.emitters.map(flowOf);
  const totalFlow = flows.reduce((a, b) => a + b, 0);
  const volume = totalFlow / input.particlesPerS;

  // Particle state, grown as they start.
  const P = new Float64Array(3 * cap);
  const V = new Float64Array(3 * cap);
  const tri = new Int32Array(cap).fill(-1);
  const side = new Int8Array(cap).fill(1);
  const state = new Uint8Array(cap);
  const anchor = new Float64Array(3 * cap);
  const anchorT = new Float64Array(cap);
  let started = 0;

  const get = (a: Float64Array, i: number): Vec3 => [a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!];
  const set = (a: Float64Array, i: number, v: Vec3) => {
    a[3 * i] = v[0];
    a[3 * i + 1] = v[1];
    a[3 * i + 2] = v[2];
  };

  const entries = new Map<string, ShowerEntry>();
  const ponds = new Map<string, ShowerPond>();
  const enteredBySeal: Record<string, number> = Object.fromEntries(
    input.seals.map((s) => [s.id, 0]),
  );

  const emit = (i: number) => {
    // Pick an emitter by its share of the flow.
    let r = rand() * totalFlow;
    let e = input.emitters[0]!;
    for (let k = 0; k < flows.length; k++) {
      e = input.emitters[k]!;
      if ((r -= flows[k]!) <= 0) break;
    }
    const d = unit(e.direction);
    if (e.kind === 'rain') {
      const x = e.min[0] + rand() * (e.max[0] - e.min[0]);
      const y = e.min[1] + rand() * (e.max[1] - e.min[1]);
      set(P, i, [x, y, e.heightMm]);
      set(V, i, scale(d, e.speedMmPerS));
    } else {
      // Uniform over the cone's cap.
      const c = Math.cos((e.coneDeg * Math.PI) / 180);
      const z = 1 - rand() * (1 - c);
      const a = 2 * Math.PI * rand();
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const [u, w] = across(d);
      const dir = add(scale(d, z), add(scale(u, s * Math.cos(a)), scale(w, s * Math.sin(a))));
      set(P, i, e.origin);
      set(V, i, scale(dir, e.speedMmPerS));
    }
    state[i] = 0;
  };

  const normalOf = (i: number) => scale(surface.normal(tri[i]!), side[i]!);

  const toFilm = (i: number, at: Vec3, t: number, incoming: Vec3) => {
    const n = surface.normal(t);
    side[i] = dot(n, incoming) > 0 ? -1 : 1;
    tri[i] = t;
    set(P, i, at);
    state[i] = 1;
    set(anchor, i, at);
    anchorT[i] = time;
  };

  const pond = (i: number) => {
    state[i] = 2;
    const p = get(P, i);
    const c = showerLimits.pondCellMm;
    const key = p.map((v) => Math.floor(v / c)).join(',');
    const o = ponds.get(key) ?? { position: [0, 0, 0] as Vec3, particles: 0, volumeMm3: 0 };
    o.position = scale(add(scale(o.position, o.particles), p), 1 / (o.particles + 1));
    o.particles++;
    o.volumeMm3 += volume;
    ponds.set(key, o);
  };

  const enter = (i: number, seal: number, point: number) => {
    state[i] = 3;
    const s = input.seals[seal]!;
    const key = `${seal}:${point}`;
    const o = entries.get(key) ?? {
      sealId: s.id,
      point,
      position: s.ribbon[point]!.base,
      particles: 0,
      volumeMm3: 0,
    };
    o.particles++;
    o.volumeMm3 += volume;
    entries.set(key, o);
    enteredBySeal[s.id]! += volume;
  };

  /** A drop's step: fly, meet the surface. */
  const flyDrop = (i: number) => {
    const p = get(P, i);
    let v = add(get(V, i), scale(g, dt));
    const sp = norm(v);
    if (sp > terminal) v = scale(v, terminal / sp);
    set(V, i, v);
    const move = scale(v, dt);
    const len = norm(move);
    if (len > 0) {
      const dir = scale(move, 1 / len);
      // A hit at the very end of the step counts (round-off past `len`); a drop just off a face
      // (detached) skips that face (Codex on #1269).
      const reach = len * (1 + 1e-9) + 1e-9;
      // Not a face it starts on (a nozzle on a surface sprays off it); a drop that left a face
      // starts off it a hair (Codex on #1269).
      const hit = surface.raycast(p, dir, 1e-7, reach, tri[i]!);
      // A drop meets a seal too (one falling in the gap between a closure and its opening): a
      // closed seal holds it there, a leaking one lets it in when it crosses inwards.
      // Past a leaking one crossed outwards the rest of the step is still checked (Codex on #1271).
      for (let from = 0, tries = 0; walls && tries < 8; tries++) {
        const wall = walls.grid.raycast(p, dir, from, hit ? hit.t : reach);
        if (!wall) break;
        const o = walls.owner[wall.triangle]!;
        if (!o.open) {
          set(P, i, add(p, scale(dir, wall.t)));
          tri[i] = -1;
          return pond(i);
        }
        if (dot(dir, o.inward) > 0) {
          set(P, i, add(p, scale(dir, wall.t)));
          return enter(i, o.seal, o.point);
        }
        from = wall.t + 1e-6;
      }
      if (hit) {
        toFilm(i, add(p, scale(dir, hit.t)), hit.triangle, dir);
        return;
      }
    }
    const q = add(p, move);
    set(P, i, q);
    tri[i] = -1;
    // Below the surfaces and still falling: it cannot come back (a nozzle under a face sprays up).
    if (dot(q, down) > drainAt && dot(v, down) >= 0) state[i] = 4;
  };

  /** A film's step: run down the surface, meet a ribbon, leave an edge, stop. */
  const runFilm = (i: number) => {
    const p = get(P, i);
    const n = normalOf(i);
    // An overhang drips.
    if (dot(n, scale(down, -1)) < -0.3) return detach(i, [0, 0, 0]);
    const gt = sub(g, scale(n, dot(g, n)));
    const gtLen = norm(gt);
    if (gtLen < gLen * Math.sin((0.5 * Math.PI) / 180)) return pond(i);
    let move = scale(gt, (filmSpeed * dt) / gLen);
    // A ribbon or a face in the way (a wall standing on the face): lifted off the face so a
    // ribbon's base edge is met. Past an open ribbon crossed outwards, or a face lying along the
    // film's own, the rest of the step is still checked, so a closed ribbon or a wall behind it
    // holds the film (Codex on #1269).
    const lift = add(p, scale(n, filmLiftMm));
    let from = 0;
    for (let k = 0, tries = 0; k < 2 && tries < 8; tries++) {
      const len = norm(move);
      if (len < 1e-12) break;
      const dir = scale(move, 1 / len);
      const rib = walls?.grid.raycast(lift, dir, from, len) ?? null;
      const face = surface.raycast(lift, dir, from, rib ? rib.t : len, tri[i]!);
      let m: Vec3;
      if (face) {
        m = surface.normal(face.triangle);
        // Its side facing the film. Turned less than 60° from the film's face, it is the next face
        // of a valley the film runs on into, not a wall (Codex on #1269).
        if (dot(m, dir) > 0) m = scale(m, -1);
        if (dot(m, n) > 0.5) {
          from = face.t + 1e-6;
          continue;
        }
      } else if (rib) {
        const o = walls!.owner[rib.triangle]!;
        if (o.open) {
          if (dot(dir, o.inward) > 0) {
            // Where it went in, so a frame shows it at the seal.
            set(P, i, add(p, scale(dir, rib.t)));
            return enter(i, o.seal, o.point);
          }
          from = rib.t + 1e-6;
          continue;
        }
        m = walls!.grid.normal(rib.triangle);
      } else break;
      from = 0;
      // Closed: slide along the foot of the ribbon or wall on the face (the line across both
      // normals), so the film neither crosses it nor creeps under it.
      const along = cross(m, n);
      const l = norm(along);
      move = l > 1e-9 ? scale(along, dot(move, along) / (l * l)) : [0, 0, 0];
      if (k === 1) move = [0, 0, 0];
      k++;
    }
    const len = norm(move);
    const q = add(p, move);
    const at = surface.nearest(q, Math.max(1, 4 * len));
    if (!at) return detach(i, scale(move, 1 / dt));
    // Past a free edge the nearest point lags behind the move: the surface turned away.
    // Relative to the step only, so a short step leaves an edge too (Codex on #1269).
    if (at.distance > Math.max(1e-9, 0.5 * len)) return detach(i, scale(move, 1 / dt));
    // Onto another piece (across a slit narrower than the step): the film left its own piece's
    // edge first (Codex on #1269).
    if (piece[at.triangle] !== piece[tri[i]!]) return detach(i, scale(move, 1 / dt));
    // Over a hole in its own piece (a slot the step spans): the surface is missing under the way
    // between, checked every 0.5 mm (Codex on #1277).
    if (len > holeStepMm) {
      const k = Math.min(32, Math.ceil(len / holeStepMm));
      for (let j = 1; j < k; j++) {
        const at = add(p, scale(move, j / k));
        const under = surface.nearest(at, Math.max(4 * holeStepMm, len));
        // Across a hole the nearest surface is its edge, off to the side in the film's plane;
        // in a valley it is the next face, across the plane (above or below the way).
        const off = under ? sub(under.point, at) : null;
        if (!off || (under!.distance > holeStepMm / 2 && Math.abs(dot(off, n)) < 0.5 * norm(off)))
          return detach(i, scale(move, 1 / dt));
      }
    }
    const nn = surface.normal(at.triangle);
    // The new face's side: the one whose normal agrees with the side the film was on.
    const flip = dot(nn, n) < 0 ? -1 : 1;
    const on = scale(nn, flip);
    // Over a sharp edge (the face turns away, towards the move, more than 30°) the film drops
    // off rather than wrapping round it; into a valley it carries on (Codex on #1269).
    if (dot(on, n) < Math.cos(Math.PI / 6) && dot(on, move) > dot(n, move))
      return detach(i, scale(move, 1 / dt));
    tri[i] = at.triangle;
    side[i] = flip;
    set(P, i, at.point);
    const a = get(anchor, i);
    if (norm(sub(at.point, a)) > stallMm) {
      set(anchor, i, at.point);
      anchorT[i] = time;
    } else if (time - anchorT[i]! > stallS) pond(i);
  };

  const detach = (i: number, v: Vec3) => {
    state[i] = 0;
    // Off the face a hair, so the drop's first ray does not meet it again.
    const n = tri[i]! >= 0 ? normalOf(i) : ([0, 0, 0] as Vec3);
    set(P, i, add(get(P, i), scale(n, 0.05)));
    set(V, i, v);
  };

  let time = 0;
  const frame = () => {
    if (!input.onFrame) return;
    const positions = new Float32Array(3 * started);
    for (let k = 0; k < 3 * started; k++) positions[k] = P[k]!;
    input.onFrame({ timeS: time, positions, states: state.slice(0, started) });
  };
  for (let s = 0; s < steps; s++) {
    dt = Math.min(input.stepS, input.durationS - s * input.stepS);
    if (time < emitUntil - 1e-12) {
      // The count due by the step's end, from the elapsed time itself so round-off in a running
      // sum cannot drop the last particle (Codex on #1269).
      const due = Math.min(
        cap,
        Math.floor(input.particlesPerS * Math.min(time + dt, emitUntil) + 1e-6),
      );
      while (started < due) emit(started++);
    }
    for (let i = 0; i < started; i++) {
      if (state[i] === 0) flyDrop(i);
      else if (state[i] === 1) runFilm(i);
    }
    time = Math.min((s + 1) * input.stepS, input.durationS);
    if (input.frameEvery && ((s + 1) % input.frameEvery === 0 || s + 1 === steps)) frame();
  }
  const counts = Object.fromEntries(stateCodes.map((k) => [k, 0])) as Record<ShowerState, number>;
  for (let i = 0; i < started; i++) counts[stateCodes[state[i]!]!]++;
  return {
    particles: started,
    particleVolumeMm3: volume,
    counts,
    entries: [...entries.values()],
    ponds: [...ponds.values()],
    enteredBySeal,
    steps,
  };
}
