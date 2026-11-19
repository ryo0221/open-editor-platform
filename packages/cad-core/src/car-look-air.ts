/**
 * CL3 (docs/cad/car-look-process.md): the air story of 「翔」 (F83), drawn over F82's package
 * before the shape (N1, N8). Where the air goes in and out (the nose, the floor and its two
 * tunnels, the wheel arches, the side intakes to the radiators, the deck outlets, the tail), the
 * surfaces that press the car down (splitter, floor, diffuser, ducktail) and where vortices are
 * made to seal the floor's edges. Geometry only: no flow is computed here (CL-U2); CL7 checks
 * the shape against this story with simple indicators. Same frame as F82.
 */
import { fixtureKernel } from './fixtures';
import { applyCadOperation } from './operations';
import { identityQuaternion, position, type CadDocument, type CadKernelProfile } from './model';
import { f82Package, f82Rules, outlineSketch, sidePlane } from './car-look-package';

type V2 = readonly [number, number];

/** An opening on the skin: where on the car (x range, z range, |y| range) and what it does. */
export interface F83Opening {
  id: string;
  name: string;
  x: V2;
  z: V2;
  /** |y| (mirrored left and right; from 0 on the centre line). */
  y: V2;
  kind: 'inlet' | 'outlet';
}

/** A path of the air, in the side view (x, z) and the plan view (x, y ≥ 0, mirrored). */
export interface F83Path {
  id: string;
  name: string;
  side: V2[];
  plan: V2[];
}

export const f83Air = Object.freeze({
  /** The flat floor from the splitter's tip to the tunnels, at the ground clearance. */
  floor: { from: -950, to: 1700, z: f82Rules.clearance },
  /**
   * Two tunnels (|y| inner to outer) from the floor's end to the tail, their roof rising from the
   * floor to the exit: the diffuser. Outside the engine (±310) and gearbox, inside the rear tyres.
   */
  tunnel: { start: 1700, exit: 3400, inner: 320, outer: 640, roofStart: 100, roofExit: 400 },
  /** The splitter ahead of the nose's inlet, and the ducktail's lip on the deck's end. */
  splitter: { x: [-950, -700] as V2, z: 100 },
  ducktail: { x: [3250, 3400] as V2, z: [930, 960] as V2 },
  openings: [
    {
      id: 'nose',
      name: 'Nose inlet (front brakes, arches)',
      x: [-950, -900],
      z: [180, 350],
      y: [250, 600],
      kind: 'inlet',
    },
    {
      id: 'fender-vent',
      name: 'Fender vent behind the front wheel',
      x: [380, 560],
      z: [380, 640],
      y: [940, 975],
      kind: 'outlet',
    },
    {
      id: 'side-intake',
      name: 'Side intake to the radiator',
      x: [1800, 2250],
      z: [300, 650],
      y: [900, 975],
      kind: 'inlet',
    },
    {
      id: 'deck-outlet',
      name: 'Deck outlet above the radiator',
      x: [2250, 2550],
      z: [960, 1010],
      y: [650, 900],
      kind: 'outlet',
    },
    {
      id: 'engine-intake',
      name: 'Engine intake behind the side window',
      x: [1550, 1750],
      z: [880, 1040],
      y: [560, 700],
      kind: 'inlet',
    },
    {
      id: 'diffuser-exit',
      name: 'Diffuser exit',
      x: [3380, 3400],
      z: [100, 400],
      y: [320, 640],
      kind: 'outlet',
    },
    {
      id: 'arch-exit',
      name: 'Rear arch exit',
      x: [3380, 3400],
      z: [420, 700],
      y: [680, 840],
      kind: 'outlet',
    },
  ] as F83Opening[],
  paths: [
    {
      id: 'over',
      name: 'Over the body, kicked up by the ducktail',
      side: [
        [-1150, 470],
        [-950, 470],
        [-500, 730],
        [0, 840],
        [400, 820],
        [1150, 1180],
        [1450, 1180],
        [2650, 1040],
        [3400, 990],
        [3750, 1060],
      ],
      plan: [
        [-1150, 0],
        [3750, 0],
      ],
    },
    {
      id: 'floor',
      name: 'Under the floor, out through the tunnels',
      side: [
        [-1150, 60],
        [-950, 60],
        [1700, 60],
        [3400, 280],
        [3750, 340],
      ],
      plan: [
        [-1150, 480],
        [-950, 480],
        [3750, 480],
      ],
    },
    {
      id: 'arches',
      name: 'Nose inlet through the front arch, out of the fender vent',
      side: [
        [-1150, 260],
        [-950, 260],
        [-450, 300],
        [-100, 380],
        [470, 510],
        [700, 540],
      ],
      plan: [
        [-1150, 420],
        [-950, 420],
        [-400, 560],
        [0, 720],
        [470, 958],
        [700, 1080],
      ],
    },
    {
      id: 'radiator',
      name: 'Side intake through the radiator, out of the deck',
      side: [
        [1350, 470],
        [1800, 470],
        [2025, 430],
        [2250, 700],
        [2400, 985],
        [2550, 1150],
      ],
      plan: [
        [1350, 1080],
        [1800, 975],
        [2025, 830],
        [2250, 800],
        [2400, 775],
        [2550, 775],
      ],
    },
    {
      id: 'engine',
      name: 'Behind the side window into the engine',
      side: [
        [1350, 1000],
        [1650, 960],
        [1900, 760],
      ],
      plan: [
        [1350, 1080],
        [1650, 630],
        [1900, 300],
      ],
    },
    {
      id: 'wake',
      name: 'Rear wheel wake out of the arch exit',
      side: [
        [2650, 560],
        [3100, 560],
        [3400, 560],
        [3750, 560],
      ],
      plan: [
        [2650, 820],
        [3400, 800],
        [3750, 800],
      ],
    },
  ] as F83Path[],
  /** Floor-edge vortices along the sills (side x range, |y|), sealing the floor's edges. */
  vortex: { x: [400, 1700] as V2, y: 950 },
});

