/**
 * CL7c (docs/cad/car-look-process.md, 空力の簡易検査): 「翔」 F141 read with the aero indicators
 * (CLF4) against its air story (CL3, F83), and the mismatch the story cannot do without fixed:
 * the skin had no underside, so the floor and the diffuser the story runs under the car (its
 * `floor` path) did not exist. F142 adds them as sheets: the flat floor at the ground clearance
 * from the splitter's tip to the tunnels' start, inside the lower edge and the front tyres, and
 * the two tunnels' roofs rising from the floor to the tail (F83's diffuser). The openings the
 * story also draws (nose inlet, fender vent, deck outlet, engine intake, arch exit) are details
 * of CL8. Same frame as F82.
 */
import { f83Air } from './car-look-air';
import { f82Rules } from './car-look-package';
import { f141BodyLines, f141Package, f141Variant } from './car-look-skin';
import { fixtureKernel } from './fixtures';
import { position, type CadAppearance, type CadDocument, type CadKernelProfile } from './model';
import { applyCadOperation } from './operations';
import { splineThrough, type CadSketch } from './sketch';

type V2 = [number, number];
type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/** F142's underside, from F83's floor and tunnels. */
export const f142Underbody = (() => {
  const r = f82Rules;
  const a = f83Air;
  // 40 mm clear of the front tyres' inner faces (half the track less half the tyre's width) and
  // 20 mm inside the skin's lower edge.
  const tyreInner = r.track.front / 2 - r.tyre.front.width / 2;
  return Object.freeze({
    floor: { from: a.floor.from, to: a.floor.to, z: a.floor.z, inset: 20, maxY: tyreInner - 40 },
    tunnel: a.tunnel,
    /** Stations of the floor's edge along x. */
    stations: [-950, -800, -600, -350, -100, 200, 450, 800, 1200, 1500, 1700] as const,
  });
})();

/** The floor's edge |y| at x: inside the lower edge and the front tyres. */
export function f142FloorEdge(x: number): number {
  const u = f142Underbody.floor;
  return Math.min(f141BodyLines()(x).lower[0] - u.inset, u.maxY);
}

/** The diffuser's angle (degrees): the tunnels' roof rise over their length. */
export function f142DiffuserDegrees(): number {
  const t = f142Underbody.tunnel;
  return (Math.atan2(t.roofExit - t.roofStart, t.exit - t.start) * 180) / Math.PI;
}

const under: CadAppearance = { color: '#2b2f35', opacity: 1 };

/** A planar loop of lines through `points` (in the sketch's plane), closed. */
function polygon(id: string, name: string, plane: CadSketch['plane'], points: readonly V2[]) {
  const solved = Object.fromEntries(points.map((p, i) => [`p${i}`, [p[0], p[1]]])) as Record<
    string,
    [number, number]
  >;
  const n = points.length;
  return {
    id,
    name,
    plane,
    entities: [
      ...points.map((_, i) => ({ type: 'point' as const, id: `p${i}` })),
      ...points.map((_, i) => ({
        type: 'line' as const,
        id: `e${i}`,
        start: `p${i}`,
        end: `p${(i + 1) % n}`,
      })),
    ],
    constraints: [],
    solved,
  } satisfies CadSketch;
}

/**
 * F142: F141 with the floor and the diffuser (CL7c). The floor is one planar sheet at the
 * ground clearance whose sides follow the lower edge (splines) and whose ends are straight; each
 * tunnel's roof is a planar sheet tilted about y, from the floor's height at the tunnels' start
 * to the roof's exit height at the tail.
 */
export function f142Package(kernel: Kernel = fixtureKernel) {
  const doc = f141Package(f141Variant, kernel) as CadDocument;
  const u = f142Underbody;
  const right = splineThrough(
    u.stations.map((x) => [x, f142FloorEdge(x)] as V2),
    3,
    false,
  );
  const left = right.map(([x, y]) => [x, -y] as V2);
  const solved: Record<string, [number, number]> = {};
  right.forEach((p, i) => (solved[`r${i}`] = [p[0], p[1]]));
  left.forEach((p, i) => (solved[`l${i}`] = [p[0], p[1]]));
  const last = right.length - 1;
  const floor: CadSketch = {
    id: 'aero-floor-loop',
    name: 'Floor loop',
    plane: { origin: position(0, 0, u.floor.z), orientation: [0, 0, 0, 1] },
    entities: [
      ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'line', id: 'front', start: 'l0', end: 'r0' },
      { type: 'spline', id: 'r', poles: right.map((_, i) => `r${i}`), degree: 3 },
      { type: 'line', id: 'back', start: `r${last}`, end: `l${last}` },
      { type: 'spline', id: 'l', poles: left.map((_, i) => `l${i}`), degree: 3 },
    ],
    constraints: [],
    solved,
  };
  // The tunnels' roofs: the sketch's x along the rise (y as the car's), tilted about y.
  const t = u.tunnel;
  const length = Math.hypot(t.exit - t.start, t.roofExit - t.roofStart);
  const half = (-f142DiffuserDegrees() * Math.PI) / 360;
  const tilt: [number, number, number, number] = [0, Math.sin(half), 0, Math.cos(half)];
  const tunnels = ([1, -1] as const).map((side) =>
    polygon(
      `aero-tunnel-${side > 0 ? 'right' : 'left'}-loop`,
      `Tunnel ${side > 0 ? 'right' : 'left'} loop`,
      { origin: position(t.start, 0, t.roofStart), orientation: tilt },
      [
        [0, side * t.inner],
        [length, side * t.inner],
        [length, side * t.outer],
        [0, side * t.outer],
      ],
    ),
  );
  const fill = (id: string, name: string, sketch: CadSketch, elements: string[]) => ({
    id,
    name,
    type: 'fill' as const,
    inputFeatureIds: [] as [],
    args: {
      boundary: elements.map((e) => ({
        curve: { sketchId: sketch.id, element: e },
        continuity: 'G0' as const,
      })),
    },
  });
  const bodyOf = (id: string, name: string) => ({
    id: `${id}-body`,
    name,
    sourceFeatureId: id,
    placementFeatureId: `${id}-placement`,
    appearance: under,
  });
  return applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [floor, ...tunnels],
    features: [
      fill('aero-floor', 'Floor', floor, ['front', 'r', 'back', 'l']),
      ...tunnels.map((s, i) =>
        fill(`aero-tunnel-${i ? 'left' : 'right'}`, `Tunnel ${i ? 'left' : 'right'}`, s, [
          'e0',
          'e1',
          'e2',
          'e3',
        ]),
      ),
    ],
    bodies: [
      bodyOf('aero-floor', 'Floor'),
      bodyOf('aero-tunnel-right', 'Tunnel right'),
      bodyOf('aero-tunnel-left', 'Tunnel left'),
    ],
  });
}