/** The diffuser's angle (degrees): the tunnel roof's rise over its length. */
export function f83DiffuserDegrees(): number {
  const t = f83Air.tunnel;
  return (Math.atan2(t.roofExit - t.roofStart, t.exit - t.start) * 180) / Math.PI;
}

/** The tunnel roof's height above x (the floor's height ahead of the tunnels). */
export function f83TunnelRoof(x: number): number {
  const t = f83Air.tunnel;
  if (x <= t.start) return t.roofStart;
  const s = Math.min(1, (x - t.start) / (t.exit - t.start));
  return t.roofStart + s * (t.roofExit - t.roofStart);
}

/** An arrow: the path and a head of two 120 mm strokes at its end. */
function arrow(path: readonly V2[]): V2[] {
  const [a, b] = [path.at(-2)!, path.at(-1)!];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const [ux, uy] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const head = (turn: number): V2 => {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    return [b[0] - 120 * (ux * c - uy * s), b[1] - 120 * (ux * s + uy * c)];
  };
  // Out along the path, to one stroke's end, back to the tip, to the other's.
  return [...path, head(0.45), b, head(-0.45)];
}

/**
 * F83: F82's package with the air story as two sketches: `air-side` (each path as an arrow, the
 * floor and the tunnel roof, the splitter and ducktail, the openings as rectangles) and
 * `air-plan` (the paths on the right side, mirrored, the tunnels, the openings, the sills'
 * vortex lines).
 */
export function f83Package(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const a = f83Air;
  const t = a.tunnel;
  const box = (x: V2, v: V2): V2[] => [
    [x[0], v[0]],
    [x[1], v[0]],
    [x[1], v[1]],
    [x[0], v[1]],
  ];
  const mirror = (pts: readonly V2[]) => pts.map(([x, y]) => [x, -y] as V2);
  const sideLoops: Record<string, readonly V2[]> = {
    floor: [
      [a.floor.from, a.floor.z],
      [t.start, t.roofStart],
      [t.exit, t.roofExit],
    ],
    splitter: box(a.splitter.x, [a.splitter.z - 15, a.splitter.z]),
    ducktail: [
      [a.ducktail.x[0], a.ducktail.z[0]],
      [a.ducktail.x[1], a.ducktail.z[1]],
    ],
  };
  const planLoops: Record<string, readonly V2[]> = {
    tunnelR: box([t.start, t.exit], [t.inner, t.outer]),
    tunnelL: box([t.start, t.exit], [-t.outer, -t.inner]),
    vortexR: [
      [a.vortex.x[0], a.vortex.y],
      [a.vortex.x[1], a.vortex.y],
    ],
    vortexL: mirror([
      [a.vortex.x[0], a.vortex.y],
      [a.vortex.x[1], a.vortex.y],
    ]),
  };
  const open = ['floor', 'ducktail', 'vortexR', 'vortexL'];
  for (const o of a.openings) {
    sideLoops[`o-${o.id}`] = box(o.x, o.z);
    planLoops[`o-${o.id}R`] = box(o.x, o.y);
    planLoops[`o-${o.id}L`] = mirror(box(o.x, o.y));
  }
  for (const p of a.paths) {
    sideLoops[`f-${p.id}`] = arrow(p.side);
    planLoops[`f-${p.id}R`] = arrow(p.plan);
    open.push(`f-${p.id}`, `f-${p.id}R`);
    if (p.plan.some(([, y]) => y !== 0)) {
      planLoops[`f-${p.id}L`] = arrow(mirror(p.plan));
      open.push(`f-${p.id}L`);
    }
  }
  const side = outlineSketch(
    'air-side',
    'Air side',
    { origin: position(0, 0, 0), orientation: sidePlane },
    sideLoops,
    {},
    open,
  );
  const plan = outlineSketch(
    'air-plan',
    'Air plan',
    { origin: position(0, 0, 0), orientation: identityQuaternion() },
    planLoops,
    {},
    open,
  );
  return applyCadOperation(f82Package(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [side, plan],
    features: [],
    bodies: [],
  });
}
